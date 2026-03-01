import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CLASS_OPTIONS, EXAM_DURATION_SECONDS, EXAM_QUESTION_COUNT } from './questions.js';
import { addQuestion, getQuestionByIdMap, getQuestionPool } from './questionStore.js';
import { getSession, listSessions, saveSession, updateSession } from './store.js';

const PORT = Number(process.env.PORT ?? 4000);
const PENALTY_PER_VIOLATION = 2;
const ADMIN_PASSCODE_HASH = process.env.ADMIN_PASSCODE_HASH ?? '';
const ADMIN_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
const OPTION_IDS = ['A', 'B', 'C', 'D'];

const adminTokens = new Map();

function shuffleArray(items) {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function sanitizeRating(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round(parsed);
  return rounded >= 1 && rounded <= 5 ? rounded : null;
}

function normalizeFeedbackComment(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ').slice(0, 600);
}

function sanitizeFeedbackPayload(payload) {
  const rating = sanitizeRating(payload?.rating);
  const comment = normalizeFeedbackComment(payload?.comment);

  if (!rating && !comment) {
    return null;
  }

  return {
    rating,
    comment,
    submittedAt: Date.now(),
  };
}

function normalizeStoredFeedback(feedback) {
  if (!feedback || typeof feedback !== 'object') {
    return null;
  }

  const rating = sanitizeRating(feedback.rating);
  const comment = normalizeFeedbackComment(feedback.comment);
  if (!rating && !comment) {
    return null;
  }

  const submittedAtInput = Number(feedback.submittedAt);
  const submittedAt = Number.isFinite(submittedAtInput) && submittedAtInput > 0
    ? submittedAtInput
    : Date.now();

  if (feedback.rating === rating && feedback.comment === comment && feedback.submittedAt === submittedAt) {
    return feedback;
  }

  return {
    rating,
    comment,
    submittedAt,
  };
}

function shuffleQuestionOptions(question) {
  const shuffledOptions = shuffleArray(question.options.map((option) => ({ ...option })));
  const options = shuffledOptions.map((option, index) => ({
    id: OPTION_IDS[index],
    text: option.text,
  }));
  const correctOptionIds = shuffledOptions
    .map((option, index) => (question.correctOptionIds.includes(option.id) ? OPTION_IDS[index] : null))
    .filter(Boolean);

  return {
    ...question,
    options,
    correctOptionIds,
  };
}

function parseAdminPasscodeHash(hashValue) {
  if (typeof hashValue !== 'string' || !hashValue) {
    return null;
  }

  const parts = hashValue.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const digestHex = parts[5];

  if (!Number.isInteger(n) || n <= 1 || !Number.isInteger(r) || r <= 0 || !Number.isInteger(p) || p <= 0) {
    return null;
  }

  if (!/^[a-fA-F0-9]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
    return null;
  }

  if (!/^[a-fA-F0-9]+$/.test(digestHex) || digestHex.length % 2 !== 0) {
    return null;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const digest = Buffer.from(digestHex, 'hex');
  if (salt.length < 16 || digest.length < 32) {
    return null;
  }

  return {
    n,
    r,
    p,
    salt,
    digest,
  };
}

const parsedAdminPasscodeHash = parseAdminPasscodeHash(ADMIN_PASSCODE_HASH);

function verifyAdminPasscode(passcode) {
  if (!parsedAdminPasscodeHash || typeof passcode !== 'string' || passcode.length < 1) {
    return false;
  }

  try {
    const derived = scryptSync(passcode, parsedAdminPasscodeHash.salt, parsedAdminPasscodeHash.digest.length, {
      N: parsedAdminPasscodeHash.n,
      r: parsedAdminPasscodeHash.r,
      p: parsedAdminPasscodeHash.p,
    });

    return timingSafeEqual(derived, parsedAdminPasscodeHash.digest);
  } catch {
    return false;
  }
}

function asPublicQuestion(question) {
  return {
    id: question.id,
    topic: question.topic,
    type: question.type,
    text: question.text,
    options: question.options,
  };
}

function hasSameOptions(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function sanitizeSelectedOptions(question, selectedOptionIds) {
  if (!Array.isArray(selectedOptionIds)) {
    return [];
  }

  const allowedOptionIds = new Set(question.options.map((option) => option.id));
  const unique = [...new Set(selectedOptionIds.filter((optionId) => allowedOptionIds.has(optionId)))];

  if (question.type === 'single') {
    return unique.slice(0, 1);
  }

  return unique;
}

function evaluateSession(session) {
  let correctCount = 0;
  let answeredCount = 0;

  for (const questionId of session.questionOrder) {
    const question = session.questionSnapshot?.[questionId];
    if (!question) {
      continue;
    }

    const selected = session.answers[questionId] ?? [];
    if (selected.length > 0) {
      answeredCount += 1;
    }

    if (hasSameOptions(selected, question.correctOptionIds)) {
      correctCount += 1;
    }
  }

  const totalQuestions = session.questionOrder.length;
  const rawPercent = totalQuestions === 0 ? 0 : Number(((correctCount / totalQuestions) * 100).toFixed(2));
  const penaltyPoints = Number(
    Math.min(rawPercent, session.violations.length * PENALTY_PER_VIOLATION).toFixed(2)
  );
  const finalPercent = Number(Math.max(0, rawPercent - penaltyPoints).toFixed(2));
  const finalScoreOutOf40 = Number(((finalPercent / 100) * EXAM_QUESTION_COUNT).toFixed(2));

  return {
    totalQuestions,
    answeredCount,
    correctCount,
    rawPercent,
    penaltyPoints,
    violationsCount: session.violations.length,
    finalPercent,
    finalScoreOutOf40,
    penaltyPerViolation: PENALTY_PER_VIOLATION,
  };
}

function finalizeSession(session) {
  if (session.submittedAt) {
    if (session.summary) {
      return session;
    }

    return {
      ...session,
      summary: evaluateSession(session),
    };
  }

  return {
    ...session,
    submittedAt: Date.now(),
    summary: evaluateSession(session),
  };
}

function toClientSession(session) {
  const durationSeconds = session.durationSeconds ?? EXAM_DURATION_SECONDS;
  const remainingSeconds = session.submittedAt
    ? 0
    : Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));

  const questionList = session.questionOrder
    .map((questionId) => session.questionSnapshot?.[questionId])
    .filter(Boolean)
    .map(asPublicQuestion);

  return {
    sessionId: session.id,
    student: session.student,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    durationSeconds,
    remainingSeconds,
    questions: questionList,
    responses: session.answers,
    flagged: session.flagged,
    seen: session.seen,
    violations: session.violations,
    submittedAt: session.submittedAt,
    summary: session.summary,
    feedback: session.feedback ?? null,
  };
}

function sessionStatus(session) {
  if (session.submittedAt) {
    return 'submitted';
  }

  return Date.now() < session.expiresAt ? 'active' : 'time_up';
}

async function hydrateLegacyQuestionSnapshot(session) {
  if (session.questionSnapshot && Object.keys(session.questionSnapshot).length > 0) {
    return session;
  }

  const questionMap = await getQuestionByIdMap();
  const snapshot = {};

  for (const questionId of session.questionOrder ?? []) {
    const question = questionMap.get(questionId);
    if (question) {
      snapshot[questionId] = question;
    }
  }

  return {
    ...session,
    questionSnapshot: snapshot,
  };
}

async function normalizeSession(session) {
  const normalizedStudent = {
    fullName: normalizeName(session.student?.fullName ?? ''),
    classRoom: normalizeName(session.student?.classRoom ?? ''),
    email: normalizeEmail(session.student?.email ?? ''),
  };

  let next = {
    ...session,
    student: normalizedStudent,
    durationSeconds: session.durationSeconds ?? EXAM_DURATION_SECONDS,
    answers: session.answers ?? {},
    flagged: session.flagged ?? {},
    seen: session.seen ?? {},
    violations: Array.isArray(session.violations) ? session.violations : [],
    questionOrder: Array.isArray(session.questionOrder) ? session.questionOrder : [],
    feedback: normalizeStoredFeedback(session.feedback),
  };

  let changed =
    normalizedStudent.fullName !== (session.student?.fullName ?? '') ||
    normalizedStudent.classRoom !== (session.student?.classRoom ?? '') ||
    normalizedStudent.email !== (session.student?.email ?? '') ||
    next.durationSeconds !== session.durationSeconds ||
    next.answers !== session.answers ||
    next.flagged !== session.flagged ||
    next.seen !== session.seen ||
    next.violations !== session.violations ||
    next.questionOrder !== session.questionOrder ||
    next.feedback !== session.feedback;

  next = await hydrateLegacyQuestionSnapshot(next);
  if (!session.questionSnapshot && next.questionSnapshot) {
    changed = true;
  }

  if (!next.submittedAt && Date.now() >= next.expiresAt) {
    next = finalizeSession(next);
    changed = true;
  }

  if (next.submittedAt && !next.summary) {
    next = finalizeSession(next);
    changed = true;
  }

  if (changed) {
    await saveSession(next);
  }

  return next;
}

async function getLatestSession(sessionId) {
  const existing = await getSession(sessionId);
  if (!existing) {
    return null;
  }

  return normalizeSession(existing);
}

async function getLatestSessions() {
  const sessions = await listSessions();
  return Promise.all(sessions.map((session) => normalizeSession(session)));
}

async function getUpdatableSessionOrError(sessionId, res) {
  const session = await getLatestSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return null;
  }

  if (session.submittedAt) {
    res.status(409).json({ error: 'Exam already submitted.', session: toClientSession(session) });
    return null;
  }

  if (Date.now() >= session.expiresAt) {
    const finalized = finalizeSession(session);
    await saveSession(finalized);
    res.status(409).json({ error: 'Exam time is over.', session: toClientSession(finalized) });
    return null;
  }

  return session;
}

