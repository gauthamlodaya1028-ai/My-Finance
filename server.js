import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// ---- month helpers ---------------------------------------------------------

const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Build the forward EMI schedule for one debt -> [{month, amount}]
function scheduleFor(debt) {
  if (debt.status !== 'paying' || !debt.emi || !debt.remaining_months) return [];
  const start = debt.start_month || thisMonth();
  const out = [];
  let bal = debt.remaining;
  for (let i = 0; i < debt.remaining_months && bal > 0; i++) {
    const amt = Math.min(debt.emi, bal);
    out.push({ month: addMonths(start, i), amount: amt });
    bal -= amt;
  }
  return out;
}

function debtView(debt) {
  return { ...debt, schedule: scheduleFor(debt) };
}

// All monthly commitments due in a given month (EMIs + debt interest + recurring).
function commitmentsForMonth(ym, debts, recurrings) {
  const items = [];
  const now = thisMonth();
  for (const d of debts) {
    if (d.status === 'closed') continue;
    const se = (d.schedule || scheduleFor(d)).find((s) => s.month === ym);
    if (se) items.push({ label: d.source, amount: se.amount, currency: d.currency, type: 'emi' });
    if (d.monthly_interest > 0 && ym >= now)
      items.push({ label: d.source + ' (interest)', amount: d.monthly_interest, currency: d.currency, type: 'interest' });
  }
  for (const r of recurrings) {
    if (r.start_month <= ym && (!r.end_month || ym <= r.end_month))
      items.push({ label: r.label, amount: r.amount, currency: r.currency, type: 'recurring' });
  }
  return items;
}

// ---- entries (income / expense) -------------------------------------------

// Amount actually credited/debited, in the RECEIVED currency.
function recvAmount(e) {
  const from = e.currency, to = e.recv_currency || e.currency;
  if (from === to) return e.amount;
  if (from === 'INR' && to === 'AED') return e.rate ? e.amount / e.rate : 0;
  if (from === 'AED' && to === 'INR') return e.amount * e.rate;
  return e.amount;
}
// INR-equivalent of an entry (for reporting/chart).
function inrValue(e) {
  if (e.kind === 'transfer') return e.amount * e.rate;       // AED -> INR received
  const to = e.recv_currency || e.currency;
  if (to === 'INR') return recvAmount(e);
  // landed in AED -> INR-equivalent: the INR figure behind it
  if (e.currency === 'INR') return e.amount;                 // decided in INR
  return e.rate ? e.amount * e.rate : 0;                     // AED with a known rate
}
const entryView = (e) => ({ ...e, recv_amount: recvAmount(e), inr_value: inrValue(e) });

app.get('/api/entries', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM entries ORDER BY date DESC, id DESC').all().map(entryView));
}));

app.post('/api/entries', wrap((req, res) => {
  const { kind, currency, recv_currency, category, narrative, amount, rate, date } = req.body;
  if (!['income', 'expense', 'transfer'].includes(kind)) throw new Error('Invalid kind');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  let cur = currency || 'INR';
  let recv = recv_currency || cur;
  let rt = Number(rate) || 0;
  if (kind === 'transfer') {                       // AED -> INR, rate required
    cur = 'AED'; recv = 'INR';
    if (!(rt > 0)) throw new Error('Transfer needs an exchange rate (₹/AED)');
  } else if (cur !== recv && !(rt > 0)) {
    throw new Error('A rate (₹/AED) is required when "Amount in" and "Received in" differ');
  }
  const info = db.prepare(
    'INSERT INTO entries (kind, currency, recv_currency, category, narrative, amount, rate, date) VALUES (?,?,?,?,?,?,?,?)'
  ).run(kind, cur, recv, category || 'General', narrative || '', amount, rt, date);
  res.json(entryView(db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid)));
}));

