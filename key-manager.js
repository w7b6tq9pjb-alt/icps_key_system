// key-manager.js — Manage keys in Firebase Realtime Database
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'firebase-service-account.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ firebase-service-account.json not found');
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
const databaseURL = `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: databaseURL
});

const db = admin.database();
const keysRef = db.ref('keys');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function showMenu() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  KEY MANAGEMENT CONSOLE');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('1. List all keys');
  console.log('2. Add a new key');
  console.log('3. Add multiple keys (bulk)');
  console.log('4. Edit a key');
  console.log('5. Delete a key');
  console.log('6. Import from JSON file');
  console.log('7. Export to JSON file');
  console.log('8. Reset to default 5 keys');
  console.log('0. Exit\n');

  const choice = await ask('Select option: ');

  switch(choice.trim()) {
    case '1': await listKeys(); break;
    case '2': await addKey(); break;
    case '3': await addBulk(); break;
    case '4': await editKey(); break;
    case '5': await deleteKey(); break;
    case '6': await importJson(); break;
    case '7': await exportJson(); break;
    case '8': await resetDefaults(); break;
    case '0': console.log('Goodbye!'); rl.close(); process.exit(0);
    default: console.log('Invalid option');
  }

  await showMenu();
}

async function listKeys() {
  const snap = await keysRef.once('value');
  const keys = snap.val() || {};

  console.log('\n─── Current Keys ───');
  if (Object.keys(keys).length === 0) {
    console.log('No keys found');
    return;
  }

  Object.entries(keys).forEach(([id, data]) => {
    console.log(`  ${id}: ${data.label || 'Unnamed'} (${data.location || 'No location'})`);
  });
  console.log(`\nTotal: ${Object.keys(keys).length} keys\n`);
}

async function addKey() {
  const keyId = await ask('Key ID (e.g., KEY-006): ');
  if (!keyId.trim()) {
    console.log('Cancelled');
    return;
  }

  const existing = await keysRef.child(keyId).once('value');
  if (existing.exists()) {
    console.log(`❌ Key ${keyId} already exists!`);
    return;
  }

  const label = await ask('Label (description): ') || `Key ${keyId}`;
  const location = await ask('Location: ') || 'Main Office';

  await keysRef.child(keyId).set({
    keyId,
    label: label.trim(),
    location: location.trim(),
    createdAt: Date.now()
  });

  console.log(`✅ Added ${keyId}\n`);
}

async function addBulk() {
  console.log('\nEnter key IDs (one per line, empty line to finish):');
  const ids = [];
  while (true) {
    const id = await ask('> ');
    if (!id.trim()) break;
    ids.push(id.trim());
  }

  if (ids.length === 0) {
    console.log('Cancelled');
    return;
  }

  const labelPrefix = await ask('Label prefix (e.g., "Storage Key"): ') || 'Key';
  const location = await ask('Location: ') || 'Main Office';

  const updates = {};
  ids.forEach((id, i) => {
    updates[id] = {
      keyId: id,
      label: `${labelPrefix} ${i + 1}`,
      location,
      createdAt: Date.now()
    };
  });

  await keysRef.update(updates);
  console.log(`✅ Added ${ids.length} keys\n`);
}

async function editKey() {
  const keyId = await ask('Key ID to edit: ');
  const snap = await keysRef.child(keyId).once('value');

  if (!snap.exists()) {
    console.log(`❌ Key ${keyId} not found`);
    return;
  }

  const data = snap.val();
  console.log(`Current: ${JSON.stringify(data, null, 2)}`);

  const label = await ask(`New label [${data.label}]: `);
  const location = await ask(`New location [${data.location}]: `);

  const updates = {};
  if (label.trim()) updates.label = label.trim();
  if (location.trim()) updates.location = location.trim();

  if (Object.keys(updates).length > 0) {
    await keysRef.child(keyId).update(updates);
    console.log(`✅ Updated ${keyId}\n`);
  } else {
    console.log('No changes made\n');
  }
}

async function deleteKey() {
  const keyId = await ask('Key ID to delete: ');
  const snap = await keysRef.child(keyId).once('value');

  if (!snap.exists()) {
    console.log(`❌ Key ${keyId} not found`);
    return;
  }

  const confirm = await ask(`Are you sure you want to delete ${keyId}? (yes/no): `);
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled');
    return;
  }

  await keysRef.child(keyId).remove();
  console.log(`✅ Deleted ${keyId}\n`);
}

async function importJson() {
  const filename = await ask('JSON file path: ');
  if (!fs.existsSync(filename)) {
    console.log(`❌ File not found: ${filename}`);
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    await keysRef.set(data);
    console.log(`✅ Imported ${Object.keys(data).length} keys\n`);
  } catch (err) {
    console.log(`❌ Import failed: ${err.message}\n`);
  }
}

async function exportJson() {
  const filename = await ask('Output file path [keys-export.json]: ') || 'keys-export.json';
  const snap = await keysRef.once('value');
  fs.writeFileSync(filename, JSON.stringify(snap.val() || {}, null, 2));
  console.log(`✅ Exported to ${filename}\n`);
}

async function resetDefaults() {
  const confirm = await ask('This will replace ALL keys with the default 5. Continue? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled');
    return;
  }

  const defaults = {};
  ['KEY-001', 'KEY-002', 'KEY-003', 'KEY-004', 'KEY-005'].forEach(keyId => {
    defaults[keyId] = {
      keyId,
      label: `Master Key ${keyId.split('-')[1]}`,
      location: 'Main Office',
      createdAt: Date.now()
    };
  });

  await keysRef.set(defaults);
  console.log('✅ Reset to 5 default keys\n');
}

showMenu().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
