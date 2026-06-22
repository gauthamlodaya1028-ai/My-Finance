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

(No chat endpoint — chat was removed. PDF export is client-side via jsPDF in [public/app.js](public/app.js) `exportPdf()`.)

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

## 8. Chat — REMOVED (replaced by PDF export)

The Claude chat assistant was **removed** (it needed the local `claude` CLI, which can't run on
Hostinger Cloud's managed Node.js, and the goal was a no-API-cost setup). In its place, the app
has a floating **Export PDF** button → `exportPdf()` in [public/app.js](public/app.js), which
builds a summary report (totals, debts, monthly commitments) **client-side with jsPDF +
autotable** (loaded via CDN in `index.html`). Uses "Rs " not ₹ in the PDF (jsPDF's built-in
fonts lack the ₹ glyph). No server endpoint, no API key, no cost.

<details><summary>Historical: the old chat implementation</summary>

It built a context blob and called Claude via the Anthropic API, an OAuth token, or the local
`claude` CLI. All of that code, the `@anthropic-ai/sdk` dep, and the `/api/chat` route are gone.
</details>

### (old chat notes below are obsolete)

Builds a context blob (balances + debts + recent entries) and asks Claude. Three auth
paths, chosen by env (see [.env.example](.env.example)); the boot log prints which one
(`chat=api|oauth|cli`):

1. **`ANTHROPIC_API_KEY`** set → Anthropic API via `@anthropic-ai/sdk`, model `CHAT_MODEL`
   (default `claude-opus-4-8`; owner picked `claude-sonnet-4-6`). Pay-per-use, reliable on a server.
2. **`ANTHROPIC_AUTH_TOKEN`** set → OAuth bearer token + `anthropic-beta: oauth-2025-04-20`.
   ⚠️ short-lived (~1h), **not auto-refreshed here** — only useful for short sessions.
3. **Neither set → spawns the local `claude` CLI** (`claude -p`). This is the owner's chosen
   path for hosting: the CLI holds a **refresh token** and renews OAuth itself, so it "stays
   logged in" indefinitely on a subscription account. Selectable via:
   - `CLAUDE_BIN` — absolute path if `claude` isn't on PATH.
   - `CLAUDE_CONFIG_DIR` — which logged-in account/subscription to use (isolates the app's
     chat account from any other login on the host).

> The owner runs the CLI on a host already (30+ days). To put a specific subscription account
> behind the app: `CLAUDE_CONFIG_DIR=DIR claude` → `/login` once (browser), copy `DIR` to the
> host, set `CLAUDE_CONFIG_DIR`. See [DEPLOY.md](DEPLOY.md) → "Chat via a subscription".
> **Do NOT** automate/scrape claude.ai in a browser/Electron — against Anthropic's terms,
> brittle, and risks the account. OAuth/CLI is the sanctioned "log in once, persists" path.

---

## 9. Hosting — already built (dual-mode), pending verification

The app is **deploy-ready** and switches behavior by env var. Full steps: **[DEPLOY.md](DEPLOY.md)**.

- **DB**: SQLite locally; Supabase **Postgres** when `DATABASE_URL` is set. One async layer in
  [db.js](db.js) (`q`/`one`, `$N` placeholders, portable schema, SSL on the pool). Schema
  auto-creates on boot via `init()`.
- **Data migration**: [migrate-to-postgres.js](migrate-to-postgres.js) copies the local
  `finance.db` rows into Supabase (ids preserved, sequences fixed). Run once with `DATABASE_URL` set.
- **Auth**: Supabase Auth (magic link) when `SUPABASE_URL` is set; **off** locally. Backend
  verifies the JWT on every `/api` route except `/api/config` + `/api/health`; restricted to
  `ALLOWED_EMAIL`. Frontend gate in [public/app.js](public/app.js) (`boot()` / `showLogin`).
- **Host**: Hostinger "Node.js Web App" from GitHub (owner has Cloud Startup). Supabase is only
  DB+auth; Hostinger runs the Node server. App reads `process.env.PORT`.

**Status (2026-06): owner is testing LOCALLY first** (SQLite + no auth + CLI chat). The Postgres +
auth path is built but **not yet verified against the real Supabase** — that needs the owner's
pooler `DATABASE_URL` (port 6543) and a one-time `migrate-to-postgres.js` run. Don't claim the
PG path works until it's been run live.

---

## 10. Backlog / not yet built

- **Earning CSV import** — owner's Earning sheet is key-value, needs a custom parser.
- **Monthly earning summary** — per month: AED received / transferred / ₹ landed / blended rate.
- **Streaming chat** replies.
- **Edit** for ledger entries and recurring (currently add/delete only).
- **House rent** recurring expense: owner said AED 4,000 from December, but is relocating to India
  by ~November — currency/continuity was left undecided. Confirm before adding.
- **Verify the Supabase Postgres + auth path live** (built, not yet run against real Supabase — see §9).

(Auth, Postgres dual-mode, API/OAuth/CLI chat, CSV import, data-migration script — **built**.)

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
2. `npm install && npm start`, open http://localhost:3000. With no real env, runs **local mode**:
   SQLite + no auth + chat via local `claude` CLI (boot log shows `[db=sqlite, auth=false, chat=cli]`).
3. Chat needs the local `claude` CLI (or set `ANTHROPIC_API_KEY`); see §8.
4. **Owner is testing locally right now.** When ready to host: fill `.env` and follow
   [DEPLOY.md](DEPLOY.md) — the same code switches to Supabase Postgres + auth automatically.
   A `.env` exists with empty values (harmless; reads as local mode).