function cleanupAdminTokens() {
  const now = Date.now();

  for (const [token, details] of adminTokens.entries()) {
    if (details.expiresAt <= now) {
      adminTokens.delete(token);
    }
  }
}

function issueAdminToken() {
  cleanupAdminTokens();

  const token = randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + ADMIN_TOKEN_LIFETIME_MS;

  adminTokens.set(token, { token, createdAt, expiresAt });
  return { token, createdAt, expiresAt };
}

function getBearerToken(req) {
  const raw = req.headers.authorization ?? '';
  if (!raw.startsWith('Bearer ')) {
    return '';
  }

  return raw.slice('Bearer '.length).trim();
}

function requireAdmin(req, res, next) {
  cleanupAdminTokens();

  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing admin token.' });
    return;
  }

  const details = adminTokens.get(token);
  if (!details) {
    res.status(401).json({ error: 'Invalid or expired admin token.' });
    return;
  }

  req.admin = details;
  next();
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(2));
}

function scoreBand(score) {
  if (score < 20) {
    return '0-19';
  }
  if (score < 40) {
    return '20-39';
  }
  if (score < 60) {
    return '40-59';
  }
  if (score < 80) {
    return '60-79';
  }

  return '80-100';
}

function toSessionRow(session) {
  const status = sessionStatus(session);
  const remainingSeconds = session.submittedAt
    ? 0
    : Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));

  return {
    id: session.id,
    studentName: session.student?.fullName ?? 'Unknown',
    classRoom: session.student?.classRoom ?? 'Unknown',
    email: session.student?.email ?? '',
    startedAt: session.startedAt,
    submittedAt: session.submittedAt,
    expiresAt: session.expiresAt,
    status,
    remainingSeconds,
    violationsCount: session.violations?.length ?? 0,
    answeredCount: session.summary?.answeredCount ?? 0,
    correctCount: session.summary?.correctCount ?? 0,
    rawPercent: session.summary?.rawPercent ?? 0,
    finalPercent: session.summary?.finalPercent ?? 0,
    feedbackRating: session.feedback?.rating ?? null,
    feedbackComment: session.feedback?.comment ?? '',
    feedbackSubmittedAt: session.feedback?.submittedAt ?? null,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }

  return lines.join('\n');
}

