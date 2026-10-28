// WhatsApp message texts sent to parents.
const { getSetting } = require('../db');
const { money, waLink } = require('./format');
const { dateLabel } = require('./dates');
const { duesSummary } = require('./ledger');

function feeReminderLink(student, label, ledger) {
  if (!ledger || ledger.pending <= 0 || !student.phone) return null;
  const text = `Dear ${student.parent_name || 'Parent'}, this is a gentle reminder that the tuition fee of `
    + `${money(ledger.pending)} for ${student.name} (Class ${label}) is pending for `
    + `${duesSummary(ledger)}. Kindly pay at the earliest. Thank you. - ${getSetting('center_name')}`;
  return waLink(student.phone, text);
}

function absenceAlertLink(student, label, date) {
  if (!student.phone) return null;
  const text = `Dear ${student.parent_name || 'Parent'}, ${student.name} (Class ${label}) was absent for tuition `
    + `on ${dateLabel(date)}. Please let us know if there is any concern. - ${getSetting('center_name')}`;
  return waLink(student.phone, text);
}

module.exports = { feeReminderLink, absenceAlertLink };
