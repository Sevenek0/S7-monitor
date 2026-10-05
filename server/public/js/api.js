// Klient REST z tokenem Bearer.
const KEY = 's7_token';

export const auth = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(KEY, t); } catch { /* tryb prywatny */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Brak połączenia z serwerem');
  }
  let data = null;
  try { data = await res.json(); } catch { /* brak treści */ }
  if (res.status === 401 && path !== '/login') { onUnauthorized(); }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Błąd ${res.status}`);
  return data;
}

export async function login(password) {
  const r = await api('/login', { method: 'POST', body: { password } });
  auth.set(r.token);
  return r;
}
