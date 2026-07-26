import React from 'react';
import { Outlet, Link, useRouterState, useNavigate } from '@tanstack/react-router';
import { NotificationBell } from './NotificationBell';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

// ─── Icônes SVG inline ────────────────────────────────────────────────────────

const IconBox = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 10V11" />
  </svg>
);
const IconPlus = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 4v16m8-8H4" />
  </svg>
);
const IconArrows = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
  </svg>
);
const IconUsers = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm12 2c0-2.21-1.79-4-4-4" />
  </svg>
);
const IconReceipt = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 14l2 2 4-4m5 5V5a2 2 0 00-2-2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2 3-2z" />
  </svg>
);
const IconTruck = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10m9 0H3m10 0h6v-4l-3-3h-3v7z" />
  </svg>
);
const IconWarehouse = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 12l9-9 9 9M5 10v9h14v-9" />
  </svg>
);
const IconTag = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
  </svg>
);
const IconCircle = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" strokeWidth={1.8} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 7v5l3 3" />
  </svg>
);
const IconCurrency = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const IconLogout = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
  </svg>
);

// ─── NavLink ─────────────────────────────────────────────────────────────────

function NavLink({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  const { location } = useRouterState();
  const active = location.pathname === to || location.pathname.startsWith(to + '/');
  return (
    <Link
      to={to}
      className={[
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-indigo-50 text-indigo-700 font-medium'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      ].join(' ')}
    >
      {icon}
      {label}
    </Link>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 select-none first:pt-2">
      {children}
    </p>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export function AppLayout() {
  const navigate = useNavigate();

  async function handleLogout() {
    const accessToken  = localStorage.getItem('access_token');
    const refreshToken = localStorage.getItem('refresh_token');
    try {
      // Révocation du refresh token côté serveur (blacklist Redis)
      if (accessToken && refreshToken) {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } finally {
      // Session locale effacée dans tous les cas, même si l'API échoue
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('organization_id');
      localStorage.removeItem('permissions');
      void navigate({ to: '/login' });
    }
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-gray-200 flex-shrink-0">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <span className="text-white text-xs font-bold">E</span>
          </div>
          <span className="text-sm font-bold text-gray-900">Ensemb</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <SectionLabel>Catalogue</SectionLabel>
          <NavLink to="/catalog/products"       label="Produits"     icon={<IconBox />} />

          <SectionLabel>Ventes</SectionLabel>
          <NavLink to="/sales"                  label="Ventes"       icon={<IconReceipt />} />

          <SectionLabel>Inventaire</SectionLabel>
          <NavLink to="/inventory/adjustments"  label="Ajustements"  icon={<IconPlus />} />
          <NavLink to="/inventory/transfers"    label="Transferts"   icon={<IconArrows />} />

          <SectionLabel>Partenaires</SectionLabel>
          <NavLink to="/people/customers"       label="Clients"      icon={<IconUsers />} />
          <NavLink to="/people/suppliers"       label="Fournisseurs" icon={<IconTruck />} />

          <SectionLabel>Paramètres</SectionLabel>
          <NavLink to="/settings/warehouses"    label="Entrepôts"    icon={<IconWarehouse />} />
          <NavLink to="/settings/categories"    label="Catégories"   icon={<IconTag />} />
          <NavLink to="/settings/brands"        label="Marques"      icon={<IconCircle />} />
          <NavLink to="/settings/units"         label="Unités"       icon={<IconCircle />} />
          <NavLink to="/settings/currencies"    label="Devises"      icon={<IconCurrency />} />
        </nav>

        {/* Déconnexion */}
        <div className="px-3 pb-4 flex-shrink-0">
          <button
            onClick={() => void handleLogout()}
            className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            <IconLogout />
            Déconnexion
          </button>
        </div>
      </aside>

      {/* ── Zone principale ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Barre supérieure */}
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-end px-6 flex-shrink-0">
          <NotificationBell />
        </header>

        {/* Contenu de la page */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
