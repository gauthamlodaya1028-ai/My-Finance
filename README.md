# My Finance

A personal finance web app: track **income & expenses**, manage **debts & receivables**,
record **payments**, watch a **debt calendar**, and get **reminders** for what's due.

## Features
- **Dashboard** — total income, expense, cash balance, money you owe vs. owed to you, net position, income-vs-expense chart, and reminders.
- **Income / Expense ledger** — log salary, incentives, side earnings, expenses — each with a category, narrative, amount and date.
- **Debts & Receivables** — track money you owe (payable) and money owed to you (receivable), with optional annual simple interest and due dates. Record full/part payments; items auto-close when settled.
- **Calendar** — month view of every due date, color-coded by type.
- **Reminders** — overdue and due-in-7-days items surfaced on the dashboard.

## Tech
- Backend: Node + Express, REST API
- Database: SQLite (single `finance.db` file — no DB server to install)
- Frontend: plain HTML/CSS/JS (no build step)

## Run
```bash
npm install
npm start
```
Open http://localhost:3000

Data lives in `finance.db` in this folder. Back it up by copying that file.
```
