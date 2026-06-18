# My Finance — Project Handoff

> Read this first if you are a new Claude session / developer taking over this project.
> It captures everything not obvious from the code: architecture, the real-world
> business logic, decisions made, and the plan to host on Supabase.

---

## 1. What this app is

A personal finance web app for **one user** (the owner) to track:

- **Earnings & expenses** across **two currencies (INR + AED)** with a two-rate
  currency loop (see §4 — this is the most important domain concept).
- **Debts** modelled around **EMI / currency / status**, with a forward payment schedule.
- **Variable interest** (e.g. a credit card whose interest changes monthly and is paid twice a month).
- **Recurring monthly expenses** (rent, subscriptions).
- A **dashboard**, a **monthly-commitments calendar**, and a **chat assistant**.

The owner earns a salary/incentive that is **decided in INR but paid in AED** in Dubai,
then **transfers AED → INR** (at a different exchange rate) into an Indian account to pay EMIs.
He is planning to relocate to India (~Nov 2026). The app's currency model exists to track this.

---

## 2. Current tech stack (dual-mode: local + production)

| Layer    | Choice |
|----------|--------|
| Runtime  | Node.js (ESM, `"type":"module"`) |
| Server   | Express ([server.js](server.js)), fully async |
| Database | **SQLite** (`better-sqlite3`) locally; **Supabase Postgres** (`pg`) when `DATABASE_URL` is set. One async query layer in [db.js](db.js) (`q`/`one`, `$N` placeholders). |
| Auth     | **Supabase Auth** (magic link) when `SUPABASE_URL` is set; **off** locally. Backend verifies JWT per request; frontend gate in [public/app.js](public/app.js). |
| Frontend | Plain HTML/CSS/JS, no build step ([public/](public/)); Supabase JS from CDN |
| Chat     | **Anthropic API** (`@anthropic-ai/sdk`, `CHAT_MODEL`, default `claude-opus-4-8`) when `ANTHROPIC_API_KEY` is set; falls back to the local **`claude` CLI** otherwise |

Run locally (zero config → SQLite, no auth, chat via CLI):
```bash
npm install
npm start          # http://localhost:3000
```
Production is all env-driven — see [.env.example](.env.example) and **[DEPLOY.md](DEPLOY.md)**.
`finance.db` and `.env` are **gitignored**. Move local data to Postgres with
`node migrate-to-postgres.js` (needs `DATABASE_URL`).

---

## 3. File map

- [server.js](server.js) — all REST endpoints + business logic (interest, schedules, balances, chat).
- [db.js](db.js) — schema + idempotent migrations (runs on every boot).
- [public/index.html](public/index.html) — shell + tab nav.
- [public/app.js](public/app.js) — entire SPA (views: dashboard, ledger, debts, calendar; chat panel).
- [public/styles.css](public/styles.css) — dark theme.

---

## 4. ★ Domain logic you MUST understand before changing anything

### 4.1 Two-currency, two-rate earning loop
```
INR (decided) ──÷ receive rate──▶ AED (Dubai acct) ──× transfer rate──▶ INR (India acct) ──▶ EMIs
```
- Salary is **decided in INR** (e.g. ₹88,000) but **received in AED** at a "receive rate"
  (e.g. 26.5 ₹/AED → 3,320.75 AED).
- Later, AED is **transferred to INR** at a *different* "transfer rate".
- The app keeps **two running balances**: `INR on hand` (pays EMIs) and `AED on hand` (Dubai).

### 4.2 Ledger entries (`entries` table)
Each entry has `kind` ∈ {`income`, `expense`, `transfer`} and **two currency fields**:
- `currency` = the currency the **amount is typed in**.
- `recv_currency` = the currency it **lands in** (which balance is credited/debited).
- `rate` = ₹ per AED, required when `currency != recv_currency`.

Conversion (`recvAmount` in server.js):
- INR→AED: `amount / rate`
- AED→INR: `amount * rate`
- same: `amount`

A **transfer** is forced to AED→INR (`currency=AED`, `recv_currency=INR`): subtracts AED, adds `amount*rate` INR.

`inr_value` is an INR-equivalent used only for the dashboard chart/totals (not balances).

### 4.3 Debts (`debts` table)
- `status` ∈ {`paying`, `not_decided`, `not_possible`, `closed`}.
  - `not_decided` = informal family/friend debts ("they're asking", no plan).
  - `not_possible` = e.g. Nizam's card — interest-only, principal not being cleared.
