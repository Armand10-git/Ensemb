import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RefreshCw, ShoppingCart, Smartphone, Trash2, Warehouse, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatXAF } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { NativeSelect } from '../components/ui/native-select';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState, ErrorState } from '../components/page-states';
import { PosReceipt, type PosReceiptData, type PosReceiptPaymentMethod } from '../components/PosReceipt';

// ─── Types ───────────────────────────────────────────────────────────────────

type SaleStatus = 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED';

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface WarehouseRef { id: string; name: string }
interface ClientRef { id: string; code: number; name: string }

/** Résultat de GET /pos/products/search — tous les Decimal sont sérialisés en string sur le fil. */
interface ProductSearchResult {
  id: string;
  code: string;
  name: string;
  price: string;
  taxRate: string;
  taxMethod: 'percentage' | 'fixed';
  quantity: string;
}

interface ComputedPosLine {
  productId: string;
  price: string;
  taxAmount: string;
  taxMethod: string;
  discount: string;
  discountMethod: string;
  quantity: string;
  total: string;
}

interface CalculatedTotal {
  details: ComputedPosLine[];
  sumLines: string;
  taxAmount: string;
  discount: string;
  shipping: string;
  grandTotal: string;
}

interface SaleDetailResponse {
  id: string;
  productId: string;
  quantity: string;
  price: string;
  total: string;
}

interface Sale {
  id: string;
  reference: string;
  date: string;
  clientId: string;
  warehouseId: string;
  taxAmount: string | null;
  discount: string | null;
  grandTotal: string;
  status: SaleStatus;
  cancelReason: string | null;
  details?: SaleDetailResponse[];
  paymentLink?: string;
}

/** Ligne panier — snapshot du produit au moment de l'ajout (nom/prix/taxe figés pour l'affichage). */
interface CartLine {
  productId: string;
  code: string;
  name: string;
  price: string;
  quantity: string;
  taxAmount: string;
  taxMethod: 'percentage' | 'fixed';
}

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY';
type PanelState = 'cart' | 'awaiting-mobile-money' | 'receipt' | 'mobile-money-expired';

const VITE_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const WS_URL = VITE_API_URL.replace('/api/v1', '');
const SEARCH_RESULT_LIMIT = 25;
const MOBILE_MONEY_POLL_INTERVAL_MS = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Product.taxRate est stocké comme une fraction (ex. "0.1925" = 19,25 %), tandis que
 * PosLineDto.taxAmount en méthode 'percentage' attend un pourcentage direct (ex. "19.25",
 * divisé par 100 côté serveur — pos.service.ts computeLineTotal). Conversion nécessaire
 * pour que le panier applique le taux de TVA du produit sans le fausser d'un facteur 100.
 */
function fractionToPercentString(fraction: string): string {
  const pct = Number(fraction) * 100;
  return String(Number(pct.toFixed(3)));
}

function productToCartLine(product: ProductSearchResult): CartLine {
  return {
    productId: product.id,
    code: product.code,
    name: product.name,
    price: product.price,
    quantity: '1',
    taxAmount: product.taxMethod === 'fixed' ? product.taxRate : fractionToPercentString(product.taxRate),
    taxMethod: product.taxMethod,
  };
}

function cartLineToPosDetail(line: CartLine) {
  return {
    productId: line.productId,
    price: line.price,
    quantity: line.quantity,
    taxAmount: line.taxAmount,
    taxMethod: line.taxMethod,
    discount: '0',
    discountMethod: 'percentage' as const,
  };
}

function buildReceipt(
  sale: Sale,
  cartLines: CartLine[],
  clientName: string,
  paymentMethod: PaymentMethod,
  amountReceived: string,
): PosReceiptData {
  const grandTotal = Number(sale.grandTotal);
  const received = Number(amountReceived);
  return {
    reference: sale.reference,
    date: sale.date,
    clientName,
    lines: (sale.details ?? []).map((d) => ({
      productId: d.productId,
      name: cartLines.find((l) => l.productId === d.productId)?.name ?? d.productId,
      quantity: d.quantity,
      price: d.price,
      total: d.total,
    })),
    taxAmount: sale.taxAmount ?? '0',
    discount: sale.discount ?? '0',
    grandTotal: sale.grandTotal,
    paymentMethod: paymentMethod as PosReceiptPaymentMethod,
    amountReceived: paymentMethod === 'CASH' ? amountReceived : undefined,
    change: paymentMethod === 'CASH' && !Number.isNaN(received) ? String(Math.max(received - grandTotal, 0)) : undefined,
  };
}

