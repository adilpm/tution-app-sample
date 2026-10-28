// Date-range filters shared by the Payments and Expenses pages.
const {
  today, currentMonth, addMonths, addDays, lastDayOfMonth, isDate, isMonth, dateLabel,
} = require('./dates');

const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
];

// Turns ?range=... (or ?from=&to=, or the older ?month=) into an inclusive date range.
function resolveRange(query) {
  const t = today();
  const thisMonth = currentMonth();
  const lastMonth = addMonths(thisMonth, -1);
  const presets = {
    today: [t, t],
    yesterday: [addDays(t, -1), addDays(t, -1)],
    '7d': [addDays(t, -6), t],
    '30d': [addDays(t, -29), t],
    this_month: [`${thisMonth}-01`, t],
    last_month: [`${lastMonth}-01`, lastDayOfMonth(lastMonth)],
  };
  if (presets[query.range]) {
    const [from, to] = presets[query.range];
    return { range: query.range, from, to };
  }
  if (isDate(query.from) && isDate(query.to)) {
    const [from, to] = query.from <= query.to ? [query.from, query.to] : [query.to, query.from];
    return { range: 'custom', from, to: to > t ? t : to };
  }
  if (isMonth(query.month)) {
    return { range: 'custom', from: `${query.month}-01`, to: lastDayOfMonth(query.month) };
  }
  return { range: 'this_month', from: presets.this_month[0], to: t };
}

function rangeLabel({ from, to }) {
  return from === to ? dateLabel(from) : `${dateLabel(from)} – ${dateLabel(to)}`;
}

// Query string that reproduces a resolved range (for export links).
function rangeQuery(period) {
  return period.range === 'custom' ? `from=${period.from}&to=${period.to}` : `range=${period.range}`;
}

module.exports = {
  RANGES, resolveRange, rangeLabel, rangeQuery,
};
