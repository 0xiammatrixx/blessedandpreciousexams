import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchMeta,
  fetchSession,
  logViolation,
  markSeen,
  saveAnswer,
  saveExamFeedback,
  saveFlag,
  startSession,
  submitExam,
} from './api';

const ACTIVE_SESSION_KEY = 'salem_exam_active_session';
const ACTIVE_INDEX_KEY = 'salem_exam_active_index';

const TOUR_STEPS = [
  {
    selector: '.tour-timer',
    dock: 'bottom',
    title: 'Timer',
    text: 'You have 25 minutes. Exam will submit automatically when time is 00:00.',
  },
  {
    selector: '.tour-violation',
    dock: 'bottom',
    title: 'Violation Counter',
    text: 'Tab switch, leaving fullscreen, and blocked keys are logged. Each violation can reduce marks.',
  },
  {
    selector: '.tour-question',
    dock: 'bottom',
    title: 'Question Area',
    text: 'Read one question at a time and choose your answer. Use clear answer if needed.',
  },
  {
    selector: '.tour-palette',
    dock: 'top',
    title: 'Question Palette',
    text: 'Use this menu to jump to any of your 40 questions. Colors show answer status.',
  },
];

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (safeSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return '-';
  }
}

function getQuestionStatus(questionId, seen, responses, flagged) {
  if (!seen[questionId]) {
    return 'unread';
  }

  if (flagged[questionId]) {
    return 'flagged';
  }

  return (responses[questionId] ?? []).length > 0 ? 'answered' : 'unanswered';
}

