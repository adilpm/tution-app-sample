const express = require('express');
const { db } = require('../db');
const {
  checkPassword, hashPassword, requireLogin, loginBlocked, recordLoginFailure, clearLoginFailures,
} = require('../lib/auth');
const { track } = require('../lib/analytics');

const router = express.Router();

// Only allow redirects back into this app after login.
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Login', next: safeNext(req.query.next), error: null, username: '' });
});

router.post('/login', (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const fail = (error) => res.status(401).render('login', { title: 'Login', next: nextUrl, error, username });

  if (loginBlocked(req.ip)) return fail('Too many failed attempts. Try again in 15 minutes.');

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !checkPassword(password, user.password_hash)) {
    recordLoginFailure(req.ip);
    return fail('Wrong username or password.');
  }
  clearLoginFailures(req.ip);
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    track(user, 'logged_in');
    res.redirect(nextUrl);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tc.sid');
    res.redirect('/login');
  });
});

router.get('/account/password', requireLogin, (req, res) => {
  res.render('password', { title: 'Change password', error: null });
});

router.post('/account/password', requireLogin, (req, res) => {
  const { current, password, confirm } = req.body;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  let error = null;
  if (!checkPassword(String(current || ''), row.password_hash)) error = 'Current password is wrong.';
  else if (String(password || '').length < 8) error = 'New password must be at least 8 characters.';
  else if (password !== confirm) error = 'New passwords do not match.';
  if (error) return res.status(400).render('password', { title: 'Change password', error });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  // Sign out other devices still using the old password.
  db.prepare("DELETE FROM sessions WHERE sid != ? AND json_extract(sess, '$.userId') = ?").run(req.sessionID, req.user.id);
  req.flash('success', 'Password changed.');
  res.redirect(req.user.role === 'admin' ? '/more' : '/attendance');
});

module.exports = router;
