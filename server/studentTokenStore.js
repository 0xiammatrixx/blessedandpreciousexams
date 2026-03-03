import { getCollection } from './db.js';

const COLLECTION_NAME = 'student_tokens';
let initialized = false;

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
  await collection.createIndex({ token: 1 }, { unique: true, name: 'idx_student_token' });
  await collection.createIndex({ userId: 1 }, { name: 'idx_student_token_user_id' });
  await collection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'ttl_student_token_expires_at' }
  );

  initialized = true;
}

export async function saveStudentToken(tokenRow) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  await collection.replaceOne({ token: tokenRow.token }, tokenRow, { upsert: true });
  return tokenRow;
}

export async function getStudentToken(token) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const row = await collection.findOne({ token });
  return row ? stripMongoId(row) : null;
}

export async function deleteStudentToken(token) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const result = await collection.deleteOne({ token });
  return (result.deletedCount ?? 0) > 0;
}

export async function deleteStudentTokensByUser(userId) {
  await ensureInitialized();
  if (!userId) {
    return 0;
  }

  const collection = await getCollection(COLLECTION_NAME);
  const result = await collection.deleteMany({ userId });
  return result.deletedCount ?? 0;
}

export async function cleanupExpiredStudentTokens(now = Date.now()) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const result = await collection.deleteMany({ expiresAt: { $lte: Number(now) } });
  return result.deletedCount ?? 0;
}
