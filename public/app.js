// ---------- helpers ----------
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

const CUR = { INR: '₹', AED: 'AED ' };
const money = (n, c = 'INR') =>
  (CUR[c] || '') + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const fmtDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
const fmtMonth = (ym) => { const [y, m] = ym.split('-'); return new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS_LABEL = { paying: 'Paying', not_decided: 'Not decided', not_possible: 'Not possible', closed: 'Closed' };
const STATUS_PILL = { paying: 'soon', not_decided: 'soon', not_possible: 'overdue', closed: 'closed' };

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
  const cur = Object.keys(s.byCurrency);
  const months = {};
  s.monthly.forEach((m) => { months[m.month] = months[m.month] || { income: 0, expense: 0 }; months[m.month][m.type] = m.total; });
  const monthKeys = Object.keys(months).sort().slice(-6);
  const max = Math.max(1, ...monthKeys.flatMap((k) => [months[k].income, months[k].expense]));

  // next 6 months EMI outflow
  const schedMonths = Object.keys(s.schedule).sort().slice(0, 6);

  app.innerHTML = `
    <h2>Dashboard</h2>
    <div class="cards">
      <div class="card"><div class="label">INR on hand <span class="muted">(pays EMIs)</span></div><div class="value ${(s.balances?.INR || 0) >= 0 ? 'green' : 'red'}">${money(s.balances?.INR || 0, 'INR')}</div></div>
      <div class="card"><div class="label">AED on hand <span class="muted">(Dubai)</span></div><div class="value ${(s.balances?.AED || 0) >= 0 ? 'green' : 'red'}">${money(s.balances?.AED || 0, 'AED')}</div></div>
      <div class="card"><div class="label">Income / Expense (₹ equiv)</div><div class="value">${money(s.income)} <span class="muted" style="font-size:1rem;">/ ${money(s.expense)}</span></div></div>
      ${cur.map((c) => `<div class="card"><div class="label">Debt outstanding (${c})</div>
        <div class="value red">${money(s.byCurrency[c].remaining, c)}</div>
        <div class="label" style="margin-top:6px;">EMI/mo ${money(s.byCurrency[c].emi, c)}${s.byCurrency[c].interest ? ' · interest ' + money(s.byCurrency[c].interest, c) : ''}</div></div>`).join('')}
    </div>

    <div class="panel">
      <h3>EMI outflow — next 6 months</h3>
      ${schedMonths.length ? `<table><thead><tr><th>Month</th>${cur.map((c) => `<th class="right">${c}</th>`).join('')}</tr></thead><tbody>
        ${schedMonths.map((m) => `<tr><td>${fmtMonth(m)}</td>${cur.map((c) => `<td class="right">${s.schedule[m][c] ? money(s.schedule[m][c], c) : '—'}</td>`).join('')}</tr>`).join('')}
      </tbody></table>` : '<p class="empty">No EMI schedule yet. Add paying debts with an EMI &amp; months.</p>'}
    </div>

    <div class="panel">
      <h3>Income vs Expense — last 6 months</h3>
      ${monthKeys.length ? `<div class="bars">
        ${monthKeys.map((k) => `<div class="bar-col"><div class="bar-pair">
          <div class="bar inc" style="height:${(months[k].income / max) * 130}px" title="${money(months[k].income)}"></div>
          <div class="bar exp" style="height:${(months[k].expense / max) * 130}px" title="${money(months[k].expense)}"></div>
        </div><div class="bar-label">${fmtMonth(k)}</div></div>`).join('')}
      </div>
      <div class="legend"><span><span class="dot inc"></span>Income</span><span><span class="dot exp"></span>Expense</span></div>`
      : '<p class="empty">Add some income/expense entries to see trends.</p>'}
    </div>`;
};

