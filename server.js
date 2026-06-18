import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { q, one, init } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// ---- auth (Supabase) — enabled only when SUPABASE_URL is set ---------------
const AUTH = !!process.env.SUPABASE_URL;
const supa = AUTH ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;
const ALLOWED = (process.env.ALLOWED_EMAIL || '').toLowerCase();

async function requireAuth(req, res, next) {
  if (!AUTH) return next();                       // local dev: no auth
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid session' });
  if (ALLOWED && (data.user.email || '').toLowerCase() !== ALLOWED)
    return res.status(403).json({ error: 'Not authorized for this app' });
  req.user = data.user;
  next();
}
// Gate every /api route except the public config/health endpoints.
app.use('/api', (req, res, next) =>
  (req.path === '/config' || req.path === '/health') ? next() : requireAuth(req, res, next));

app.get('/api/config', (req, res) =>
  res.json({ authEnabled: AUTH, supabaseUrl: process.env.SUPABASE_URL || null, supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(join(__dirname, 'public')));

// ---- month helpers ---------------------------------------------------------
const thisMonth = () => new Date().toISOString().slice(0, 7);
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
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
const debtView = (d) => ({ ...d, schedule: scheduleFor(d) });

function commitmentsForMonth(ym, debts, recurrings) {
  const items = [];
  const now = thisMonth();
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n] || 'th');
  for (const d of debts) {
    if (d.status === 'closed') continue;
    const se = (d.schedule || scheduleFor(d)).find((s) => s.month === ym);
    if (se) items.push({ label: d.source, amount: se.amount, currency: d.currency, type: 'emi' });
    if (d.monthly_interest > 0 && ym >= now) {
      const days = (d.interest_days || '').split(',').map((x) => parseInt(x.trim())).filter((x) => x >= 1 && x <= 31);
      if (days.length > 1) {
        const per = d.monthly_interest / days.length;
        for (const dy of days) items.push({ label: `${d.source} (interest ${ord(dy)})`, amount: per, currency: d.currency, type: 'interest', estimate: true });
      } else {
        items.push({ label: d.source + ' (interest est.)', amount: d.monthly_interest, currency: d.currency, type: 'interest', estimate: true });
      }
    }
  }
  for (const r of recurrings) {
    if (r.start_month <= ym && (!r.end_month || ym <= r.end_month))
      items.push({ label: r.label, amount: r.amount, currency: r.currency, type: 'recurring' });
  }
  return items;
}

// ---- currency conversion for ledger entries --------------------------------
function recvAmount(e) {
  const from = e.currency, to = e.recv_currency || e.currency;
  if (from === to) return e.amount;
  if (from === 'INR' && to === 'AED') return e.rate ? e.amount / e.rate : 0;
  if (from === 'AED' && to === 'INR') return e.amount * e.rate;
  return e.amount;
}
function inrValue(e) {
  if (e.kind === 'transfer') return e.amount * e.rate;
  const to = e.recv_currency || e.currency;
  if (to === 'INR') return recvAmount(e);
  if (e.currency === 'INR') return e.amount;
  return e.rate ? e.amount * e.rate : 0;
}
const entryView = (e) => ({ ...e, recv_amount: recvAmount(e), inr_value: inrValue(e) });

// ---- entries ---------------------------------------------------------------
app.get('/api/entries', wrap(async (req, res) => {
  const rows = await q('SELECT * FROM entries ORDER BY date DESC, id DESC');
  res.json(rows.map(entryView));
}));