function buildOverview(sessions, questionPool) {
  const submitted = sessions.filter((session) => session.submittedAt);
  const active = sessions.filter((session) => sessionStatus(session) === 'active');

  const classBuckets = new Map();
  for (const session of submitted) {
    const key = session.student?.classRoom ?? 'Unknown';
    const existing = classBuckets.get(key) ?? { count: 0, scores: [], violations: [] };
    existing.count += 1;
    existing.scores.push(session.summary?.finalPercent ?? 0);
    existing.violations.push(session.summary?.violationsCount ?? 0);
    classBuckets.set(key, existing);
  }

  const classPerformance = [...classBuckets.entries()]
    .map(([classRoom, details]) => ({
      classRoom,
      count: details.count,
      averageScore: average(details.scores),
      averageViolations: average(details.violations),
    }))
    .sort((left, right) => right.averageScore - left.averageScore);

  const scoreDistributionMap = {
    '0-19': 0,
    '20-39': 0,
    '40-59': 0,
    '60-79': 0,
    '80-100': 0,
  };

  for (const session of submitted) {
    const band = scoreBand(session.summary?.finalPercent ?? 0);
    scoreDistributionMap[band] += 1;
  }

  const violationBreakdownMap = new Map();
  for (const session of sessions) {
    for (const violation of session.violations ?? []) {
      const key = violation.type ?? 'unknown';
      violationBreakdownMap.set(key, (violationBreakdownMap.get(key) ?? 0) + 1);
    }
  }

  const topicCoverageMap = new Map();
  const typeCoverageMap = new Map();

  for (const question of questionPool) {
    topicCoverageMap.set(question.topic, (topicCoverageMap.get(question.topic) ?? 0) + 1);
    typeCoverageMap.set(question.type, (typeCoverageMap.get(question.type) ?? 0) + 1);
  }

  const scores = submitted.map((session) => session.summary?.finalPercent ?? 0);
  const rawScores = submitted.map((session) => session.summary?.rawPercent ?? 0);
  const violations = submitted.map((session) => session.summary?.violationsCount ?? 0);
  const feedbackSessions = submitted.filter((session) => session.feedback?.rating || session.feedback?.comment);
  const ratingValues = feedbackSessions
    .map((session) => session.feedback?.rating)
    .filter((value) => Number.isFinite(value));
  const ratingDistributionMap = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  for (const rating of ratingValues) {
    ratingDistributionMap[rating] += 1;
  }

  return {
    totals: {
      candidates: sessions.length,
      submitted: submitted.length,
      active: active.length,
      completionRate: sessions.length
        ? Number(((submitted.length / sessions.length) * 100).toFixed(2))
        : 0,
      averageScore: average(scores),
      averageRawScore: average(rawScores),
      averageViolations: average(violations),
      lowScoreCount: submitted.filter((session) => (session.summary?.finalPercent ?? 0) < 40).length,
      feedbackCount: feedbackSessions.length,
      averageRating: average(ratingValues),
    },
    scoreDistribution: Object.entries(scoreDistributionMap).map(([band, count]) => ({ band, count })),
    classPerformance,
    violationBreakdown: [...violationBreakdownMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count),
    topicCoverage: [...topicCoverageMap.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((left, right) => right.count - left.count),
    questionTypeCoverage: [...typeCoverageMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count),
    ratingDistribution: Object.entries(ratingDistributionMap).map(([rating, count]) => ({
      rating: Number(rating),
      count,
    })),
    recentSubmissions: submitted
      .sort((left, right) => (right.submittedAt ?? 0) - (left.submittedAt ?? 0))
      .slice(0, 10)
      .map((session) => ({
        id: session.id,
        studentName: session.student?.fullName ?? 'Unknown',
        classRoom: session.student?.classRoom ?? 'Unknown',
        finalPercent: session.summary?.finalPercent ?? 0,
        violationsCount: session.summary?.violationsCount ?? 0,
        feedbackRating: session.feedback?.rating ?? null,
        submittedAt: session.submittedAt,
      })),
    recentFeedback: feedbackSessions
      .sort((left, right) => (right.feedback?.submittedAt ?? 0) - (left.feedback?.submittedAt ?? 0))
      .slice(0, 12)
      .map((session) => ({
        id: session.id,
        studentName: session.student?.fullName ?? 'Unknown',
        classRoom: session.student?.classRoom ?? 'Unknown',
        rating: session.feedback?.rating ?? null,
        comment: session.feedback?.comment ?? '',
        submittedAt: session.feedback?.submittedAt ?? null,
      })),
  };
}

function questionToAdminRow(question) {
  return {
    ...question,
    answerKey: question.correctOptionIds.join(', '),
  };
}

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/exam/meta', async (_req, res) => {
  const questionPool = await getQuestionPool();

  res.json({
    schoolName: 'Salem Academy',
    durationSeconds: EXAM_DURATION_SECONDS,
    questionCount: EXAM_QUESTION_COUNT,
    questionPoolCount: questionPool.length,
    classOptions: CLASS_OPTIONS,
    penaltyPerViolation: PENALTY_PER_VIOLATION,
  });
});

