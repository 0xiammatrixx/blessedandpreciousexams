import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  adminLogin,
  createAdminQuestion,
  deleteAdminSession,
  deleteAdminSessions,
  downloadAdminExport,
  fetchAdminOverview,
  fetchAdminQuestions,
  fetchAdminSessions,
  fetchMeta,
  purgeAdminSessions,
} from './api';

const ADMIN_TOKEN_KEY = 'salem_admin_token';
const ADMIN_TOKEN_EXPIRES_KEY = 'salem_admin_token_expires_at';
const ADMIN_WIDGETS_KEY = 'salem_admin_widgets';

const TOPIC_OPTIONS = ['basics', 'internet', 'web', 'coding', 'navigation', 'vscode', 'general'];

const DEFAULT_WIDGETS = {
  summaryCards: true,
  scoreDistribution: true,
  violationTypes: true,
  classPerformance: true,
  recentSubmissions: true,
  exportCenter: true,
  candidateSessions: true,
  questionManager: true,
};

const ANALYTICS_WIDGET_KEYS = [
  'summaryCards',
  'scoreDistribution',
  'violationTypes',
  'classPerformance',
  'recentSubmissions',
];

const CORE_WIDGET_PRESET = {
  summaryCards: true,
  scoreDistribution: true,
  violationTypes: false,
  classPerformance: true,
  recentSubmissions: true,
  exportCenter: true,
  candidateSessions: true,
  questionManager: false,
};

const WIDGET_LABELS = {
  summaryCards: 'Summary cards',
  scoreDistribution: 'Score distribution',
  violationTypes: 'Violation types',
  classPerformance: 'Class performance',
  recentSubmissions: 'Recent submissions',
  exportCenter: 'Export center',
  candidateSessions: 'Candidate sessions',
  questionManager: 'Question manager',
};

const PURGE_LABELS = {
  submitted: 'submitted sessions',
  active: 'active sessions',
  time_up: 'timed-out sessions',
  all: 'all sessions',
};

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

function loadStoredWidgets() {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_WIDGETS };
  }

  try {
    const raw = window.localStorage.getItem(ADMIN_WIDGETS_KEY);
    if (!raw) {
      return { ...DEFAULT_WIDGETS };
    }

    const parsed = JSON.parse(raw);
    return { ...DEFAULT_WIDGETS, ...parsed };
  } catch {
    return { ...DEFAULT_WIDGETS };
  }
}

