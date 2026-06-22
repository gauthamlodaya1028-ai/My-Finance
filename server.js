import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { data, BACKEND, initData } from './data.js';
import { APPWRITE, verifyJwt } from './appwrite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// ---- auth: Appwrite (JWT) → Supabase → none -------------------------------
const SUPA_URL = process.env.SUPABASE_URL;
const supa = (!APPWRITE && SUPA_URL) ? createClient(SUPA_URL, process.env.SUPABASE_ANON_KEY) : null;
const AUTH = APPWRITE ? 'appwrite' : (supa ? 'supabase' : 'none');
const ALLOWED = (process.env.ALLOWED_EMAIL || '').toLowerCase();

async function requireAuth(req, res, next) {
  if (AUTH === 'none') return next();
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    let email;
    if (AUTH === 'appwrite') { email = (await verifyJwt(token)).email; }
    else { const { data: d, error } = await supa.auth.getUser(token); if (error || !d?.user) throw new Error('bad'); email = d.user.email; }
    if (ALLOWED && (email || '').toLowerCase() !== ALLOWED) return res.status(403).json({ error: 'Not authorized for this app' });
    req.userEmail = email;
    next();
  } catch { return res.status(401).json({ error: 'Invalid session' }); }
}
app.use('/api', (req, res, next) =>
  (req.path === '/config' || req.path === '/health') ? next() : requireAuth(req, res, next));

app.get('/api/config', (req, res) => res.json({
  auth: AUTH,
  appwrite: APPWRITE ? { endpoint: process.env.APPWRITE_ENDPOINT, project: process.env.APPWRITE_PROJECT } : null,
  supabaseUrl: !APPWRITE ? (SUPA_URL || null) : null,
  supabaseAnonKey: !APPWRITE ? (process.env.SUPABASE_ANON_KEY || null) : null,
}));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(join(__dirname, 'public')));

// ---- helpers ---------------------------------------------------------------
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
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || String(b.created_at || '').localeCompare(String(a.created_at || ''));
const sameId = (a, b) => String(a) === String(b);
const num = (s) => Number(String(s ?? '').replace(/[^0-9.\-]/g, '')) || 0;

// ---- entries ---------------------------------------------------------------
app.get('/api/entries', wrap(async (req, res) => {
  const rows = (await data.list('entries')).sort(byDateDesc);
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
  const row = await data.create('entries', {
    kind, currency: cur, recv_currency: recv, category: category || 'General',
    narrative: narrative || '', amount: Number(amount), rate: rt, date,
  });
  res.json(entryView(row));
}));

app.delete('/api/entries/:id', wrap(async (req, res) => { await data.remove('entries', req.params.id); res.json({ ok: true }); }));

// ---- debts -----------------------------------------------------------------
const STATUS_ORDER = { paying: 0, not_decided: 1, not_possible: 2, closed: 3 };
app.get('/api/debts', wrap(async (req, res) => {
  const rows = (await data.list('debts')).sort((a, b) =>
    (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.remaining - a.remaining));
  res.json(rows.map(debtView));
}));

async function insertDebt(b) {
  if (!b.source) throw new Error('Source required');
  if (b.remaining == null) throw new Error('Remaining required');
  return data.create('debts', {
    source: b.source, direction: b.direction || 'payable', remaining: Number(b.remaining) || 0,
    emi: Number(b.emi) || 0, remaining_months: Number(b.remaining_months) || 0, currency: b.currency || 'INR',
    monthly_interest: Number(b.monthly_interest) || 0, interest_days: b.interest_days || '',
    status: b.status || 'paying', start_month: b.start_month || thisMonth(), notes: b.notes || '',
  });
}

app.post('/api/debts', wrap(async (req, res) => { res.json(debtView(await insertDebt(req.body))); }));

const DEBT_FIELDS = ['source', 'direction', 'remaining', 'emi', 'remaining_months',
  'currency', 'monthly_interest', 'interest_days', 'status', 'start_month', 'notes'];
app.patch('/api/debts/:id', wrap(async (req, res) => {
  const debt = await data.get('debts', req.params.id);
  if (!debt) throw new Error('Not found');
  const upd = {};
  for (const f of DEBT_FIELDS) if (f in req.body) upd[f] = req.body[f];
  const row = Object.keys(upd).length ? await data.update('debts', debt.id, upd) : debt;
  res.json(debtView(row));
}));

app.delete('/api/debts/:id', wrap(async (req, res) => {
  // remove dependent payment/interest rows first (no FK cascade on Appwrite)
  const id = req.params.id;
  for (const t of ['payments', 'interest_payments']) {
    const dep = (await data.list(t)).filter((r) => sameId(r.debt_id, id));
    for (const r of dep) await data.remove(t, r.id);
  }
  await data.remove('debts', id);
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
  if (req.body.replace) { for (const d of await data.list('debts')) await data.remove('debts', d.id); }

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
  const rows = (await data.list('payments')).filter((p) => sameId(p.debt_id, req.params.id)).sort(byDateDesc);
  res.json(rows);
}));

app.post('/api/debts/:id/payments', wrap(async (req, res) => {
  const debt = await data.get('debts', req.params.id);
  if (!debt) throw new Error('Debt not found');
  const { amount, date, note } = req.body;
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  await data.create('payments', { debt_id: String(debt.id), amount: Number(amount), date, note: note || '' });
  const newRemaining = Math.max(0, debt.remaining - amount);
  const newMonths = Math.max(0, (debt.remaining_months || 0) - 1);
  const newStatus = newRemaining <= 0.5 ? 'closed' : debt.status;
  const row = await data.update('debts', debt.id, { remaining: newRemaining, remaining_months: newMonths, status: newStatus });
  res.json(debtView(row));
}));