app.post('/api/exam/start', async (req, res) => {
  const fullName = normalizeName(req.body?.fullName);
  const classRoom = normalizeName(req.body?.classRoom);
  const email = normalizeEmail(req.body?.email);

  if (fullName.length < 5) {
    res.status(400).json({ error: 'Please enter the full name (at least 5 characters).' });
    return;
  }

  if (!CLASS_OPTIONS.includes(classRoom)) {
    res.status(400).json({ error: 'Please choose a valid class.' });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }

  const questionPool = await getQuestionPool();
  if (questionPool.length < EXAM_QUESTION_COUNT) {
    res.status(503).json({
      error: `Question pool has ${questionPool.length}. At least ${EXAM_QUESTION_COUNT} questions are required.`,
    });
    return;
  }

  const servedQuestions = shuffleArray(questionPool)
    .slice(0, EXAM_QUESTION_COUNT)
    .map(shuffleQuestionOptions);
  const startedAt = Date.now();
  const session = {
    id: randomUUID(),
    student: {
      fullName,
      classRoom,
      email,
    },
    startedAt,
    expiresAt: startedAt + EXAM_DURATION_SECONDS * 1000,
    durationSeconds: EXAM_DURATION_SECONDS,
    questionOrder: servedQuestions.map((question) => question.id),
    questionSnapshot: Object.fromEntries(servedQuestions.map((question) => [question.id, question])),
    answers: {},
    flagged: {},
    seen: {},
    violations: [],
    submittedAt: null,
    summary: null,
    feedback: null,
  };

  await saveSession(session);
  res.status(201).json(toClientSession(session));
});