// ─── API hooks ───────────────────────────────────────────────────────────────

function useWarehouses() {
  return useQuery<Paginated<WarehouseRef>>({
    queryKey: ['warehouses-all'],
    queryFn: () => api.get<Paginated<WarehouseRef>>('/warehouses?limit=200'),
    staleTime: 60_000,
  });
}

function useClients() {
  return useQuery<Paginated<ClientRef>>({
    queryKey: ['clients-all'],
    queryFn: () => api.get<Paginated<ClientRef>>('/partners/clients?limit=200'),
    staleTime: 60_000,
  });
}

function useProductSearch(warehouseId: string, query: string) {
  return useQuery<ProductSearchResult[]>({
    queryKey: ['pos-products', warehouseId, query],
    queryFn: () =>
      api.get<ProductSearchResult[]>(
        `/pos/products/search?warehouseId=${warehouseId}&q=${encodeURIComponent(query)}`,
      ),
    enabled: warehouseId !== '',
  });
}

function useCalculateTotal(cart: CartLine[]) {
  const debouncedCart = useDebounce(cart, 300);
  const payload = useMemo(() => ({ details: debouncedCart.map(cartLineToPosDetail) }), [debouncedCart]);
  return useQuery<CalculatedTotal>({
    queryKey: ['pos-calculate-total', JSON.stringify(payload)],
    queryFn: () => api.post<CalculatedTotal>('/pos/calculate-total', payload),
    enabled: payload.details.length > 0,
  });
}

function useCreateSale() {
  return useMutation({ mutationFn: (data: unknown) => api.post<Sale>('/pos/sales', data) });
}

