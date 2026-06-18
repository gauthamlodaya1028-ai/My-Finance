import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---- helpers ---------------------------------------------------------------

// Simple interest accrued from start_date to today (annual rate %).
function accruedInterest(debt) {
  if (!debt.interest_rate) return 0;
  const start = new Date(debt.start_date);
  const now = new Date();
  const days = Math.max(0, (now - start) / 86400000);
  return debt.principal * (debt.interest_rate / 100) * (days / 365);
}

function debtView(debt) {
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE debt_id = ?')
    .get(debt.id).s;
  const interest = accruedInterest(debt);
  const total = debt.principal + interest;
  const outstanding = Math.max(0, total - paid);
  return { ...debt, paid, interest, total, outstanding };
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// ---- entries (income / expense) -------------------------------------------

app.get('/api/entries', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM entries ORDER BY date DESC, id DESC').all());
}));

app.post('/api/entries', wrap((req, res) => {
  const { type, category, narrative, amount, date } = req.body;
  if (!['income', 'expense'].includes(type)) throw new Error('Invalid type');
  if (!(amount > 0)) throw new Error('Amount must be positive');
  if (!date) throw new Error('Date required');
  const info = db.prepare(
    'INSERT INTO entries (type, category, narrative, amount, date) VALUES (?,?,?,?,?)'
  ).run(type, category || 'General', narrative || '', amount, date);
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid));
}));

app.delete('/api/entries/:id', wrap((req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---- debts -----------------------------------------------------------------

app.get('/api/debts', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM debts ORDER BY status, due_date IS NULL, due_date').all();
  res.json(rows.map(debtView));
}));

app.post('/api/debts', wrap((req, res) => {
  const { direction, counterparty, principal, interest_rate, start_date, due_date, notes } = req.body;
  if (!['payable', 'receivable'].includes(direction)) throw new Error('Invalid direction');
  if (!counterparty) throw new Error('Counterparty required');
  if (!(principal > 0)) throw new Error('Principal must be positive');
  if (!start_date) throw new Error('Start date required');
  const info = db.prepare(
    `INSERT INTO debts (direction, counterparty, principal, interest_rate, start_date, due_date, notes)
     VALUES (?,?,?,?,?,?,?)`
  ).run(direction, counterparty, principal, interest_rate || 0, start_date, due_date || null, notes || '');
  res.json(debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(info.lastInsertRowid)));
}));

app.patch('/api/debts/:id', wrap((req, res) => {
  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(req.params.id);
  if (!debt) throw new Error('Not found');
  const fields = ['direction', 'counterparty', 'principal', 'interest_rate', 'start_date', 'due_date', 'status', 'notes'];
  const updates = {};
  for (const f of fields) if (f in req.body) updates[f] = req.body[f];
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
  // auto-close if fully settled
  const v = debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(debt.id));
  if (v.outstanding <= 0.005 && debt.status === 'open') {
    db.prepare("UPDATE debts SET status = 'closed' WHERE id = ?").run(debt.id);
  }
  res.json(debtView(db.prepare('SELECT * FROM debts WHERE id = ?').get(debt.id)));
}));

app.delete('/api/payments/:id', wrap((req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---- dashboard summary -----------------------------------------------------

app.get('/api/summary', wrap((req, res) => {
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM entries WHERE type='income'").get().s;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM entries WHERE type='expense'").get().s;
  const debts = db.prepare("SELECT * FROM debts WHERE status='open'").all().map(debtView);
  const payable = debts.filter(d => d.direction === 'payable').reduce((a, d) => a + d.outstanding, 0);
  const receivable = debts.filter(d => d.direction === 'receivable').reduce((a, d) => a + d.outstanding, 0);

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const reminders = debts
    .filter(d => d.due_date)
    .map(d => ({
      ...d,
      overdue: d.due_date < today,
      dueSoon: d.due_date >= today && d.due_date <= soon,
    }))
    .filter(d => d.overdue || d.dueSoon)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  // last 6 months income vs expense
  const monthly = db.prepare(`
    SELECT substr(date,1,7) AS month, type, SUM(amount) AS total
    FROM entries GROUP BY month, type ORDER BY month
  `).all();

  res.json({
    income, expense, balance: income - expense,
    payable, receivable, netWorthDelta: income - expense + receivable - payable,
    reminders, monthly,
  });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`My Finance running → http://localhost:${PORT}`));
