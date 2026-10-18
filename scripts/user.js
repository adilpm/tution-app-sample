// Create a user or reset a password from the server shell:
//   node scripts/user.js <username> <password> [admin|teacher]
const { db } = require('../db');
const { hashPassword } = require('../lib/auth');

const [username, password, role = 'admin'] = process.argv.slice(2);
if (!username || !password || !['admin', 'teacher'].includes(role)) {
  console.log('Usage: node scripts/user.js <username> <password> [admin|teacher]');
  process.exit(1);
}
if (password.length < 8) {
  console.log('Password must be at least 8 characters.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(hashPassword(password), role, existing.id);
  db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(existing.id);
  console.log(`Updated ${username} (${role}). Existing sessions signed out.`);
} else {
  db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, username, hashPassword(password), role);
  console.log(`Created ${username} (${role}).`);
}