/** Poll GET /sales/:id toutes les 3s jusqu'à sortie de AWAITING_PAYMENT (§18.2 étape 10). */
function usePosSaleStatus(saleId: string | null) {
  const [result, setResult] = useState<{ status: SaleStatus; sale: Sale } | null>(null);

  useEffect(() => {
    setResult(null);
    if (!saleId) return;
    let cancelled = false;

    async function poll() {
      try {
        const s = await api.get<Sale>(`/sales/${saleId!}`);
        if (cancelled) return;
        if (s.status !== 'AWAITING_PAYMENT') setResult({ status: s.status, sale: s });
      } catch {
        // erreur transitoire — retentée au prochain tick
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), MOBILE_MONEY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [saleId]);

  return result;
}

// ─── Grille produits ───────────────────────────────────────────────────────────

function ProductGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-card border border-neutral-200 bg-white p-3">
          <Skeleton className="h-11 w-11 rounded-card" />
          <Skeleton className="mt-2 h-3.5 w-3/4" />
          <Skeleton className="mt-1.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function ProductCard({
  product,
  disabled,
  onAdd,
}: {
  product: ProductSearchResult;
  disabled: boolean;
  onAdd: (product: ProductSearchResult) => void;
}) {
  const qty = Number(product.quantity);
  const outOfStock = qty <= 0;

  return (
    <button
      type="button"
      data-testid={`product-card-${product.code}`}
      disabled={disabled || outOfStock}
      onClick={() => onAdd(product)}
      className={cn(
        'flex flex-col items-start gap-2 rounded-card border border-neutral-200 bg-white p-3 text-left shadow-1 transition-colors',
        'hover:border-brand-300 hover:bg-brand-50',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-200 disabled:hover:bg-white',
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-card bg-brand-50 text-[13px] font-semibold text-brand-600">
        {product.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="w-full">
        <p className="truncate text-[13.5px] font-medium text-neutral-900">{product.name}</p>
        <p className="tabular text-[12px] text-neutral-500">{product.code}</p>
      </div>
      <div className="flex w-full items-start justify-between gap-1.5">
        <span className="tabular whitespace-nowrap text-[13.5px] font-semibold leading-tight text-neutral-900">{formatXAF(product.price)}</span>
        {outOfStock ? (
          <Badge variant="danger" className="flex-shrink-0">Rupture</Badge>
        ) : (
          <Badge variant={qty <= 5 ? 'warning' : 'neutral'} className="tabular flex-shrink-0">
            {qty.toLocaleString('fr-CM', { maximumFractionDigits: 3 })}
          </Badge>
        )}
      </div>
    </button>
  );
}

// ─── Panneau panier ────────────────────────────────────────────────────────────

function CartLineRow({
  line,
  insufficient,
  liveQuantity,
  onQuantityChange,
  onRemove,
}: {
  line: CartLine;
  insufficient: boolean;
  liveQuantity: number | undefined;
  onQuantityChange: (productId: string, value: string) => void;
  onRemove: (productId: string) => void;
}) {
  const lineTotal = (Number(line.price) || 0) * (Number(line.quantity) || 0);
  return (
    <div className="rounded-card border border-neutral-200 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-neutral-900">{line.name}</p>
          <p className="tabular text-[11.5px] text-neutral-500">{formatXAF(line.price)} / unité</p>
        </div>
        <button
          type="button"
          aria-label={`Retirer ${line.name}`}
          onClick={() => onRemove(line.productId)}
          className="flex-shrink-0 rounded-field p-1 text-danger-600 hover:bg-danger-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <Input
          type="text"
          inputMode="decimal"
          aria-label={`Quantité — ${line.name}`}
          value={line.quantity}
          onChange={(e) => onQuantityChange(line.productId, e.target.value)}
          className="h-8 w-20 text-center"
        />
        <span className="tabular text-[13px] font-semibold text-neutral-900">{formatXAF(lineTotal)}</span>
      </div>
      {insufficient && (
        <p className="mt-1 text-[11.5px] text-danger-600">
          Stock insuffisant : quantité disponible {liveQuantity ?? 0}.
        </p>
      )}
    </div>
  );
}

// ─── Écran principal ──────────────────────────────────────────────────────────

export default function PosPage() {
  const qc = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [warehouseId, setWarehouseId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const debouncedQuery = useDebounce(searchQuery, 300);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [clientId, setClientId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [amountReceived, setAmountReceived] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [panelState, setPanelState] = useState<PanelState>('cart');
  const [awaitingSale, setAwaitingSale] = useState<{ id: string; reference: string; grandTotal: string; paymentLink: string } | null>(null);
  const [expiredReason, setExpiredReason] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<PosReceiptData | null>(null);

  const [stockByProduct, setStockByProduct] = useState<Record<string, string>>({});

  const { data: warehouseData } = useWarehouses();
  const { data: clientData } = useClients();
  const warehouses = warehouseData?.data ?? [];
  const clients = clientData?.data ?? [];

  const {
    data: productData,
    isLoading: productsLoading,
    isError: productsError,
    refetch: refetchProducts,
  } = useProductSearch(warehouseId, debouncedQuery);
  const products = useMemo(() => productData ?? [], [productData]);

  const { data: calculatedTotal, isLoading: totalsLoading } = useCalculateTotal(cart);
  const createSaleMutation = useCreateSale();

  const mmResult = usePosSaleStatus(panelState === 'awaiting-mobile-money' ? awaitingSale?.id ?? null : null);

  // Pré-sélection du client "Walk-in" (code 1, seedé par organisation — §18.2 étape 5).
  useEffect(() => {
    if (clientId !== '' || clients.length === 0) return;
    const walkIn = clients.find((c) => c.code === 1) ?? clients.find((c) => c.name === 'Walk-in');
    if (walkIn) setClientId(walkIn.id);
  }, [clients, clientId]);

  // Focus initial sur la recherche (scan douchette prêt sans clic).
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Alimente stockByProduct avec les résultats de recherche successifs.
  useEffect(() => {
    if (products.length === 0) return;
    setStockByProduct((prev) => {
      const next = { ...prev };
      for (const p of products) next[p.id] = p.quantity;
      return next;
    });
  }, [products]);

  // Socket.io — stock:updated (patron exact routes/sales/index.tsx) : grille + panier en direct.
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', { auth: { token }, transports: ['websocket'] });
    socket.on('stock:updated', (payload: { warehouseId: string; products: { productId: string; newQuantity: string }[] }) => {
      if (payload.warehouseId !== warehouseId) return;
      setStockByProduct((prev) => {
        const next = { ...prev };
        for (const p of payload.products) next[p.productId] = p.newQuantity;
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['pos-products', warehouseId] });
    });
    return () => { socket.disconnect(); };
  }, [qc, warehouseId]);

  // Résolution du paiement mobile money (COMPLETED ou CANCELLED — §18.2 étape 10).
  useEffect(() => {
    if (!mmResult) return;
    if (mmResult.status === 'COMPLETED') {
      const clientName = clients.find((c) => c.id === clientId)?.name ?? '—';
      setLastReceipt(buildReceipt(mmResult.sale, cart, clientName, 'MOBILE_MONEY', ''));
      setPanelState('receipt');
    } else if (mmResult.status === 'CANCELLED') {
      setExpiredReason(mmResult.sale.cancelReason ?? 'Le délai de paiement mobile money a expiré.');
      setPanelState('mobile-money-expired');
    }
  }, [mmResult]);

  /** Le panier est lié à un entrepôt (stock vérifié dedans) — le changer vide le panier en cours. */
  function handleWarehouseChange(newWarehouseId: string) {
    if (cart.length > 0 && newWarehouseId !== warehouseId) {
      toast("Entrepôt changé — le panier a été vidé.");
      setCart([]);
    }
    setWarehouseId(newWarehouseId);
  }

  function resetForNextSale() {
    setCart([]);
    setAmountReceived('');
    setPaymentMethod('CASH');
    setSubmitError(null);
    setAwaitingSale(null);
    const walkIn = clients.find((c) => c.code === 1) ?? clients.find((c) => c.name === 'Walk-in');
    setClientId(walkIn?.id ?? '');
    searchInputRef.current?.focus();
  }

  function startNewSale() {
    setPanelState('cart');
    setLastReceipt(null);
    setExpiredReason(null);
    resetForNextSale();
  }

  function addProductToCart(product: ProductSearchResult) {
    if (panelState !== 'cart') return;
    const liveQty = Number(stockByProduct[product.id] ?? product.quantity);
    if (liveQty <= 0) {
      toast.error(`Stock épuisé pour ${product.name}.`);
      return;
    }
    // Lu depuis le `cart` du rendu courant (pas depuis l'updater setCart, exécuté de façon
    // différée par le batching React 18 — un flag lu juste après l'appel resterait périmé).
    const existing = cart.find((l) => l.productId === product.id);
    const currentQty = existing ? Number(existing.quantity) : 0;
    if (currentQty + 1 > liveQty) {
      toast.error(`Stock insuffisant pour ${product.name} : quantité disponible ${liveQty}.`);
      return;
    }
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.productId === product.id);
      if (idx >= 0) {
        return prev.map((l, i) => (i === idx ? { ...l, quantity: String(currentQty + 1) } : l));
      }
      return [...prev, productToCartLine(product)];
    });
    setLastReceipt(null);
    searchInputRef.current?.focus();
  }

  function updateLineQuantity(productId: string, value: string) {
    setCart((prev) => prev.map((l) => (l.productId === productId ? { ...l, quantity: value } : l)));
  }

  function removeLine(productId: string) {
    setCart((prev) => prev.filter((l) => l.productId !== productId));
  }

  /** Recherche exacte immédiate (hors debounce) pour le scan douchette — §17 point D. */
  async function handleScanEnter() {
    if (panelState !== 'cart' || !warehouseId || scanning) return;
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    setScanning(true);
    try {
      const results = await api.get<ProductSearchResult[]>(
        `/pos/products/search?warehouseId=${warehouseId}&q=${encodeURIComponent(trimmed)}`,
      );
      const matches = results.filter((p) => p.code === trimmed);
      if (matches.length === 1 && matches[0]) {
        addProductToCart(matches[0]);
        setSearchQuery('');
      }
    } catch {
      // silencieux — le caissier retente ou clique dans la grille filtrée
    } finally {
      setScanning(false);
    }
  }

  // ── Calcul dérivé : stock insuffisant, monnaie à rendre, éligibilité "Encaisser" ──

  const insufficientLines = useMemo(() => {
    const set = new Set<string>();
    for (const line of cart) {
      const live = stockByProduct[line.productId];
      if (live !== undefined && Number(line.quantity) > Number(live)) set.add(line.productId);
    }
    return set;
  }, [cart, stockByProduct]);

  const grandTotal = calculatedTotal ? Number(calculatedTotal.grandTotal) : 0;
  const received = Number(amountReceived);
  const change = paymentMethod === 'CASH' && amountReceived !== '' && !Number.isNaN(received)
    ? Math.max(received - grandTotal, 0)
    : null;
  const cashAmountValid = paymentMethod !== 'CASH' || (amountReceived !== '' && !Number.isNaN(received) && received >= grandTotal);

  const canSubmit =
    cart.length > 0 &&
    warehouseId !== '' &&
    clientId !== '' &&
    !!calculatedTotal &&
    !totalsLoading &&
    insufficientLines.size === 0 &&
    cashAmountValid &&
    !createSaleMutation.isPending;

  async function handleEncaisser() {
    if (!canSubmit || !calculatedTotal) return;
    setSubmitError(null);
    const payload = {
      clientId,
      warehouseId,
      details: cart.map(cartLineToPosDetail),
      paymentMethod,
      amountReceived: paymentMethod === 'CASH' ? amountReceived : undefined,
    };
    try {
      const sale = await createSaleMutation.mutateAsync(payload);
      if (paymentMethod === 'MOBILE_MONEY') {
        setAwaitingSale({ id: sale.id, reference: sale.reference, grandTotal: sale.grandTotal, paymentLink: sale.paymentLink ?? '' });
        setPanelState('awaiting-mobile-money');
      } else {
        const clientName = clients.find((c) => c.id === clientId)?.name ?? '—';
        setLastReceipt(buildReceipt(sale, cart, clientName, paymentMethod, amountReceived));
        setPanelState('receipt');
        resetForNextSale();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Erreur lors de l'encaissement.");
    }
  }

  const partial = products.length === SEARCH_RESULT_LIMIT;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col p-4 sm:p-6 lg:h-[calc(100vh-3.5rem)] lg:p-8">
      {/*
        Sous lg : colonnes empilées, page qui défile normalement (comme le reste de
        l'app) — pas de hauteur figée ni de scroll interne, donc rien ne peut jamais
        écraser la liste du panier. À partir de lg : deux colonnes côte à côte, chacune
        avec son propre scroll interne borné par la hauteur du viewport.
      */}
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* ── Colonne gauche : entrepôt + recherche + grille ─────────────────── */}
        <div className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="sm:w-64">
              <Label htmlFor="pos-warehouse">Entrepôt *</Label>
              <NativeSelect
                id="pos-warehouse"
                data-testid="pos-warehouse-select"
                value={warehouseId}
                onChange={(e) => handleWarehouseChange(e.target.value)}
                className="mt-1"
              >
                <option value="">— Choisir un entrepôt —</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </NativeSelect>
            </div>
            <div className="flex-1">
              <Label htmlFor="pos-search">Recherche / scan</Label>
              <Input
                id="pos-search"
                ref={searchInputRef}
                type="search"
                placeholder="Nom, code produit ou scan douchette…"
                aria-label="Rechercher un produit"
                value={searchQuery}
                disabled={panelState !== 'cart'}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleScanEnter(); }
                }}
                className="mt-1"
              />
            </div>
          </div>

          <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
            {warehouseId === '' && (
              <EmptyState
                icon={Warehouse}
                title="Sélectionnez un entrepôt pour commencer."
                description="Le stock affiché et la vente dépendent de l'entrepôt choisi en haut de l'écran."
              />
            )}

            {warehouseId !== '' && productsLoading && <ProductGridSkeleton />}

            {warehouseId !== '' && !productsLoading && productsError && (
              <ErrorState message="Impossible de charger les produits." onRetry={() => void refetchProducts()} />
            )}

            {warehouseId !== '' && !productsLoading && !productsError && products.length === 0 && (
              <EmptyState
                icon={ShoppingCart}
                title="Aucun produit"
                description={debouncedQuery ? 'Aucun produit ne correspond à cette recherche.' : 'Aucun produit disponible dans cet entrepôt.'}
              />
            )}

            {warehouseId !== '' && !productsLoading && !productsError && products.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4">
                  {products.map((p) => (
                    <ProductCard key={p.id} product={{ ...p, quantity: stockByProduct[p.id] ?? p.quantity }} disabled={panelState !== 'cart'} onAdd={addProductToCart} />
                  ))}
                </div>
                {partial && (
                  <p className="mt-3 text-center text-[12.5px] text-neutral-500">
                    Résultats limités à {SEARCH_RESULT_LIMIT} — affinez la recherche pour en voir plus.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Panneau panier persistant ────────────────────────────────────── */}
        <div className="flex w-full flex-shrink-0 flex-col rounded-card border border-neutral-200 bg-white shadow-1 lg:h-full lg:min-h-0 lg:w-[380px]">
          <div className="rounded-t-card bg-brand-500 px-4 py-3.5 text-white">
            <p className="text-[11.5px] uppercase tracking-wide text-brand-100">Total</p>
            <p className="tabular text-[24px] font-semibold">{formatXAF(calculatedTotal?.grandTotal ?? '0')}</p>
          </div>

          {panelState === 'cart' && (
            <>
              <div className="p-3 lg:min-h-[220px] lg:flex-1 lg:overflow-y-auto">
                {cart.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center lg:h-full">
                    <ShoppingCart className="h-8 w-8 text-neutral-300" strokeWidth={1.5} />
                    <p className="text-[13px] text-neutral-500">Panier vide — cliquez un produit ou scannez un article.</p>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {cart.map((line) => (
                    <CartLineRow
                      key={line.productId}
                      line={line}
                      insufficient={insufficientLines.has(line.productId)}
                      liveQuantity={stockByProduct[line.productId] !== undefined ? Number(stockByProduct[line.productId]) : undefined}
                      onQuantityChange={updateLineQuantity}
                      onRemove={removeLine}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 border-t border-neutral-100 p-3.5">
                <div className="space-y-1">
                  <Label htmlFor="pos-client">Client</Label>
                  <NativeSelect id="pos-client" data-testid="pos-client-select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">— Client —</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </NativeSelect>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="pos-payment-method">Mode de paiement</Label>
                  <NativeSelect
                    id="pos-payment-method"
                    data-testid="pos-payment-method-select"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  >
                    <option value="CASH">Espèces</option>
                    <option value="CARD">Carte</option>
                    <option value="MOBILE_MONEY">Mobile Money</option>
                  </NativeSelect>
                </div>

                {paymentMethod === 'CASH' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="pos-amount-received">Montant reçu</Label>
                      <Input
                        id="pos-amount-received"
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={amountReceived}
                        onChange={(e) => setAmountReceived(e.target.value)}
                        className="tabular"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Monnaie à rendre</Label>
                      <p className="tabular flex h-9 items-center rounded-field bg-neutral-50 px-3 text-[14px] font-medium text-neutral-800">
                        {change !== null ? formatXAF(change) : '—'}
                      </p>
                    </div>
                  </div>
                )}

                {submitError && (
                  <div role="alert" className="rounded-card border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-[13px] text-danger-700">
                    {submitError}
                  </div>
                )}

                <Button
                  data-testid="encaisser-button"
                  size="lg"
                  disabled={!canSubmit}
                  loading={createSaleMutation.isPending}
                  onClick={() => void handleEncaisser()}
                >
                  {!createSaleMutation.isPending && 'Encaisser'}
                  {createSaleMutation.isPending && 'Encaissement…'}
                </Button>
              </div>
            </>
          )}

          {panelState === 'awaiting-mobile-money' && awaitingSale && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
              <Smartphone className="h-6 w-6 text-neutral-400" />
              <p className="text-[14px] font-medium text-neutral-900">En attente de confirmation du paiement</p>
              <p className="text-[13px] text-neutral-500">
                Référence <span className="tabular">{awaitingSale.reference}</span> — <span className="tabular">{formatXAF(awaitingSale.grandTotal)}</span>
              </p>
              {awaitingSale.paymentLink && (
                <a
                  href={awaitingSale.paymentLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12.5px] text-brand-600 underline underline-offset-2"
                >
                  Lien de paiement
                </a>
              )}
              <p className="text-[12px] text-neutral-400">Le panier reste bloqué jusqu&apos;à confirmation.</p>
            </div>
          )}

          {panelState === 'mobile-money-expired' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <XCircle className="h-8 w-8 text-danger-500" />
              <p className="text-[14px] font-medium text-neutral-900">Paiement mobile money expiré</p>
              <p className="text-[13px] text-neutral-500">{expiredReason}</p>
              <Button variant="secondary" onClick={startNewSale}>
                <RefreshCw className="h-3.5 w-3.5" />
                Réessayer
              </Button>
            </div>
          )}

          {panelState === 'receipt' && lastReceipt && (
            <div className="p-3.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <div className="mb-3 flex items-center gap-2 text-brand-700">
                <CheckCircle2 className="h-5 w-5" />
                <p className="text-[13.5px] font-medium">Vente encaissée avec succès.</p>
              </div>
              <PosReceipt receipt={lastReceipt} />
              <Button className="mt-4 w-full" onClick={startNewSale}>
                Nouvelle vente
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