app.post('/api/entries', wrap(async (req, res) => {
  const { kind, currency, recv_currency, category, narrative, amount, rate, date } = req.body;
  if (!['income', 'expense', 'transfer'].includes(kind)) throw new Error('Invalid kind');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  let cur = currency || 'INR', recv = recv_currency || cur, rt = Number(rate) || 0;
  if (kind === 'transfer') { cur = 'AED'; recv = 'INR'; if (!(rt > 0)) throw new Error('Transfer needs an exchange rate (₹/AED)'); }
  else if (cur !== recv && !(rt > 0)) throw new Error('A rate (₹/AED) is required when "Amount in" and "Received in" differ');
  const row = await one(
    `INSERT INTO entries (kind,currency,recv_currency,category,narrative,amount,rate,date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [kind, cur, recv, category || 'General', narrative || '', amount, rt, date]);
  res.json(entryView(row));
}));

app.delete('/api/entries/:id', wrap(async (req, res) => {
  await q('DELETE FROM entries WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- debts -----------------------------------------------------------------
app.get('/api/debts', wrap(async (req, res) => {
  const order = "CASE status WHEN 'paying' THEN 0 WHEN 'not_decided' THEN 1 WHEN 'not_possible' THEN 2 ELSE 3 END";
  const rows = await q(`SELECT * FROM debts ORDER BY ${order}, remaining DESC`);
  res.json(rows.map(debtView));
}));

const num = (s) => Number(String(s ?? '').replace(/[^0-9.\-]/g, '')) || 0;

async function insertDebt(b) {
  if (!b.source) throw new Error('Source required');
  if (b.remaining == null) throw new Error('Remaining required');
  return one(
    `INSERT INTO debts (source,direction,remaining,emi,remaining_months,currency,monthly_interest,interest_days,status,start_month,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.source, b.direction || 'payable', Number(b.remaining) || 0, Number(b.emi) || 0,
     Number(b.remaining_months) || 0, b.currency || 'INR', Number(b.monthly_interest) || 0,
     b.interest_days || '', b.status || 'paying', b.start_month || thisMonth(), b.notes || '']);
}

app.post('/api/debts', wrap(async (req, res) => {
  res.json(debtView(await insertDebt(req.body)));
}));

const DEBT_FIELDS = ['source', 'direction', 'remaining', 'emi', 'remaining_months',
  'currency', 'monthly_interest', 'interest_days', 'status', 'start_month', 'notes'];

app.patch('/api/debts/:id', wrap(async (req, res) => {
  const debt = await one('SELECT * FROM debts WHERE id = $1', [req.params.id]);
  if (!debt) throw new Error('Not found');
  const cols = [], vals = [];
  for (const f of DEBT_FIELDS) if (f in req.body) { cols.push(f); vals.push(req.body[f]); }
  if (cols.length) {
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    vals.push(debt.id);
    await q(`UPDATE debts SET ${set} WHERE id = $${vals.length}`, vals);
  }
  res.json(debtView(await one('SELECT * FROM debts WHERE id = $1', [debt.id])));
}));

app.delete('/api/debts/:id', wrap(async (req, res) => {
  await q('DELETE FROM debts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- CSV import ------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', qd = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (qd) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') qd = false; else cell += c; }
    else if (c === '"') qd = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

app.post('/api/debts/import', wrap(async (req, res) => {
  const text = req.body.csv;
  if (!text) throw new Error('No CSV provided');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const startMonth = req.body.start_month || thisMonth();
  if (req.body.replace) await q('DELETE FROM debts');

  let imported = 0;
  for (let i = 1; i < rows.length; i++) {
    const [source, remaining, emiRaw, monthsRaw] = rows[i];
    if (!source || !source.trim()) continue;
    const emiTxt = (emiRaw || '').trim(), monthsTxt = (monthsRaw || '').trim();
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
    } else { emi = num(emiRaw); months = num(monthsRaw); }
    const currency = /aed/i.test(source) ? 'AED' : 'INR';
    await insertDebt({ source: source.trim(), remaining: num(remaining), emi, remaining_months: months, currency, monthly_interest, status, notes, start_month: startMonth });
    imported++;
  }
  res.json({ imported });
}));

// ---- payments --------------------------------------------------------------
app.get('/api/debts/:id/payments', wrap(async (req, res) => {
  res.json(await q('SELECT * FROM payments WHERE debt_id = $1 ORDER BY date DESC, id DESC', [req.params.id]));
}));

app.post('/api/debts/:id/payments', wrap(async (req, res) => {
  const debt = await one('SELECT * FROM debts WHERE id = $1', [req.params.id]);
  if (!debt) throw new Error('Debt not found');
  const { amount, date, note } = req.body;
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  await q('INSERT INTO payments (debt_id,amount,date,note) VALUES ($1,$2,$3,$4)', [debt.id, amount, date, note || '']);
  const newRemaining = Math.max(0, debt.remaining - amount);
  const newMonths = Math.max(0, (debt.remaining_months || 0) - 1);
  const newStatus = newRemaining <= 0.5 ? 'closed' : debt.status;
  await q('UPDATE debts SET remaining=$1, remaining_months=$2, status=$3 WHERE id=$4', [newRemaining, newMonths, newStatus, debt.id]);
  res.json(debtView(await one('SELECT * FROM debts WHERE id = $1', [debt.id])));
}));

app.delete('/api/payments/:id', wrap(async (req, res) => {
  await q('DELETE FROM payments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- interest payments -----------------------------------------------------
app.get('/api/debts/:id/interest', wrap(async (req, res) => {
  res.json(await q('SELECT * FROM interest_payments WHERE debt_id = $1 ORDER BY date DESC, id DESC', [req.params.id]));
}));

app.post('/api/debts/:id/interest', wrap(async (req, res) => {
  const debt = await one('SELECT * FROM debts WHERE id = $1', [req.params.id]);
  if (!debt) throw new Error('Debt not found');
  const { amount, date, note } = req.body;
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  await q('INSERT INTO interest_payments (debt_id,amount,date,note) VALUES ($1,$2,$3,$4)', [debt.id, amount, date, note || '']);
  res.json({ ok: true });
}));

app.delete('/api/interest/:id', wrap(async (req, res) => {
  await q('DELETE FROM interest_payments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- recurring -------------------------------------------------------------
app.get('/api/recurring', wrap(async (req, res) => {
  res.json(await q('SELECT * FROM recurring ORDER BY start_month, label'));
}));

app.post('/api/recurring', wrap(async (req, res) => {
  const { label, amount, currency, category, start_month, end_month } = req.body;
  if (!label) throw new Error('Label required');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!start_month) throw new Error('Start month required');
  const row = await one(
    'INSERT INTO recurring (label,amount,currency,category,start_month,end_month) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [label, amount, currency || 'INR', category || 'General', start_month, end_month || null]);
  res.json(row);
}));

app.delete('/api/recurring/:id', wrap(async (req, res) => {
  await q('DELETE FROM recurring WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/commitments/:month', wrap(async (req, res) => {
  const debts = (await q('SELECT * FROM debts')).map(debtView);
  const recur = await q('SELECT * FROM recurring');
  res.json(commitmentsForMonth(req.params.month, debts, recur));
}));

// ---- summary ---------------------------------------------------------------
app.get('/api/summary', wrap(async (req, res) => {
  const all = await q('SELECT * FROM entries');
  const bal = { INR: 0, AED: 0 };
  let incomeINR = 0, expenseINR = 0;
  for (const e of all) {
    const to = e.recv_currency || e.currency;
    if (e.kind === 'income') { bal[to] = (bal[to] || 0) + recvAmount(e); incomeINR += inrValue(e); }
    else if (e.kind === 'expense') { bal[to] = (bal[to] || 0) - recvAmount(e); expenseINR += inrValue(e); }
    else if (e.kind === 'transfer') { bal.AED -= e.amount; bal.INR += e.amount * e.rate; }
  }
  const debts = (await q('SELECT * FROM debts')).map(debtView);
  const curById = Object.fromEntries(debts.map((d) => [d.id, d.currency]));
  let interestPaidTotal = 0;
  for (const ip of await q('SELECT * FROM interest_payments')) {
    const c = curById[ip.debt_id] || 'INR';
    bal[c] = (bal[c] || 0) - ip.amount;
    if (c === 'INR') interestPaidTotal += ip.amount;
  }
  const income = incomeINR, expense = expenseINR;
  const active = debts.filter((d) => d.status !== 'closed');

  const byCurrency = {};
  for (const d of active) {
    const c = (byCurrency[d.currency] = byCurrency[d.currency] || { remaining: 0, emi: 0, interest: 0 });
    c.remaining += d.remaining; c.interest += d.monthly_interest;
    if (d.status === 'paying') c.emi += d.emi;
  }

  const recur = await q('SELECT * FROM recurring');
  const sched = {};
  let ym = thisMonth();
  for (let i = 0; i < 12; i++) {
    const items = commitmentsForMonth(ym, debts, recur);
    if (items.length) { const m = (sched[ym] = sched[ym] || {}); for (const it of items) m[it.currency] = (m[it.currency] || 0) + it.amount; }
    ym = addMonths(ym, 1);
  }

  const statusCounts = active.reduce((a, d) => { a[d.status] = (a[d.status] || 0) + 1; return a; }, {});

  const monthMap = {};
  for (const e of all) {
    if (e.kind === 'transfer') continue;
    const m = e.date.slice(0, 7);
    monthMap[m] = monthMap[m] || { month: m, income: 0, expense: 0 };
    monthMap[m][e.kind] += inrValue(e);
  }
  const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month))
    .flatMap((r) => [{ month: r.month, type: 'income', total: r.income }, { month: r.month, type: 'expense', total: r.expense }]);

  res.json({ income, expense, balance: income - expense, balances: bal, interestPaidTotal, byCurrency, schedule: sched, statusCounts, debtCount: active.length, monthly });
}));

// ---- chat (Anthropic API when key present; local `claude` CLI otherwise) ---
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8';

async function buildContext() {
  const entries = (await q('SELECT * FROM entries ORDER BY date DESC LIMIT 60')).map(entryView);
  const debts = (await q('SELECT * FROM debts')).map(debtView);
  const bal = { INR: 0, AED: 0 };
  for (const e of await q('SELECT * FROM entries')) {
    const to = e.recv_currency || e.currency;
    if (e.kind === 'income') bal[to] += recvAmount(e);
    else if (e.kind === 'expense') bal[to] -= recvAmount(e);
    else if (e.kind === 'transfer') { bal.AED -= e.amount; bal.INR += e.amount * e.rate; }
  }
  return JSON.stringify({
    note: 'Salary/incentive are decided in INR but paid in AED at a receive rate, then transferred AED->INR at a different rate. INR pays the EMIs.',
    balances: bal, debts, recentEntries: entries,
  });
}

const CHAT_SYSTEM = `You are a personal finance assistant embedded in the user's own "My Finance" app.
Answer ONLY using the JSON data provided plus general financial reasoning. Be concise and practical, and use ₹ for INR and AED for AED. Do not invent numbers not supported by the data.`;

app.post('/api/chat', wrap(async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) throw new Error('Empty message');
  const context = await buildContext();
  const userContent = `=== USER FINANCE DATA (JSON) ===\n${context}\n\n=== USER QUESTION ===\n${message}`;

  if (anthropic) {
    const msg = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: CHAT_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    const reply = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return res.json({ reply });
  }
  // Fallback: local claude CLI (Max subscription) — dev only.
  const child = spawn('claude', ['-p'], { cwd: __dirname });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => res.headersSent || res.status(500).json({ error: 'claude CLI failed: ' + e.message }));
  child.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: err || 'claude exited ' + code });
    res.json({ reply: out.trim() });
  });
  child.stdin.write(`${CHAT_SYSTEM}\n\n${userContent}`);
  child.stdin.end();
}));

const PORT = process.env.PORT || 3000;
await init();
app.listen(PORT, () => console.log(`My Finance running → http://localhost:${PORT}  [db=${process.env.DATABASE_URL ? 'postgres' : 'sqlite'}, auth=${AUTH}, chat=${anthropic ? 'api' : 'cli'}]`));
