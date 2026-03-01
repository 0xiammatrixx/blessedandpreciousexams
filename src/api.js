const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: 'Unexpected server response.' };

  if (!response.ok) {
    const message = payload?.error || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }

  return payload;
}

function withAdminHeaders(token, headers = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...headers,
  };
}

export function fetchMeta() {
  return apiRequest('/api/exam/meta');
}

export function startSession(data) {
  return apiRequest('/api/exam/start', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function fetchSession(sessionId) {
  return apiRequest(`/api/exam/${sessionId}`);
}

export function markSeen(sessionId, questionId) {
  return apiRequest(`/api/exam/${sessionId}/seen`, {
    method: 'POST',
    body: JSON.stringify({ questionId }),
  });
}

export function saveAnswer(sessionId, questionId, selectedOptionIds) {
  return apiRequest(`/api/exam/${sessionId}/answer`, {
    method: 'POST',
    body: JSON.stringify({ questionId, selectedOptionIds }),
  });
}

export function saveFlag(sessionId, questionId, flagged) {
  return apiRequest(`/api/exam/${sessionId}/flag`, {
    method: 'POST',
    body: JSON.stringify({ questionId, flagged }),
  });
}

export function logViolation(sessionId, type, detail) {
  return apiRequest(`/api/exam/${sessionId}/proctor`, {
    method: 'POST',
    body: JSON.stringify({ type, detail }),
  });
}

export function submitExam(sessionId) {
  return apiRequest(`/api/exam/${sessionId}/submit`, {
    method: 'POST',
  });
}

export function saveExamFeedback(sessionId, payload) {
  return apiRequest(`/api/exam/${sessionId}/feedback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function adminLogin(passcode) {
  return apiRequest('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ passcode }),
  });
}

export function fetchAdminOverview(token) {
  return apiRequest('/api/admin/overview', {
    headers: withAdminHeaders(token),
  });
}

export function fetchAdminSessions(token, { search = '', classRoom = '', status = '' } = {}) {
  const params = new URLSearchParams();
  if (search) {
    params.set('search', search);
  }
  if (classRoom) {
    params.set('classRoom', classRoom);
  }
  if (status) {
    params.set('status', status);
  }

  const queryString = params.toString();
  return apiRequest(`/api/admin/sessions${queryString ? `?${queryString}` : ''}`, {
    headers: withAdminHeaders(token),
  });
}

export function fetchAdminQuestions(token) {
  return apiRequest('/api/admin/questions', {
    headers: withAdminHeaders(token),
  });
}

export function createAdminQuestion(token, payload) {
  return apiRequest('/api/admin/questions', {
    method: 'POST',
    headers: withAdminHeaders(token),
    body: JSON.stringify(payload),
  });
}

export async function downloadAdminExport(token, path, downloadName) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: withAdminHeaders(token),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Ignore response parsing errors for failed download responses.
    }

    throw new Error(message);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = downloadName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
