import React, { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, ArrowRight } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

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
    <div className="flex min-h-screen items-center justify-center bg-brand-950 p-4">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(47,167,94,0.25),transparent_55%),radial-gradient(circle_at_85%_75%,rgba(47,167,94,0.15),transparent_50%)]" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-card bg-brand-500 shadow-2">
            <span className="font-display text-base font-bold text-white">E</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-white">Ensemb</h1>
          <p className="mt-1 text-[13.5px] text-brand-200/80">Gestion de vente &amp; suivi de stock</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-card border border-white/10 bg-white p-6 shadow-2 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-field border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-[13px] text-danger-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="subdomain">Sous-domaine de l&apos;organisation</Label>
            <div className="flex overflow-hidden rounded-field border border-neutral-300 shadow-1 focus-within:border-brand-500">
              <input
                id="subdomain"
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="monentreprise"
                required
                autoFocus
                className="flex-1 bg-white px-3 py-1.5 text-[14px] text-neutral-900 outline-none placeholder:text-neutral-400"
              />
              <span className="flex items-center border-l border-neutral-200 bg-neutral-50 px-3 text-[12.5px] text-neutral-400">
                .ensemb.cm
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vous@exemple.com"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <Button type="submit" className="mt-2 w-full" loading={loading}>
            {!loading && (
              <>
                Se connecter
                <ArrowRight />
              </>
            )}
            {loading && 'Connexion…'}
          </Button>
        </form>

        <p className="mt-6 text-center text-[12.5px] text-brand-200/60">
          Ensemb © {new Date().getFullYear()} — Cameroun
        </p>
      </div>
    </div>
  );
}
