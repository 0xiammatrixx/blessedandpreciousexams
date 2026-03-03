import { randomUUID } from 'node:crypto';

import { getCollection } from './db.js';

const COLLECTION_NAME = 'student_general_feedback';
let initialized = false;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function stripMongoId(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const { _id: _ignoredId, ...rest } = value;
  return rest;
}

async function ensureInitialized() {
  if (initialized) {
    return;
  }

  const collection = await getCollection(COLLECTION_NAME);
  await collection.createIndex({ id: 1 }, { unique: true, name: 'idx_general_feedback_id' });
  await collection.createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_general_feedback_user_created' });
  await collection.createIndex({ createdAt: -1 }, { name: 'idx_general_feedback_created' });

  initialized = true;
}

export async function createGeneralFeedback({ user, rating = null, comment = '' }) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);

  const row = {
    id: randomUUID(),
    userId: user.id,
    userKey: user.userKey,
    fullName: normalizeText(user.fullName),
    classRoom: normalizeText(user.classRoom),
    email: normalizeEmail(user.email),
    rating: Number.isFinite(Number(rating)) ? Math.round(Number(rating)) : null,
    comment: normalizeText(comment).slice(0, 600),
    createdAt: Date.now(),
  };

  await collection.insertOne(row);
  return stripMongoId(row);
}

export async function listGeneralFeedbackByUser(userId, limit = 8) {
  await ensureInitialized();
  if (!userId) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 8)));
  const collection = await getCollection(COLLECTION_NAME);
  const rows = await collection
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return rows.map(stripMongoId);
}

export async function countGeneralFeedback() {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  return collection.estimatedDocumentCount();
}