- EMI schedule (`scheduleFor`): for `paying` debts, projects `emi` for `remaining_months`
  from `start_month`, capping the final month at the leftover balance.
- `remaining` is the **live outstanding**; a logged payment reduces it and decrements `remaining_months`,
  auto-closing at ~0.
- **Currency** is per-debt (INR or AED). AED is auto-detected on CSV import from the source name.

### 4.4 Variable interest (the Nizam case)
- `monthly_interest` = an **editable estimate** (forecast only).
- `interest_days` = comma list, e.g. `"20,30"` → the calendar shows **two** interest reminders
  that month, each `monthly_interest / count`, flagged `estimate:true`.
- **Actual** interest is logged per occurrence in `interest_payments` (variable amount + date).
  Logged interest **draws down `INR on hand`** (real cash out) and **never touches principal**.
- `summary.interestPaidTotal` = total INR interest actually paid.

### 4.5 Monthly commitments
`commitmentsForMonth(ym)` = EMIs (that month) + debt interest (split across `interest_days`,
for months ≥ current) + `recurring` expenses active that month. The dashboard shows a 12-month
horizon; the calendar shows one month at a time. Endpoint: `GET /api/commitments/:YYYY-MM`.

---

## 5. Data model (SQLite tables)

- **entries** — `id, kind, currency, recv_currency, category, narrative, amount, rate, date, created_at`
- **debts** — `id, source, direction(payable/receivable), remaining, emi, remaining_months, currency, monthly_interest, interest_days, status, start_month, notes, created_at`
- **payments** — `id, debt_id→debts, amount, date, note` (principal payments)
- **interest_payments** — `id, debt_id→debts, amount, date, note` (variable interest, no principal effect)
- **recurring** — `id, label, amount, currency, category, start_month, end_month(null=ongoing), created_at`

`db.js` migrations are additive and idempotent (e.g. it ALTERs in `recv_currency` and `interest_days`
on older DBs). Keep that pattern.

---

## 6. API surface (all JSON)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/entries` | list / create ledger entry |
| DELETE | `/api/entries/:id` | delete entry |
| GET/POST | `/api/debts` | list (with computed schedule) / create |
| PATCH/DELETE | `/api/debts/:id` | update / delete |
| POST | `/api/debts/import` | import CSV (`{csv, replace, start_month}`) |
| GET/POST | `/api/debts/:id/payments` | principal payments |
| DELETE | `/api/payments/:id` | delete payment |
| GET/POST | `/api/debts/:id/interest` | variable interest log |
| DELETE | `/api/interest/:id` | delete interest entry |
| GET/POST | `/api/recurring` | recurring expenses |
| DELETE | `/api/recurring/:id` | delete recurring |
| GET | `/api/commitments/:month` | commitments for a month |
| GET | `/api/summary` | dashboard aggregates + balances |
| POST | `/api/chat` | `{message}` → Claude reply (see §8) |

---

## 7. CSV import format (debts)

Matches the owner's "Budgeting - Debt" sheet. Columns:
`Source, Remaining, Equated Monthly Installment, Remaining Month, <month columns…>`
- AED detected from `/aed/i` in the source name.
- "Not Paid / Not Decided / asking" → `not_decided`; "Not Possible" → `not_possible`
  (and `55k` style interest text is parsed into `monthly_interest`).
- Importer takes a `start_month` so the schedule begins the right month.

The owner's **Earning** CSV is a key-value layout (not rows) — **no importer built yet** (see §10).

---

## 8. ★ Chat assistant — and why it breaks when hosted

`POST /api/chat` builds a context blob (balances + debts + recent entries) and **spawns the
local `claude` CLI** (`claude -p`). This uses the **owner's Claude Max subscription**, so it is
free of API cost — BUT it only works on a machine where the `claude` CLI is installed and logged in.

**When you host this on a server, the CLI path will NOT work.** Choose one:
- **(A) Anthropic API** — replace the `spawn('claude', ['-p'])` block with an Anthropic SDK call
  using `ANTHROPIC_API_KEY` (paid per token). Model id e.g. `claude-opus-4-8` or a cheaper Sonnet/Haiku.
