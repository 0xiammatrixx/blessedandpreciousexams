import express from 'express';
import nodemailer from 'nodemailer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 5050);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function extractEmails(rawText) {
  const ignoredTokens = new Set(['email', 'emails']);
  const tokens = String(rawText ?? '')
    .split(/[\n,;\t\s]+/)
    .map((token) => normalizeEmail(token))
    .filter((token) => token && !ignoredTokens.has(token));

  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const token of tokens) {
    if (!isValidEmail(token)) {
      invalid.push(token);
      continue;
    }

    if (seen.has(token)) {
      continue;
    }

    seen.add(token);
    valid.push(token);
  }

  return {
    valid,
    invalid,
  };
}

function createDraft({ emails, subject, message }) {
  return [
    `Subject: ${subject}`,
    '',
    `BCC (${emails.length}):`,
    emails.join(', '),
    '',
    'Message:',
    message,
  ].join('\n');
}

function getTransportConfig() {
  const host = process.env.SMTP_HOST ?? '';
  const port = Number(process.env.SMTP_PORT ?? '587');
  const user = process.env.SMTP_USER ?? '';
  const pass = process.env.SMTP_PASS ?? '';
  const from = process.env.SMTP_FROM ?? user;

  if (!host || !port || !user || !pass || !from) {
    return null;
  }

  return {
    host,
    port,
    secure: String(process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    auth: { user, pass },
    from,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/api/preview', (req, res) => {
  const subject = String(req.body?.subject ?? '').trim();
  const message = String(req.body?.message ?? '').trim();

  if (!subject || !message) {
    res.status(400).json({ error: 'Subject and message are required.' });
    return;
  }

  const { valid, invalid } = extractEmails(req.body?.emailsText ?? '');
  if (!valid.length) {
    res.status(400).json({ error: 'No valid email addresses found in pasted content.', invalid });
    return;
  }

  res.json({
    ok: true,
    validCount: valid.length,
    invalid,
    emails: valid,
    draft: createDraft({ emails: valid, subject, message }),
  });
});

app.post('/api/send', async (req, res) => {
  const config = getTransportConfig();
  if (!config) {
    res.status(503).json({
      error: 'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.',
    });
    return;
  }

  const subject = String(req.body?.subject ?? '').trim();
  const message = String(req.body?.message ?? '').trim();
  if (!subject || !message) {
    res.status(400).json({ error: 'Subject and message are required.' });
    return;
  }

  const { valid, invalid } = extractEmails(req.body?.emailsText ?? '');
  if (!valid.length) {
    res.status(400).json({ error: 'No valid email addresses found in pasted content.', invalid });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  try {
    const info = await transporter.sendMail({
      from: config.from,
      to: config.from,
      bcc: valid,
      subject,
      text: message,
    });

    res.json({
      ok: true,
      sentCount: valid.length,
      invalid,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Failed to send email batch.',
      invalid,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Local mailer running on http://localhost:${PORT}`);
});
