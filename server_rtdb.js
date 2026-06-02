// server.js — Express + Firebase Realtime Database
// This version uses RTDB which is simpler and more reliable than Firestore

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
// The database URL is ALWAYS: https://<PROJECT-ID>-default-rtdb.firebaseio.com
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

// ═══════════════════════════════════════════════════════════════
// STEP 3: TEST CONNECTION
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

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ═══════════════════════════════════════════════════════════════
// SEED DEFAULT KEYS
// ═══════════════════════════════════════════════════════════════
async function seedKeys() {
  console.log('Checking/Seeding default keys...');

  try {
    const snap = await keysRef.once('value');
    if (snap.exists() && Object.keys(snap.val() || {}).length > 0) {
      console.log('✅ Keys already exist\n');
      return;
    }

    const keys = {};
    ['KEY-001', 'KEY-002', 'KEY-003', 'KEY-004', 'KEY-005'].forEach(keyId => {
      keys[keyId] = {
        keyId,
        label: `Master Key ${keyId.split('-')[1]}`,
        location: 'Main Office',
        createdAt: Date.now()
      };
    });

    await keysRef.set(keys);
    console.log('✅ Seeded 5 default keys\n');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  }
}

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

// GET /api/records — All records
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
      sigTo: null
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
    const { filter, search, emailConfig } = req.body;

    const snap = await recordsRef.once('value');
    let records = [];
    snap.forEach(child => records.push({ id: child.key, ...child.val() }));

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

    const filename = `icps_export_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv`;
    const exportDir = path.join(__dirname, 'exports');
    const filepath = path.join(exportDir, filename);

    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(filepath, csv);

    let emailResult = { sent: false, recipients: 0, error: null };

    if (emailConfig?.smtpHost && emailConfig?.smtpUser && emailConfig?.smtpPass && emailConfig?.recipients) {
      try {
        const transporter = nodemailer.createTransport({
          host: emailConfig.smtpHost,
          port: parseInt(emailConfig.smtpPort) || 587,
          secure: parseInt(emailConfig.smtpPort) === 465,
          auth: { user: emailConfig.smtpUser, pass: emailConfig.smtpPass }
        });

        const recipientList = emailConfig.recipients.split(',').map(r => r.trim()).filter(Boolean);
        await transporter.sendMail({
          from: `"ICPS Key System" <${emailConfig.smtpUser}>`,
          to: recipientList.join(', '),
          subject: `ICPS Export — ${new Date().toLocaleDateString()}`,
          text: `Records: ${records.length}\nFilter: ${filter || 'all'}\nSearch: ${search || 'none'}`,
          attachments: [{ filename, path: filepath }]
        });
        emailResult = { sent: true, recipients: recipientList.length, error: null };
      } catch (err) {
        emailResult = { sent: false, recipients: 0, error: err.message };
      }
    }

    res.json({ downloadUrl: `/exports/${filename}`, filename, count: records.length, email: emailResult });
  } catch (err) {
    console.error('Error:', err.message);
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
    timestamp: new Date().toISOString()
  });
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
    console.log('\n⚠️  Starting server anyway for debugging...');
    console.log('   Check http://localhost:' + PORT + '/api/health\n');
  } else {
    await seedKeys();
  }

  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  🚀 Server running on http://localhost:${PORT}`);
    console.log(`  🔍 Health check: http://localhost:${PORT}/api/health`);
    console.log('═══════════════════════════════════════════════════════\n');
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
