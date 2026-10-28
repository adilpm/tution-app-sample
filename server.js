// Local settings from ./.env, if there is one. Variables already set (e.g. by
// the systemd service on the server) win; empty lines in .env are ignored.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}
for (const [k, v] of Object.entries(process.env)) if (v === '') delete process.env[k];

// Fee amounts and "today" depend on local dates, so pin the timezone before
// anything creates a Date. Override with TZ=... if the center is elsewhere.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const { db, getSetting, setSetting, getSettings } = require('./db');
const SqliteStore = require('./lib/session-store');
const { loadUser, requireLogin, ensureAdmin } = require('./lib/auth');
const format = require('./lib/format');
const dates = require('./lib/dates');
const { icon } = require('./lib/icons');
const { logoPath } = require('./lib/pdf-kit');
const analytics = require('./lib/analytics');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
// PostHog's browser bundle, served from here rather than a third-party CDN.
if (analytics.browserConfig) {
  app.use('/vendor/posthog', express.static(path.join(path.dirname(require.resolve('posthog-js/package.json')), 'dist'), { maxAge: '7d' }));
}
// File uploads (logo, student import) arrive base64-encoded in a form field,
// so only those two endpoints accept large bodies.
const BIG_FORMS = new Set(['/settings/logo', '/import/preview']);
const bigForm = express.urlencoded({ extended: false, limit: '6mb' });
const smallForm = express.urlencoded({ extended: false, limit: '100kb' });
app.use((req, res, next) => (BIG_FORMS.has(req.path) ? bigForm : smallForm)(req, res, next));

let secret = process.env.SESSION_SECRET || getSetting('session_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('session_secret', secret);
}

app.use(session({
  store: new SqliteStore(db),
  name: 'tc.sid',
  secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// CSRF guard: SameSite=Lax already blocks cross-site form posts carrying the
// cookie; additionally reject POSTs whose Origin doesn't match this host.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { /* "null" or malformed origin */ }
  if (host !== req.get('host')) return res.status(403).send('Cross-site request blocked.');
  next();
});

app.use(loadUser);

app.use((req, res, next) => {
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  req.flash = (type, message) => { req.session.flash = { type, message }; };

  res.locals.settings = getSettings();
  res.locals.hasLogo = !!logoPath();
  res.locals.path = req.path;
  res.locals.fmt = format;
  res.locals.dates = dates;
  res.locals.icon = icon;
  res.locals.user = res.locals.user || null;
  res.locals.posthog = analytics.browserConfig && req.user
    ? { ...analytics.browserConfig, distinctId: analytics.distinctId(req.user) }
    : null;
  next();
});

app.use(require('./routes/auth'));
app.use(requireLogin);
app.use(require('./routes/dashboard'));
app.use(require('./routes/students'));
app.use(require('./routes/payments'));
app.use(require('./routes/attendance'));
app.use(require('./routes/fees'));
app.use(require('./routes/expenses'));
app.use(require('./routes/import'));
app.use(require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

ensureAdmin();

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`Tuition manager running on http://${HOST}:${PORT}`));
}

module.exports = app;