- **(B) Disable chat in production** — guard the route behind an env flag and hide the FAB.
- **(C) Self-host the CLI** — only if your host lets you install + auth the `claude` CLI (most don't).

Recommended for hosting: **(A)** with a small/cheap model, or **(B)** if cost matters.

---

## 9. ★ Hosting plan (Supabase + a Node host)

A Supabase project already exists (owner created it). To go live:

### 9.1 Move the DB from SQLite → Supabase Postgres
1. Get the Supabase **connection string** (Project → Settings → Database → Connection string / URI)
   and/or the **service-role key** + project URL.
2. Recreate the 5 tables in Postgres. SQL is a near-direct port; differences to handle:
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY` (or `serial`).
   - `datetime('now')` defaults → `now()`.
   - `substr(date,1,7)` (used in the summary chart) → `to_char(date::date,'YYYY-MM')` or `left(date,7)`.
   - Keep `date`/month fields as `text` (app stores `YYYY-MM-DD` / `YYYY-MM`) to minimise churn,
     or migrate to real `date` and update the few string comparisons.
3. Swap the data layer: replace `better-sqlite3` with either
   - the **`pg`** client / **`postgres`** lib using the connection string, **or**
   - the **`@supabase/supabase-js`** client.
   Centralise this in `db.js`; the route handlers mostly do simple queries.
   ⚠️ `better-sqlite3` is **synchronous**; Postgres clients are **async**. Every `db.prepare(...).get/all/run`
   becomes `await`. The route handlers already use the `wrap()` helper which supports async — good.
4. Set env vars on the host: `DATABASE_URL` (and `ANTHROPIC_API_KEY` if using chat path A).

### 9.2 Pick a host
- The frontend is static; the backend is a small Express app. Any Node host works
  (Render, Railway, Fly.io, a VPS). **Supabase itself does not run your Node server** —
  it's only the database (and optionally auth/storage). So: Node host + Supabase Postgres.
- Set `PORT` from env (already supported: `process.env.PORT || 3000`).

### 9.3 Add auth before exposing it publicly
Right now there is **no authentication** — anyone with the URL sees/edits all data.
This is fine on localhost, **not** fine when hosted. Options:
- Supabase Auth (email magic link) + Row Level Security, or
- A simple single-user password / basic-auth middleware (fastest for one user).
**Do not deploy publicly without this.**

---

## 10. Backlog / not yet built

- **Earning CSV import** — owner's Earning sheet is key-value, needs a custom parser.
- **Monthly earning summary** — per month: AED received / transferred / ₹ landed / blended rate.
- **Streaming chat** replies.
- **Edit** for ledger entries and recurring (currently add/delete only).
- **Auth** (required before hosting — see §9.3).
- **House rent** recurring expense: owner said AED 4,000 from December, but is relocating to India
  by ~November — currency/continuity was left undecided. Confirm before adding.

---

## 11. Known data notes / decisions

- Debts were imported with **`start_month = 2026-07`** because June 2026 was already paid;
  the sheet balances are the **July-1 position** (owner confirmed — do not re-deduct June).
- **Hitesh Bhai AED**: sheet had EMI 25,000 on a 2,000 balance (typo). Corrected EMI → **1,000**
  (2 months). If you re-import with "replace", re-apply this fix.
- **Nizam's ICICI card**: `not_possible`, `monthly_interest` 55,000 estimate, `interest_days="20,30"`.
  Interest is variable — owner logs actuals via the Interest button.
- Currency formatting: INR shown as `₹`, AED as `AED ` (see `money()` / `CUR` in app.js).

---

## 12. Git / GitHub

- Repo: **https://github.com/gauthamlodaya1028-ai/My-Finance**
- ⚠️ The local machine's git is authenticated as a **different** GitHub account
  (`aryanshahmarketer-design`), added as a **collaborator** so pushes work. The repo owner is
  `gauthamlodaya1028-ai`. If pushes 403, that's the cause — re-auth or keep the collaborator.
- `finance.db*` and `node_modules/` are gitignored.

---

## 13. Quick orientation for a new Claude session

1. Read this file + [server.js](server.js) (logic) + [public/app.js](public/app.js) (UI).
2. `npm install && npm start`, open http://localhost:3000.
3. The chat needs the local `claude` CLI; if absent, that one feature is down (see §8).
4. Before hosting: do §9 (Postgres swap + auth + chat path). Everything else already works locally.