// ---------- Ledger (multi-currency income/expense + AED→INR transfer) ----------
views.ledger = async () => {
  const [entries, s] = await Promise.all([api('/api/entries'), api('/api/summary')]);
  const b = s.balances || { INR: 0, AED: 0 };

  const kindPill = (e) => e.kind === 'transfer' ? '<span class="pill" style="background:rgba(79,156,249,.18);color:var(--accent)">transfer</span>'
    : `<span class="pill ${e.kind}">${e.kind}</span>`;
  const amountCell = (e) => {
    if (e.kind === 'transfer')
      return `<span style="color:var(--accent)">${money(e.amount, 'AED')} → ${money(e.amount * e.rate, 'INR')}</span> <span class="muted">@${e.rate}</span>`;
    const sign = e.kind === 'income' ? '+' : '−';
    const col = e.kind === 'income' ? 'var(--green)' : 'var(--red)';
    const equiv = e.currency === 'AED' && e.rate ? ` <span class="muted">≈ ${money(e.amount * e.rate, 'INR')} @${e.rate}</span>` : '';
    return `<span style="color:${col}">${sign}${money(e.amount, e.currency)}</span>${equiv}`;
  };

  app.innerHTML = `
    <h2>Earnings &amp; Expenses</h2>
    <div class="cards">
      <div class="card"><div class="label">INR on hand <span class="muted">(pays EMIs)</span></div><div class="value ${b.INR >= 0 ? 'green' : 'red'}">${money(b.INR, 'INR')}</div></div>
      <div class="card"><div class="label">AED on hand <span class="muted">(Dubai)</span></div><div class="value ${b.AED >= 0 ? 'green' : 'red'}">${money(b.AED, 'AED')}</div></div>
    </div>

    <div class="panel">
      <h3>Add entry</h3>
      <form class="grid" id="entry-form">
        <label class="field">Kind
          <select name="kind" id="kind-sel">
            <option value="income">Income</option>
            <option value="expense">Expense</option>
            <option value="transfer">Transfer AED → INR</option>
          </select></label>
        <label class="field" id="cur-field">Currency
          <select name="currency"><option value="INR">₹ INR</option><option value="AED">AED</option></select></label>
        <label class="field">Category<input name="category" placeholder="Salary, Incentive, Food, Rent…" /></label>
        <label class="field" style="grid-column: span 2;">Narrative<input name="narrative" placeholder="e.g. June salary / Dubai side gig" /></label>
        <label class="field" id="amt-field">Amount<input name="amount" type="number" step="0.0001" min="0" required /></label>
        <label class="field" id="rate-field">Rate (₹/AED)<input name="rate" type="number" step="0.0001" min="0" placeholder="optional" /></label>
        <label class="field">Date<input name="date" type="date" value="${today()}" required /></label>
        <button class="btn" type="submit">Add</button>
      </form>
      <p class="muted" id="entry-hint" style="margin-top:10px;font-size:.84rem;"></p>
    </div>

    <div class="panel">
      <h3>History</h3>
      ${entries.length ? `<table><thead><tr><th>Date</th><th>Kind</th><th>Category</th><th>Narrative</th><th class="right">Amount</th><th></th></tr></thead><tbody>
        ${entries.map((e) => `<tr>
          <td>${fmtDate(e.date)}</td><td>${kindPill(e)}</td>
          <td>${esc(e.category)}</td><td class="muted">${esc(e.narrative)}</td>
          <td class="right">${amountCell(e)}</td>
          <td class="right"><button class="btn danger" data-del="${e.id}">✕</button></td>
        </tr>`).join('')}
      </tbody></table>` : '<p class="empty">No entries yet.</p>'}
    </div>`;

  const kindSel = $('#kind-sel');
  const curField = $('#cur-field');
  const rateLabel = $('#rate-field');
  const hint = $('#entry-hint');
  const syncForm = () => {
    const k = kindSel.value;
    const cur = $('select[name=currency]').value;
    curField.style.display = k === 'transfer' ? 'none' : '';
    rateLabel.querySelector('input').required = k === 'transfer';
    if (k === 'transfer') {
      rateLabel.querySelector('span, label')?.remove();
      hint.textContent = 'Transfer: enter AED to send + the exchange rate. It subtracts AED and adds AED×rate to your INR balance.';
    } else if (cur === 'AED') {
      hint.textContent = 'AED income/expense. Add the receive rate to record the ₹-equivalent (AED × rate). e.g. salary 3320.75 AED @ 26.5 = ₹88,000.';
    } else {
      hint.textContent = 'INR income/expense credited/debited directly to your INR balance.';
    }
  };
  kindSel.onchange = syncForm;
  $('select[name=currency]').onchange = syncForm;
  syncForm();

  $('#entry-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await api('/api/entries', { method: 'POST', body: {
      kind: f.get('kind'), currency: f.get('currency'), category: f.get('category'),
      narrative: f.get('narrative'), amount: parseFloat(f.get('amount')),
      rate: parseFloat(f.get('rate')) || 0, date: f.get('date') } });
    render();
  };
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (confirm('Delete this entry?')) { await api('/api/entries/' + b.dataset.del, { method: 'DELETE' }); render(); }
  });
};

