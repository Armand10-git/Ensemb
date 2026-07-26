import React, { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

interface OrgLookup { organizationId: string }
interface LoginResponse { accessToken: string; refreshToken: string; permissions: string[] }

export function LoginPage() {
  const navigate = useNavigate();
  const [subdomain, setSubdomain] = useState('');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // 1 — résoudre l'ID de l'organisation depuis le sous-domaine
      const orgRes = await fetch(`${API_BASE}/public/organizations/by-subdomain/${encodeURIComponent(subdomain.trim())}`);
      if (!orgRes.ok) { setError('Sous-domaine introuvable.'); return; }
      const org = await orgRes.json() as OrgLookup;

      // 2 — authentification
      const loginRes = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Organization-Id': org.organizationId },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!loginRes.ok) {
        const body = await loginRes.json().catch(() => ({})) as { message?: string };
        setError(body.message ?? 'Identifiants invalides.');
        return;
      }
      const data = await loginRes.json() as LoginResponse;

      localStorage.setItem('access_token',   data.accessToken);
      localStorage.setItem('refresh_token',  data.refreshToken);
      localStorage.setItem('organization_id', org.organizationId);
      localStorage.setItem('permissions',    JSON.stringify(data.permissions));

      void navigate({ to: '/catalog/products' });
    } catch {
      setError('Erreur réseau. Vérifiez votre connexion.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-600 mb-3">
            <span className="text-white text-sm font-bold">E</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Ensemb</h1>
          <p className="text-sm text-gray-500 mt-1">Connectez-vous à votre espace</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Sous-domaine de l'organisation
            </label>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500">
              <input
                type="text"
                value={subdomain}
                onChange={e => setSubdomain(e.target.value)}
                placeholder="monentreprise"
                required
                autoFocus
                className="flex-1 px-3 py-2 text-sm outline-none bg-white"
              />
              <span className="flex items-center px-3 text-xs text-gray-400 bg-gray-50 border-l border-gray-200">.ensemb.cm</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Adresse e-mail</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="vous@exemple.com"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 text-white text-sm font-medium py-2.5 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 transition-colors mt-2"
          >
            {loading ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  );
}
