import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RefreshCw, ShoppingCart, Smartphone, Trash2, Wallet, Warehouse, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatTime, formatXAF } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { NativeSelect } from '../components/ui/native-select';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState, ErrorState } from '../components/page-states';
import { PosReceipt, type PosReceiptData, type PosReceiptPaymentMethod } from '../components/PosReceipt';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '../components/ui/sheet';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../components/ui/alert-dialog';

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
/**
 * 'cart' : panier éditable, Sheet de paiement fermé.
 * 'checkout' : Sheet ouvert, formulaire Client/Mode de paiement/Encaisser.
 * 'awaiting-mobile-money' / 'mobile-money-expired' : Sheet ouvert, contenu de suivi du paiement.
 * 'receipt' : Sheet fermé, reçu affiché à la place du panier.
 */
type PanelState = 'cart' | 'checkout' | 'awaiting-mobile-money' | 'receipt' | 'mobile-money-expired';

/**
 * Session de caisse (S23b) — ouverture/clôture avec fond de caisse et écart. Tous les
 * Decimal sont sérialisés en string sur le fil (même patron que Sale/PosLine ci-dessus).
 * `variance` : positif = excédent, négatif = manque, zéro = aucun écart.
 */
interface CashSessionResponse {
  id: string;
  organizationId: string;
  reference: string;
  warehouseId: string;
  userId: string;
  openingAmount: string;
  expectedClosingAmount: string | null;
  countedClosingAmount: string | null;
  variance: string | null;
  status: 'OPEN' | 'CLOSED';
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
}

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
export function fractionToPercentString(fraction: string): string {
  const pct = Number(fraction) * 100;
  return String(Number(pct.toFixed(3)));
}

/** Construit une ligne panier à partir d'un résultat de recherche — snapshot figé pour l'affichage. */
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

/** Convertit une ligne panier au format PosLineDto attendu par calculate-total et pos/sales. */
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

/**
 * Construit les données du reçu affiché/imprimé après une vente réussie.
 * Les lignes viennent de `sale.details` (totaux serveur, source de vérité) — le nom du
 * produit est récupéré depuis le snapshot local `cartLines` car l'API ne le renvoie pas.
 */
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

/**
 * Session de caisse ouverte par l'utilisateur courant pour cet entrepôt, ou `null` si
 * aucune (le serveur renvoie `null` en corps JSON, jamais un 204 — cf. cash-sessions.controller.ts).
 * Change automatiquement de session quand l'entrepôt change (queryKey incluant warehouseId).
 */
function useCurrentCashSession(warehouseId: string) {
  return useQuery<CashSessionResponse | null>({
    queryKey: ['cash-session-current', warehouseId],
    queryFn: () => api.get<CashSessionResponse | null>(`/cash-sessions/current?warehouseId=${warehouseId}`),
    enabled: warehouseId !== '',
  });
}

/** Ouvre une session de caisse (fond de caisse déclaré). Invalide la session courante de l'entrepôt. */
function useOpenCashSession(warehouseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { warehouseId: string; openingAmount: string }) =>
      api.post<CashSessionResponse>('/cash-sessions/open', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cash-session-current', warehouseId] }); },
  });
}

/**
 * Clôture la session de caisse courante (montant compté saisi par le caissier). Invalide la
 * session courante (redevient `null` → le gate se réaffiche) et la liste `/cash-sessions`
 * (historique) pour qu'elle reflète immédiatement l'écart calculé côté serveur.
 */
