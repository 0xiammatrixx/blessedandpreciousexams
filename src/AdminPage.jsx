import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  adminLogin,
  createAdminQuestion,
  downloadAdminExport,
  fetchAdminOverview,
  fetchAdminQuestions,
  fetchAdminSessions,
  fetchMeta,
} from './api';

const ADMIN_TOKEN_KEY = 'salem_admin_token';
const ADMIN_TOKEN_EXPIRES_KEY = 'salem_admin_token_expires_at';

const TOPIC_OPTIONS = ['basics', 'internet', 'web', 'coding', 'navigation', 'vscode', 'general'];

const EMPTY_QUESTION_FORM = {
  topic: 'general',
  type: 'single',
  text: '',
  optionA: '',
  optionB: '',
  optionC: '',
  optionD: '',
  correctA: true,
  correctB: false,
  correctC: false,
  correctD: false,
};

function formatDate(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return '-';
  }
}

function percentBarValue(value, max) {
  if (!max || max <= 0) {
    return 0;
  }

  return Math.max(4, Math.round((value / max) * 100));
}

function AdminPage() {
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState(0);
  const [passcode, setPasscode] = useState('');

  const [overview, setOverview] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [questions, setQuestions] = useState([]);

  const [filters, setFilters] = useState({ search: '', classRoom: '', status: '' });

  const [questionForm, setQuestionForm] = useState(EMPTY_QUESTION_FORM);

  const [loading, setLoading] = useState({
    login: false,
    overview: false,
    sessions: false,
    questions: false,
    addQuestion: false,
  });

  const [errorMessage, setErrorMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  const updateLoading = useCallback((field, value) => {
    setLoading((previous) => ({ ...previous, [field]: value }));
  }, []);

  const clearAuth = useCallback(() => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
    setToken('');
    setTokenExpiresAt(0);
    setOverview(null);
    setSessions([]);
    setQuestions([]);
  }, []);

  const handleUnauthorized = useCallback(
    (error) => {
      if (error?.status !== 401) {
        return false;
      }

      clearAuth();
      setErrorMessage('Your admin session has expired. Please login again.');
      return true;
    },
    [clearAuth]
  );

  const loadOverview = useCallback(
    async (activeToken) => {
      updateLoading('overview', true);
      try {
        const payload = await fetchAdminOverview(activeToken);
        setOverview(payload.overview);
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setErrorMessage(error.message || 'Could not load dashboard overview.');
        }
      } finally {
        updateLoading('overview', false);
      }
    },
    [handleUnauthorized, updateLoading]
  );

  const loadSessions = useCallback(
    async (activeToken, activeFilters) => {
      updateLoading('sessions', true);
      try {
        const payload = await fetchAdminSessions(activeToken, activeFilters);
        setSessions(payload.sessions ?? []);
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setErrorMessage(error.message || 'Could not load candidate sessions.');
        }
      } finally {
        updateLoading('sessions', false);
      }
    },
    [handleUnauthorized, updateLoading]
  );

  const loadQuestions = useCallback(
    async (activeToken) => {
      updateLoading('questions', true);
      try {
        const payload = await fetchAdminQuestions(activeToken);
        setQuestions(payload.questions ?? []);
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setErrorMessage(error.message || 'Could not load question pool.');
        }
      } finally {
        updateLoading('questions', false);
      }
    },
    [handleUnauthorized, updateLoading]
  );

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const metadata = await fetchMeta();
        if (!active) {
          return;
        }

        setMeta(metadata);
      } catch {
        if (active) {
          setErrorMessage('Could not load exam metadata.');
        }
      }

      const savedToken = localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
      const savedExpiresAt = Number(localStorage.getItem(ADMIN_TOKEN_EXPIRES_KEY) ?? '0');

      if (savedToken && Number.isFinite(savedExpiresAt) && savedExpiresAt > Date.now()) {
        if (!active) {
          return;
        }

        setToken(savedToken);
        setTokenExpiresAt(savedExpiresAt);
      }
    }

    bootstrap();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadOverview(token);
    void loadQuestions(token);
  }, [loadOverview, loadQuestions, token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadSessions(token, filters);
  }, [filters, loadSessions, token]);

  useEffect(() => {
    if (!infoMessage) {
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      setInfoMessage('');
    }, 3500);

    return () => clearTimeout(timeoutId);
  }, [infoMessage]);

  const handleLogin = async (event) => {
    event.preventDefault();

    setErrorMessage('');
    updateLoading('login', true);

    try {
      const payload = await adminLogin(passcode);
      localStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
      localStorage.setItem(ADMIN_TOKEN_EXPIRES_KEY, String(payload.expiresAt));

      setToken(payload.token);
      setTokenExpiresAt(payload.expiresAt);
      setPasscode('');
      setInfoMessage('Admin login successful.');
    } catch (error) {
      setErrorMessage(error.message || 'Login failed.');
    } finally {
      updateLoading('login', false);
    }
  };

  const handleLogout = () => {
    clearAuth();
    setInfoMessage('Logged out of admin dashboard.');
  };

  const handleRefreshAll = async () => {
    if (!token) {
      return;
    }

    setErrorMessage('');
    await Promise.all([loadOverview(token), loadSessions(token, filters), loadQuestions(token)]);
    setInfoMessage('Dashboard refreshed.');
  };

  const handleExport = async (path, fileName) => {
    if (!token) {
      return;
    }

    setErrorMessage('');

    try {
      await downloadAdminExport(token, path, fileName);
      setInfoMessage(`${fileName} downloaded.`);
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setErrorMessage(error.message || 'Export failed.');
      }
    }
  };

  const handleCreateQuestion = async (event) => {
    event.preventDefault();

    if (!token) {
      return;
    }

    const correctOptionIds = [
      questionForm.correctA ? 'A' : null,
      questionForm.correctB ? 'B' : null,
      questionForm.correctC ? 'C' : null,
      questionForm.correctD ? 'D' : null,
    ].filter(Boolean);

    const payload = {
      topic: questionForm.topic,
      type: questionForm.type,
      text: questionForm.text,
      optionTexts: [
        questionForm.optionA,
        questionForm.optionB,
        questionForm.optionC,
        questionForm.optionD,
      ],
      correctOptionIds,
    };

    updateLoading('addQuestion', true);
    setErrorMessage('');

    try {
      await createAdminQuestion(token, payload);
      setQuestionForm((previous) => ({
        ...EMPTY_QUESTION_FORM,
        topic: previous.topic,
        type: previous.type,
      }));

      await Promise.all([loadQuestions(token), loadOverview(token)]);
      setInfoMessage('New question added to pool.');
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setErrorMessage(error.message || 'Could not add question.');
      }
    } finally {
      updateLoading('addQuestion', false);
    }
  };

  const scoreDistribution = useMemo(
    () => overview?.scoreDistribution ?? [],
    [overview?.scoreDistribution]
  );
  const scoreDistributionMax = useMemo(
    () => Math.max(1, ...scoreDistribution.map((item) => item.count)),
    [scoreDistribution]
  );

  const violationBreakdown = useMemo(
    () => overview?.violationBreakdown ?? [],
    [overview?.violationBreakdown]
  );
  const violationMax = useMemo(
    () => Math.max(1, ...violationBreakdown.map((item) => item.count)),
    [violationBreakdown]
  );

  if (!token) {
    return (
      <main className="center-screen">
        <div className="card-panel wide admin-login-card">
          <h1>Admin Dashboard Login</h1>
          <p className="muted">Open this page with `/admin` and use your admin passcode.</p>

          <form className="form-stack" onSubmit={handleLogin}>
            <label htmlFor="adminPasscode">Admin Passcode</label>
            <input
              id="adminPasscode"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              required
              placeholder="Enter admin passcode"
            />

            {errorMessage && <p className="error-text">{errorMessage}</p>}

            <button type="submit" className="btn btn-primary" disabled={loading.login}>
              {loading.login ? 'Signing in...' : 'Login'}
            </button>
          </form>

          <div className="inline-actions">
            <a className="btn btn-outline" href="/">
              Go to Student Exam
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      {infoMessage && <div className="toast info">{infoMessage}</div>}
      {errorMessage && <div className="toast error">{errorMessage}</div>}

      <header className="admin-header">
        <div>
          <h1>Salem Exam Admin</h1>
          <p>
            Session expires: <strong>{formatDate(tokenExpiresAt)}</strong>
          </p>
          <p>
            Exam serves <strong>{meta?.questionCount ?? 40}</strong> questions per candidate.
          </p>
        </div>

        <div className="inline-actions">
          <button type="button" className="btn btn-outline" onClick={handleRefreshAll}>
            Refresh Data
          </button>
          <a className="btn btn-secondary" href="/">
            Student View
          </a>
          <button type="button" className="btn btn-danger" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <section className="admin-cards-grid">
        <article className="result-box">
          <span>Total Candidates</span>
          <strong>{overview?.totals?.candidates ?? 0}</strong>
        </article>
        <article className="result-box">
          <span>Submitted</span>
          <strong>{overview?.totals?.submitted ?? 0}</strong>
        </article>
        <article className="result-box">
          <span>Active</span>
          <strong>{overview?.totals?.active ?? 0}</strong>
        </article>
        <article className="result-box">
          <span>Completion Rate</span>
          <strong>{overview?.totals?.completionRate ?? 0}%</strong>
        </article>
        <article className="result-box">
          <span>Avg Final Score</span>
          <strong>{overview?.totals?.averageScore ?? 0}%</strong>
        </article>
        <article className="result-box">
          <span>Avg Violations</span>
          <strong>{overview?.totals?.averageViolations ?? 0}</strong>
        </article>
      </section>

      <section className="admin-grid-2">
        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Score Distribution</h2>
            {loading.overview && <span className="muted">Loading...</span>}
          </div>

          <div className="chart-stack">
            {scoreDistribution.map((item) => (
              <div key={item.band} className="chart-row">
                <span className="chart-label">{item.band}</span>
                <div className="chart-track">
                  <div
                    className="chart-fill"
                    style={{ width: `${percentBarValue(item.count, scoreDistributionMax)}%` }}
                  />
                </div>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Violation Types</h2>
            {loading.overview && <span className="muted">Loading...</span>}
          </div>

          <div className="chart-stack">
            {violationBreakdown.length === 0 && <p className="muted">No violations logged yet.</p>}
            {violationBreakdown.map((item) => (
              <div key={item.type} className="chart-row">
                <span className="chart-label">{item.type}</span>
                <div className="chart-track">
                  <div
                    className="chart-fill warn"
                    style={{ width: `${percentBarValue(item.count, violationMax)}%` }}
                  />
                </div>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="admin-grid-2">
        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Class Performance</h2>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Candidates</th>
                  <th>Avg Score</th>
                  <th>Avg Violations</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.classPerformance ?? []).map((item) => (
                  <tr key={item.classRoom}>
                    <td>{item.classRoom}</td>
                    <td>{item.count}</td>
                    <td>{item.averageScore}%</td>
                    <td>{item.averageViolations}</td>
                  </tr>
                ))}
                {!overview?.classPerformance?.length && (
                  <tr>
                    <td colSpan={4}>No submitted sessions yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Recent Submissions</h2>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Class</th>
                  <th>Final</th>
                  <th>Violations</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.recentSubmissions ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.studentName}</td>
                    <td>{item.classRoom}</td>
                    <td>{item.finalPercent}%</td>
                    <td>{item.violationsCount}</td>
                    <td>{formatDate(item.submittedAt)}</td>
                  </tr>
                ))}
                {!overview?.recentSubmissions?.length && (
                  <tr>
                    <td colSpan={5}>No submissions yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="card-panel wide">
        <div className="panel-title-row">
          <h2>Export Center</h2>
        </div>

        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleExport('/api/admin/export/sessions.csv', 'sessions-export.csv')}
          >
            Export Sessions CSV
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleExport('/api/admin/export/sessions.json', 'sessions-export.json')}
          >
            Export Sessions JSON
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleExport('/api/admin/export/emails.csv', 'emails-only-export.csv')}
          >
            Export Emails Only CSV
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleExport('/api/admin/export/questions.csv', 'questions-export.csv')}
          >
            Export Questions CSV
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleExport('/api/admin/export/questions.json', 'questions-export.json')}
          >
            Export Questions JSON
          </button>
        </div>
      </section>

      <section className="card-panel wide">
        <div className="panel-title-row">
          <h2>Candidate Sessions</h2>
        </div>

        <div className="admin-filters">
          <input
            type="search"
            placeholder="Search by name or session ID"
            value={filters.search}
            onChange={(event) =>
              setFilters((previous) => ({ ...previous, search: event.target.value }))
            }
          />

          <select
            value={filters.classRoom}
            onChange={(event) =>
              setFilters((previous) => ({ ...previous, classRoom: event.target.value }))
            }
          >
            <option value="">All classes</option>
            {(meta?.classOptions ?? []).map((classOption) => (
              <option key={classOption} value={classOption}>
                {classOption}
              </option>
            ))}
          </select>

          <select
            value={filters.status}
            onChange={(event) => setFilters((previous) => ({ ...previous, status: event.target.value }))}
          >
            <option value="">All status</option>
            <option value="submitted">Submitted</option>
            <option value="active">Active</option>
          </select>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Name</th>
                <th>Class</th>
                <th>Email</th>
                <th>Status</th>
                <th>Final %</th>
                <th>Violations</th>
                <th>Started</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="mono">{session.id.slice(0, 8)}...</td>
                  <td>{session.studentName}</td>
                  <td>{session.classRoom}</td>
                  <td>{session.email || '-'}</td>
                  <td>
                    <span className={`status-pill ${session.status}`}>{session.status}</span>
                  </td>
                  <td>{session.finalPercent}%</td>
                  <td>{session.violationsCount}</td>
                  <td>{formatDate(session.startedAt)}</td>
                  <td>{formatDate(session.submittedAt)}</td>
                </tr>
              ))}
              {!sessions.length && (
                <tr>
                  <td colSpan={9}>{loading.sessions ? 'Loading sessions...' : 'No sessions found.'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-grid-2">
        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Add Question to Pool</h2>
            <span className="muted">Current pool: {questions.length}</span>
          </div>

          <form className="form-stack" onSubmit={handleCreateQuestion}>
            <label htmlFor="topic">Topic</label>
            <select
              id="topic"
              value={questionForm.topic}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, topic: event.target.value }))
              }
            >
              {TOPIC_OPTIONS.map((topic) => (
                <option key={topic} value={topic}>
                  {topic}
                </option>
              ))}
            </select>

            <label htmlFor="qtype">Type</label>
            <select
              id="qtype"
              value={questionForm.type}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, type: event.target.value }))
              }
            >
              <option value="single">Single Choice</option>
              <option value="multi">Multi Choice</option>
            </select>

            <label htmlFor="qtext">Question Text</label>
            <input
              id="qtext"
              value={questionForm.text}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, text: event.target.value }))
              }
              required
              placeholder="Enter a simple question"
            />

            <label htmlFor="optA">Option A</label>
            <input
              id="optA"
              value={questionForm.optionA}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, optionA: event.target.value }))
              }
              required
            />
            <label htmlFor="optB">Option B</label>
            <input
              id="optB"
              value={questionForm.optionB}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, optionB: event.target.value }))
              }
              required
            />
            <label htmlFor="optC">Option C</label>
            <input
              id="optC"
              value={questionForm.optionC}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, optionC: event.target.value }))
              }
              required
            />
            <label htmlFor="optD">Option D</label>
            <input
              id="optD"
              value={questionForm.optionD}
              onChange={(event) =>
                setQuestionForm((previous) => ({ ...previous, optionD: event.target.value }))
              }
              required
            />

            <label>Correct Answer(s)</label>
            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={questionForm.correctA}
                  onChange={(event) =>
                    setQuestionForm((previous) => ({ ...previous, correctA: event.target.checked }))
                  }
                />{' '}
                A
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={questionForm.correctB}
                  onChange={(event) =>
                    setQuestionForm((previous) => ({ ...previous, correctB: event.target.checked }))
                  }
                />{' '}
                B
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={questionForm.correctC}
                  onChange={(event) =>
                    setQuestionForm((previous) => ({ ...previous, correctC: event.target.checked }))
                  }
                />{' '}
                C
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={questionForm.correctD}
                  onChange={(event) =>
                    setQuestionForm((previous) => ({ ...previous, correctD: event.target.checked }))
                  }
                />{' '}
                D
              </label>
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading.addQuestion}>
              {loading.addQuestion ? 'Adding...' : 'Add Question'}
            </button>
          </form>
        </article>

        <article className="card-panel wide">
          <div className="panel-title-row">
            <h2>Question Pool</h2>
            {loading.questions && <span className="muted">Loading...</span>}
          </div>

          <div className="table-wrap tall">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Topic</th>
                  <th>Type</th>
                  <th>Question</th>
                  <th>Answer Key</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((question) => (
                  <tr key={question.id}>
                    <td className="mono">{question.id}</td>
                    <td>{question.topic}</td>
                    <td>{question.type}</td>
                    <td>{question.text}</td>
                    <td>{question.answerKey}</td>
                  </tr>
                ))}
                {!questions.length && (
                  <tr>
                    <td colSpan={5}>No questions available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  );
}

export default AdminPage;
