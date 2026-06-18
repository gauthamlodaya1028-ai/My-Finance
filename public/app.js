// ---------- tiny helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const modalHost = $('#modal-host');

const api = async (url, opts) => {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

const money = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- modal ----------
function openModal(title, bodyHtml, onMount) {
  modalHost.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <div class="panel-head"><h3>${esc(title)}</h3>
          <button class="btn ghost small" id="modal-close">Close</button></div>
        <div id="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const close = () => (modalHost.innerHTML = '');
  $('#modal-close').onclick = close;
  $('.overlay').onclick = (e) => { if (e.target.classList.contains('overlay')) close(); };
  onMount?.(close);
}

// ---------- routing ----------
const views = {};
let current = 'dashboard';

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    current = t.dataset.view;
    render();
  })
);

async function render() {
  app.innerHTML = '<p class="empty">Loading…</p>';
  try { await views[current](); }
  catch (e) { app.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`; }
}

// ---------- Dashboard ----------
views.dashboard = async () => {
  const s = await api('/api/summary');
  const months = {};
  s.monthly.forEach((m) => { months[m.month] = months[m.month] || { income: 0, expense: 0 }; months[m.month][m.type] = m.total; });
  const monthKeys = Object.keys(months).sort().slice(-6);
  const max = Math.max(1, ...monthKeys.flatMap((k) => [months[k].income, months[k].expense]));

  app.innerHTML = `
    <h2>Dashboard</h2>
    <div class="cards">
      <div class="card"><div class="label">Total Income</div><div class="value green">${money(s.income)}</div></div>
      <div class="card"><div class="label">Total Expense</div><div class="value red">${money(s.expense)}</div></div>
      <div class="card"><div class="label">Cash Balance</div><div class="value ${s.balance >= 0 ? 'green' : 'red'}">${money(s.balance)}</div></div>
      <div class="card"><div class="label">Owed to me (receivable)</div><div class="value green">${money(s.receivable)}</div></div>
      <div class="card"><div class="label">I owe (payable)</div><div class="value red">${money(s.payable)}</div></div>
      <div class="card"><div class="label">Net position</div><div class="value ${s.netWorthDelta >= 0 ? 'green' : 'red'}">${money(s.netWorthDelta)}</div></div>
    </div>

    <div class="panel">
      <h3>Reminders — due soon &amp; overdue</h3>
      ${s.reminders.length ? `<table><thead><tr><th>Who</th><th>Type</th><th>Due</th><th class="right">Outstanding</th><th></th></tr></thead><tbody>
        ${s.reminders.map((d) => `<tr>
          <td>${esc(d.counterparty)}</td>
          <td><span class="pill ${d.direction}">${d.direction}</span></td>
          <td>${fmtDate(d.due_date)} <span class="pill ${d.overdue ? 'overdue' : 'soon'}">${d.overdue ? 'OVERDUE' : 'due soon'}</span></td>
          <td class="right">${money(d.outstanding)}</td>
        </tr>`).join('')}
      </tbody></table>` : '<p class="empty">Nothing due in the next 7 days. 🎉</p>'}
    </div>

    <div class="panel">
      <h3>Income vs Expense — last 6 months</h3>
      ${monthKeys.length ? `<div class="bars">
        ${monthKeys.map((k) => `<div class="bar-col"><div class="bar-pair">
          <div class="bar inc" style="height:${(months[k].income / max) * 130}px" title="${money(months[k].income)}"></div>
          <div class="bar exp" style="height:${(months[k].expense / max) * 130}px" title="${money(months[k].expense)}"></div>
        </div><div class="bar-label">${k.slice(2)}</div></div>`).join('')}
      </div>
      <div class="legend"><span><span class="dot inc"></span>Income</span><span><span class="dot exp"></span>Expense</span></div>`
      : '<p class="empty">Add some income/expense entries to see trends.</p>'}
    </div>`;
};

// ---------- Ledger (income/expense) ----------
views.ledger = async () => {
  const entries = await api('/api/entries');
  app.innerHTML = `
    <h2>Income &amp; Expense</h2>
    <div class="panel">
      <h3>Add entry</h3>
      <form class="grid" id="entry-form">
        <label class="field">Type
          <select name="type"><option value="income">Income</option><option value="expense">Expense</option></select></label>
        <label class="field">Category
          <input name="category" placeholder="Salary, Rent, Side gig…" /></label>
        <label class="field" style="grid-column: span 2;">Narrative
          <input name="narrative" placeholder="e.g. June salary + incentive" /></label>
        <label class="field">Amount
          <input name="amount" type="number" step="0.01" min="0" required /></label>
        <label class="field">Date
          <input name="date" type="date" value="${today()}" required /></label>
        <button class="btn" type="submit">Add</button>
      </form>
    </div>

    <div class="panel">
      <h3>History</h3>
      ${entries.length ? `<table><thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Narrative</th><th class="right">Amount</th><th></th></tr></thead><tbody>
        ${entries.map((e) => `<tr>
          <td>${fmtDate(e.date)}</td>
          <td><span class="pill ${e.type}">${e.type}</span></td>
          <td>${esc(e.category)}</td>
          <td class="muted">${esc(e.narrative)}</td>
          <td class="right" style="color:${e.type === 'income' ? 'var(--green)' : 'var(--red)'}">${e.type === 'income' ? '+' : '−'}${money(e.amount)}</td>
          <td class="right"><button class="btn danger" data-del="${e.id}">✕</button></td>
        </tr>`).join('')}
      </tbody></table>` : '<p class="empty">No entries yet.</p>'}
    </div>`;

  $('#entry-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await api('/api/entries', { method: 'POST', body: {
      type: f.get('type'), category: f.get('category'), narrative: f.get('narrative'),
      amount: parseFloat(f.get('amount')), date: f.get('date'),
    }});
    render();
  };
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (confirm('Delete this entry?')) { await api('/api/entries/' + b.dataset.del, { method: 'DELETE' }); render(); }
  });
};

// ---------- Debts & Receivables ----------
views.debts = async () => {
  const debts = await api('/api/debts');
  const open = debts.filter((d) => d.status === 'open');
  const closed = debts.filter((d) => d.status === 'closed');

  const row = (d) => `<tr>
    <td>${esc(d.counterparty)}</td>
    <td><span class="pill ${d.direction}">${d.direction}</span></td>
    <td class="right">${money(d.principal)}</td>
    <td class="right muted">${d.interest_rate ? d.interest_rate + '% · ' + money(d.interest) : '—'}</td>
    <td class="right">${money(d.paid)}</td>
    <td class="right"><b>${money(d.outstanding)}</b></td>
    <td>${d.due_date ? fmtDate(d.due_date) : '—'}</td>
    <td class="right">
      <button class="btn small" data-pay="${d.id}">Pay</button>
      <button class="btn ghost small" data-view-d="${d.id}">View</button>
      <button class="btn danger" data-del-d="${d.id}">✕</button>
    </td></tr>`;

  app.innerHTML = `
    <h2>Debts &amp; Receivables</h2>
    <div class="panel">
      <div class="panel-head"><h3>Add debt / receivable</h3></div>
      <form class="grid" id="debt-form">
        <label class="field">Direction
          <select name="direction">
            <option value="payable">I owe (payable)</option>
            <option value="receivable">Owed to me (receivable)</option>
          </select></label>
        <label class="field">Counterparty
          <input name="counterparty" placeholder="Person / entity" required /></label>
        <label class="field">Principal
          <input name="principal" type="number" step="0.01" min="0" required /></label>
        <label class="field">Interest % (annual)
          <input name="interest_rate" type="number" step="0.01" min="0" value="0" /></label>
        <label class="field">Start date
          <input name="start_date" type="date" value="${today()}" required /></label>
        <label class="field">Due date
          <input name="due_date" type="date" /></label>
        <label class="field" style="grid-column: span 2;">Notes
          <input name="notes" placeholder="optional" /></label>
        <button class="btn" type="submit">Add</button>
      </form>
    </div>

    <div class="panel">
      <h3>Open (${open.length})</h3>
      ${open.length ? `<table><thead><tr><th>Who</th><th>Type</th><th class="right">Principal</th><th class="right">Interest</th><th class="right">Paid</th><th class="right">Outstanding</th><th>Due</th><th></th></tr></thead><tbody>${open.map(row).join('')}</tbody></table>` : '<p class="empty">No open items.</p>'}
    </div>

    ${closed.length ? `<div class="panel"><h3>Closed (${closed.length})</h3>
      <table><thead><tr><th>Who</th><th>Type</th><th class="right">Principal</th><th class="right">Interest</th><th class="right">Paid</th><th class="right">Outstanding</th><th>Due</th><th></th></tr></thead><tbody>${closed.map(row).join('')}</tbody></table></div>` : ''}`;

  $('#debt-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await api('/api/debts', { method: 'POST', body: {
      direction: f.get('direction'), counterparty: f.get('counterparty'),
      principal: parseFloat(f.get('principal')), interest_rate: parseFloat(f.get('interest_rate')) || 0,
      start_date: f.get('start_date'), due_date: f.get('due_date') || null, notes: f.get('notes'),
    }});
    render();
  };
  app.querySelectorAll('[data-del-d]').forEach((b) => b.onclick = async () => {
    if (confirm('Delete this debt and all its payments?')) { await api('/api/debts/' + b.dataset.delD, { method: 'DELETE' }); render(); }
  });
  app.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => payModal(debts.find((d) => d.id == b.dataset.pay)));
  app.querySelectorAll('[data-view-d]').forEach((b) => b.onclick = () => detailModal(debts.find((d) => d.id == b.dataset.viewD)));
};

function payModal(d) {
  openModal(`Record payment — ${d.counterparty}`, `
    <p class="muted" style="margin-bottom:14px;">Outstanding: <b>${money(d.outstanding)}</b></p>
    <form class="grid" id="pay-form">
      <label class="field">Amount<input name="amount" type="number" step="0.01" min="0" value="${d.outstanding.toFixed(2)}" required /></label>
      <label class="field">Date<input name="date" type="date" value="${today()}" required /></label>
      <label class="field" style="grid-column: span 2;">Note<input name="note" placeholder="optional" /></label>
      <button class="btn" type="submit">Save payment</button>
    </form>`, (close) => {
    $('#pay-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      await api(`/api/debts/${d.id}/payments`, { method: 'POST', body: {
        amount: parseFloat(f.get('amount')), date: f.get('date'), note: f.get('note'),
      }});
      close(); render();
    };
  });
}

async function detailModal(d) {
  const pays = await api(`/api/debts/${d.id}/payments`);
  openModal(`${d.counterparty} — ${d.direction}`, `
    <div class="cards" style="grid-template-columns:repeat(2,1fr);">
      <div class="card"><div class="label">Principal</div><div class="value">${money(d.principal)}</div></div>
      <div class="card"><div class="label">Outstanding</div><div class="value ${d.outstanding > 0 ? 'amber' : 'green'}">${money(d.outstanding)}</div></div>
    </div>
    <p class="muted" style="margin:10px 0;">Started ${fmtDate(d.start_date)} · Due ${fmtDate(d.due_date)} · Interest ${d.interest_rate}% (${money(d.interest)} accrued)</p>
    ${d.notes ? `<p style="margin-bottom:14px;">${esc(d.notes)}</p>` : ''}
    <h3>Payments</h3>
    ${pays.length ? `<table><thead><tr><th>Date</th><th>Note</th><th class="right">Amount</th><th></th></tr></thead><tbody>
      ${pays.map((p) => `<tr><td>${fmtDate(p.date)}</td><td class="muted">${esc(p.note)}</td><td class="right">${money(p.amount)}</td>
      <td class="right"><button class="btn danger" data-delp="${p.id}">✕</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="empty">No payments yet.</p>'}`, (close) => {
    modalHost.querySelectorAll('[data-delp]').forEach((b) => b.onclick = async () => {
      await api('/api/payments/' + b.dataset.delp, { method: 'DELETE' }); close(); render();
    });
  });
}

