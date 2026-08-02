import React, { useState } from 'react';
import { Outlet, Link, useRouterState, useNavigate } from '@tanstack/react-router';
import {
  Package,
  Plus,
  ArrowLeftRight,
  Users,
  Receipt,
  PackagePlus,
  ShoppingCart,
  Truck,
  Warehouse,
  Tag,
  Shapes,
  Ruler,
  Coins,
  History,
  LogOut,
  ChevronsUpDown,
  Menu,
} from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Sheet, SheetContent } from './ui/sheet';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

// ─── Navigation ────────────────────────────────────────────────────────────────

const NAV_SECTIONS: { label: string; items: { to: string; label: string; icon: React.ElementType }[] }[] = [
  {
    label: 'Caisse',
    items: [
      { to: '/pos', label: 'Caisse', icon: ShoppingCart },
      { to: '/cash-sessions', label: 'Sessions de caisse', icon: History },
    ],
  },
  { label: 'Catalogue', items: [{ to: '/catalog/products', label: 'Produits', icon: Package }] },
  {
    label: 'Ventes & Achats',
    items: [
      { to: '/sales', label: 'Ventes', icon: Receipt },
      { to: '/purchases', label: 'Achats', icon: PackagePlus },
    ],
  },
  {
    label: 'Inventaire',
    items: [
      { to: '/inventory/adjustments', label: 'Ajustements', icon: Plus },
      { to: '/inventory/transfers', label: 'Transferts', icon: ArrowLeftRight },
    ],
  },
  {
    label: 'Partenaires',
    items: [
      { to: '/people/customers', label: 'Clients', icon: Users },
      { to: '/people/suppliers', label: 'Fournisseurs', icon: Truck },
    ],
  },
  {
    label: 'Paramètres',
    items: [
      { to: '/settings/warehouses', label: 'Entrepôts', icon: Warehouse },
      { to: '/settings/categories', label: 'Catégories', icon: Tag },
      { to: '/settings/brands', label: 'Marques', icon: Shapes },
      { to: '/settings/units', label: 'Unités', icon: Ruler },
      { to: '/settings/currencies', label: 'Devises', icon: Coins },
    ],
  },
];

function NavLink({ to, label, icon: Icon, onNavigate }: { to: string; label: string; icon: React.ElementType; onNavigate?: () => void }) {
  const { location } = useRouterState();
  const active = location.pathname === to || location.pathname.startsWith(to + '/');
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={[
        'flex items-center gap-2.5 rounded-field px-3 py-2 text-[13.5px] font-medium transition-colors',
        active ? 'bg-brand-500 text-white shadow-1' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.8} />
      {label}
    </Link>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="select-none px-3 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400 first:pt-1">
      {children}
    </p>
  );
}

// ─── Contenu de la sidebar (partagé desktop fixe / tiroir mobile) ─────────────

function SidebarContent({ orgName, onLogout, onNavigate }: { orgName: string; onLogout: () => void; onNavigate?: () => void }) {
  return (
    <>
      <div className="flex h-14 flex-shrink-0 items-center gap-2.5 border-b border-neutral-100 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-brand-500">
          <span className="font-display text-xs font-bold text-white">E</span>
        </div>
        <span className="font-display text-[15px] font-semibold text-neutral-900">Ensemb</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <SectionLabel>{section.label}</SectionLabel>
            {section.items.map((item) => (
              <NavLink key={item.to} {...item} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex-shrink-0 border-t border-neutral-100 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-field px-2 py-2 text-left transition-colors hover:bg-neutral-100">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-[12px] font-semibold text-brand-700">
              {orgName.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-neutral-800">Mon compte</p>
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-neutral-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-52">
            <DropdownMenuItem destructive onClick={onLogout}>
              <LogOut className="h-4 w-4" strokeWidth={1.8} />
              Déconnexion
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export function AppLayout() {
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const orgName = localStorage.getItem('organization_id') ? 'Organisation' : 'Ensemb';

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
    <div className="flex h-screen overflow-hidden bg-neutral-50 font-sans">
      {/* ── Sidebar fixe (≥ md) ── */}
      <aside className="hidden w-60 flex-shrink-0 flex-col border-r border-neutral-200 bg-white md:flex">
        <SidebarContent orgName={orgName} onLogout={() => void handleLogout()} />
      </aside>

      {/* ── Tiroir de navigation (< md) ── */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="p-0">
          <SidebarContent
            orgName={orgName}
            onLogout={() => void handleLogout()}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </SheetContent>
      </Sheet>

      {/* ── Zone principale ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-2.5 md:hidden">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Ouvrir le menu"
              className="rounded-field p-1.5 text-neutral-600 transition-colors hover:bg-neutral-100"
            >
              <Menu className="h-5 w-5" strokeWidth={1.8} />
            </button>
            <div className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-brand-500">
              <span className="font-display text-[10px] font-bold text-white">E</span>
            </div>
          </div>
          <div className="flex-1 md:hidden" />
          <NotificationBell />
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
