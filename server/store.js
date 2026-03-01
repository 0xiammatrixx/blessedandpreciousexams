import { promises as fs } from 'node:fs';
import path from 'node:path';

const STORE_DIR = path.resolve(process.cwd(), 'server', 'data');
const STORE_FILE = path.join(STORE_DIR, 'sessions.json');

let db = { sessions: {} };
let initialized = false;
let writeQueue = Promise.resolve();

async function ensureInitialized() {
  if (initialized) {
    return;
  }

  await fs.mkdir(STORE_DIR, { recursive: true });

  try {
    const existing = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && parsed.sessions) {
      db = parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    await fs.writeFile(STORE_FILE, JSON.stringify(db, null, 2), 'utf8');
  }

  initialized = true;
}

function persist() {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(STORE_FILE, JSON.stringify(db, null, 2), 'utf8')
  );
  return writeQueue;
}

export async function getSession(sessionId) {
  await ensureInitialized();
  return db.sessions[sessionId] ?? null;
}

export async function listSessions() {
  await ensureInitialized();
  return Object.values(db.sessions);
}

export async function saveSession(session) {
  await ensureInitialized();
  db.sessions[session.id] = session;
  await persist();
  return session;
}

export async function updateSession(sessionId, updater) {
  await ensureInitialized();
  const existing = db.sessions[sessionId];
  if (!existing) {
    return null;
  }

  const nextValue = updater(existing);
  if (!nextValue) {
    return null;
  }

  db.sessions[sessionId] = nextValue;
  await persist();
  return nextValue;
}