app.get('/api/exam/:sessionId', async (req, res) => {
  const session = await getLatestSession(req.params.sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  res.json(toClientSession(session));
});

app.post('/api/exam/:sessionId/seen', async (req, res) => {
  const sessionId = req.params.sessionId;
  const questionId = req.body?.questionId;

  const session = await getUpdatableSessionOrError(sessionId, res);
  if (!session) {
    return;
  }

  if (!session.questionOrder.includes(questionId)) {
    res.status(400).json({ error: 'Question is not in this exam session.' });
    return;
  }

  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    seen: {
      ...current.seen,
      [questionId]: true,
    },
  }));

  res.json({ ok: true, seen: updated?.seen ?? session.seen });
});

app.post('/api/exam/:sessionId/answer', async (req, res) => {
  const sessionId = req.params.sessionId;
  const questionId = req.body?.questionId;

  const session = await getUpdatableSessionOrError(sessionId, res);
  if (!session) {
    return;
  }

  if (!session.questionOrder.includes(questionId)) {
    res.status(400).json({ error: 'Question is not in this exam session.' });
    return;
  }

  const question = session.questionSnapshot?.[questionId];
  if (!question) {
    res.status(400).json({ error: 'Question details could not be loaded for this session.' });
    return;
  }

  const selected = sanitizeSelectedOptions(question, req.body?.selectedOptionIds);

  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    answers: {
      ...current.answers,
      [questionId]: selected,
    },
  }));

  res.json({ ok: true, responses: updated?.answers ?? session.answers });
});

app.post('/api/exam/:sessionId/flag', async (req, res) => {
  const sessionId = req.params.sessionId;
  const questionId = req.body?.questionId;
  const flagged = Boolean(req.body?.flagged);

  const session = await getUpdatableSessionOrError(sessionId, res);
  if (!session) {
    return;
  }

  if (!session.questionOrder.includes(questionId)) {
    res.status(400).json({ error: 'Question is not in this exam session.' });
    return;
  }

  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    flagged: {
      ...current.flagged,
      [questionId]: flagged,
    },
  }));

  res.json({ ok: true, flagged: updated?.flagged ?? session.flagged });
});

