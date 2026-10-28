// Report exports (PDF and Excel). Pages describe a report as columns + rows,
// and these writers handle layout, paging and totals.

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { dateLabel, today } = require('./dates');
const { registerFonts, rupees, logoPath } = require('./pdf-kit');

const INK = '#1d1d1f';
const MUTED = '#6e6e73';
const LINE = '#d2d2d7';

/**
 * report = {
 *   title, subtitle, settings,
 *   summary: [[label, value]],                 up to 4 boxes; first is highlighted
 *   columns: [{ title, w, align }],            widths in points; last column takes the rest
 *   rows: [{ cells: [string], color }],
 *   total: { label, value } | null,
 *   empty: 'text when there are no rows',
 * }
 */
function writeTablePdf(out, report) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    bufferPages: true,
    info: { Title: `${report.title} ${report.subtitle || ''}`.trim(), Author: report.settings.center_name },
  });
  registerFonts(doc);
  doc.pipe(out);

  const left = 36;
  const width = doc.page.width - 72;
  const fixed = report.columns.slice(0, -1).reduce((n, c) => n + c.w, 0);
  const cols = report.columns.map((c, i) => (i === report.columns.length - 1 ? { ...c, w: width - fixed } : c));

  // Title block, with the logo on the right when there is one
  const logo = logoPath();
  if (logo) {
    try { doc.image(logo, left + width - 48, 32, { fit: [48, 48] }); } catch { /* skip unreadable logo */ }
  }
  doc.fillColor(INK).font('Bold').fontSize(16).text(report.settings.center_name || '', left, 36, { width: width - 60 });
  doc.font('Body').fontSize(9.5).fillColor(MUTED)
    .text(`${report.title}${report.subtitle ? ` · ${report.subtitle}` : ''}`, { width: width - 60 })
    .text(`Generated on ${dateLabel(today())}`, { width: width - 60 });

  let y = Math.max(doc.y, 84) + 12;
  if (report.summary && report.summary.length) {
    const gap = 8;
    const n = report.summary.length;
    const boxW = (width - gap * (n - 1)) / n;
    report.summary.forEach(([label, value], i) => {
      const x = left + i * (boxW + gap);
      doc.roundedRect(x, y, boxW, 48, 8).fill(i === 0 ? INK : '#f5f5f7');
      doc.fillColor(i === 0 ? '#a1a1a6' : MUTED).font('Bold').fontSize(7).text(label.toUpperCase(), x + 10, y + 9, { width: boxW - 20 });
      doc.fillColor(i === 0 ? '#ffffff' : INK).fontSize(13).text(value, x + 10, y + 23, { width: boxW - 20, lineBreak: false });
    });
    y += 64;
  }

  const drawHeader = () => {
    doc.roundedRect(left, y, width, 20, 5).fill('#f5f5f7');
    doc.fillColor(MUTED).font('Bold').fontSize(7);
    let x = left;
    for (const c of cols) {
      doc.text(c.title.toUpperCase(), x + 5, y + 7, { width: c.w - 10, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += 20;
  };
  drawHeader();

  if (!report.rows.length) {
    doc.fillColor(MUTED).font('Body').fontSize(10).text(report.empty || 'Nothing to show.', left, y + 14, { width, align: 'center' });
  }

  const ROW_H = 18;
  for (const row of report.rows) {
    if (y + ROW_H > doc.page.height - 56) {
      doc.addPage();
      y = 36;
      drawHeader();
    }
    doc.font('Condensed').fontSize(8.5).fillColor(row.color || INK);
    let x = left;
    cols.forEach((c, i) => {
      doc.text(String(row.cells[i] ?? ''), x + 5, y + 5, {
        width: c.w - 10, height: 10, align: c.align || 'left', lineBreak: false, ellipsis: true,
      });
      x += c.w;
    });
    y += ROW_H;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  if (report.total && report.rows.length) {
    if (y + 30 > doc.page.height - 56) {
      doc.addPage();
      y = 36;
    }
    y += 8;
    doc.roundedRect(left, y, width, 24, 6).fill(INK);
    doc.fillColor('#ffffff').font('Bold').fontSize(9.5)
      .text(report.total.label, left + 10, y + 7, { lineBreak: false })
      .text(report.total.value, left, y + 7, { width: width - 10, align: 'right', lineBreak: false });
  }

  // Page numbers; the footer sits inside the bottom margin.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Body').fontSize(8)
      .text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
  }
  doc.end();
}

/**
 * sheet = {
 *   name, title, subtitle, settings,
 *   columns: [{ header, width, type: 'text'|'date'|'money' }],
 *   rows: [{ values: [], strike }],
 *   summary: [[label, value]],
 * }
 */
async function writeTableXlsx(out, sheet) {
  const wb = new ExcelJS.Workbook();
  wb.creator = sheet.settings.center_name || '';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 4 }] });

  sheet.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  ws.getCell('A1').value = `${sheet.settings.center_name || ''} — ${sheet.title}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  if (sheet.subtitle) {
    ws.getCell('A2').value = sheet.subtitle;
    ws.getCell('A2').font = { color: { argb: 'FF6E6E73' } };
  }

  const headerRow = ws.getRow(4);
  headerRow.values = sheet.columns.map((c) => c.header);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D1D1F' } };
  });

  for (const r of sheet.rows) {
    const row = ws.addRow(r.values.map((v, i) => (sheet.columns[i].type === 'date' && v ? new Date(`${v}T00:00:00Z`) : v)));
    sheet.columns.forEach((c, i) => {
      if (c.type === 'date') row.getCell(i + 1).numFmt = 'dd-mmm-yyyy';
      if (c.type === 'money') row.getCell(i + 1).numFmt = '#,##0';
    });
    if (r.strike) row.font = { strike: true, color: { argb: 'FFD70015' } };
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: sheet.columns.length } };

  if (sheet.summary && sheet.summary.length) {
    ws.addRow([]);
    const valueCol = Math.max(1, sheet.columns.findIndex((c) => c.type === 'money') + 1);
    for (const [label, value] of sheet.summary) {
      const values = new Array(sheet.columns.length).fill(null);
      values[0] = label;
      values[valueCol - 1] = value;
      const row = ws.addRow(values);
      row.font = { bold: true };
      row.getCell(valueCol).numFmt = '#,##0';
    }
  }

  await wb.xlsx.write(out);
}

// ---------- Payments ----------

function writePaymentsPdf(out, { payments, totals, periodLabel, settings }) {
  writeTablePdf(out, {
    title: 'Payments report',
    subtitle: periodLabel,
    settings,
    summary: [
      ['Total collected', rupees(totals.all)],
      ['Cash', rupees(totals.cash)],
      ['UPI', rupees(totals.upi)],
      ['Receipts', String(totals.count)],
    ],
    columns: [
      { title: 'Date', w: 62 }, { title: 'Receipt', w: 70 }, { title: 'Student', w: 118 },
      { title: 'Class', w: 40 }, { title: 'For', w: 112 }, { title: 'Mode', w: 40 }, { title: 'Amount', align: 'right' },
    ],
    rows: payments.map((p) => ({
      cells: [dateLabel(p.paid_on), p.receipt_no, p.student_name, p.label || '', p.monthsText, p.method,
        p.voided ? `VOID ${rupees(p.amount)}` : rupees(p.amount)],
      color: p.voided ? '#d70015' : null,
    })),
    total: { label: `TOTAL (${totals.count} receipts, excluding void)`, value: rupees(totals.all) },
    empty: `No payments for ${periodLabel}.`,
  });
}

function writePaymentsXlsx(out, { payments, totals, periodLabel, settings }) {
  return writeTableXlsx(out, {
    name: 'Payments',
    title: 'Payments report',
    subtitle: `Period: ${periodLabel}`,
    settings,
    columns: [
      { header: 'Receipt No', width: 14 }, { header: 'Date', width: 13, type: 'date' },
      { header: 'Student', width: 26 }, { header: 'Class', width: 8 }, { header: 'For', width: 30 },
      { header: 'Method', width: 9 }, { header: 'Amount', width: 12, type: 'money' },
      { header: 'Collected by', width: 16 }, { header: 'Note', width: 24 },
      { header: 'Status', width: 9 }, { header: 'Void reason', width: 24 },
    ],
    rows: [...payments].reverse().map((p) => ({
      values: [p.receipt_no, p.paid_on, p.student_name, p.label, p.monthsText, p.method, p.amount,
        p.collected_by_name || '', p.note || '', p.voided ? 'VOID' : 'OK', p.void_reason || ''],
      strike: !!p.voided,
    })),
    summary: [
      ['Total collected (excluding void)', totals.all],
      ['Cash', totals.cash],
      ['UPI', totals.upi],
      ['Receipts', totals.count],
    ],
  });
}

module.exports = {
  writeTablePdf, writeTableXlsx, writePaymentsPdf, writePaymentsXlsx,
};
