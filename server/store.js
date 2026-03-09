import { setTimeout as delay } from 'node:timers/promises';

import { getCollection } from './db.js';

const COLLECTION_NAME = 'sessions';
let initialized = false;
const SESSION_UPDATE_MAX_RETRIES_INPUT = Number(process.env.SESSION_UPDATE_MAX_RETRIES ?? 8);
const SESSION_UPDATE_MAX_RETRIES =
  Number.isFinite(SESSION_UPDATE_MAX_RETRIES_INPUT) && SESSION_UPDATE_MAX_RETRIES_INPUT >= 1
    ? Math.round(SESSION_UPDATE_MAX_RETRIES_INPUT)
    : 8;
const SESSION_UPDATE_DELAY_MS_INPUT = Number(process.env.SESSION_UPDATE_DELAY_MS ?? 0);
const SESSION_UPDATE_DELAY_MS =
  Number.isFinite(SESSION_UPDATE_DELAY_MS_INPUT) && SESSION_UPDATE_DELAY_MS_INPUT > 0
    ? Math.round(SESSION_UPDATE_DELAY_MS_INPUT)
    : 0;

function stripMongoId(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const { _id: _ignoredId, ...rest } = value;
  return rest;
}

function getSessionRevision(session) {
  const revisionInput = Number(session?.revision);
  return Number.isFinite(revisionInput) && revisionInput >= 1 ? Math.trunc(revisionInput) : 0;
}

function buildRevisionFilter(sessionId, revision) {
  if (revision <= 0) {
    return {
      id: sessionId,
      $or: [{ revision: { $exists: false } }, { revision: 0 }],
    };
  }

  return { id: sessionId, revision };
}

async function ensureInitialized() {
  if (initialized) {
    return;
  }

  const collection = await getCollection(COLLECTION_NAME);
  await collection.createIndex({ id: 1 }, { unique: true, name: 'idx_session_id' });
  await collection.createIndex({ studentKey: 1 }, { name: 'idx_session_student_key' });
  await collection.createIndex({ examId: 1 }, { name: 'idx_session_exam_id' });
  await collection.createIndex({ startedAt: -1 }, { name: 'idx_session_started_at' });

  initialized = true;
}

export async function getSession(sessionId) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const session = await collection.findOne({ id: sessionId });
  return session ? stripMongoId(session) : null;
}

export async function listSessions() {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const sessions = await collection.find({}).toArray();
  return sessions.map(stripMongoId);
}

export async function saveSession(session) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const revision = Math.max(1, getSessionRevision(session));
  const nextSession = {
    ...session,
    revision,
  };

  await collection.replaceOne(
    { id: session.id },
    nextSession,
    { upsert: true }
  );

  return nextSession;
}

export async function updateSession(sessionId, updater) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);

  for (let attempt = 0; attempt < SESSION_UPDATE_MAX_RETRIES; attempt += 1) {
    const existing = await collection.findOne({ id: sessionId });
    if (!existing) {
      return null;
    }

    const current = stripMongoId(existing);
    const currentRevision = getSessionRevision(current);
    const nextValue = updater(current);
    if (!nextValue) {
      return null;
    }

    const nextSession = {
      ...nextValue,
      revision: currentRevision + 1,
    };

    if (SESSION_UPDATE_DELAY_MS > 0) {
      await delay(SESSION_UPDATE_DELAY_MS);
    }

    const result = await collection.replaceOne(
      buildRevisionFilter(sessionId, currentRevision),
      nextSession,
      { upsert: false }
    );

    if (result.matchedCount === 1) {
      return nextSession;
    }
  }

  throw new Error(`Could not update session ${sessionId} after repeated concurrent write conflicts.`);
}

export async function deleteSession(sessionId) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const result = await collection.deleteOne({ id: sessionId });
  return result.deletedCount > 0;
}

export async function deleteSessions(sessionIds) {
  await ensureInitialized();
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return 0;
  }

  const collection = await getCollection(COLLECTION_NAME);
  const result = await collection.deleteMany({ id: { $in: sessionIds } });
  return result.deletedCount ?? 0;
}
