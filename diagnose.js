// diagnose.js — Run this to check your Firebase setup
const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════');
console.log('  ICPS Firebase Diagnostic Tool');
console.log('═══════════════════════════════════════════════════════');
console.log('');

// Check 1: Service account file
const saPath = path.join(__dirname, 'firebase-service-account.json');
console.log('1. Service Account File');
console.log('   Path:', saPath);
console.log('   Exists:', fs.existsSync(saPath) ? '✅ YES' : '❌ NO');

if (fs.existsSync(saPath)) {
  try {
    const sa = require(saPath);
    console.log('   Project ID:', sa.project_id || '❌ MISSING');
    console.log('   Client Email:', sa.client_email || '❌ MISSING');
    console.log('   Private Key:', sa.private_key ? '✅ Present' : '❌ MISSING');
    console.log('   Key ID:', sa.private_key_id || '❌ MISSING');
  } catch (err) {
    console.log('   ❌ Invalid JSON:', err.message);
  }
}
console.log('');

// Check 2: Node modules
console.log('2. Dependencies');
const deps = ['express', 'firebase-admin', 'nodemailer', 'json2csv'];
deps.forEach(dep => {
  try {
    require.resolve(dep);
    console.log(`   ${dep}: ✅ Installed`);
  } catch {
    console.log(`   ${dep}: ❌ NOT INSTALLED (run: npm install ${dep})`);
  }
});
console.log('');

// Check 3: Try Firebase connection
console.log('3. Firebase Connection Test');
try {
  const admin = require('firebase-admin');
  const sa = require(saPath);

  admin.initializeApp({
    credential: admin.credential.cert(sa)
  });

  const db = admin.firestore();
  db.collection('_test').doc('ping').get()
    .then(() => {
      console.log('   ✅ Firestore connection: SUCCESS');
      process.exit(0);
    })
    .catch(err => {
      console.log('   ❌ Firestore connection FAILED');
      console.log('   Error:', err.message);
      console.log('   Code:', err.code);

      if (err.code === 7 || err.message.includes('PERMISSION_DENIED')) {
        console.log('');
        console.log('   🔧 This is a PERMISSION DENIED error.');
        console.log('   The Admin SDK should bypass rules, but sometimes:');
        console.log('   • The Firestore database hasn\'t been created yet');
        console.log('   • The service account lacks IAM permissions');
        console.log('');
        console.log('   Go to: https://console.firebase.google.com/project/' + sa.project_id + '/firestore');
      }
      process.exit(1);
    });
} catch (err) {
  console.log('   ❌ Failed to initialize:', err.message);
  process.exit(1);
}
