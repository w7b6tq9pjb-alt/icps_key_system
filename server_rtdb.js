// server.js — Express + Firebase Realtime Database
// Monthly auto-refresh: archives previous month, resets current month records

const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Parser } = require('json2csv');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('\n═══════════════════════════════════════════════════════');
console.log('  ICPS Key System — Realtime Database Edition');
console.log('  Monthly Auto-Refresh + Archive Enabled');
console.log('═══════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════
// STEP 1: SERVICE ACCOUNT
// ═══════════════════════════════════════════════════════════════
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'firebase-service-account.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ FATAL: firebase-service-account.json not found!');
  console.error('');
  console.error('HOW TO GET IT:');
  console.error('1. Go to https://console.firebase.google.com');
  console.error('2. Click the gear ⚙️ → Project Settings');
  console.error('3. Go to "Service accounts" tab');
  console.error('4. Click "Generate new private key"');
  console.error('5. Save as firebase-service-account.json in this folder\n');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = require(SERVICE_ACCOUNT_PATH);
  console.log('✅ Service account loaded');
  console.log('   Project ID:', serviceAccount.project_id);
} catch (err) {
  console.error('❌ Invalid JSON:', err.message);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: INITIALIZE WITH REALTIME DATABASE URL
// ═══════════════════════════════════════════════════════════════
const databaseURL = `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;
console.log('   Database URL:', databaseURL);

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: databaseURL
  });
  console.log('✅ Firebase initialized with Realtime Database\n');
} catch (err) {
  console.error('❌ Firebase init failed:', err.message);
  process.exit(1);
}

const db = admin.database();
const keysRef = db.ref('keys');
const recordsRef = db.ref('records');
const archivesRef = db.ref('archives');

// ═══════════════════════════════════════════════════════════════
// STEP 3: MONTHLY AUTO-REFRESH & ARCHIVING SYSTEM
// ═══════════════════════════════════════════════════════════════

/**
 * Gets current month key in format YYYY-MM
 */
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Gets previous month key in format YYYY-MM
 */
function getPreviousMonthKey() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Get month key from a timestamp
 */
function getMonthFromTimestamp(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Archives current records to the previous month's archive
 * Then clears current records for the new month
 */
async function performMonthlyArchive(targetMonth = null) {
  // targetMonth: the month to archive TO (e.g., "2026-06")
  // If not provided, uses previous month from current date
  const archiveToMonth = targetMonth || getPreviousMonthKey();
  const currentMonth = getCurrentMonthKey();

  console.log(`\n📅 Monthly Archive — Current: ${currentMonth}, Archiving to: ${archiveToMonth}`);
  console.log(`   Server time: ${new Date().toISOString()}`);

  try {
    // 1. Get all current records
    const recordsSnap = await recordsRef.once('value');
    const currentRecords = recordsSnap.val() || {};
    const recordCount = Object.keys(currentRecords).length;

    if (recordCount === 0) {
      console.log('   ℹ️ No records to archive');
      return { archived: 0, archiveToMonth };
    }

    console.log(`   📦 Found ${recordCount} records to archive to ${archiveToMonth}`);

    // 2. Archive to target month (merge with existing if any)
    const archiveRef = archivesRef.child(archiveToMonth);
    const existingArchiveSnap = await archiveRef.once('value');
    const existingArchive = existingArchiveSnap.val() || {};

    // Merge: keep existing archived records + add new ones
    const mergedArchive = { ...existingArchive };
    Object.entries(currentRecords).forEach(([key, value]) => {
      // Only archive records that were actually issued (not just available keys)
      if (value && value.dateIssued) {
        mergedArchive[key] = {
          ...value,
          archivedAt: Date.now(),
          archivedMonth: archiveToMonth
        };
      }
    });

    await archiveRef.set(mergedArchive);
    console.log(`   ✅ Archived to ${archiveToMonth}: ${Object.keys(mergedArchive).length} total records`);

    // 3. Generate archive summary
    const summary = {
      month: archiveToMonth,
      archivedAt: Date.now(),
      recordCount: Object.keys(mergedArchive).length,
      statuses: {}
    };

    Object.values(mergedArchive).forEach(r => {
      const status = r.status || 'Unknown';
      summary.statuses[status] = (summary.statuses[status] || 0) + 1;
    });

    await archivesRef.child('_summaries').child(archiveToMonth).set(summary);
    console.log(`   📊 Archive summary:`, summary.statuses);

    // 4. Clear current records (keep keys intact)
    await recordsRef.remove();
    console.log('   🧹 Current records cleared for new month');

    // 5. Reset all keys to Available status for the new month
    const keysSnap = await keysRef.once('value');
    const allKeys = keysSnap.val() || {};

    // Keys stay in registry, just records are cleared
    console.log(`   🔑 ${Object.keys(allKeys).length} keys remain in registry`);

    return { 
      archived: Object.keys(mergedArchive).length, 
      archiveToMonth,
      summary 
    };

  } catch (err) {
    console.error('❌ Archive failed:', err.message);
    throw err;
  }
}

/**
 * Check if we need to run monthly archive (first request of new month)
 */
let lastCheckedMonth = null;
let archiveInProgress = false;

async function checkMonthlyArchive(force = false) {
  const currentMonth = getCurrentMonthKey();

  console.log(`\n🔍 Archive check: currentMonth=${currentMonth}, lastChecked=${lastCheckedMonth}, force=${force}, inProgress=${archiveInProgress}`);

  // Skip if already checked this month or archive in progress
  // But DON'T skip on force (startup check)
  if (!force && lastCheckedMonth === currentMonth || archiveInProgress) {
    console.log(`   ⏭️ Skipping archive check (already checked or in progress)`);
    return null;
  }

  archiveInProgress = true;

  try {
    // Check if records exist from previous month
    const recordsSnap = await recordsRef.once('value');
    const records = recordsSnap.val() || {};

    // If there are records, check if any are from previous month
    let hasOldRecords = false;
    let oldMonth = null;

    Object.values(records).forEach(r => {
      if (r.dateIssued) {
        const issuedDate = new Date(r.dateIssued);
        const issuedMonth = `${issuedDate.getFullYear()}-${String(issuedDate.getMonth() + 1).padStart(2, '0')}`;
        if (issuedMonth !== currentMonth) {
          hasOldRecords = true;
          oldMonth = issuedMonth; // Track the actual old month
        }
      }
    });

    if (hasOldRecords) {
      console.log(`\n🔄 Auto-archive triggered: Found records from ${oldMonth} (current is ${currentMonth})`);
      const result = await performMonthlyArchive();
      lastCheckedMonth = currentMonth;
      return result;
    } else {
      lastCheckedMonth = currentMonth;
      return null;
    }

  } catch (err) {
    console.error('Archive check failed:', err);
    return null;
  } finally {
    archiveInProgress = false;
  }
}

/**
 * Startup archive check — runs once when server starts
 * This handles the case where server was down during month rollover
 * or when testing with fake dates
 */
async function startupArchiveCheck() {
  console.log('\n🔍 Running startup archive check...');
  const result = await checkMonthlyArchive(true); // force = true
  if (result) {
    console.log(`✅ Startup archive complete: ${result.archived} records archived to ${result.previousMonth}`);
  } else {
    console.log('ℹ️ No old records found — ready for current month');
  }
}

/**
 * Manual archive trigger (for testing or admin use)
 */
async function manualArchive(targetMonth = null) {
  return await performMonthlyArchive(targetMonth);
}

// ═══════════════════════════════════════════════════════════════
// STEP 4: TEST CONNECTION
// ═══════════════════════════════════════════════════════════════
async function testConnection() {
  try {
    console.log('Testing Realtime Database connection...');
    await db.ref('_connection_test').set({ timestamp: Date.now(), working: true });
    const snap = await db.ref('_connection_test').once('value');
    if (snap.exists()) {
      console.log('✅ Connection test PASSED');
      await db.ref('_connection_test').remove();
      return true;
    }
  } catch (err) {
    console.error('❌ Connection test FAILED:', err.message);
    if (err.message.includes('permission_denied')) {
      console.error('\n🔴 PERMISSION DENIED');
      console.error('   Go to: https://console.firebase.google.com/project/' + serviceAccount.project_id + '/database');
      console.error('   Create the Realtime Database and set rules to:');
      console.error('   { "rules": { ".read": true, ".write": true } }');
    }
    if (err.message.includes('not found') || err.message.includes('404')) {
      console.error('\n🔴 DATABASE NOT FOUND');
      console.error('   You need to CREATE the Realtime Database first!');
      console.error('   Go to: https://console.firebase.google.com/project/' + serviceAccount.project_id + '/database');
      console.error('   Click "Create Database"');
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
app.use(express.json({ limit: '10mb' }));

// CORS — allow frontend to talk to backend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files (your HTML)
app.use(express.static(path.join(__dirname)));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Auto-archive check on every request (lightweight, only runs on month change)
app.use(async (req, res, next) => {
  // Skip for static files and health checks to avoid overhead
  if (req.path.startsWith('/exports') || req.path === '/api/health' || req.path === '/api/archive/status') {
    return next();
  }

  try {
    await checkMonthlyArchive();
  } catch (err) {
    console.error('Auto-archive check error:', err.message);
  }
  next();
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/keys/available — Keys not currently issued
app.get('/api/keys/available', asyncHandler(async (req, res) => {
  try {
    const [keysSnap, recordsSnap] = await Promise.all([
      keysRef.once('value'),
      recordsRef.once('value')
    ]);

    const allKeys = Object.keys(keysSnap.val() || {});
    const records = recordsSnap.val() || {};

    const issuedKeys = new Set();
    Object.values(records).forEach(r => {
      if (r.status === 'Issued') issuedKeys.add(r.keyId);
    });

    const available = allKeys.filter(k => !issuedKeys.has(k));
    res.json(available);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/keys — Create new key
app.post('/api/keys', asyncHandler(async (req, res) => {
  const { keyId, label, location } = req.body;

  if (!keyId) {
    return res.status(400).json({
      error: 'Key ID is required'
    });
  }

  const cleanKey = keyId.trim().toUpperCase();

  // Check if key already exists
  const existing = await keysRef.child(cleanKey).once('value');

  if (existing.exists()) {
    return res.status(409).json({
      error: 'Key already exists'
    });
  }

  const keyData = {
    keyId: cleanKey,
    label: label || '',
    location: location || '',
    createdAt: Date.now()
  };

  await keysRef.child(cleanKey).set(keyData);

  res.status(201).json({
    message: 'Key created successfully',
    key: keyData
  });
}));

// GET /api/keys
app.get('/api/keys', asyncHandler(async (req, res) => {
  const snap = await keysRef.once('value');
  const data = snap.val() || {};
  const keys = Object.values(data);
  keys.sort((a, b) => {
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  res.json(keys);
}));

// GET /api/records — All CURRENT month records (auto-refreshed)
app.get('/api/records', asyncHandler(async (req, res) => {
  try {
    const { status, search, limit = 100 } = req.query;

    const snap = await recordsRef.once('value');
    const rawData = snap.val();
    let records = [];

    // FIX: Handle null/undefined RTDB responses
    if (rawData && typeof rawData === 'object') {
      Object.entries(rawData).forEach(([key, value]) => {
        if (value && typeof value === 'object') {
          records.push({ id: key, ...value });
        }
      });
    }

    // Sort by dateIssued desc (newest first)
    records.sort((a, b) => (b.dateIssued || 0) - (a.dateIssued || 0));

    // Filter by status
    if (status && status !== 'all') {
      records = records.filter(r => r.status === status);
    }

    // Search
    if (search) {
      const s = search.toLowerCase().trim();
      records = records.filter(r => {
        const fields = [r.keyId, r.issuedBy, r.recipient, r.purpose, r.department, r.returnedBy, r.returnedTo];
        return fields.some(v => v && v.toLowerCase().includes(s));
      });
    }

    // Limit
    records = records.slice(0, parseInt(limit));

    res.json(records);
  } catch (err) {
    console.error('Error in /api/records:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/archives — List all archived months
app.get('/api/archives', asyncHandler(async (req, res) => {
  try {
    const snap = await archivesRef.once('value');
    const data = snap.val() || {};

    // Filter out _summaries key
    const months = Object.keys(data).filter(k => !k.startsWith('_'));

    // Get summaries if available
    const summaries = data._summaries || {};

    const archives = months.map(month => ({
      month,
      recordCount: summaries[month]?.recordCount || Object.keys(data[month] || {}).length,
      archivedAt: summaries[month]?.archivedAt || null,
      statuses: summaries[month]?.statuses || {}
    }));

    // Sort by month descending
    archives.sort((a, b) => b.month.localeCompare(a.month));

    res.json({
      currentMonth: getCurrentMonthKey(),
      archives
    });
  } catch (err) {
    console.error('Error fetching archives:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/archives/:month — Get records from a specific archived month
app.get('/api/archives/:month', asyncHandler(async (req, res) => {
  try {
    const { month } = req.params;

    // Validate month format (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
    }

    const snap = await archivesRef.child(month).once('value');
    const data = snap.val() || {};

    let records = [];
    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !key.startsWith('_')) {
        records.push({ id: key, ...value });
      }
    });

    // Sort by dateIssued desc
    records.sort((a, b) => (b.dateIssued || 0) - (a.dateIssued || 0));

    res.json({
      month,
      recordCount: records.length,
      records
    });
  } catch (err) {
    console.error('Error fetching archive:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/archive/trigger — Manual archive trigger (admin only)
app.post('/api/archive/trigger', asyncHandler(async (req, res) => {
  try {
    console.log('\n🖐️ Manual archive triggered via API');
    const result = await manualArchive();
    res.json({
      success: true,
      message: `Archived ${result.archived} records to ${result.previousMonth}`,
      ...result
    });
  } catch (err) {
    console.error('Manual archive failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/archive/status — Check archive status
app.get('/api/archive/status', asyncHandler(async (req, res) => {
  const currentMonth = getCurrentMonthKey();
  const previousMonth = getPreviousMonthKey();

  const [recordsSnap, archiveSnap, keysSnap] = await Promise.all([
    recordsRef.once('value'),
    archivesRef.child(previousMonth).once('value'),
    keysRef.once('value')
  ]);

  const currentRecords = recordsSnap.val() || {};
  const previousArchive = archiveSnap.val() || {};
  const allKeys = keysSnap.val() || {};

  res.json({
    currentMonth,
    previousMonth,
    currentRecordsCount: Object.keys(currentRecords).length,
    previousArchiveCount: Object.keys(previousArchive).length,
    totalKeysInRegistry: Object.keys(allKeys).length,
    lastCheckedMonth,
    archiveInProgress
  });
}));

// POST /api/records — Issue a key
app.post('/api/records', asyncHandler(async (req, res) => {
  try {
    const { keyId, issuedBy, department, recipient, purpose, issueSigBy, issueSigRec } = req.body;

    if (!keyId || !issuedBy || !department || !recipient || !purpose) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check key exists
    const keySnap = await keysRef.child(keyId).once('value');
    if (!keySnap.exists()) {
      return res.status(404).json({ error: 'Key not found in registry' });
    }

    // Check key not already issued
    const recordsSnap = await recordsRef.once('value');
    let alreadyIssued = false;
    recordsSnap.forEach(child => {
      if (child.val().keyId === keyId && child.val().status === 'Issued') {
        alreadyIssued = true;
      }
    });

    if (alreadyIssued) {
      return res.status(409).json({ error: 'Key is already issued' });
    }

    // Create record
    const newRef = recordsRef.push();
    const record = {
      keyId,
      issuedBy,
      department,
      recipient,
      purpose,
      dateIssued: Date.now(),
      dateReturned: null,
      returnedBy: null,
      returnedTo: null,
      status: 'Issued',
      issueSigBy: issueSigBy || null,
      issueSigRec: issueSigRec || null,
      sigBy: null,
      sigTo: null,
      month: getCurrentMonthKey() // Track which month this record belongs to
    };

    await newRef.set(record);
    console.log('Created record:', newRef.key);

    res.status(201).json({
      id: newRef.key,
      message: 'Key issued successfully',
      ...record
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// PUT /api/records/:id/return — Return a key
app.put('/api/records/:id/return', asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { returnedBy, returnedTo, sigBy, sigTo } = req.body;

    if (!returnedBy || !returnedTo) {
      return res.status(400).json({ error: 'returnedBy and returnedTo required' });
    }

    const ref = recordsRef.child(id);
    const snap = await ref.once('value');

    if (!snap.exists()) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = snap.val();
    if (data.status !== 'Issued') {
      return res.status(409).json({ error: 'Key is not currently issued' });
    }

    const updates = {
      status: 'Available',
      dateReturned: Date.now(),
      returnedBy,
      returnedTo,
      sigBy: sigBy || null,
      sigTo: sigTo || null
    };

    await ref.update(updates);
    res.json({ message: 'Key returned', id, ...data, ...updates });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// PUT /api/records/:id/revoke — Revoke a key
app.put('/api/records/:id/revoke', asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const ref = recordsRef.child(id);
    const snap = await ref.once('value');

    if (!snap.exists()) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = snap.val();
    if (data.status === 'Revoked') {
      return res.status(409).json({ error: 'Already revoked' });
    }

    await ref.update({ status: 'Revoked', dateReturned: Date.now() });
    res.json({ message: 'Key revoked', id });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/export — Export CSV + optional email
app.post('/api/export', asyncHandler(async (req, res) => {
  try {
    const { filter, search, emailConfig, month } = req.body;

    let sourceRef = recordsRef;
    let sourceName = 'current';

    // If month specified, export from archive
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      sourceRef = archivesRef.child(month);
      sourceName = month;
    }

    const snap = await sourceRef.once('value');
    const rawData = snap.val();
    let records = [];

    if (rawData && typeof rawData === 'object') {
      Object.entries(rawData).forEach(([key, value]) => {
        if (value && typeof value === 'object' && !key.startsWith('_')) {
          records.push({ id: key, ...value });
        }
      });
    }

    if (filter && filter !== 'all') {
      records = records.filter(r => r.status === filter);
    }

    if (search) {
      const s = search.toLowerCase().trim();
      records = records.filter(r => {
        const fields = [r.keyId, r.issuedBy, r.recipient, r.purpose, r.department, r.returnedBy, r.returnedTo];
        return fields.some(v => v && v.toLowerCase().includes(s));
      });
    }

    records.sort((a, b) => (b.dateIssued || 0) - (a.dateIssued || 0));

    const fields = ['id', 'keyId', 'department', 'issuedBy', 'recipient', 'purpose', 'dateIssued', 'dateReturned', 'returnedBy', 'returnedTo', 'status'];
    const csv = new Parser({ fields }).parse(records.map(r => ({
      ...r,
      dateIssued: r.dateIssued ? new Date(r.dateIssued).toISOString() : '',
      dateReturned: r.dateReturned ? new Date(r.dateReturned).toISOString() : ''
    })));

    const filename = `icps_export_${sourceName}_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv`;
    const exportDir = path.join(__dirname, 'exports');
    const filepath = path.join(exportDir, filename);

    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(filepath, csv);

    let emailResult = { sent: false, recipients: 0, error: null };

    if (emailConfig?.smtpHost && emailConfig?.smtpUser && emailConfig?.smtpPass && emailConfig?.recipients) {
      try {
        const port = parseInt(emailConfig.smtpPort) || 587;
        const isSecure = port === 465;

        console.log('\n📧 Email Configuration:');
        console.log('   Host:', emailConfig.smtpHost);
        console.log('   Port:', port);
        console.log('   Secure:', isSecure);
        console.log('   User:', emailConfig.smtpUser);
        console.log('   Recipients:', emailConfig.recipients);

        const transporter = nodemailer.createTransport({
          host: emailConfig.smtpHost,
          port: port,
          secure: isSecure,
          requireTLS: !isSecure, // Force STARTTLS for port 587
          auth: { 
            user: emailConfig.smtpUser, 
            pass: emailConfig.smtpPass 
          },
          tls: {
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true
          },
          connectionTimeout: 30000,
          greetingTimeout: 30000,
          socketTimeout: 30000,
          debug: true,
          logger: true
        });

        // Verify connection before sending
        console.log('   Verifying SMTP connection...');
        await transporter.verify();
        console.log('   ✓ SMTP connection verified');

        const recipientList = emailConfig.recipients.split(',').map(r => r.trim()).filter(Boolean);
        console.log('   Sending to', recipientList.length, 'recipient(s)...');

        const info = await transporter.sendMail({
          from: `"ICPS Key System" <${emailConfig.smtpUser}>`,
          to: recipientList.join(', '),
          subject: `ICPS Export — ${sourceName} — ${new Date().toLocaleDateString()}`,
          text: `Records: ${records.length}\nFilter: ${filter || 'all'}\nSearch: ${search || 'none'}\nMonth: ${sourceName}\n\nExported: ${new Date().toLocaleString()}`,
          attachments: [{ filename, path: filepath }]
        });

        console.log('   ✓ Email sent:', info.messageId);
        emailResult = { sent: true, recipients: recipientList.length, error: null, messageId: info.messageId };
      } catch (err) {
        console.error('   ✗ Email failed:', err.message);
        console.error('   Full error:', err);
        emailResult = { sent: false, recipients: 0, error: err.message, code: err.code };
      }
    } else {
      console.log('\n⚠ Email not configured — CSV only');
      if (!emailConfig) console.log('   Reason: emailConfig is null');
      else {
        if (!emailConfig.smtpHost) console.log('   Missing: smtpHost');
        if (!emailConfig.smtpUser) console.log('   Missing: smtpUser');
        if (!emailConfig.smtpPass) console.log('   Missing: smtpPass');
        if (!emailConfig.recipients) console.log('   Missing: recipients');
      }
    }

    res.json({ downloadUrl: `/exports/${filename}`, filename, count: records.length, email: emailResult, month: sourceName });
  } catch (err) {
    console.error('Export Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// Serve exports
app.use('/exports', express.static(path.join(__dirname, 'exports')));

// Health check
app.get('/api/health', asyncHandler(async (req, res) => {
  let connected = false;
  try {
    await db.ref('_health').set({ time: Date.now() });
    connected = true;
  } catch (e) {
    connected = false;
  }

  res.json({
    status: connected ? 'ok' : 'error',
    firebase: connected ? 'connected' : 'disconnected',
    project: serviceAccount.project_id,
    currentMonth: getCurrentMonthKey(),
    previousMonth: getPreviousMonthKey(),
    timestamp: new Date().toISOString()
  });
}));

// Simulate month endpoint — test archive without changing system date
app.post('/api/archive/simulate', asyncHandler(async (req, res) => {
  try {
    const { simulateMonth } = req.body;
    if (!simulateMonth || !/^\d{4}-\d{2}$/.test(simulateMonth)) {
      return res.status(400).json({ error: 'simulateMonth required (YYYY-MM format)' });
    }

    console.log(`\n🧪 SIMULATION: Testing with simulated current month = ${simulateMonth}`);

    // Read records
    const recordsSnap = await recordsRef.once('value');
    const records = recordsSnap.val() || {};

    // Find records that are from a different month than simulated
    let hasOldRecords = false;
    let oldMonth = null;

    Object.values(records).forEach(r => {
      if (r.dateIssued) {
        const recordMonth = getMonthFromTimestamp(r.dateIssued);
        if (recordMonth !== simulateMonth) {
          hasOldRecords = true;
          oldMonth = recordMonth;
        }
      }
    });

    let result = null;
    if (hasOldRecords) {
      console.log(`   Found old records from ${oldMonth}, archiving to ${oldMonth}...`);
      result = await performMonthlyArchive(oldMonth);
    }

    res.json({
      simulatedCurrentMonth: simulateMonth,
      totalRecords: Object.keys(records).length,
      hasOldRecords: hasOldRecords,
      oldMonth: oldMonth,
      archiveResult: result,
      message: result ? `Archived ${result.archived} records to ${result.archiveToMonth}` : 'No old records to archive'
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Debug endpoint — shows what the archive check sees
app.get('/api/archive/debug', asyncHandler(async (req, res) => {
  try {
    const currentMonth = getCurrentMonthKey();
    const previousMonth = getPreviousMonthKey();

    const recordsSnap = await recordsRef.once('value');
    const records = recordsSnap.val() || {};

    const recordList = [];
    let hasOldRecords = false;

    Object.entries(records).forEach(([key, value]) => {
      if (value && typeof value === 'object') {
        const issuedDate = value.dateIssued ? new Date(value.dateIssued) : null;
        const issuedMonth = issuedDate ? 
          `${issuedDate.getFullYear()}-${String(issuedDate.getMonth() + 1).padStart(2, '0')}` : 
          'no-dateIssued';

        const isOld = issuedMonth !== currentMonth;
        if (isOld) hasOldRecords = true;

        recordList.push({
          id: key,
          keyId: value.keyId,
          status: value.status,
          dateIssued: value.dateIssued,
          issuedMonth: issuedMonth,
          isOld: isOld,
          currentMonth: currentMonth
        });
      }
    });

    const archivesSnap = await archivesRef.once('value');
    const archives = archivesSnap.val() || {};

    res.json({
      serverTime: new Date().toISOString(),
      currentMonth: currentMonth,
      previousMonth: previousMonth,
      lastCheckedMonth: lastCheckedMonth,
      archiveInProgress: archiveInProgress,
      totalRecords: Object.keys(records).length,
      hasOldRecords: hasOldRecords,
      records: recordList,
      archiveMonths: Object.keys(archives).filter(k => !k.startsWith('_'))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════
async function start() {
  const connected = await testConnection();

  if (!connected) {
    console.log('\n⚠️ Starting server anyway for debugging...');
    console.log('Check http://localhost:' + PORT + '/api/health\n');
  }

  // Run startup archive check BEFORE setting lastCheckedMonth
  // This ensures old records get archived even if server starts in new month
  await startupArchiveCheck();

  // Initialize lastCheckedMonth on startup
  lastCheckedMonth = getCurrentMonthKey();
  console.log(`📅 Current month initialized: ${lastCheckedMonth}`);
  console.log('🔄 Auto-archive enabled: Records will archive on first request of new month');
  console.log('📦 Previous month data is preserved in /archives/YYYY-MM');

  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  🚀 Server running on http://localhost:${PORT}`);
    console.log(`  🔍 Health check: http://localhost:${PORT}/api/health`);
    console.log(`  📊 Archive status: http://localhost:${PORT}/api/archive/status`);
    console.log('═══════════════════════════════════════════════════════\n');
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});