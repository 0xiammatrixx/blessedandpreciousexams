import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_QUESTION_BANK } from './questions.js';

const STORE_DIR = path.resolve(process.cwd(), 'server', 'data');
const STORE_FILE = path.join(STORE_DIR, 'questions.json');

let questionPool = [];
let initialized = false;
let writeQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function extractNumericId(questionId) {
  const match = /^Q(\d+)$/i.exec(questionId ?? '');
  return match ? Number(match[1]) : 0;
}

function getNextQuestionId() {
  const maxId = questionPool.reduce((max, question) => {
    const parsed = extractNumericId(question.id);
    return parsed > max ? parsed : max;
  }, 0);

  return `Q${String(maxId + 1).padStart(3, '0')}`;
}

function sanitizeOptionTexts(optionTexts) {
  if (!Array.isArray(optionTexts)) {
    return [];
  }

  return optionTexts.slice(0, 4).map((text) => normalizeText(text));
}

function sanitizeCorrectOptionIds(correctOptionIds) {
  if (!Array.isArray(correctOptionIds)) {
    return [];
  }

  const validIds = new Set(['A', 'B', 'C', 'D']);
  return [...new Set(correctOptionIds.map((id) => String(id).toUpperCase()))].filter((id) =>
    validIds.has(id)
  );
}

function validateQuestion(question) {
  if (!question || typeof question !== 'object') {
    throw new Error('Invalid question payload.');
  }

  const text = normalizeText(question.text);
  if (text.length < 5) {
    throw new Error('Question text must be at least 5 characters.');
  }

  const type = normalizeText(question.type).toLowerCase();
  if (!['single', 'multi'].includes(type)) {
    throw new Error('Question type must be single or multi.');
  }

  const topic = normalizeText(question.topic).toLowerCase() || 'general';

  const optionTexts = sanitizeOptionTexts(
    question.optionTexts ?? question.options?.map((option) => option?.text)
  );
  if (optionTexts.length !== 4 || optionTexts.some((item) => item.length < 1)) {
    throw new Error('Question must have 4 options.');
  }

  const options = optionTexts.map((textValue, index) => ({
    id: ['A', 'B', 'C', 'D'][index],
    text: textValue,
  }));

  const correctOptionIds = sanitizeCorrectOptionIds(question.correctOptionIds);
  if (correctOptionIds.length < 1) {
    throw new Error('Select at least one correct option.');
  }

  if (type === 'single' && correctOptionIds.length !== 1) {
    throw new Error('Single-choice question must have exactly one correct option.');
  }

  const id = normalizeText(question.id) || getNextQuestionId();

  return {
    id,
    topic,
    type,
    text,
    options,
    correctOptionIds,
  };
}

async function persist() {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(STORE_FILE, JSON.stringify({ questions: questionPool }, null, 2), 'utf8')
  );

  await writeQueue;
}

async function ensureInitialized() {
  if (initialized) {
    return;
  }

  await fs.mkdir(STORE_DIR, { recursive: true });

  try {
    const existing = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) {
      questionPool = parsed.questions.map((item) => validateQuestion(item));
    } else {
      questionPool = DEFAULT_QUESTION_BANK.map((item) => validateQuestion(item));
      await persist();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    questionPool = DEFAULT_QUESTION_BANK.map((item) => validateQuestion(item));
    await persist();
  }

  initialized = true;
}

export async function getQuestionPool() {
  await ensureInitialized();
  return clone(questionPool);
}

export async function getQuestionByIdMap() {
  await ensureInitialized();
  return new Map(questionPool.map((question) => [question.id, clone(question)]));
}

export async function addQuestion(payload) {
  await ensureInitialized();

  const nextQuestion = validateQuestion(payload);
  if (questionPool.some((question) => question.id === nextQuestion.id)) {
    throw new Error('Question ID already exists.');
  }

  questionPool.push(nextQuestion);
  await persist();
  return clone(nextQuestion);
}

export async function replaceQuestionPool(nextQuestions) {
  await ensureInitialized();

  if (!Array.isArray(nextQuestions) || nextQuestions.length === 0) {
    throw new Error('Question pool cannot be empty.');
  }

  const sanitized = nextQuestions.map((question) => validateQuestion(question));
  const idSet = new Set(sanitized.map((question) => question.id));

  if (idSet.size !== sanitized.length) {
    throw new Error('Question IDs must be unique.');
  }

  questionPool = sanitized;
  await persist();
  return clone(questionPool);
}