// ---------- Debts ----------
views.debts = async () => {
  const debts = await api('/api/debts');
  const groups = { paying: [], not_decided: [], not_possible: [], closed: [] };
  debts.forEach((d) => groups[d.status].push(d));

  const row = (d) => `<tr>
    <td>${esc(d.source)} <span class="pill ${d.currency === 'AED' ? 'soon' : ''}" style="margin-left:4px;">${d.currency}</span></td>
    <td class="right"><b>${money(d.remaining, d.currency)}</b></td>
    <td class="right">${d.emi ? money(d.emi, d.currency) : (d.notes ? `<span class="muted">${esc(d.notes)}</span>` : '—')}</td>
    <td class="right">${d.remaining_months || '—'}</td>
    <td>${d.monthly_interest ? `<span style="color:var(--red)">${money(d.monthly_interest, d.currency)}/mo</span>` : '—'}</td>
    <td class="right">
      ${d.status === 'paying' ? `<button class="btn small" data-pay="${d.id}">Pay</button>` : ''}
      <button class="btn ghost small" data-edit="${d.id}">Edit</button>
      <button class="btn danger" data-del-d="${d.id}">✕</button>
    </td></tr>`;

  const section = (key) => groups[key].length ? `<div class="panel">
    <h3>${STATUS_LABEL[key]} (${groups[key].length})</h3>
    <table><thead><tr><th>Source</th><th class="right">Remaining</th><th class="right">EMI / note</th><th class="right">Months</th><th>Interest</th><th></th></tr></thead>
    <tbody>${groups[key].map(row).join('')}</tbody></table></div>` : '';

  app.innerHTML = `
    <div class="panel-head"><h2 style="margin:0;">Debts</h2>
      <div style="display:flex;gap:8px;">
        <button class="btn ghost" id="import-btn">Import CSV</button>
        <button class="btn" id="add-btn">+ Add debt</button>
      </div></div>
    ${debts.length ? '' : '<p class="empty">No debts yet. Add one or import your CSV.</p>'}
    ${section('paying')}${section('not_decided')}${section('not_possible')}${section('closed')}`;

  $('#add-btn').onclick = () => debtModal();
  $('#import-btn').onclick = importModal;
  app.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => payModal(debts.find((d) => d.id == b.dataset.pay)));
  app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => debtModal(debts.find((d) => d.id == b.dataset.edit)));
  app.querySelectorAll('[data-del-d]').forEach((b) => b.onclick = async () => {
    if (confirm('Delete this debt?')) { await api('/api/debts/' + b.dataset.delD, { method: 'DELETE' }); render(); }
  });
};