// ---------- Calendar ----------
let calRef = new Date();
views.calendar = async () => {
  const debts = await api('/api/debts');
  const events = {};
  debts.filter((d) => d.due_date && d.status === 'open').forEach((d) => {
    (events[d.due_date] = events[d.due_date] || []).push(d);
  });

  const y = calRef.getFullYear(), m = calRef.getMonth();
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const monthName = calRef.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let cells = dow.map((d) => `<div class="cal-cell dow">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty-cell"></div>';
  for (let day = 1; day <= days; day++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const evs = events[ds] || [];
    cells += `<div class="cal-cell ${ds === today() ? 'today' : ''}">
      <div class="daynum">${day}</div>
      ${evs.map((e) => `<div class="cal-event ${e.direction}" title="${esc(e.counterparty)}: ${money(e.outstanding)}">${esc(e.counterparty)} ${money(e.outstanding)}</div>`).join('')}
    </div>`;
  }

  app.innerHTML = `
    <h2>Debt Calendar</h2>
    <div class="panel">
      <div class="panel-head">
        <button class="btn ghost small" id="prev">← Prev</button>
        <h3 style="margin:0;">${monthName}</h3>
        <button class="btn ghost small" id="next">Next →</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="legend" style="margin-top:14px;">
        <span><span class="dot exp"></span>Payable due</span>
        <span><span class="dot inc"></span>Receivable due</span>
      </div>
    </div>`;
  $('#prev').onclick = () => { calRef = new Date(y, m - 1, 1); render(); };
  $('#next').onclick = () => { calRef = new Date(y, m + 1, 1); render(); };
};

render();