app.delete('/api/entries/:id', wrap((req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---- debts -----------------------------------------------------------------

app.get('/api/debts', wrap((req, res) => {
  const order = "CASE status WHEN 'paying' THEN 0 WHEN 'not_decided' THEN 1 WHEN 'not_possible' THEN 2 ELSE 3 END";
  const rows = db.prepare(`SELECT * FROM debts ORDER BY ${order}, remaining DESC`).all();
  res.json(rows.map(debtView));
}));

const DEBT_FIELDS = ['source', 'direction', 'remaining', 'emi', 'remaining_months',
  'currency', 'monthly_interest', 'status', 'start_month', 'notes'];

function insertDebt(b) {
  if (!b.source) throw new Error('Source required');
  if (b.remaining == null) throw new Error('Remaining required');
  const row = {
    source: b.source,
    direction: b.direction || 'payable',
    remaining: Number(b.remaining) || 0,
    emi: Number(b.emi) || 0,
    remaining_months: Number(b.remaining_months) || 0,
    currency: b.currency || 'INR',
    monthly_interest: Number(b.monthly_interest) || 0,
    status: b.status || 'paying',
    start_month: b.start_month || thisMonth(),
    notes: b.notes || '',
  };
  const info = db.prepare(`INSERT INTO debts
    (source,direction,remaining,emi,remaining_months,currency,monthly_interest,status,start_month,notes)
    VALUES (@source,@direction,@remaining,@emi,@remaining_months,@currency,@monthly_interest,@status,@start_month,@notes)`)
    .run(row);
  return info.lastInsertRowid;
}

app.post('/api/debts', wrap((req, res) => {
  const id = insertDebt(req.body);
  res.json(debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(id)));
}));

app.patch('/api/debts/:id', wrap((req, res) => {
  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(req.params.id);
  if (!debt) throw new Error('Not found');
  const updates = {};
  for (const f of DEBT_FIELDS) if (f in req.body) updates[f] = req.body[f];
  if (Object.keys(updates).length) {
    const set = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE debts SET ${set} WHERE id = @id`).run({ ...updates, id: debt.id });
  }
  res.json(debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(debt.id)));
}));

app.delete('/api/debts/:id', wrap((req, res) => {
  db.prepare('DELETE FROM debts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---- CSV import (matches the "Budgeting - Debt" layout) --------------------
// Columns: Source, Remaining, Equated Monthly Installment, Remaining Month, <month cols...>
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const num = (s) => Number(String(s ?? '').replace(/[^0-9.\-]/g, '')) || 0;

app.post('/api/debts/import', wrap((req, res) => {
  const text = req.body.csv;
  if (!text) throw new Error('No CSV provided');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const replace = !!req.body.replace;
  const startMonth = req.body.start_month || thisMonth();   // schedule starts here
  if (replace) db.prepare('DELETE FROM debts').run();

  let imported = 0;
  const tx = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const [source, remaining, emiRaw, monthsRaw] = rows[i];
      if (!source || !source.trim()) continue;
      const emiTxt = (emiRaw || '').trim();
      const monthsTxt = (monthsRaw || '').trim();
      // Detect informal / undecided debts by their text markers.
      const lower = (emiTxt + ' ' + monthsTxt).toLowerCase();
      let status = 'paying', emi = 0, months = 0, monthly_interest = 0, notes = '';
      if (lower.includes('not possible')) {
        status = 'not_possible';
        const mi = emiTxt.match(/(\d[\d,]*)\s*k/i);
        if (mi) monthly_interest = num(mi[1]) * 1000;
        notes = emiTxt;
      } else if (lower.includes('not paid') || lower.includes('not decided') || lower.includes('asking')) {
        status = 'not_decided';
        notes = [emiTxt, monthsTxt].filter(Boolean).join(' · ');
      } else {
        emi = num(emiRaw);
        months = num(monthsRaw);
      }
      // Currency heuristic: "AED" in the name => AED.
      const currency = /aed/i.test(source) ? 'AED' : 'INR';
      insertDebt({
        source: source.trim(), remaining: num(remaining), emi,
        remaining_months: months, currency, monthly_interest, status, notes,
        start_month: startMonth,
      });
      imported++;
    }
  });
  tx();
  res.json({ imported });
}));

// ---- recurring expenses ----------------------------------------------------

app.get('/api/recurring', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM recurring ORDER BY start_month, label').all());
}));

app.post('/api/recurring', wrap((req, res) => {
  const { label, amount, currency, category, start_month, end_month } = req.body;
  if (!label) throw new Error('Label required');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!start_month) throw new Error('Start month required');
  const info = db.prepare(
    'INSERT INTO recurring (label, amount, currency, category, start_month, end_month) VALUES (?,?,?,?,?,?)'
  ).run(label, amount, currency || 'INR', category || 'General', start_month, end_month || null);
  res.json(db.prepare('SELECT * FROM recurring WHERE id = ?').get(info.lastInsertRowid));
}));

app.delete('/api/recurring/:id', wrap((req, res) => {
  db.prepare('DELETE FROM recurring WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// commitments (EMI + interest + recurring) for a specific month
app.get('/api/commitments/:month', wrap((req, res) => {
  const debts = db.prepare('SELECT * FROM debts').all().map(debtView);
  const recur = db.prepare('SELECT * FROM recurring').all();
  res.json(commitmentsForMonth(req.params.month, debts, recur));
}));

// ---- payments --------------------------------------------------------------

app.get('/api/debts/:id/payments', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM payments WHERE debt_id = ? ORDER BY date DESC, id DESC').all(req.params.id));
}));

app.post('/api/debts/:id/payments', wrap((req, res) => {
  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(req.params.id);
  if (!debt) throw new Error('Debt not found');
  const { amount, date, note } = req.body;
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  db.prepare('INSERT INTO payments (debt_id, amount, date, note) VALUES (?,?,?,?)')
    .run(debt.id, amount, date, note || '');
  // reduce outstanding & a month off the plan
  const newRemaining = Math.max(0, debt.remaining - amount);
  const newMonths = Math.max(0, (debt.remaining_months || 0) - 1);
  const newStatus = newRemaining <= 0.5 ? 'closed' : debt.status;
  db.prepare('UPDATE debts SET remaining=?, remaining_months=?, status=? WHERE id=?')
    .run(newRemaining, newMonths, newStatus, debt.id);
  res.json(debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(debt.id)));
}));

app.delete('/api/payments/:id', wrap((req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---- dashboard summary -----------------------------------------------------

app.get('/api/summary', wrap((req, res) => {
  // --- two running balances: AED on hand + INR on hand ---
  const all = db.prepare('SELECT * FROM entries').all();
  const bal = { INR: 0, AED: 0 };
  let incomeINR = 0, expenseINR = 0;           // INR-equivalent totals for the chart/cards
  for (const e of all) {
    const to = e.recv_currency || e.currency;
    if (e.kind === 'income') {
      bal[to] = (bal[to] || 0) + recvAmount(e);
      incomeINR += inrValue(e);
    } else if (e.kind === 'expense') {
      bal[to] = (bal[to] || 0) - recvAmount(e);
      expenseINR += inrValue(e);
    } else if (e.kind === 'transfer') {          // AED -> INR
      bal.AED -= e.amount;
      bal.INR += e.amount * e.rate;
    }
  }
  const income = incomeINR, expense = expenseINR;
  const debts = db.prepare('SELECT * FROM debts').all().map(debtView);
  const active = debts.filter((d) => d.status !== 'closed');

  // outstanding & monthly interest grouped by currency
  const byCurrency = {};
  for (const d of active) {
    const c = (byCurrency[d.currency] = byCurrency[d.currency] || { remaining: 0, emi: 0, interest: 0 });
    c.remaining += d.remaining;
    c.interest += d.monthly_interest;
    if (d.status === 'paying') c.emi += d.emi;
  }

  // aggregate ALL commitments (EMI + interest + recurring) per month per currency,
  // over a 12-month horizon starting this month.
  const recur = db.prepare('SELECT * FROM recurring').all();
  const sched = {}; // month -> {INR, AED}
  let ym = thisMonth();
  for (let i = 0; i < 12; i++) {
    const items = commitmentsForMonth(ym, debts, recur);
    if (items.length) {
      const m = (sched[ym] = sched[ym] || {});
      for (const it of items) m[it.currency] = (m[it.currency] || 0) + it.amount;
    }
    ym = addMonths(ym, 1);
  }

  const statusCounts = active.reduce((a, d) => { a[d.status] = (a[d.status] || 0) + 1; return a; }, {});

  // monthly income vs expense in INR-equivalent
  const monthMap = {};
  for (const e of all) {
    if (e.kind === 'transfer') continue;
    const m = e.date.slice(0, 7);
    monthMap[m] = monthMap[m] || { month: m, income: 0, expense: 0 };
    monthMap[m][e.kind] += inrValue(e);
  }
  const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month))
    .flatMap((r) => [{ month: r.month, type: 'income', total: r.income }, { month: r.month, type: 'expense', total: r.expense }]);

  res.json({
    income, expense, balance: income - expense, balances: bal,
    byCurrency, schedule: sched, statusCounts,
    debtCount: active.length, monthly,
  });
}));

// ---- chat (uses the local `claude` CLI = your Max subscription) ------------

function buildContext() {
  const entries = db.prepare('SELECT * FROM entries ORDER BY date DESC LIMIT 60').all().map(entryView);
  const debts = db.prepare('SELECT * FROM debts').all().map(debtView);
  const bal = { INR: 0, AED: 0 };
  for (const e of db.prepare('SELECT * FROM entries').all()) {
    const to = e.recv_currency || e.currency;
    if (e.kind === 'income') bal[to] += recvAmount(e);
    else if (e.kind === 'expense') bal[to] -= recvAmount(e);
    else if (e.kind === 'transfer') { bal.AED -= e.amount; bal.INR += e.amount * e.rate; }
  }
  return JSON.stringify({
    note: 'Salary/incentive are decided in INR but paid in AED at a receive rate, then transferred AED->INR at a different rate. Balances below are live: INR pays the EMIs.',
    balances: bal, debts, recentEntries: entries,
  }, null, 0);
}

app.post('/api/chat', wrap((req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) throw new Error('Empty message');

  const prompt = `You are a personal finance assistant embedded in the user's own "My Finance" app.
Answer ONLY using the JSON data below plus general financial reasoning. Be concise, practical, and use the same currency symbols (₹ for INR, AED for AED). Do not invent numbers that aren't supported by the data.

=== USER FINANCE DATA (JSON) ===
${buildContext()}

=== USER QUESTION ===
${message}`;

  const child = spawn('claude', ['-p'], { cwd: __dirname });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => res.status(500).json({ error: 'claude CLI failed: ' + e.message }));
  child.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: err || 'claude exited ' + code });
    res.json({ reply: out.trim() });
  });
  child.stdin.write(prompt);
  child.stdin.end();
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`My Finance running → http://localhost:${PORT}`));