function debtModal(d) {
  const v = d || { source: '', remaining: '', emi: '', remaining_months: '', currency: 'INR', monthly_interest: 0, status: 'paying', start_month: thisMonth(), notes: '' };
  const opt = (val, label, sel) => `<option value="${val}" ${sel === val ? 'selected' : ''}>${label}</option>`;
  openModal(d ? 'Edit debt' : 'Add debt', `
    <form class="grid" id="debt-form">
      <label class="field" style="grid-column: span 2;">Source<input name="source" value="${esc(v.source)}" required /></label>
      <label class="field">Currency<select name="currency">${opt('INR', '₹ INR', v.currency)}${opt('AED', 'AED', v.currency)}</select></label>
      <label class="field">Status<select name="status">
        ${opt('paying', 'Paying', v.status)}${opt('not_decided', 'Not decided', v.status)}${opt('not_possible', 'Not possible', v.status)}${opt('closed', 'Closed', v.status)}</select></label>
      <label class="field">Remaining<input name="remaining" type="number" step="0.01" value="${v.remaining}" required /></label>
      <label class="field">EMI / month<input name="emi" type="number" step="0.01" value="${v.emi}" /></label>
      <label class="field">Remaining months<input name="remaining_months" type="number" value="${v.remaining_months}" /></label>
      <label class="field">Start month<input name="start_month" type="month" value="${v.start_month || thisMonth()}" /></label>
      <label class="field">Interest /mo (optional)<input name="monthly_interest" type="number" step="0.01" value="${v.monthly_interest}" /></label>
      <label class="field" style="grid-column: span 2;">Notes<input name="notes" value="${esc(v.notes)}" /></label>
      <button class="btn" type="submit">${d ? 'Save' : 'Add'}</button>
    </form>`, (close) => {
    $('#debt-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const body = {
        source: f.get('source'), currency: f.get('currency'), status: f.get('status'),
        remaining: parseFloat(f.get('remaining')) || 0, emi: parseFloat(f.get('emi')) || 0,
        remaining_months: parseInt(f.get('remaining_months')) || 0,
        start_month: f.get('start_month'), monthly_interest: parseFloat(f.get('monthly_interest')) || 0,
        notes: f.get('notes'),
      };
      if (d) await api('/api/debts/' + d.id, { method: 'PATCH', body });
      else await api('/api/debts', { method: 'POST', body });
      close(); render();
    };
  });
}

function payModal(d) {
  openModal(`Record payment — ${d.source}`, `
    <p class="muted" style="margin-bottom:14px;">Remaining: <b>${money(d.remaining, d.currency)}</b>${d.emi ? ' · EMI ' + money(d.emi, d.currency) : ''}</p>
    <form class="grid" id="pay-form">
      <label class="field">Amount<input name="amount" type="number" step="0.01" min="0" value="${(d.emi || d.remaining).toFixed ? (d.emi || d.remaining).toFixed(0) : (d.emi || d.remaining)}" required /></label>
      <label class="field">Date<input name="date" type="date" value="${today()}" required /></label>
      <label class="field" style="grid-column: span 2;">Note<input name="note" placeholder="optional" /></label>
      <button class="btn" type="submit">Save payment</button>
    </form>`, (close) => {
    $('#pay-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      await api(`/api/debts/${d.id}/payments`, { method: 'POST', body: {
        amount: parseFloat(f.get('amount')), date: f.get('date'), note: f.get('note') } });
      close(); render();
    };
  });
}

function importModal() {
  openModal('Import debts from CSV', `
    <p class="muted" style="margin-bottom:12px;">Paste your "Budgeting - Debt" CSV (with Source, Remaining, EMI, Remaining Month columns). AED detected from the source name; "Not paid/decided/asking" and "Not possible" become statuses automatically.</p>
    <textarea id="csv-text" rows="8" style="width:100%;" placeholder="Source,Remaining,Equated Monthly Installment,Remaining Month,..."></textarea>
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0;font-size:.88rem;">
      <input type="checkbox" id="csv-replace" /> Replace all existing debts</label>
    <button class="btn" id="csv-go">Import</button>
    <span id="csv-msg" class="muted" style="margin-left:10px;"></span>`, (close) => {
    $('#csv-go').onclick = async () => {
      const csv = $('#csv-text').value.trim();
      if (!csv) { $('#csv-msg').textContent = 'Paste CSV first.'; return; }
      try {
        const r = await api('/api/debts/import', { method: 'POST', body: { csv, replace: $('#csv-replace').checked } });
        $('#csv-msg').textContent = `Imported ${r.imported} rows.`;
        setTimeout(() => { close(); render(); }, 700);
      } catch (e) { $('#csv-msg').textContent = 'Error: ' + e.message; }
    };
  });
}