app.post('/api/exam/:sessionId/proctor', async (req, res) => {
  const sessionId = req.params.sessionId;

  const session = await getUpdatableSessionOrError(sessionId, res);
  if (!session) {
    return;
  }

  const type = normalizeName(req.body?.type);
  const detail = normalizeName(req.body?.detail);

  if (!type) {
    res.status(400).json({ error: 'Violation type is required.' });
    return;
  }

  const violation = {
    id: randomUUID(),
    type: type.slice(0, 80),
    detail: detail.slice(0, 160),
    occurredAt: Date.now(),
  };

  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    violations: [...current.violations, violation],
  }));

  res.json({
    ok: true,
    violations: updated?.violations ?? session.violations,
    penaltyPerViolation: PENALTY_PER_VIOLATION,
  });
});

app.post('/api/exam/:sessionId/submit', async (req, res) => {
  const sessionId = req.params.sessionId;
  const latest = await getLatestSession(sessionId);

  if (!latest) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  const finalized = finalizeSession(latest);
  await saveSession(finalized);

  res.json({
    ok: true,
    session: toClientSession(finalized),
    summary: finalized.summary,
  });
});

app.post('/api/exam/:sessionId/feedback', async (req, res) => {
  const sessionId = req.params.sessionId;
  const latest = await getLatestSession(sessionId);

  if (!latest) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  if (!latest.submittedAt) {
    res.status(409).json({ error: 'Feedback can only be sent after submitting the exam.' });
    return;
  }

  const feedback = sanitizeFeedbackPayload(req.body ?? {});
  if (!feedback) {
    res.status(400).json({ error: 'Please add at least a rating or comment.' });
    return;
  }

  const updated = {
    ...latest,
    feedback,
  };
  await saveSession(updated);

  res.json({
    ok: true,
    feedback: updated.feedback,
    session: toClientSession(updated),
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!parsedAdminPasscodeHash) {
    res.status(503).json({
      error: 'Admin authentication hash is missing. Set ADMIN_PASSCODE_HASH in your environment.',
    });
    return;
  }

  const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
  if (!verifyAdminPasscode(passcode)) {
    res.status(401).json({ error: 'Invalid admin passcode.' });
    return;
  }

  const tokenInfo = issueAdminToken();

  res.json({
    ok: true,
    token: tokenInfo.token,
    expiresAt: tokenInfo.expiresAt,
    tokenLifetimeMs: ADMIN_TOKEN_LIFETIME_MS,
  });
});

app.get('/api/admin/overview', requireAdmin, async (_req, res) => {
  const [sessions, questionPool] = await Promise.all([getLatestSessions(), getQuestionPool()]);
  const overview = buildOverview(sessions, questionPool);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    generatedAt: Date.now(),
    overview,
  });
});

app.get('/api/admin/sessions', requireAdmin, async (req, res) => {
  const search = normalizeName(req.query?.search ?? '').toLowerCase();
  const classRoom = normalizeName(req.query?.classRoom ?? '');
  const statusFilter = normalizeName(req.query?.status ?? '').toLowerCase();

  const sessions = await getLatestSessions();

  const filtered = sessions.filter((session) => {
    const sessionRow = toSessionRow(session);

    if (classRoom && sessionRow.classRoom !== classRoom) {
      return false;
    }

    if (statusFilter && sessionRow.status !== statusFilter) {
      return false;
    }

    if (search) {
      const haystack = `${sessionRow.studentName} ${sessionRow.email} ${sessionRow.id}`.toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }

    return true;
  });

  const rows = filtered
    .map((session) => toSessionRow(session))
    .sort((left, right) => right.startedAt - left.startedAt);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    total: rows.length,
    sessions: rows,
  });
});

app.get('/api/admin/sessions/:sessionId', requireAdmin, async (req, res) => {
  const session = await getLatestSession(req.params.sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    session: {
      ...toClientSession(session),
      internal: {
        id: session.id,
        status: sessionStatus(session),
      },
    },
  });
});

