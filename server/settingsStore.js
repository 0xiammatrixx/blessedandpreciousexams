import { getCollection } from './db.js';

const COLLECTION_NAME = 'settings';
const BRANDING_KEY = 'branding';
let initialized = false;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function toBrandingSettings(input = {}) {
  const schoolName = normalizeText(input.schoolName) || 'blessedandprecious Academy';
  const logoUrl = normalizeText(input.logoUrl);

  return {
    schoolName: schoolName.slice(0, 120),
    logoUrl: logoUrl.slice(0, 500),
  };
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
  await collection.createIndex({ key: 1 }, { unique: true, name: 'idx_settings_key' });

  const existing = await collection.findOne({ key: BRANDING_KEY });
  if (!existing) {
    await collection.insertOne({
      key: BRANDING_KEY,
      value: toBrandingSettings({}),
      updatedAt: Date.now(),
    });
  }

  initialized = true;
}

export async function getBrandingSettings() {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const row = await collection.findOne({ key: BRANDING_KEY });
  return toBrandingSettings(stripMongoId(row)?.value ?? {});
}

export async function updateBrandingSettings(patch = {}) {
  await ensureInitialized();
  const collection = await getCollection(COLLECTION_NAME);
  const existing = await collection.findOne({ key: BRANDING_KEY });
  const current = toBrandingSettings(stripMongoId(existing)?.value ?? {});

  const next = toBrandingSettings({
    ...current,
    ...patch,
  });

  await collection.replaceOne(
    { key: BRANDING_KEY },
    {
      key: BRANDING_KEY,
      value: next,
      updatedAt: Date.now(),
    },
    { upsert: true }
  );

  return next;
}