function AdminPage() {
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState(0);
  const [passcode, setPasscode] = useState('');
  const [widgets, setWidgets] = useState(loadStoredWidgets);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);

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
    deleting: false,
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
    setSelectedSessionIds([]);
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

  useEffect(() => {
    try {
      localStorage.setItem(ADMIN_WIDGETS_KEY, JSON.stringify(widgets));
    } catch {
      // ignore storage write errors
    }
  }, [widgets]);

  useEffect(() => {
    if (!sessions.length) {
      setSelectedSessionIds([]);
      return;
    }

    const validIds = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((previous) => previous.filter((id) => validIds.has(id)));
  }, [sessions]);

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

  const refreshOverviewAndSessions = useCallback(
    async (activeToken) => {
      if (!activeToken) {
        return;
      }

      await Promise.all([loadOverview(activeToken), loadSessions(activeToken, filters)]);
    },
    [filters, loadOverview, loadSessions]
  );

  const handleToggleWidget = useCallback((widgetKey) => {
    setWidgets((previous) => ({
      ...previous,
      [widgetKey]: !previous[widgetKey],
    }));
  }, []);

  const handleWidgetPreset = useCallback((preset) => {
    if (preset === 'all') {
      setWidgets({ ...DEFAULT_WIDGETS });
      return;
    }

    if (preset === 'core') {
      setWidgets({ ...CORE_WIDGET_PRESET });
      return;
    }

    if (preset === 'analytics-all') {
      setWidgets((previous) => {
        const next = { ...previous };
        for (const key of ANALYTICS_WIDGET_KEYS) {
          next[key] = true;
        }
        return next;
      });
      return;
    }

    if (preset === 'analytics-relevant') {
      setWidgets((previous) => ({
        ...previous,
        summaryCards: true,
        scoreDistribution: true,
        violationTypes: false,
        classPerformance: true,
        recentSubmissions: true,
      }));
    }
  }, []);

  const visibleSessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const visibleSessionIdSet = useMemo(() => new Set(visibleSessionIds), [visibleSessionIds]);
  const selectedVisibleCount = useMemo(
    () => selectedSessionIds.filter((id) => visibleSessionIdSet.has(id)).length,
    [selectedSessionIds, visibleSessionIdSet]
  );
  const allVisibleSelected = useMemo(
    () => visibleSessionIds.length > 0 && selectedVisibleCount === visibleSessionIds.length,
    [selectedVisibleCount, visibleSessionIds.length]
  );

  const handleToggleSessionSelection = useCallback((sessionId, checked) => {
    setSelectedSessionIds((previous) => {
      if (checked) {
        if (previous.includes(sessionId)) {
          return previous;
        }

        return [...previous, sessionId];
      }

      return previous.filter((id) => id !== sessionId);
    });
  }, []);

  const handleToggleAllVisible = useCallback(
    (checked) => {
      setSelectedSessionIds((previous) => {
        if (checked) {
          return [...new Set([...previous, ...visibleSessionIds])];
        }

        const visibleIdSet = new Set(visibleSessionIds);
        return previous.filter((id) => !visibleIdSet.has(id));
      });
    },
    [visibleSessionIds]
  );

  const handleDeleteSingleSession = useCallback(
    async (session) => {
      if (!token || !session?.id) {
        return;
      }

      const confirmed = window.confirm(
        `Delete session for ${session.studentName}? This action cannot be undone.`
      );
      if (!confirmed) {
        return;
      }

      setErrorMessage('');
      updateLoading('deleting', true);

      try {
        await deleteAdminSession(token, session.id);
        setSelectedSessionIds((previous) => previous.filter((id) => id !== session.id));
        await refreshOverviewAndSessions(token);
        setInfoMessage('Session deleted.');
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setErrorMessage(error.message || 'Could not delete session.');
        }
      } finally {
        updateLoading('deleting', false);
      }
    },
    [handleUnauthorized, refreshOverviewAndSessions, token, updateLoading]
  );

  const handleDeleteSelectedSessions = useCallback(async () => {
    if (!token) {
      return;
    }

    if (!selectedSessionIds.length) {
      setErrorMessage('Select at least one session to delete.');
      return;
    }

    const confirmed = window.confirm(
      `Delete ${selectedSessionIds.length} selected session(s)? This action cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    setErrorMessage('');
    updateLoading('deleting', true);

    try {
      const payload = await deleteAdminSessions(token, selectedSessionIds);
      setSelectedSessionIds([]);
      await refreshOverviewAndSessions(token);
      setInfoMessage(`${payload.deletedCount ?? 0} selected session(s) deleted.`);
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setErrorMessage(error.message || 'Could not delete selected sessions.');
      }
    } finally {
      updateLoading('deleting', false);
    }
  }, [
    handleUnauthorized,
    refreshOverviewAndSessions,
    selectedSessionIds,
    token,
    updateLoading,
  ]);

  const handlePurgeSessions = useCallback(
    async (scope) => {
      if (!token) {
        return;
      }

      const label = PURGE_LABELS[scope] ?? 'sessions';
      const confirmed = window.confirm(`Purge ${label}? This action cannot be undone.`);
      if (!confirmed) {
        return;
      }

      setErrorMessage('');
      updateLoading('deleting', true);

      try {
        const payload = await purgeAdminSessions(token, scope);
        setSelectedSessionIds([]);
        await refreshOverviewAndSessions(token);
        setInfoMessage(`Purge complete: ${payload.deletedCount ?? 0} session(s) removed.`);
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setErrorMessage(error.message || 'Could not purge sessions.');
        }
      } finally {
        updateLoading('deleting', false);
      }
    },
    [handleUnauthorized, refreshOverviewAndSessions, token, updateLoading]
  );

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
  const visibleAnalyticsCount = useMemo(
    () => ANALYTICS_WIDGET_KEYS.filter((key) => widgets[key]).length,
    [widgets]
  );
  const showScoreAndViolation = widgets.scoreDistribution || widgets.violationTypes;
  const showClassAndRecent = widgets.classPerformance || widgets.recentSubmissions;

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

      <section className="card-panel wide admin-card">
        <div className="panel-title-row">
          <h2>Dashboard Widget Controls</h2>
          <span className="muted">
            Visible analytics widgets: {visibleAnalyticsCount}/{ANALYTICS_WIDGET_KEYS.length}
          </span>
        </div>

        <div className="inline-actions">
          <button type="button" className="btn btn-outline" onClick={() => handleWidgetPreset('analytics-all')}>
            Show All Analytics
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => handleWidgetPreset('analytics-relevant')}
          >
            Relevant Analytics
          </button>
          <button type="button" className="btn btn-outline" onClick={() => handleWidgetPreset('core')}>
            Core View
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => handleWidgetPreset('all')}>
            Reset Defaults
          </button>
        </div>

        <div className="widget-grid">
          {Object.entries(WIDGET_LABELS).map(([widgetKey, label]) => (
            <label key={widgetKey} className={`widget-toggle ${widgets[widgetKey] ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={Boolean(widgets[widgetKey])}
                onChange={() => handleToggleWidget(widgetKey)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {widgets.summaryCards && (
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
        <article className="result-box">
          <span>Feedback Count</span>
          <strong>{overview?.totals?.feedbackCount ?? 0}</strong>
        </article>
        <article className="result-box">
          <span>Average Rating</span>
          <strong>{overview?.totals?.averageRating ?? 0}/5</strong>
        </article>
      </section>
      )}

      {showScoreAndViolation && (
      <section className={`admin-grid-2 ${!widgets.scoreDistribution || !widgets.violationTypes ? 'single-column' : ''}`}>
        {widgets.scoreDistribution && (
        <article className="card-panel wide admin-card">
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
        )}

        {widgets.violationTypes && (
        <article className="card-panel wide admin-card">
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
        )}
      </section>
      )}

      {showClassAndRecent && (
      <section className={`admin-grid-2 ${!widgets.classPerformance || !widgets.recentSubmissions ? 'single-column' : ''}`}>
        {widgets.classPerformance && (
        <article className="card-panel wide admin-card">
          <div className="panel-title-row">
            <h2>Class Performance</h2>
          </div>

          <div className="table-wrap medium">
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
        )}

        {widgets.recentSubmissions && (
        <article className="card-panel wide admin-card">
          <div className="panel-title-row">
            <h2>Recent Submissions</h2>
          </div>

          <div className="table-wrap medium">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Class</th>
                  <th>Final</th>
                  <th>Violations</th>
                  <th>Rating</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.recentSubmissions ?? []).map((item) => (
                  <tr key={item.id}>
                    <td title={item.studentName}>
                      <span className="truncate-line">{item.studentName}</span>
                    </td>
                    <td title={item.classRoom}>
                      <span className="truncate-line">{item.classRoom}</span>
                    </td>
                    <td>{item.finalPercent}%</td>
                    <td>{item.violationsCount}</td>
                    <td>{item.feedbackRating ?? '-'}</td>
                    <td>{formatDate(item.submittedAt)}</td>
                  </tr>
                ))}
                {!overview?.recentSubmissions?.length && (
                  <tr>
                    <td colSpan={6}>No submissions yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
        )}
      </section>
      )}

      {widgets.exportCenter && (
      <section className="card-panel wide admin-card">
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
      )}

      {widgets.candidateSessions && (
      <section className="card-panel wide admin-card">
        <div className="panel-title-row">
          <h2>Candidate Sessions</h2>
          <span className="muted">{sessions.length} row(s)</span>
        </div>

        <div className="admin-action-row">
          <p className="muted">Selected: {selectedSessionIds.length}</p>
          <div className="inline-actions admin-action-buttons">
            <button
              type="button"
              className="btn btn-danger"
              disabled={loading.deleting || selectedSessionIds.length === 0}
              onClick={handleDeleteSelectedSessions}
            >
              {loading.deleting ? 'Working...' : 'Delete Selected'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={selectedSessionIds.length === 0 || loading.deleting}
              onClick={() => setSelectedSessionIds([])}
            >
              Clear Selection
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={loading.deleting}
              onClick={() => handlePurgeSessions('submitted')}
            >
              Purge Submitted
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={loading.deleting}
              onClick={() => handlePurgeSessions('time_up')}
            >
              Purge Timed-out
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={loading.deleting}
              onClick={() => handlePurgeSessions('active')}
            >
              Purge Active
            </button>
            <button
              type="button"
              className="btn btn-warning"
              disabled={loading.deleting}
              onClick={() => handlePurgeSessions('all')}
            >
              Purge All
            </button>
          </div>
        </div>

        <div className="admin-filters">
          <input
            type="search"
            placeholder="Search by name, email or session ID"
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
            <option value="time_up">Time Up</option>
          </select>
        </div>

        <div className="table-wrap large">
          <table className="sessions-table">
            <thead>
              <tr>
                <th className="cell-tight">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => handleToggleAllVisible(event.target.checked)}
                    aria-label="Select all visible sessions"
                  />
                </th>
                <th>Session ID</th>
                <th>Name</th>
                <th>Class</th>
                <th>Email</th>
                <th>Status</th>
                <th>Final %</th>
                <th>Violations</th>
                <th>Rating</th>
                <th>Feedback</th>
                <th>Started</th>
                <th>Submitted</th>
                <th className="cell-tight">Action</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="cell-tight">
                    <input
                      type="checkbox"
                      checked={selectedSessionIds.includes(session.id)}
                      onChange={(event) =>
                        handleToggleSessionSelection(session.id, event.target.checked)
                      }
                      aria-label={`Select session ${session.id}`}
                    />
                  </td>
                  <td className="mono" title={session.id}>
                    <span className="truncate-line">{session.id}</span>
                  </td>
                  <td title={session.studentName}>
                    <span className="truncate-line">{session.studentName}</span>
                  </td>
                  <td title={session.classRoom}>
                    <span className="truncate-line">{session.classRoom}</span>
                  </td>
                  <td title={session.email || '-'}>
                    <span className="truncate-line">{session.email || '-'}</span>
                  </td>
                  <td>
                    <span className={`status-pill ${session.status}`}>{session.status}</span>
                  </td>
                  <td>{session.finalPercent}%</td>
                  <td>{session.violationsCount}</td>
                  <td>{session.feedbackRating ?? '-'}</td>
                  <td title={session.feedbackComment || '-'}>
                    <span className="truncate-line">{session.feedbackComment || '-'}</span>
                  </td>
                  <td>{formatDate(session.startedAt)}</td>
                  <td>{formatDate(session.submittedAt)}</td>
                  <td className="cell-tight">
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      disabled={loading.deleting}
                      onClick={() => handleDeleteSingleSession(session)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!sessions.length && (
                <tr>
                  <td colSpan={13}>
                    {loading.sessions ? 'Loading sessions...' : 'No sessions found for this filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="muted">Selected on screen: {selectedVisibleCount}</p>
      </section>
      )}

      {widgets.questionManager && (
      <section className="admin-grid-2">
        <article className="card-panel wide admin-card">
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

        <article className="card-panel wide admin-card">
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
                    <td className="mono" title={question.id}>
                      <span className="truncate-line">{question.id}</span>
                    </td>
                    <td title={question.topic}>
                      <span className="truncate-line">{question.topic}</span>
                    </td>
                    <td title={question.type}>
                      <span className="truncate-line">{question.type}</span>
                    </td>
                    <td title={question.text}>
                      <span className="truncate-2">{question.text}</span>
                    </td>
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
      )}
    </main>
  );
}

export default AdminPage;