// ---------- Calendar ----------
let calRef = new Date();
views.calendar = async () => {
  const debts = await api('/api/debts');
  const events = {}; // YYYY-MM -> [{source, amount, currency}]
  debts.forEach((d) => d.schedule.forEach((s) => {
    (events[s.month] = events[s.month] || []).push({ source: d.source, amount: s.amount, currency: d.currency });
  }));

  const y = calRef.getFullYear(), m = calRef.getMonth();
  const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthName = calRef.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const evs = events[ym] || [];
  const tot = evs.reduce((a, e) => { a[e.currency] = (a[e.currency] || 0) + e.amount; return a; }, {});

  app.innerHTML = `
    <h2>Payment Calendar</h2>
    <div class="panel">
      <div class="panel-head">
        <button class="btn ghost small" id="prev">← Prev</button>
        <h3 style="margin:0;">${monthName}</h3>
        <button class="btn ghost small" id="next">Next →</button>
      </div>
      ${evs.length ? `<table><thead><tr><th>Source</th><th class="right">EMI due</th></tr></thead><tbody>
        ${evs.map((e) => `<tr><td>${esc(e.source)}</td><td class="right">${money(e.amount, e.currency)}</td></tr>`).join('')}
        <tr><td><b>Total</b></td><td class="right"><b>${Object.entries(tot).map(([c, v]) => money(v, c)).join(' + ')}</b></td></tr>
      </tbody></table>` : '<p class="empty">No EMIs scheduled this month.</p>'}
    </div>`;
  $('#prev').onclick = () => { calRef = new Date(y, m - 1, 1); render(); };
  $('#next').onclick = () => { calRef = new Date(y, m + 1, 1); render(); };
};

// ---------- Chat (Claude Max via local CLI) ----------
const chatLog = [];
function toggleChat(open) {
  const panel = $('#chat-panel');
  panel.classList.toggle('open', open ?? !panel.classList.contains('open'));
}
function renderChat() {
  $('#chat-messages').innerHTML = chatLog.map((m) =>
    `<div class="chat-msg ${m.role}">${m.role === 'assistant' ? m.text : esc(m.text)}</div>`).join('');
  const box = $('#chat-messages'); box.scrollTop = box.scrollHeight;
}
async function sendChat() {
  const input = $('#chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  chatLog.push({ role: 'user', text: msg });
  chatLog.push({ role: 'assistant', text: '<span class="muted">Thinking… (Claude Max)</span>' });
  input.value = ''; renderChat();
  try {
    const r = await api('/api/chat', { method: 'POST', body: { message: msg } });
    chatLog[chatLog.length - 1] = { role: 'assistant', text: esc(r.reply).replace(/\n/g, '<br>') };
  } catch (e) {
    chatLog[chatLog.length - 1] = { role: 'assistant', text: '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>' };
  }
  renderChat();
}
function mountChat() {
  document.body.insertAdjacentHTML('beforeend', `
    <button id="chat-fab" title="Ask Claude about your finances">💬 Ask Claude</button>
    <div id="chat-panel">
      <div class="chat-head"><b>Finance Assistant</b><span class="muted" style="font-size:.75rem;"> · Claude Max</span>
        <button class="btn ghost small" id="chat-close" style="margin-left:auto;">✕</button></div>
      <div id="chat-messages"><div class="chat-msg assistant">Hi! Ask me anything about your income, expenses, or debts — e.g. "How much EMI do I owe next month?" or "Which debt should I clear first?"</div></div>
      <div class="chat-input-row">
        <textarea id="chat-input" rows="1" placeholder="Ask about your finances…"></textarea>
        <button class="btn" id="chat-send">Send</button>
      </div>
    </div>`);
  $('#chat-fab').onclick = () => toggleChat();
  $('#chat-close').onclick = () => toggleChat(false);
  $('#chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

mountChat();
render();
