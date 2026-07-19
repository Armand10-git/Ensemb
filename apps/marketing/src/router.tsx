import React from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { HomePage } from './routes/index';
import { PricingPage } from './routes/pricing';

/** Route racine : layout commun (Navbar + Outlet + Footer). */
const rootRoute = createRootRoute({
  component: () => (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pricing',
  component: PricingPage,
});

/** Routes stub pour pages légales (T10 — contenus à compléter ultérieurement). */
const mentionsLegalesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mentions-legales',
  component: () => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-gray-700">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Mentions légales</h1>
      <p>Contenu à venir.</p>
    </div>
  ),
});

const cguRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cgu',
  component: () => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-gray-700">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Conditions générales d'utilisation</h1>
      <p>Contenu à venir.</p>
    </div>
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  pricingRoute,
  mentionsLegalesRoute,
  cguRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