app.get('/api/admin/questions', requireAdmin, async (_req, res) => {
  const questionPool = await getQuestionPool();

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    questionCount: questionPool.length,
    requiredExamQuestionCount: EXAM_QUESTION_COUNT,
    questions: questionPool.map(questionToAdminRow),
  });
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const created = await addQuestion(req.body ?? {});
    const questionPool = await getQuestionPool();

    res.status(201).json({
      ok: true,
      question: questionToAdminRow(created),
      questionCount: questionPool.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid question payload.' });
  }
});

app.get('/api/admin/export/sessions.csv', requireAdmin, async (_req, res) => {
  const sessions = await getLatestSessions();

  const rows = sessions
    .map((session) => {
      const summary = session.summary ?? evaluateSession(session);
      return {
        sessionId: session.id,
        fullName: session.student?.fullName ?? '',
        classRoom: session.student?.classRoom ?? '',
        email: session.student?.email ?? '',
        status: sessionStatus(session),
        startedAtIso: new Date(session.startedAt).toISOString(),
        submittedAtIso: session.submittedAt ? new Date(session.submittedAt).toISOString() : '',
        answeredCount: summary.answeredCount,
        correctCount: summary.correctCount,
        rawPercent: summary.rawPercent,
        penaltyPoints: summary.penaltyPoints,
        finalPercent: summary.finalPercent,
        violationsCount: summary.violationsCount,
        feedbackRating: session.feedback?.rating ?? '',
        feedbackComment: session.feedback?.comment ?? '',
        feedbackSubmittedAtIso: session.feedback?.submittedAt
          ? new Date(session.feedback.submittedAt).toISOString()
          : '',
      };
    })
    .sort((left, right) =>
      left.startedAtIso < right.startedAtIso ? 1 : left.startedAtIso > right.startedAtIso ? -1 : 0
    );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sessions-export.csv"');
  res.send(toCsv(rows));
});

app.get('/api/admin/export/sessions.json', requireAdmin, async (_req, res) => {
  const sessions = await getLatestSessions();

  const payload = sessions
    .map((session) => ({
      ...toSessionRow(session),
      startedAtIso: new Date(session.startedAt).toISOString(),
      submittedAtIso: session.submittedAt ? new Date(session.submittedAt).toISOString() : null,
      feedbackSubmittedAtIso: session.feedback?.submittedAt
        ? new Date(session.feedback.submittedAt).toISOString()
        : null,
    }))
    .sort((left, right) => right.startedAt - left.startedAt);

  res.setHeader('Content-Disposition', 'attachment; filename="sessions-export.json"');
  res.json(payload);
});

app.get('/api/admin/export/emails.csv', requireAdmin, async (_req, res) => {
  const sessions = await getLatestSessions();

  const uniqueEmails = [...new Set(
    sessions
      .map((session) => normalizeEmail(session.student?.email ?? ''))
      .filter((email) => isValidEmail(email))
  )];

  const rows = uniqueEmails
    .sort((left, right) => left.localeCompare(right))
    .map((email) => ({ email }));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="emails-only-export.csv"');
  res.send(toCsv(rows));
});

app.get('/api/admin/export/questions.csv', requireAdmin, async (_req, res) => {
  const questionPool = await getQuestionPool();

  const rows = questionPool.map((question) => ({
    id: question.id,
    topic: question.topic,
    type: question.type,
    text: question.text,
    optionA: question.options[0]?.text ?? '',
    optionB: question.options[1]?.text ?? '',
    optionC: question.options[2]?.text ?? '',
    optionD: question.options[3]?.text ?? '',
    correctOptionIds: question.correctOptionIds.join('|'),
  }));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="questions-export.csv"');
  res.send(toCsv(rows));
});

app.get('/api/admin/export/questions.json', requireAdmin, async (_req, res) => {
  const questionPool = await getQuestionPool();

  res.setHeader('Content-Disposition', 'attachment; filename="questions-export.json"');
  res.json(questionPool);
});

const distPath = path.resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));

  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }

    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Salem Exam API running on http://localhost:${PORT}`);
  if (!parsedAdminPasscodeHash) {
    console.warn('ADMIN_PASSCODE_HASH is not configured. Admin login is disabled until it is set.');
  }
});