app.delete('/api/payments/:id', wrap(async (req, res) => { await data.remove('payments', req.params.id); res.json({ ok: true }); }));

// ---- interest payments -----------------------------------------------------
app.get('/api/debts/:id/interest', wrap(async (req, res) => {
  const rows = (await data.list('interest_payments')).filter((p) => sameId(p.debt_id, req.params.id)).sort(byDateDesc);
  res.json(rows);
}));

app.post('/api/debts/:id/interest', wrap(async (req, res) => {
  const debt = await data.get('debts', req.params.id);
  if (!debt) throw new Error('Debt not found');
  const { amount, date, note } = req.body;
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  await data.create('interest_payments', { debt_id: String(debt.id), amount: Number(amount), date, note: note || '' });
  res.json({ ok: true });
}));

app.delete('/api/interest/:id', wrap(async (req, res) => { await data.remove('interest_payments', req.params.id); res.json({ ok: true }); }));

// ---- recurring -------------------------------------------------------------
app.get('/api/recurring', wrap(async (req, res) => {
  const rows = (await data.list('recurring')).sort((a, b) => (a.start_month || '').localeCompare(b.start_month || '') || (a.label || '').localeCompare(b.label || ''));
  res.json(rows);
}));

app.post('/api/recurring', wrap(async (req, res) => {
  const { label, amount, currency, category, start_month, end_month } = req.body;
  if (!label) throw new Error('Label required');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!start_month) throw new Error('Start month required');
  const row = await data.create('recurring', { label, amount: Number(amount), currency: currency || 'INR', category: category || 'General', start_month, end_month: end_month || null });
  res.json(row);
}));

app.delete('/api/recurring/:id', wrap(async (req, res) => { await data.remove('recurring', req.params.id); res.json({ ok: true }); }));

app.get('/api/commitments/:month', wrap(async (req, res) => {
  const debts = (await data.list('debts')).map(debtView);
  const recur = await data.list('recurring');
  res.json(commitmentsForMonth(req.params.month, debts, recur));
}));

// ---- summary ---------------------------------------------------------------
app.get('/api/summary', wrap(async (req, res) => {
  const all = await data.list('entries');
  const bal = { INR: 0, AED: 0 };
  let incomeINR = 0, expenseINR = 0;
  for (const e of all) {
    const to = e.recv_currency || e.currency;
    if (e.kind === 'income') { bal[to] = (bal[to] || 0) + recvAmount(e); incomeINR += inrValue(e); }
    else if (e.kind === 'expense') { bal[to] = (bal[to] || 0) - recvAmount(e); expenseINR += inrValue(e); }
    else if (e.kind === 'transfer') { bal.AED -= e.amount; bal.INR += e.amount * e.rate; }
  }
  const debts = (await data.list('debts')).map(debtView);
  const curById = Object.fromEntries(debts.map((d) => [String(d.id), d.currency]));
  let interestPaidTotal = 0;
  for (const ip of await data.list('interest_payments')) {
    const c = curById[String(ip.debt_id)] || 'INR';
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

  const recur = await data.list('recurring');
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
    const m = (e.date || '').slice(0, 7);
    monthMap[m] = monthMap[m] || { month: m, income: 0, expense: 0 };
    monthMap[m][e.kind] += inrValue(e);
  }
  const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month))
    .flatMap((r) => [{ month: r.month, type: 'income', total: r.income }, { month: r.month, type: 'expense', total: r.expense }]);

  res.json({ income, expense, balance: income - expense, balances: bal, interestPaidTotal, byCurrency, schedule: sched, statusCounts, debtCount: active.length, monthly });
}));

// ---- chat ------------------------------------------------------------------
let anthropic = null, chatMode = 'cli';
if (process.env.ANTHROPIC_API_KEY) { anthropic = new Anthropic(); chatMode = 'api'; }
else if (process.env.ANTHROPIC_AUTH_TOKEN) { anthropic = new Anthropic({ authToken: process.env.ANTHROPIC_AUTH_TOKEN, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } }); chatMode = 'oauth'; }
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8';

async function buildContext() {
  const entries = (await data.list('entries')).sort(byDateDesc).slice(0, 60).map(entryView);
  const debts = (await data.list('debts')).map(debtView);
  const bal = { INR: 0, AED: 0 };
  for (const e of await data.list('entries')) {
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
  const userContent = `=== USER FINANCE DATA (JSON) ===\n${await buildContext()}\n\n=== USER QUESTION ===\n${message}`;
  if (anthropic) {
    const msg = await anthropic.messages.create({ model: CHAT_MODEL, max_tokens: 1024, system: CHAT_SYSTEM, messages: [{ role: 'user', content: userContent }] });
    return res.json({ reply: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() });
  }
  const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p'], { cwd: __dirname, env: process.env });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => res.headersSent || res.status(500).json({ error: 'claude CLI failed: ' + e.message }));
  child.on('close', (code) => { if (res.headersSent) return; code !== 0 ? res.status(500).json({ error: err || 'claude exited ' + code }) : res.json({ reply: out.trim() }); });
  child.stdin.write(`${CHAT_SYSTEM}\n\n${userContent}`);
  child.stdin.end();
}));

const PORT = process.env.PORT || 3000;
await initData();
app.listen(PORT, () => console.log(`My Finance running → http://localhost:${PORT}  [db=${BACKEND}, auth=${AUTH}, chat=${chatMode}]`));