function useCloseCashSession(warehouseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, countedClosingAmount }: { id: string; countedClosingAmount: string }) =>
      api.patch<CashSessionResponse>(`/cash-sessions/${id}/close`, { countedClosingAmount }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cash-session-current', warehouseId] });
      void qc.invalidateQueries({ queryKey: ['cash-sessions'] });
    },
  });
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
  locked,
  onQuantityChange,
  onRemove,
}: {
  line: CartLine;
  insufficient: boolean;
  liveQuantity: number | undefined;
  locked: boolean;
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
          disabled={locked}
          onClick={() => onRemove(line.productId)}
          className="flex-shrink-0 rounded-field p-1 text-danger-600 hover:bg-danger-50 disabled:pointer-events-none disabled:opacity-40"
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
          disabled={locked}
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

// ─── Session de caisse (S23b) ──────────────────────────────────────────────────

/**
 * Badge d'écart de clôture — jamais un nombre nu (standards.md règle 10 : le statut est
 * toujours visible). Excédent (variance > 0) = succès, manque (variance < 0) = danger,
 * exactement à l'équilibre = neutre.
 */
function VarianceBadge({ variance }: { variance: string | null }) {
  if (variance === null) return <Badge variant="neutral">—</Badge>;
  const n = Number(variance);
  if (n > 0) return <Badge variant="success" className="tabular">Excédent {formatXAF(Math.abs(n))}</Badge>;
  if (n < 0) return <Badge variant="danger" className="tabular">Manque {formatXAF(Math.abs(n))}</Badge>;
  return <Badge variant="neutral">Aucun écart</Badge>;
}

/**
 * Bandeau permanent affiché au-dessus de la grille/panier tant qu'une session de caisse est
 * ouverte pour l'entrepôt sélectionné — référence, heure d'ouverture, fond de caisse, action
 * de clôture (§10 « session de caisse » de standards.md). Le bouton de clôture est désactivé
 * en dehors de l'état 'cart' : on ne clôture pas la caisse en plein paiement.
 */
function CashSessionBanner({
  session,
  disabled,
  onRequestClose,
}: {
  session: CashSessionResponse;
  disabled: boolean;
  onRequestClose: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-neutral-200 bg-white px-4 py-2.5 shadow-1">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
        <div className="flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5 text-brand-500" strokeWidth={1.8} />
          <span className="text-neutral-500">Session</span>
          <span className="tabular font-semibold text-neutral-900">{session.reference}</span>
        </div>
        <div>
          <span className="text-neutral-500">Ouverte à </span>
          <span className="tabular text-neutral-800">{formatTime(session.openedAt)}</span>
        </div>
        <div>
          <span className="text-neutral-500">Fond de caisse </span>
          <span className="tabular text-neutral-800">{formatXAF(session.openingAmount)}</span>
        </div>
      </div>
      <Button data-testid="close-session-button" variant="secondary" size="sm" disabled={disabled} onClick={onRequestClose}>
        Clôturer la caisse
      </Button>
    </div>
  );
}

/**
 * État vide actionnable remplaçant grille produits + panneau panier tant qu'aucune session
 * de caisse n'est ouverte pour l'entrepôt sélectionné — le panier reste inutilisable
 * (cohérent avec le gate serveur ajouté sur PosService.createSale()).
 */
function OpenCashSessionGate({ onOpen, opening }: { onOpen: (openingAmount: string) => void; opening: boolean }) {
  const [openingAmount, setOpeningAmount] = useState('0');
  const amountValue = Number(openingAmount);
  const canSubmit = openingAmount.trim() !== '' && !Number.isNaN(amountValue) && amountValue >= 0;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-sm rounded-card border border-neutral-200 bg-white p-6 text-center shadow-1">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
          <Wallet className="h-6 w-6 text-brand-500" strokeWidth={1.5} />
        </div>
        <p className="font-display text-[16px] font-semibold text-neutral-900">
          Ouvrez votre session de caisse pour commencer à encaisser
        </p>
        <p className="mt-1.5 text-[13.5px] text-neutral-500">
          Déclarez le fond de caisse (espèces en tiroir) au début de votre service.
        </p>
        <div className="mt-5 space-y-1.5 text-left">
          <Label htmlFor="opening-amount-input">Fond de caisse (XAF) *</Label>
          <Input
            id="opening-amount-input"
            data-testid="opening-amount-input"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={openingAmount}
            onChange={(e) => setOpeningAmount(e.target.value)}
            className="tabular"
          />
        </div>
        <Button
          data-testid="open-session-button"
          size="lg"
          className="mt-4 w-full"
          disabled={!canSubmit || opening}
          loading={opening}
          onClick={() => onOpen(openingAmount)}
        >
          {!opening && 'Ouvrir la session'}
          {opening && 'Ouverture…'}
        </Button>
      </div>
    </div>
  );
}

/**
 * AlertDialog de clôture de session — nomme la session (standards.md règle 4), puis affiche
 * le récapitulatif renvoyé par le serveur (fond de caisse, attendu, compté, écart) sans
 * fermer automatiquement : la confirmation (`preventDefault`) garde le dialogue ouvert pour
 * la lecture de l'écart avant que le caissier ne le ferme explicitement.
 */
