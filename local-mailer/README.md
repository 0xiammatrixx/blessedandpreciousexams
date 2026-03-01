# Local Mailer (Standalone)

This folder is intentionally separate from the CBT app.

## Purpose

- Paste exported student email list
- Generate a reusable draft
- Optionally send a batch mail through your local SMTP config

## Setup

```bash
cd local-mailer
npm install
```

## Run

```bash
npm run dev
```

Open: `http://localhost:5050`

## SMTP Env (optional for send)

Create `local-mailer/.env` and set:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@example.com
SMTP_PASS=your-password-or-app-password
SMTP_FROM=you@example.com
PORT=5050
```

If SMTP variables are missing, preview still works but send is disabled.

## Workflow

1. Export emails from admin dashboard (`Export Emails Only CSV`).
2. Paste the CSV content (or raw emails) into the local mailer.
3. Generate draft preview.
4. Send from local mailer using your SMTP details.
