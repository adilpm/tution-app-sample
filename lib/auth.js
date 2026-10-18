const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

// Loads the logged-in user (if any) onto req.user / res.locals.user.
function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT id, username, name, role FROM users WHERE id = ? AND active = 1')
      .get(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  const target = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login${target}`);
}

function requireAdmin(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Not allowed', message: 'Only an admin can open this page.' });
}

// Simple in-memory brute-force guard for the login form.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function loginBlocked(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

function clearLoginFailures(ip) {
  failures.delete(ip);
}

// If there are no users yet, create an admin and print its password once.
function ensureAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const password = process.env.ADMIN_PASSWORD || randomPassword();
  db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('admin', 'Admin', ?, 'admin')")
    .run(hashPassword(password));
  console.log('\n========================================================');
  console.log(' First run: created admin login');
  console.log('   username: admin');
  console.log(`   password: ${password}`);
  console.log(' Change it after logging in (More > Change password).');
  console.log('========================================================\n');
}

module.exports = {
  hashPassword, checkPassword, randomPassword, loadUser, requireLogin, requireAdmin,
  loginBlocked, recordLoginFailure, clearLoginFailures, ensureAdmin,
};
