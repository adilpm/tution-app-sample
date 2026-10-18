const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'tuition.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  grade INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  division TEXT NOT NULL,
  UNIQUE (class_id, division)
);

-- Monthly fee per class. The rate in force for a month is the latest one
-- whose effective_from (YYYY-MM) is <= that month, so raising fees never
-- rewrites what earlier months cost.
CREATE TABLE IF NOT EXISTS fee_rates (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  amount INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  UNIQUE (class_id, effective_from)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_name TEXT,
  phone TEXT,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  join_date TEXT NOT NULL,
  billing_start TEXT NOT NULL,   -- first billed month, YYYY-MM
  billing_end TEXT,              -- last billed month, NULL while active
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'passed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Which section a student was in from a given month onward. Needed so that
-- promotion (8th -> 9th) bills old months at the old class's rate.
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  from_month TEXT NOT NULL,
  UNIQUE (student_id, from_month)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Payments are never deleted, only voided, so the money trail stays intact.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('Cash', 'UPI')),
  paid_on TEXT NOT NULL,
  note TEXT,
  collected_by INTEGER REFERENCES users(id),
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS payments_student ON payments (student_id);
CREATE INDEX IF NOT EXISTS payments_paid_on ON payments (paid_on);

-- How each payment was split across fee months (oldest unpaid first).
CREATE TABLE IF NOT EXISTS payment_months (
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (payment_id, month)
);

CREATE TABLE IF NOT EXISTS attendance (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  status TEXT NOT NULL CHECK (status IN ('P', 'A')),
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, date)
);
CREATE INDEX IF NOT EXISTS attendance_section_date ON attendance (section_id, date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  center_name: 'My Tuition Center',
  center_address: 'Address line, City',
  center_phone: '+91 00000 00000',
  skip_months: '',  // comma-separated month numbers that are not billed, e.g. "04,05"
};

db.transaction(() => {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  if (db.prepare('SELECT COUNT(*) AS n FROM classes').get().n === 0) {
    const insertClass = db.prepare('INSERT INTO classes (grade, name) VALUES (?, ?)');
    const insertSection = db.prepare('INSERT INTO sections (class_id, division) VALUES (?, ?)');
    const insertRate = db.prepare('INSERT INTO fee_rates (class_id, amount, effective_from) VALUES (?, ?, ?)');
    for (const grade of [8, 9, 10]) {
      const classId = insertClass.run(grade, `${grade}th`).lastInsertRowid;
      for (const div of ['A', 'B', 'C', 'D']) insertSection.run(classId, div);
      insertRate.run(classId, 2500, '2000-01');
    }
  }
})();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function getSections() {
  return db.prepare(`
    SELECT s.id, s.division, c.id AS class_id, c.grade, c.name AS class_name,
           c.grade || s.division AS label
    FROM sections s JOIN classes c ON c.id = s.class_id
    ORDER BY c.grade, s.division
  `).all();
}

module.exports = { db, dataDir, getSetting, setSetting, getSettings, getSections };
