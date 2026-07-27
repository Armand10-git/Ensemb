const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

function getToken(): string | null {
  return localStorage.getItem('access_token');
}

/**
 * En dev/CLI (Host sans sous-domaine, ex. localhost), TenancyMiddleware résout le tenant
 * via ce header plutôt que via le sous-domaine — cf. tenancy.middleware.ts. Posé en
 * localStorage à la connexion (routes/login.tsx). Sans lui, toute route protégée renvoie
 * 404 "Organisation introuvable" avant même d'atteindre le contrôleur.
 */
function getOrganizationId(): string | null {
  return localStorage.getItem('organization_id');
}

function clearSession(): void {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('organization_id');
  localStorage.removeItem('permissions');
}

function buildHeaders(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  const organizationId = getOrganizationId();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
    ...(extra ?? {}),
  };
}

/**
 * Rafraîchit l'access token (durée de vie 15 min, cf. auth.service.ts) via le refresh
 * token stocké. Dédupliqué : si plusieurs requêtes échouent en 401 simultanément, un
 * seul appel /auth/refresh part — les autres attendent son résultat. Retourne false si
 * le refresh échoue (refresh token expiré/révoqué) : la session doit alors être terminée.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshPromise ??= (async () => {
    const refreshToken = localStorage.getItem('refresh_token');
    const organizationId = getOrganizationId();
    if (!refreshToken || !organizationId) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      localStorage.setItem('access_token', data.accessToken);
      localStorage.setItem('refresh_token', data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/** Session irrécupérable (refresh échoué) : nettoyage local + retour à l'écran de connexion. */
function endSession(): never {
  clearSession();
  window.location.href = '/login';
  throw new Error('Session expirée — reconnexion nécessaire.');
}

async function request<T>(path: string, options?: RequestInit, isRetry = false): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers: buildHeaders(options?.headers) });

  // 401 sur une route protégée (jamais sur /auth/* lui-même, pour éviter toute boucle) :
  // tente un rafraîchissement silencieux puis rejoue la requête une seule fois.
  if (res.status === 401 && !isRetry && !path.startsWith('/auth/')) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, options, true);
    endSession();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Erreur ${res.status}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

async function upload<T>(path: string, formData: FormData, isRetry = false): Promise<T> {
  const headers = buildHeaders();
  delete (headers as Record<string, string>)['Content-Type']; // laissé au navigateur (boundary multipart)
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });

  if (res.status === 401 && !isRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return upload<T>(path, formData, true);
    endSession();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => upload<T>(path, formData),
};
