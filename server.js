const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Parser } = require('json2csv');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Initialize SQLite database
const DB_PATH = path.join(DATA_DIR, 'icps_keys.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyId TEXT NOT NULL,
    issuedBy TEXT NOT NULL,
    department TEXT NOT NULL,
    recipient TEXT NOT NULL,
    purpose TEXT NOT NULL,
    dateIssued INTEGER NOT NULL,
    dateReturned INTEGER,
    returnedBy TEXT,
    returnedTo TEXT,
    sigBy TEXT,
    sigTo TEXT,
    issueSigBy TEXT,
    issueSigRec TEXT,
    status TEXT NOT NULL DEFAULT 'Issued',
    createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
  )`);
});

// ── API Routes ────────────────────────────────────────────────

// Get all records
app.get('/api/records', (req, res) => {
  db.all('SELECT * FROM records ORDER BY dateIssued DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Create a new record (issue key)
app.post('/api/records', (req, res) => {
  const { keyId, issuedBy, department, recipient, purpose, issueSigBy, issueSigRec } = req.body;

  if (!keyId || !issuedBy || !department || !recipient || !purpose) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const dateIssued = Date.now();

  db.run(
    `INSERT INTO records (keyId, issuedBy, department, recipient, purpose, dateIssued, issueSigBy, issueSigRec, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [keyId, issuedBy, department, recipient, purpose, dateIssued, issueSigBy || null, issueSigRec || null, 'Issued'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Key issued successfully' });
    }
  );
});

// Return a key
app.put('/api/records/:id/return', (req, res) => {
  const { returnedBy, returnedTo, sigBy, sigTo } = req.body;
  const id = req.params.id;

  if (!returnedBy || !returnedTo) {
    return res.status(400).json({ error: 'Returned by and Returned to are required' });
  }

  db.run(
    `UPDATE records SET 
      status = 'Available', 
      dateReturned = ?, 
      returnedBy = ?, 
      returnedTo = ?, 
      sigBy = ?, 
      sigTo = ? 
     WHERE id = ? AND status = 'Issued'`,
    [Date.now(), returnedBy, returnedTo, sigBy || null, sigTo || null, id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Record not found or not issued' });
      res.json({ message: 'Key returned successfully' });
    }
  );
});

// Revoke a key
app.put('/api/records/:id/revoke', (req, res) => {
  const id = req.params.id;

  db.run(
    `UPDATE records SET status = 'Revoked' WHERE id = ? AND status != 'Revoked'`,
    [id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Record not found or already revoked' });
      res.json({ message: 'Key revoked successfully' });
    }
  );
});

// Get available keys
app.get('/api/keys/available', (req, res) => {
  const ALL_KEYS = ['KEY-101','KEY-102','KEY-103','KEY-104','KEY-105'];

  db.all("SELECT keyId FROM records WHERE status = 'Issued'", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const issued = new Set(rows.map(r => r.keyId));
    const available = ALL_KEYS.filter(k => !issued.has(k));
    res.json(available);
  });
});

// Export CSV + Email
app.post('/api/export', async (req, res) => {
  const { filter, search, emailConfig } = req.body;

  let query = 'SELECT * FROM records';
  const params = [];

  if (filter && filter !== 'all') {
    query += ' WHERE status = ?';
    params.push(filter);
  }

  query += ' ORDER BY dateIssued DESC';

  db.all(query, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Apply search filter in memory (SQLite doesn't handle complex text search well without FTS)
    let data = rows;
    if (search) {
      const s = search.toLowerCase();
      data = rows.filter(r => 
        [r.keyId, r.issuedBy, r.recipient, r.purpose, r.department, r.returnedBy, r.returnedTo]
          .some(v => v && v.toLowerCase().includes(s))
      );
    }

    // Generate CSV
    const fields = [
      { label: 'Key ID', value: 'keyId' },
      { label: 'Department', value: 'department' },
      { label: 'Issued By', value: 'issuedBy' },
      { label: 'Recipient', value: 'recipient' },
      { label: 'Purpose', value: 'purpose' },
      { label: 'Date Issued', value: r => r.dateIssued ? new Date(r.dateIssued).toLocaleString('en-GB') : '—' },
      { label: 'Date Returned', value: r => r.dateReturned ? new Date(r.dateReturned).toLocaleString('en-GB') : '—' },
      { label: 'Returned By', value: 'returnedBy' },
      { label: 'Returned To', value: 'returnedTo' },
      { label: 'Has Issue Sig By', value: r => r.issueSigBy ? 'Yes' : 'No' },
      { label: 'Has Issue Sig Rec', value: r => r.issueSigRec ? 'Yes' : 'No' },
      { label: 'Has Return Sig By', value: r => r.sigBy ? 'Yes' : 'No' },
      { label: 'Has Return Sig To', value: r => r.sigTo ? 'Yes' : 'No' },
      { label: 'Status', value: 'status' }
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    // Save CSV to file
    const filename = `icps_keys_${new Date().toISOString().slice(0,10)}.csv`;
    const filepath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filepath, csv);

    // Send email if configured
    let emailResult = { sent: false, error: null };

    if (emailConfig && emailConfig.smtpHost && emailConfig.smtpUser && emailConfig.smtpPass && emailConfig.recipients) {
      try {
        const transporter = nodemailer.createTransport({
          host: emailConfig.smtpHost,
          port: emailConfig.smtpPort || 587,
          secure: emailConfig.smtpPort == 465,
          auth: {
            user: emailConfig.smtpUser,
            pass: emailConfig.smtpPass
          }
        });

        const recipients = emailConfig.recipients.split(',').map(e => e.trim()).filter(e => e);

        await transporter.sendMail({
          from: `"ICPS Key System" <${emailConfig.smtpUser}>`,
          to: recipients,
          subject: `ICPS Key Export — ${new Date().toLocaleDateString('en-GB')}`,
          text: `Attached is the ICPS key export.\n\nTotal records: ${data.length}\nFilter: ${filter || 'all'}\nExported at: ${new Date().toLocaleString('en-GB')}`,
          attachments: [{ filename, content: csv }]
        });

        emailResult = { sent: true, recipients: recipients.length };
      } catch (emailErr) {
        emailResult = { sent: false, error: emailErr.message };
      }
    }

    res.json({
      filename,
      recordCount: data.length,
      email: emailResult,
      downloadUrl: `/api/download/${filename}`
    });
  });
});

// Download exported file
app.get('/api/download/:filename', (req, res) => {
  const filepath = path.join(DATA_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.download(filepath);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`ICPS Key System server running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

module.exports = app;