function CloseCashSessionDialog({
  session,
  open,
  onOpenChange,
  onConfirm,
  closing,
  closedResult,
}: {
  session: CashSessionResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (countedClosingAmount: string) => void;
  closing: boolean;
  closedResult: CashSessionResponse | null;
}) {
  const [countedAmount, setCountedAmount] = useState('');

  useEffect(() => {
    if (open) setCountedAmount('');
  }, [open]);

  const amountValue = Number(countedAmount);
  const canConfirm = countedAmount.trim() !== '' && !Number.isNaN(amountValue) && amountValue >= 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {!closedResult && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Clôturer la session {session?.reference ?? ''} ?</AlertDialogTitle>
              <AlertDialogDescription>
                Comptez les espèces en tiroir et saisissez le montant compté. L&apos;écart avec le
                montant attendu est calculé et journalisé par le serveur.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="counted-amount-input">Montant compté (XAF) *</Label>
              <Input
                id="counted-amount-input"
                data-testid="counted-amount-input"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={countedAmount}
                onChange={(e) => setCountedAmount(e.target.value)}
                className="tabular"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => onOpenChange(false)}>Annuler</AlertDialogCancel>
              <AlertDialogAction
                data-testid="confirm-close-session-button"
                disabled={!canConfirm || closing}
                onClick={(e) => {
                  // Empêche la fermeture automatique du AlertDialog (comportement Radix par
                  // défaut) : le récapitulatif serveur doit s'afficher dans ce même dialogue.
                  e.preventDefault();
                  onConfirm(countedAmount);
                }}
              >
                {closing ? 'Clôture…' : 'Clôturer'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {closedResult && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Session {closedResult.reference} clôturée</AlertDialogTitle>
              <AlertDialogDescription>Récapitulatif de la journée de caisse.</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2 rounded-card bg-neutral-50 px-4 py-3 text-[13.5px]" data-testid="close-session-summary">
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Fond de caisse</span>
                <span className="tabular font-medium text-neutral-900">{formatXAF(closedResult.openingAmount)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Attendu en caisse</span>
                <span className="tabular font-medium text-neutral-900">{formatXAF(closedResult.expectedClosingAmount)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Montant compté</span>
                <span className="tabular font-medium text-neutral-900">{formatXAF(closedResult.countedClosingAmount)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
                <span className="text-neutral-500">Écart</span>
                <VarianceBadge variance={closedResult.variance} />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogAction data-testid="close-session-summary-dismiss" onClick={() => onOpenChange(false)}>
                Fermer
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
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

  const [closeSessionDialogOpen, setCloseSessionDialogOpen] = useState(false);
  const [closedSessionSummary, setClosedSessionSummary] = useState<CashSessionResponse | null>(null);

  const { data: warehouseData } = useWarehouses();
  const { data: clientData } = useClients();
  const warehouses = warehouseData?.data ?? [];
  const clients = clientData?.data ?? [];

  const {
    data: currentSession,
    isLoading: sessionLoading,
    isError: sessionError,
    refetch: refetchSession,
  } = useCurrentCashSession(warehouseId);
  const openSessionMutation = useOpenCashSession(warehouseId);
  const closeSessionMutation = useCloseCashSession(warehouseId);

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

  /** Ouvre une session de caisse (fond de caisse déclaré) pour l'entrepôt sélectionné. */
  async function handleOpenSession(openingAmount: string) {
    try {
      await openSessionMutation.mutateAsync({ warehouseId, openingAmount });
      toast.success('Session de caisse ouverte.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'ouverture de la session.");
    }
  }

  /**
   * Clôture la session en cours. Le résultat (avec expectedClosingAmount/variance calculés
   * côté serveur) reste affiché DANS le AlertDialog (cf. CloseCashSessionDialog) tant que le
   * caissier ne l'a pas fermé explicitement — le panier est vidé, la prochaine session
   * démarrera propre.
   */
  async function handleCloseSession(countedClosingAmount: string) {
    if (!currentSession) return;
    try {
      const closed = await closeSessionMutation.mutateAsync({ id: currentSession.id, countedClosingAmount });
      setClosedSessionSummary(closed);
      setCart([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la clôture de la session.');
    }
  }

  function handleCloseDialogOpenChange(open: boolean) {
    setCloseSessionDialogOpen(open);
    if (!open) setClosedSessionSummary(null);
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

  /** Conditions pour ouvrir le Sheet de paiement — indépendant du client/mode de paiement, choisis dedans. */
  const canProceedToCheckout =
    cart.length > 0 &&
    warehouseId !== '' &&
    !!calculatedTotal &&
    !totalsLoading &&
    insufficientLines.size === 0;

  const canSubmit =
    canProceedToCheckout &&
    clientId !== '' &&
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

  // Le panier/la grille ne sont accessibles que si l'entrepôt a une session de caisse OPEN
  // (cohérent avec le gate serveur sur PosService.createSale(), §18.2 — S23b). Trois états
  // intermédiaires possibles pendant la vérification, avant le cas nominal "session ouverte".
  const sessionChecking = warehouseId !== '' && sessionLoading;
  const sessionCheckFailed = warehouseId !== '' && !sessionLoading && sessionError;
  const sessionRequired = warehouseId !== '' && !sessionLoading && !sessionError && currentSession === null;
  const canAccessCart = warehouseId === '' || (!sessionLoading && !sessionError && !!currentSession);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col p-4 sm:p-6 lg:h-[calc(100vh-3.5rem)] lg:p-8">
      {/* Le sélecteur d'entrepôt reste toujours accessible, y compris quand le gate de session
          (S23b) bloque la grille/le panier ci-dessous — sans quoi un choix d'entrepôt erroné
          serait irréversible sans recharger la page. */}
      <div className="mb-3 sm:w-64">
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

      {warehouseId !== '' && currentSession && (
        <div className="mb-3">
          <CashSessionBanner
            session={currentSession}
            disabled={panelState !== 'cart'}
            onRequestClose={() => setCloseSessionDialogOpen(true)}
          />
        </div>
      )}

      {sessionChecking && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-300" />
        </div>
      )}

      {sessionCheckFailed && (
        <ErrorState
          message="Impossible de vérifier la session de caisse."
          onRetry={() => void refetchSession()}
        />
      )}

      {sessionRequired && (
        <OpenCashSessionGate onOpen={(amount) => void handleOpenSession(amount)} opening={openSessionMutation.isPending} />
      )}

      {canAccessCart && (
      <>
      {/*
        Sous lg : colonnes empilées, page qui défile normalement (comme le reste de
        l'app) — pas de hauteur figée ni de scroll interne, donc rien ne peut jamais
        écraser la liste du panier. À partir de lg : deux colonnes côte à côte, chacune
        avec son propre scroll interne borné par la hauteur du viewport.
      */}
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* ── Colonne gauche : recherche + grille (entrepôt sélectionné plus haut) ── */}
        <div className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div>
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

          {/* Liste du panier : toujours visible tant que le reçu n'est pas affiché — y compris
              pendant le paiement (Sheet), pour que le caissier garde le contexte de ce qu'il
              encaisse. Seules les actions (quantité, suppression) se verrouillent hors 'cart'. */}
          {panelState !== 'receipt' && (
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
                      locked={panelState !== 'cart'}
                      onQuantityChange={updateLineQuantity}
                      onRemove={removeLine}
                    />
                  ))}
                </div>
              </div>

              <div className="border-t border-neutral-100 p-3.5">
                {panelState === 'cart' && (
                  <Button
                    data-testid="checkout-button"
                    size="lg"
                    className="w-full"
                    disabled={!canProceedToCheckout}
                    onClick={() => setPanelState('checkout')}
                  >
                    Passer au paiement
                  </Button>
                )}
                {panelState !== 'cart' && (
                  <p className="text-center text-[12.5px] text-neutral-500">
                    {panelState === 'checkout' && 'Finalisez le paiement dans le panneau à droite.'}
                    {panelState === 'awaiting-mobile-money' && 'En attente de confirmation du paiement…'}
                    {panelState === 'mobile-money-expired' && 'Paiement expiré — voir le panneau à droite.'}
                  </p>
                )}
              </div>
            </>
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

        {/* ── Sheet paiement (Client, Mode de paiement, attente/expiration mobile money) ── */}
        <Sheet
          open={panelState === 'checkout' || panelState === 'awaiting-mobile-money' || panelState === 'mobile-money-expired'}
          onOpenChange={(open) => {
            // Attente/expiration mobile money : fermeture ignorée, actions explicites uniquement
            // (le panier reste bloqué tant que la vente n'est pas résolue — §18.2 étape 10).
            if (!open && panelState === 'checkout') setPanelState('cart');
          }}
        >
          <SheetContent hideClose={panelState === 'awaiting-mobile-money' || panelState === 'mobile-money-expired'}>
            {panelState === 'checkout' && (
              <>
                <SheetHeader>
                  <SheetTitle>Paiement</SheetTitle>
                  <SheetDescription>Le total est recalculé côté serveur, jamais depuis cet affichage.</SheetDescription>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto px-6 py-5">
                  <div className="flex flex-col gap-4">
                    <div className="rounded-card bg-brand-50 px-4 py-3">
                      <p className="text-[11.5px] text-brand-700/70">Total</p>
                      <p className="tabular text-[20px] font-semibold text-brand-800">{formatXAF(calculatedTotal?.grandTotal ?? '0')}</p>
                    </div>

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
                  </div>
                </div>
                <SheetFooter>
                  <Button
                    data-testid="encaisser-button"
                    size="lg"
                    className="w-full"
                    disabled={!canSubmit}
                    loading={createSaleMutation.isPending}
                    onClick={() => void handleEncaisser()}
                  >
                    {!createSaleMutation.isPending && 'Encaisser'}
                    {createSaleMutation.isPending && 'Encaissement…'}
                  </Button>
                </SheetFooter>
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
                    rel="noopener noreferrer"
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
          </SheetContent>
        </Sheet>
      </div>
      </>
      )}

      <CloseCashSessionDialog
        session={currentSession ?? null}
        open={closeSessionDialogOpen}
        onOpenChange={handleCloseDialogOpenChange}
        onConfirm={(amount) => void handleCloseSession(amount)}
        closing={closeSessionMutation.isPending}
        closedResult={closedSessionSummary}
      />
    </div>
  );
}
