# Salem Academy CBT Exam App

Production-ready React + Vite CBT platform with an Express backend and an admin dashboard.

## Features

- Student login with full name and class selection (`JSS1 A` to `SS2 D`)
- Student email collection for result communication
- 25-minute fixed exam timer
- 40 questions served per candidate, randomized from pool
- One-question-per-screen flow + question palette (Answered, Unanswered, Flagged, Unread)
- Fullscreen exam mode + browser proctoring violations
- Server-side scoring with violation penalty
- Session recovery after refresh
- Guided student tour
- Admin dashboard at `/admin`
- Dashboard analytics (completion, score distribution, class performance, violation trends)
- Session filters (search, class, status)
- Export center (sessions/questions in CSV and JSON)
- Email-only export for local mailing workflows
- Add-question form for expanding the pool

## Question Pool

The default pool now includes 40 beginner-level questions focused on:

- Computer basics and internet/web basics
- 10 computer navigation questions (right-click, folder actions, simple shortcuts)
- 5 VS Code questions (Explorer, open folder, save, new file)

Pool is persisted in `server/data/questions.json` and loaded from `server/questions.js` defaults only on first run.

## Tech Stack

- Frontend: React + Vite
- Backend: Express + Helmet + CORS
- Storage:
  - Sessions: `server/data/sessions.json`
  - Question pool: `server/data/questions.json`

## Run Locally

1. Install dependencies

```bash
npm install
```

2. Start frontend + backend together

```bash
npm run dev
```

- Student app: `http://localhost:5173`
- Admin dashboard: `http://localhost:5173/admin`
- Backend API: `http://localhost:4000`

Vite proxies `/api` to backend during development.

## Admin Login

Admin login uses a hashed passcode from environment (`ADMIN_PASSCODE_HASH`).

Generate a hash:

```bash
npm run hash:admin -- "your-strong-password"
```

Then add the output to `.env`:

```env
ADMIN_PASSCODE_HASH=scrypt$16384$8$1$...$...
```

If `ADMIN_PASSCODE_HASH` is missing, admin login is disabled.

## Production Build

```bash
npm run build
npm run start
```

If `dist` exists, Express serves the frontend and supports SPA routes (including `/admin`).

## API Overview

Student APIs:

- `GET /api/exam/meta`
- `POST /api/exam/start`
- `GET /api/exam/:sessionId`
- `POST /api/exam/:sessionId/seen`
- `POST /api/exam/:sessionId/answer`
- `POST /api/exam/:sessionId/flag`
- `POST /api/exam/:sessionId/proctor`
- `POST /api/exam/:sessionId/submit`
- `POST /api/exam/:sessionId/feedback`

Admin APIs:

- `POST /api/admin/login`
- `GET /api/admin/overview`
- `GET /api/admin/sessions`
- `GET /api/admin/sessions/:sessionId`
- `GET /api/admin/questions`
- `POST /api/admin/questions`
- `GET /api/admin/export/sessions.csv`
- `GET /api/admin/export/sessions.json`
- `GET /api/admin/export/emails.csv`
- `GET /api/admin/export/questions.csv`
- `GET /api/admin/export/questions.json`

## Local Mailer

A standalone local mailer lives in `local-mailer/` and is not part of the deployed CBT app.

```bash
cd local-mailer
npm install
npm run dev
```

Then open `http://localhost:5050`.

## Notes

- Browser proctoring is best-effort and not equivalent to OS-level lockdown software.
- Keep `.env` out of source control and never commit admin hashes.
# salemexams
