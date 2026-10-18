// All dates are plain strings: days as YYYY-MM-DD, months as YYYY-MM.
// "Today" uses the process timezone, which server.js pins to Asia/Kolkata.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currentMonth() {
  return today().slice(0, 7);
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function lastDayOfMonth(month) {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

// Inclusive list of months from `from` to `to`.
function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

function monthLabel(month) {
  if (!month) return '';
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

function dateLabel(date) {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${Number(d)} ${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

// Joining on or before the 15th bills that month; later joins start next month.
function billingStartFor(joinDate) {
  const month = joinDate.slice(0, 7);
  return Number(joinDate.slice(8, 10)) <= 15 ? month : addMonths(month, 1);
}

// Compact "Jun–Aug 2026" style summary of a sorted list of months.
function monthsSummary(months) {
  if (!months.length) return '';
  const runs = [];
  let start = months[0];
  let prev = months[0];
  for (const m of months.slice(1)) {
    if (m !== addMonths(prev, 1)) {
      runs.push([start, prev]);
      start = m;
    }
    prev = m;
  }
  runs.push([start, prev]);
  return runs.map(([a, b]) => {
    if (a === b) return monthLabel(a);
    const [ay] = a.split('-');
    const [by] = b.split('-');
    const aLabel = ay === by ? MONTH_NAMES[Number(a.slice(5)) - 1] : monthLabel(a);
    return `${aLabel} – ${monthLabel(b)}`;
  }).join(', ');
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

module.exports = {
  MONTH_NAMES, today, currentMonth, addMonths, addDays, lastDayOfMonth, monthRange, monthLabel, dateLabel,
  billingStartFor, monthsSummary, isDate, isMonth,
};
