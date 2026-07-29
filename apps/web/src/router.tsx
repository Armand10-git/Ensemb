import {
  createRouter,
  createRootRoute,
  createRoute,
  redirect,
  Outlet,
} from '@tanstack/react-router';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './routes/login';
import ProductsPage    from './routes/catalog/products';
import AdjustmentsPage from './routes/adjustments/index';
import TransfersPage   from './routes/transfers/index';
import SalesPage       from './routes/sales/index';
import PosPage         from './routes/pos';
import CashSessionsPage from './routes/cash-sessions/index';
import CustomersPage   from './routes/people/customers';
import SuppliersPage   from './routes/people/suppliers';
import BrandsPage      from './routes/settings/brands';
import CategoriesPage  from './routes/settings/categories';
import UnitsPage       from './routes/settings/units';
import CurrenciesPage  from './routes/settings/currencies';
import WarehousesPage  from './routes/settings/warehouses';

function isAuthenticated() {
  return !!localStorage.getItem('access_token');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  beforeLoad: () => {
    if (isAuthenticated()) throw redirect({ to: '/catalog/products' });
  },
});

// Route layout protégée — redirige vers /login si pas de token
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppLayout,
  beforeLoad: () => {
    if (!isAuthenticated()) throw redirect({ to: '/login' });
  },
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => { throw redirect({ to: '/catalog/products' }); },
  component: () => null,
});

const productsRoute     = createRoute({ getParentRoute: () => appRoute, path: '/catalog/products',      component: ProductsPage });
const posRoute          = createRoute({ getParentRoute: () => appRoute, path: '/pos',                   component: PosPage });
const cashSessionsRoute = createRoute({ getParentRoute: () => appRoute, path: '/cash-sessions',          component: CashSessionsPage });
const adjustmentsRoute  = createRoute({ getParentRoute: () => appRoute, path: '/inventory/adjustments', component: AdjustmentsPage });
const transfersRoute    = createRoute({ getParentRoute: () => appRoute, path: '/inventory/transfers',   component: TransfersPage });
const salesRoute        = createRoute({ getParentRoute: () => appRoute, path: '/sales',                 component: SalesPage });
const customersRoute    = createRoute({ getParentRoute: () => appRoute, path: '/people/customers',      component: CustomersPage });
const suppliersRoute    = createRoute({ getParentRoute: () => appRoute, path: '/people/suppliers',      component: SuppliersPage });
const brandsRoute       = createRoute({ getParentRoute: () => appRoute, path: '/settings/brands',       component: BrandsPage });
const categoriesRoute   = createRoute({ getParentRoute: () => appRoute, path: '/settings/categories',   component: CategoriesPage });
const unitsRoute        = createRoute({ getParentRoute: () => appRoute, path: '/settings/units',        component: UnitsPage });
const currenciesRoute   = createRoute({ getParentRoute: () => appRoute, path: '/settings/currencies',   component: CurrenciesPage });
const warehousesRoute   = createRoute({ getParentRoute: () => appRoute, path: '/settings/warehouses',   component: WarehousesPage });

// ─── Arbre des routes ─────────────────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    posRoute,
    cashSessionsRoute,
    productsRoute,
    adjustmentsRoute,
    transfersRoute,
    salesRoute,
    customersRoute,
    suppliersRoute,
    brandsRoute,
    categoriesRoute,
    unitsRoute,
    currenciesRoute,
    warehousesRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
