const crypto = require('crypto');

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash-password -- your-password');
  process.exit(1);
}

const iterations = 310000;
const salt = crypto.randomBytes(16).toString('base64url');
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');

console.log(`pbkdf2$${iterations}$${salt}$${hash}`);