function StudentExamApp() {
  const [meta, setMeta] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [setupForm, setSetupForm] = useState({ fullName: '', classRoom: '', email: '' });
  const [session, setSession] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [tourRunning, setTourRunning] = useState(false);
  const [tourIndex, setTourIndex] = useState(0);
  const [infoMessage, setInfoMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [feedbackForm, setFeedbackForm] = useState({ rating: '', comment: '' });

  const violationThrottleRef = useRef(new Map());
  const autoSubmitTriggeredRef = useRef(false);

  const clearStoredSession = useCallback(() => {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_INDEX_KEY);
  }, []);

  const adoptSessionFromError = useCallback(
    (error) => {
      const serverSession = error?.payload?.session;
      if (!serverSession) {
        return false;
      }

      setSession(serverSession);
      setSetupForm({
        fullName: serverSession.student?.fullName ?? '',
        classRoom: serverSession.student?.classRoom ?? '',
        email: serverSession.student?.email ?? '',
      });

      if (serverSession.submittedAt) {
        clearStoredSession();
        setPhase('result');
      }

      return true;
    },
    [clearStoredSession]
  );

  useEffect(() => {
    let alive = true;

    async function bootstrap() {
      try {
        const metadata = await fetchMeta();
        if (!alive) {
          return;
        }

        setMeta(metadata);

        const savedSessionId = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (!savedSessionId) {
          setPhase('setup');
          return;
        }

        try {
          const existing = await fetchSession(savedSessionId);
          if (!alive) {
            return;
          }

          setSession(existing);
          setSetupForm({
            fullName: existing.student?.fullName ?? '',
            classRoom: existing.student?.classRoom ?? '',
            email: existing.student?.email ?? '',
          });

          const storedIndex = Number(localStorage.getItem(ACTIVE_INDEX_KEY) ?? '0');
          const boundedIndex = Number.isFinite(storedIndex)
            ? Math.min(Math.max(0, storedIndex), Math.max(0, existing.questions.length - 1))
            : 0;
          setCurrentIndex(boundedIndex);

          if (existing.submittedAt || existing.remainingSeconds <= 0) {
            clearStoredSession();
            setPhase('result');
          } else {
            setInfoMessage('Resumed your active exam session.');
            setPhase('exam');
          }
        } catch {
          clearStoredSession();
          setPhase('setup');
        }
      } catch (error) {
        if (!alive) {
          return;
        }

        setErrorMessage(error.message || 'Could not load exam settings.');
        setPhase('error');
      }
    }

    bootstrap();

    return () => {
      alive = false;
    };
  }, [clearStoredSession]);

  useEffect(() => {
    if (!infoMessage) {
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      setInfoMessage('');
    }, 3200);

    return () => clearTimeout(timeoutId);
  }, [infoMessage]);

  useEffect(() => {
    const rating = session?.feedback?.rating ? String(session.feedback.rating) : '';
    const comment = session?.feedback?.comment ?? '';
    setFeedbackForm({ rating, comment });
  }, [session?.feedback?.comment, session?.feedback?.rating, session?.sessionId]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!session || session.submittedAt) {
      clearStoredSession();
      return;
    }

    localStorage.setItem(ACTIVE_SESSION_KEY, session.sessionId);
  }, [clearStoredSession, session]);

  useEffect(() => {
    if (phase !== 'exam') {
      return;
    }

    localStorage.setItem(ACTIVE_INDEX_KEY, String(currentIndex));
  }, [phase, currentIndex]);

  useEffect(() => {
    if (phase !== 'exam' || !session?.sessionId || session.submittedAt) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      setSession((previous) => {
        if (!previous || previous.submittedAt) {
          return previous;
        }

        const nextRemaining = Math.max(0, Math.ceil((previous.expiresAt - Date.now()) / 1000));
        if (nextRemaining === previous.remainingSeconds) {
          return previous;
        }

        return {
          ...previous,
          remainingSeconds: nextRemaining,
        };
      });
    }, 1000);

    return () => clearInterval(intervalId);
  }, [phase, session?.sessionId, session?.submittedAt]);

  const handleSubmit = useCallback(
    async (trigger = 'manual') => {
      if (!session || isSubmitting) {
        return;
      }

      if (trigger === 'manual') {
        const ok = window.confirm('Submit exam now? You cannot edit answers after submitting.');
        if (!ok) {
          return;
        }
      }

      setIsSubmitting(true);
      setErrorMessage('');

      try {
        const payload = await submitExam(session.sessionId);
        setSession(payload.session);
        setPhase('result');
        clearStoredSession();

        if (document.fullscreenElement) {
          await document.exitFullscreen().catch(() => undefined);
        }
      } catch (error) {
        if (!adoptSessionFromError(error)) {
          setErrorMessage(error.message || 'Could not submit exam right now.');
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [adoptSessionFromError, clearStoredSession, isSubmitting, session]
  );

  useEffect(() => {
    if (phase !== 'exam' || !session || session.submittedAt) {
      return;
    }

    if (session.remainingSeconds > 0 || autoSubmitTriggeredRef.current) {
      return;
    }

    autoSubmitTriggeredRef.current = true;
    setInfoMessage('Time is up. Submitting your exam now...');
    void handleSubmit('auto');
  }, [handleSubmit, phase, session]);

  const activeQuestion = useMemo(() => {
    if (!session || !session.questions?.length) {
      return null;
    }
    return session.questions[currentIndex] ?? null;
  }, [currentIndex, session]);
  const activeTourStep = tourRunning ? TOUR_STEPS[tourIndex] ?? null : null;

  useEffect(() => {
    if (phase !== 'exam' || !session || !activeQuestion) {
      return;
    }

    const questionId = activeQuestion.id;
    if (session.seen[questionId]) {
      return;
    }

    setSession((previous) => {
      if (!previous) {
        return previous;
      }

      return {
        ...previous,
        seen: {
          ...previous.seen,
          [questionId]: true,
        },
      };
    });

    void markSeen(session.sessionId, questionId).catch((error) => {
      if (!adoptSessionFromError(error)) {
        setErrorMessage(error.message || 'Could not save read status.');
      }
    });
  }, [activeQuestion, adoptSessionFromError, phase, session]);

  const startExamFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      return;
    }

    await document.documentElement.requestFullscreen().catch(() => {
      setInfoMessage('Please click "Go Full Screen" if full screen did not start.');
    });
  }, []);

  const reportViolation = useCallback(
    (type, detail) => {
      if (!session || session.submittedAt || phase !== 'exam') {
        return;
      }

      const now = Date.now();
      const recent = violationThrottleRef.current.get(type) ?? 0;
      if (now - recent < 2000) {
        return;
      }

      violationThrottleRef.current.set(type, now);

      setSession((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          violations: [
            ...previous.violations,
            {
              id: `local-${now}`,
              type,
              detail,
              occurredAt: now,
            },
          ],
        };
      });

      setInfoMessage(`Violation logged: ${detail}`);

      void logViolation(session.sessionId, type, detail)
        .then((payload) => {
          if (!payload?.violations) {
            return;
          }

          setSession((previous) => {
            if (!previous) {
              return previous;
            }

            return {
              ...previous,
              violations: payload.violations,
            };
          });
        })
        .catch((error) => {
          if (!adoptSessionFromError(error)) {
            setErrorMessage(error.message || 'Could not sync proctoring log.');
          }
        });
    },
    [adoptSessionFromError, phase, session]
  );

  useEffect(() => {
    if (phase !== 'exam' || !session || session.submittedAt) {
      return undefined;
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        reportViolation('tab_switch', 'You left the exam tab');
      }
    };

    const onWindowBlur = () => {
      reportViolation('window_blur', 'Exam window lost focus');
    };

    const onFullscreenExit = () => {
      if (!document.fullscreenElement) {
        reportViolation('fullscreen_exit', 'You exited full screen mode');
      }
    };

    const onContextMenu = (event) => {
      event.preventDefault();
      reportViolation('right_click', 'Right click is blocked during exam');
    };

    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      const blocked =
        key === 'f12' ||
        key === 'printscreen' ||
        (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) ||
        (event.ctrlKey && ['u', 's', 'c', 'v', 'x', 'p'].includes(key)) ||
        (event.metaKey && ['c', 'v', 'x', 's', 'p'].includes(key));

      if (!blocked) {
        return;
      }

      event.preventDefault();
      reportViolation('restricted_key', `Blocked key: ${event.key}`);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('fullscreenchange', onFullscreenExit);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('fullscreenchange', onFullscreenExit);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [phase, reportViolation, session]);

  useEffect(() => {
    if (!tourRunning || phase !== 'exam') {
      return undefined;
    }

    const step = TOUR_STEPS[tourIndex];
    if (!step) {
      return undefined;
    }

    const target = document.querySelector(step.selector);
    if (!target) {
      return undefined;
    }

    target.setAttribute('data-tour-active', 'true');
    target.scrollIntoView({
      behavior: 'smooth',
      block: step.dock === 'top' ? 'end' : 'center',
      inline: 'nearest',
    });

    return () => {
      target.removeAttribute('data-tour-active');
    };
  }, [phase, tourIndex, tourRunning]);

  const finishTour = useCallback(() => {
    setTourRunning(false);
    setTourIndex(0);
  }, []);

  const handleStartSession = async (event) => {
    event.preventDefault();
    if (!meta) {
      return;
    }

    setErrorMessage('');
    setIsStarting(true);

    try {
      const created = await startSession(setupForm);
      autoSubmitTriggeredRef.current = false;
      setSession(created);
      setCurrentIndex(0);
      setPhase('instructions');
      localStorage.setItem(ACTIVE_SESSION_KEY, created.sessionId);
      localStorage.setItem(ACTIVE_INDEX_KEY, '0');
    } catch (error) {
      setErrorMessage(error.message || 'Could not start exam session.');
    } finally {
      setIsStarting(false);
    }
  };

  const beginExam = async () => {
    setPhase('exam');
    setTourRunning(true);
    setTourIndex(0);
    await startExamFullscreen();
  };

  const handlePickOption = (question, optionId) => {
    if (!session) {
      return;
    }

    const previous = session.responses[question.id] ?? [];
    const selected =
      question.type === 'single'
        ? [optionId]
        : previous.includes(optionId)
          ? previous.filter((id) => id !== optionId)
          : [...previous, optionId];

    setSession((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        responses: {
          ...current.responses,
          [question.id]: selected,
        },
      };
    });

    void saveAnswer(session.sessionId, question.id, selected).catch((error) => {
      if (!adoptSessionFromError(error)) {
        setErrorMessage(error.message || 'Could not save answer.');
      }
    });
  };

  const handleClearAnswer = () => {
    if (!session || !activeQuestion) {
      return;
    }

    setSession((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        responses: {
          ...current.responses,
          [activeQuestion.id]: [],
        },
      };
    });

    void saveAnswer(session.sessionId, activeQuestion.id, []).catch((error) => {
      if (!adoptSessionFromError(error)) {
        setErrorMessage(error.message || 'Could not clear answer.');
      }
    });
  };

  const handleToggleFlag = () => {
    if (!session || !activeQuestion) {
      return;
    }

    const nextFlagged = !session.flagged[activeQuestion.id];

    setSession((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        flagged: {
          ...current.flagged,
          [activeQuestion.id]: nextFlagged,
        },
      };
    });

    void saveFlag(session.sessionId, activeQuestion.id, nextFlagged).catch((error) => {
      if (!adoptSessionFromError(error)) {
        setErrorMessage(error.message || 'Could not update flag status.');
      }
    });
  };

  const handleStartNewCandidate = () => {
    clearStoredSession();
    autoSubmitTriggeredRef.current = false;
    setSession(null);
    setCurrentIndex(0);
    setTourRunning(false);
    setTourIndex(0);
    setIsSavingFeedback(false);
    setFeedbackForm({ rating: '', comment: '' });
    setInfoMessage('');
    setErrorMessage('');
    setSetupForm({ fullName: '', classRoom: '', email: '' });
    setPhase('setup');
  };

  const handleSaveFeedback = async (event) => {
    event.preventDefault();

    if (!session?.sessionId || !session.submittedAt || isSavingFeedback) {
      return;
    }

    const rating = feedbackForm.rating ? Number(feedbackForm.rating) : null;
    const comment = feedbackForm.comment.trim();

    if (!rating && !comment) {
      setInfoMessage('Feedback skipped. You can still start another candidate.');
      return;
    }

    setIsSavingFeedback(true);
    setErrorMessage('');

    try {
      const payload = await saveExamFeedback(session.sessionId, { rating, comment });
      if (payload?.session) {
        setSession(payload.session);
      } else if (payload?.feedback) {
        setSession((previous) => (previous ? { ...previous, feedback: payload.feedback } : previous));
      }

      setInfoMessage('Thanks. Feedback saved.');
    } catch (error) {
      if (!adoptSessionFromError(error)) {
        setErrorMessage(error.message || 'Could not save feedback right now.');
      }
    } finally {
      setIsSavingFeedback(false);
    }
  };

  if (phase === 'loading') {
    return (
      <main className="center-screen">
        <div className="card-panel">
          <h1>Salem Academy CBT</h1>
          <p>Loading exam setup...</p>
        </div>
      </main>
    );
  }

  if (phase === 'error') {
    return (
      <main className="center-screen">
        <div className="card-panel">
          <h1>Unable to Load App</h1>
          <p>{errorMessage || 'Something went wrong while loading the exam app.'}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }

  if (phase === 'setup') {
    return (
      <main className="center-screen">
        <div className="card-panel">
          <h1>Salem Academy CBT</h1>
          <p className="muted">Student Login</p>

          <form onSubmit={handleStartSession} className="form-stack">
            <label htmlFor="fullName">Full Name</label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              required
              minLength={5}
              value={setupForm.fullName}
              onChange={(event) =>
                setSetupForm((previous) => ({ ...previous, fullName: event.target.value }))
              }
              placeholder="Example: Ada Bright James"
            />

            <label htmlFor="classRoom">Class</label>
            <select
              id="classRoom"
              name="classRoom"
              required
              value={setupForm.classRoom}
              onChange={(event) =>
                setSetupForm((previous) => ({ ...previous, classRoom: event.target.value }))
              }
            >
              <option value="">Select class</option>
              {meta?.classOptions?.map((classOption) => (
                <option key={classOption} value={classOption}>
                  {classOption}
                </option>
              ))}
            </select>

            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              value={setupForm.email}
              onChange={(event) =>
                setSetupForm((previous) => ({ ...previous, email: event.target.value }))
              }
              placeholder="student@email.com"
            />

            {errorMessage && <p className="error-text">{errorMessage}</p>}

            <button type="submit" className="btn btn-primary" disabled={isStarting}>
              {isStarting ? 'Creating Session...' : 'Continue'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (phase === 'instructions') {
    return (
      <main className="center-screen">
        <div className="card-panel wide">
          <h1>Exam Instructions</h1>
          <p>
            Candidate: <strong>{session?.student.fullName}</strong> | Class:{' '}
            <strong>{session?.student.classRoom}</strong>
          </p>
          <p className="muted">Results will be sent to {session?.student.email} before end of day.</p>

          <ul className="rules-list">
            <li>Total questions: {meta?.questionCount ?? 40}</li>
            <li>Time allowed: {formatTime(meta?.durationSeconds ?? 1500)}</li>
            <li>Questions are in random order for each student.</li>
            <li>One question is shown at a time.</li>
            <li>Use the bottom palette to jump between questions.</li>
            <li>Violation warning: each violation reduces score by {meta?.penaltyPerViolation ?? 2}%.</li>
            <li>Stay in full screen for the whole exam.</li>
          </ul>

          <div className="inline-actions">
            <button type="button" className="btn btn-secondary" onClick={handleStartNewCandidate}>
              Cancel Session
            </button>
            <button type="button" className="btn btn-primary" onClick={beginExam}>
              Start Exam
            </button>
          </div>

          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </div>
      </main>
    );
  }

  if (phase === 'result' && session) {
    const summary = session.summary;

    return (
      <main className="center-screen">
        <div className="card-panel wide">
          <h1>Exam Submitted</h1>
          <p>
            Student: <strong>{session.student.fullName}</strong> | Class:{' '}
            <strong>{session.student.classRoom}</strong>
          </p>

          <div className="result-grid">
            <div className="result-box">
              <span>Answered</span>
              <strong>
                {summary?.answeredCount ?? 0}/{summary?.totalQuestions ?? 40}
              </strong>
            </div>
            <div className="result-box">
              <span>Correct</span>
              <strong>
                {summary?.correctCount ?? 0}/{summary?.totalQuestions ?? 40}
              </strong>
            </div>
            <div className="result-box">
              <span>Raw Score</span>
              <strong>{summary?.rawPercent ?? 0}%</strong>
            </div>
            <div className="result-box">
              <span>Violations</span>
              <strong>{summary?.violationsCount ?? 0}</strong>
            </div>
            <div className="result-box">
              <span>Penalty</span>
              <strong>-{summary?.penaltyPoints ?? 0}%</strong>
            </div>
            <div className="result-box final">
              <span>Final Score</span>
              <strong>{summary?.finalPercent ?? 0}%</strong>
            </div>
          </div>

          <p className="muted">
            Score out of 40: <strong>{summary?.finalScoreOutOf40 ?? 0}</strong>
          </p>
          <p className="muted">
            Results will be sent to <strong>{session.student.email}</strong> before end of day.
          </p>

          <form className="feedback-panel" onSubmit={handleSaveFeedback}>
            <h3>Optional Rating & Feedback</h3>
            <p className="muted">Tell us how the exam experience felt for this student.</p>

            <div className="feedback-grid">
              <div>
                <label htmlFor="feedbackRating">Rating (1 to 5)</label>
                <select
                  id="feedbackRating"
                  value={feedbackForm.rating}
                  onChange={(event) =>
                    setFeedbackForm((previous) => ({ ...previous, rating: event.target.value }))
                  }
                >
                  <option value="">No rating</option>
                  <option value="1">1 - Poor</option>
                  <option value="2">2 - Fair</option>
                  <option value="3">3 - Okay</option>
                  <option value="4">4 - Good</option>
                  <option value="5">5 - Excellent</option>
                </select>
              </div>

              <div>
                <label htmlFor="feedbackComment">Comment</label>
                <textarea
                  id="feedbackComment"
                  value={feedbackForm.comment}
                  onChange={(event) =>
                    setFeedbackForm((previous) => ({ ...previous, comment: event.target.value }))
                  }
                  maxLength={600}
                  rows={3}
                  placeholder="Optional comment"
                />
              </div>
            </div>

            <div className="inline-actions">
              <button type="submit" className="btn btn-outline" disabled={isSavingFeedback}>
                {isSavingFeedback ? 'Saving...' : 'Save Feedback'}
              </button>
              {session.feedback && (
                <p className="muted">
                  Saved: {session.feedback.rating ? `${session.feedback.rating}/5` : 'No rating'} at{' '}
                  {formatDateTime(session.feedback.submittedAt)}
                </p>
              )}
            </div>
          </form>

          <div className="inline-actions">
            <button type="button" className="btn btn-primary" onClick={handleStartNewCandidate}>
              Start New Candidate
            </button>
          </div>
        </div>
      </main>
    );
  }

  const responses = session?.responses ?? {};
  const flagged = session?.flagged ?? {};
  const seen = session?.seen ?? {};
  const answeredCount = session?.questions
    ? session.questions.filter((question) => (responses[question.id] ?? []).length > 0).length
    : 0;
  const unansweredCount = (session?.questions?.length ?? 0) - answeredCount;
  const violationCount = session?.violations?.length ?? 0;

  return (
    <main className="exam-shell">
      {infoMessage && <div className="toast info">{infoMessage}</div>}
      {errorMessage && <div className="toast error">{errorMessage}</div>}

      <header className="exam-header">
        <div>
          <h1>Salem Academy CBT</h1>
          <p>
            {session?.student.fullName} | {session?.student.classRoom}
          </p>
        </div>

        <div className="header-status">
          <div className="stat-pill tour-timer">
            <span>Time Left</span>
            <strong>{formatTime(session?.remainingSeconds ?? 0)}</strong>
          </div>

          <div className="stat-pill tour-violation">
            <span>Violations</span>
            <strong>{violationCount}</strong>
          </div>

          <div className="stat-pill">
            <span>Answered</span>
            <strong>{answeredCount}</strong>
          </div>

          <div className="stat-pill">
            <span>Unanswered</span>
            <strong>{unansweredCount}</strong>
          </div>

          <button type="button" className="btn btn-outline" onClick={startExamFullscreen}>
            {isFullscreen ? 'Fullscreen Active' : 'Go Full Screen'}
          </button>

          <button type="button" className="btn btn-danger" onClick={() => void handleSubmit('manual')}>
            {isSubmitting ? 'Submitting...' : 'Submit Exam'}
          </button>
        </div>
      </header>

      <section className="question-area tour-question">
        <p className="question-number">
          Question {currentIndex + 1} of {session?.questions.length ?? 0}
        </p>
        <h2>{activeQuestion?.text}</h2>
        <p className="muted">
          {activeQuestion?.type === 'multi'
            ? 'This question has more than one correct answer. Pick all that apply.'
            : 'Pick one answer.'}
        </p>

        <div className="options-list">
          {activeQuestion?.options.map((option) => {
            const chosen = (responses[activeQuestion.id] ?? []).includes(option.id);
            const controlType = activeQuestion.type === 'single' ? 'radio' : 'checkbox';

            return (
              <label key={option.id} className={`option-card ${chosen ? 'selected' : ''}`}>
                <input
                  type={controlType}
                  name={activeQuestion.id}
                  checked={chosen}
                  onChange={() => handlePickOption(activeQuestion, option.id)}
                />
                <span className="option-label">{option.id}. {option.text}</span>
              </label>
            );
          })}
        </div>

        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
            disabled={currentIndex === 0}
          >
            Previous
          </button>

          <button type="button" className="btn btn-outline" onClick={handleClearAnswer}>
            Clear Answer
          </button>

          <button
            type="button"
            className={`btn ${flagged[activeQuestion?.id] ? 'btn-warning' : 'btn-outline'}`}
            onClick={handleToggleFlag}
          >
            {flagged[activeQuestion?.id] ? 'Unflag' : 'Flag'}
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              setCurrentIndex((index) =>
                Math.min((session?.questions.length ?? 1) - 1, index + 1)
              )
            }
            disabled={currentIndex >= (session?.questions.length ?? 1) - 1}
          >
            Next
          </button>
        </div>
      </section>

      <section className="palette-panel tour-palette">
        <div className="palette-header">
          <h3>Question Menu (1 - 40)</h3>
          <p>Jump to any question</p>
        </div>

        <div className="palette-grid">
          {session?.questions.map((question, index) => {
            const status = getQuestionStatus(question.id, seen, responses, flagged);
            const isCurrent = index === currentIndex;

            return (
              <button
                key={question.id}
                type="button"
                className={`palette-btn ${status} ${isCurrent ? 'current' : ''}`}
                onClick={() => setCurrentIndex(index)}
              >
                {index + 1}
              </button>
            );
          })}
        </div>

        <div className="legend-row">
          <span><i className="legend-dot answered" />Answered</span>
          <span><i className="legend-dot unanswered" />Unanswered</span>
          <span><i className="legend-dot flagged" />Flagged</span>
          <span><i className="legend-dot unread" />Unread</span>
        </div>
      </section>

      {tourRunning && activeTourStep && (
        <div className={`tour-overlay ${activeTourStep.dock === 'top' ? 'dock-top' : 'dock-bottom'}`}>
          <div className="tour-card">
            <p className="tour-step">Step {tourIndex + 1} of {TOUR_STEPS.length}</p>
            <h3>{activeTourStep.title}</h3>
            <p>{activeTourStep.text}</p>

            <div className="inline-actions">
              <button type="button" className="btn btn-secondary" onClick={finishTour}>
                Skip Tour
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={tourIndex === 0}
                onClick={() => setTourIndex((index) => Math.max(0, index - 1))}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (tourIndex === TOUR_STEPS.length - 1) {
                    finishTour();
                    return;
                  }

                  setTourIndex((index) => index + 1);
                }}
              >
                {tourIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default StudentExamApp;
