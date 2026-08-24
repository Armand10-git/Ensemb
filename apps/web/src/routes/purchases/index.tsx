import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, PackagePlus, Undo2, Download } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, formatXAF, formatDate } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { NativeSelect } from '../../components/ui/native-select';
import { Badge } from '../../components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../../components/ui/alert-dialog';
import { PageHeader, TableSkeleton, EmptyState, ErrorState } from '../../components/page-states';

// ─── Types ───────────────────────────────────────────────────────────────────

// Purchase.status ne connaît pas AWAITING_PAYMENT (propre au flux caisse asynchrone des
// ventes mobile money) ni CANCELLED n'est jamais atteignable cette session (§ pas de /cancel).
type PurchaseStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';
type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

interface PurchaseDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  purchaseUnitId: string | null;
  price: string;
  taxAmount: string | null;
  taxMethod: string | null;
  discount: string | null;
  discountMethod: string | null;
  quantity: string;
  total: string;
}

interface Purchase {
  id: string;
  reference: string;
  date: string;
  providerId: string;
  warehouseId: string;
  taxRate: string | null;
  taxAmount: string | null;
  discount: string | null;
  shipping: string | null;
  grandTotal: string;
  paidAmount: string;
  paymentStatus: PaymentStatus;
  status: PurchaseStatus;
  notes: string | null;
  createdAt: string;
  provider?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: PurchaseDetail[];
}

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';

interface PaymentPurchaseResponse {
  id: string;
  organizationId: string;
  purchaseId: string;
  userId: string;
  date: string;
  reference: string;
  amount: string;
  method: PaymentMethod;
  change: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

// ─── Types retour d'achat (S27 — création depuis PurchaseDetailView) ──────────

/** PurchaseReturnDetail minimal — juste ce qu'il faut pour sommer les quantités déjà retournées par ligne. */
interface PurchaseReturnDetailRef {
  purchaseDetailId: string;
  quantity: string;
}

/** PurchaseReturn minimal — utilisé uniquement pour calculer l'aperçu du restant retournable. */
interface PurchaseReturnRef {
  id: string;
  purchaseId: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  details?: PurchaseReturnDetailRef[];
}

interface PurchaseReturnCreated {
  id: string;
  reference: string;
}

interface ProviderRef { id: string; name: string }
interface WarehouseRef { id: string; name: string }
interface ProductRef { id: string; code: string; name: string; price: string }

interface DetailFormRow {
  productId: string;
  quantity: string;
  price: string;
  discount: string;
  taxAmount: string;
}

const VITE_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const WS_URL = VITE_API_URL.replace('/api/v1', '');

// ─── API Hooks ───────────────────────────────────────────────────────────────

function usePurchases(
  page: number,
  limit: number,
  providerId: string,
  warehouseId: string,
  status: string,
  paymentStatus: string,
) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (providerId)    params.set('providerId', providerId);
  if (warehouseId)   params.set('warehouseId', warehouseId);
  if (status)        params.set('status', status);
  if (paymentStatus) params.set('paymentStatus', paymentStatus);
  return useQuery<Paginated<Purchase>>({
    queryKey: ['purchases', page, limit, providerId, warehouseId, status, paymentStatus],
    queryFn: () => api.get<Paginated<Purchase>>(`/purchases?${params}`),
  });
}

function usePurchaseDetail(id: string | null) {
  return useQuery<Purchase>({
    queryKey: ['purchase', id],
    queryFn: () => api.get<Purchase>(`/purchases/${id!}`),
    enabled: id !== null,
  });
}

/** Fournisseurs de l'organisation — même endpoint que people/suppliers.tsx (/partners/providers). */
function useProviders() {
  return useQuery<Paginated<ProviderRef>>({
    queryKey: ['providers-all'],
    queryFn: () => api.get<Paginated<ProviderRef>>('/partners/providers?limit=200'),
    staleTime: 60_000,
  });
}

function useWarehouses() {
  return useQuery<Paginated<WarehouseRef>>({
    queryKey: ['warehouses-all'],
    queryFn: () => api.get<Paginated<WarehouseRef>>('/warehouses?limit=200'),
    staleTime: 60_000,
  });
}

function useProducts() {
  return useQuery<Paginated<ProductRef>>({
    queryKey: ['products-all'],
    queryFn: () => api.get<Paginated<ProductRef>>('/catalog/products?limit=500'),
    staleTime: 60_000,
  });
}

function useCreatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Purchase>('/purchases', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['purchases'] }); },
  });
}

function useDeletePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/purchases/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['purchases'] }); },
  });
}

/**
 * Valide un achat (PENDING → COMPLETED) : le stock est incrémenté côté serveur.
 * Invalide la liste des achats et le détail de l'achat concerné (badge de statut).
 */
function useValidatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<Purchase>(`/purchases/${id}/validate`, {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['purchase', data.id] });
    },
  });
}

/** Historique des règlements d'un achat, triés chronologiquement par le serveur (date ASC). */
function usePurchasePayments(purchaseId: string) {
  return useQuery<PaymentPurchaseResponse[]>({
    queryKey: ['purchase-payments', purchaseId],
    queryFn: () => api.get<PaymentPurchaseResponse[]>(`/purchases/${purchaseId}/payments`),
    enabled: purchaseId !== '',
  });
}

/**
 * Enregistre un paiement sur un achat. Invalide l'historique des paiements, le détail de
 * l'achat (le statut/paidAmount recalculés côté serveur doivent se refléter immédiatement
 * dans PaymentBadge) et la liste des achats (badge de paiement affiché en colonne).
 */
function useCreatePurchasePayment(purchaseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<PaymentPurchaseResponse>(`/purchases/${purchaseId}/payments`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchase-payments', purchaseId] });
      void qc.invalidateQueries({ queryKey: ['purchase', purchaseId] });
      void qc.invalidateQueries({ queryKey: ['purchases'] });
    },
  });
}

interface DownloadPdfResponse { status: 'queued' }

/**
 * Déclenche la génération asynchrone du PDF de l'achat (S34 — job BullMQ + Puppeteer côté
 * serveur). La réponse 202 confirme uniquement la mise en file d'attente, jamais la
 * disponibilité du fichier : celle-ci n'est connue qu'à la réception de l'événement Socket.io
 * `pdf:ready` (écouté dans PurchaseDetailView, filtré sur documentType/documentId). N'invalide
 * aucune query : la génération ne modifie aucune donnée de l'achat. `api.post` exige un corps
 * de requête typé — `{}` mirror le patron déjà utilisé pour les mutations sans payload
 * (cf. useValidatePurchase).
 */
function useDownloadPurchasePdf(purchaseId: string) {
  return useMutation({
    mutationFn: () => api.post<DownloadPdfResponse>(`/purchases/${purchaseId}/pdf`, {}),
  });
}

/**
 * Crée un retour d'achat partiel (statut PENDING) — mirror useCreatePurchase côté retours.
 * Invalide la liste des retours (écran purchase-returns/index.tsx, S27).
 */
function useCreatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<PurchaseReturnCreated>('/purchase-returns', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['purchase-returns'] }); },
  });
}

/**
 * Quantités déjà retournées par ligne d'achat (PurchaseDetail.id → somme des quantités
 * retournées), pour l'affichage indicatif du restant dans le Sheet de création de retour —
 * le serveur reste l'arbitre final au submit (§17 point A). Le endpoint de liste
 * (GET /purchase-returns) ne renvoie pas les lignes (PURCHASE_RETURN_SELECT n'inclut pas
 * `details`, cf. purchase-return.service.ts) : on récupère donc la liste des retours
 * COMPLETED de cet achat, puis le détail de chacun (le nombre de retours par achat reste
 * faible en pratique — pas de N+1 côté serveur, uniquement des appels client groupés).
 */
function useReturnedQuantities(purchaseId: string, enabled: boolean) {
  return useQuery<Record<string, number>>({
    queryKey: ['purchase-returned-quantities', purchaseId],
    queryFn: async () => {
      const list = await api.get<Paginated<PurchaseReturnRef>>(
        `/purchase-returns?purchaseId=${purchaseId}&status=COMPLETED&limit=100`,
      );
      const details = await Promise.all(
        list.data.map((r) => api.get<PurchaseReturnRef>(`/purchase-returns/${r.id}`)),
      );
      const totals: Record<string, number> = {};
      for (const ret of details) {
        for (const d of ret.details ?? []) {
          totals[d.purchaseDetailId] = (totals[d.purchaseDetailId] ?? 0) + (parseFloat(d.quantity) || 0);
        }
      }
      return totals;
    },
    enabled,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmptyRow(): DetailFormRow {
  return { productId: '', quantity: '', price: '', discount: '0', taxAmount: '0' };
}

/** Calcul indicatif côté client — le serveur recalcule tout, ceci n'est qu'un aperçu. */
function computeLinePreview(row: DetailFormRow): number {
  const price = parseFloat(row.price) || 0;
  const quantity = parseFloat(row.quantity) || 0;
  const subTotal = price * quantity;
  const tax = subTotal * ((parseFloat(row.taxAmount) || 0) / 100);
  const discount = subTotal * ((parseFloat(row.discount) || 0) / 100);
  return subTotal + tax - discount;
}

// ─── Badges de statut ──────────────────────────────────────────────────────────

function PaymentBadge({ status }: { status: PaymentStatus }) {
  const map: Record<PaymentStatus, { label: string; variant: 'danger' | 'warning' | 'success' }> = {
    UNPAID:  { label: 'Non payé', variant: 'danger' },
    PARTIAL: { label: 'Partiel',  variant: 'warning' },
    PAID:    { label: 'Payé',     variant: 'success' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function StatusBadge({ status }: { status: PurchaseStatus }) {
  const map: Record<PurchaseStatus, { label: string; variant: 'warning' | 'success' | 'neutral' }> = {
    PENDING:   { label: 'En attente', variant: 'warning' },
    COMPLETED: { label: 'Terminé',    variant: 'success' },
    CANCELLED: { label: 'Annulé',     variant: 'neutral' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Libellés français des méthodes de paiement (PaymentPurchase.method). */
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  CARD: 'Carte',
  MOBILE_MONEY: 'Mobile Money',
  BANK_TRANSFER: 'Virement bancaire',
};

// ─── Formulaire de création ───────────────────────────────────────────────────

function PurchaseForm({
  providers,
  warehouses,
  products,
  onSave,
  saving,
}: {
  providers: ProviderRef[];
  warehouses: WarehouseRef[];
  products: ProductRef[];
  onSave: (data: unknown) => void;
  saving: boolean;
}) {
  const [providerId, setProviderId]   = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate]               = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]             = useState('');
  const [discount, setDiscount]       = useState('0');
  const [shipping, setShipping]       = useState('0');
  const [taxRate, setTaxRate]         = useState('0');
  const [rows, setRows]               = useState<DetailFormRow[]>([makeEmptyRow()]);

  function setRow<K extends keyof DetailFormRow>(idx: number, key: K, value: DetailFormRow[K]) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
  }

  function addRow() { setRows((prev) => [...prev, makeEmptyRow()]); }
  function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

  function onSelectProduct(idx: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    setRows((prev) => prev.map((r, i) => i === idx
      ? { ...r, productId, price: r.price || (product ? product.price : r.price) }
      : r));
  }

  const sumLines = rows.reduce((acc, r) => acc + computeLinePreview(r), 0);
  const taxGlobalPreview = sumLines * ((parseFloat(taxRate) || 0) / 100);
  const grandTotalPreview = sumLines + taxGlobalPreview - (parseFloat(discount) || 0) + (parseFloat(shipping) || 0);

  function buildPayload() {
    return {
      providerId,
      warehouseId,
      date: new Date(date).toISOString(),
      notes: notes || undefined,
      taxRate,
      discount,
      shipping,
      details: rows.map((r) => ({
        productId: r.productId,
        quantity: r.quantity,
        price: r.price,
        discount: r.discount || '0',
        taxAmount: r.taxAmount || '0',
      })),
    };
  }

  const canSubmit = providerId && warehouseId && date
    && rows.every((r) => r.productId && r.quantity && r.price);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Fournisseur *</Label>
          <NativeSelect value={providerId} onChange={(e) => setProviderId(e.target.value)} data-testid="provider-select">
            <option value="">— Fournisseur —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label>Entrepôt *</Label>
          <NativeSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} data-testid="warehouse-select">
            <option value="">— Entrepôt —</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Date *</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label>Note</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Note interne…"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label>Lignes *</Label>
          <Button variant="secondary" size="sm" onClick={addRow} type="button">
            <Plus className="h-3.5 w-3.5" />
            Ajouter une ligne
          </Button>
        </div>

        <div className="flex flex-col gap-2.5">
          {rows.map((row, idx) => (
            <div key={idx} className="rounded-card border border-neutral-200 p-3">
              <div className="mb-2 grid grid-cols-[1fr_auto] gap-2">
                <NativeSelect value={row.productId} onChange={(e) => onSelectProduct(idx, e.target.value)}>
                  <option value="">— Produit —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                </NativeSelect>
                {rows.length > 1 && (
                  <Button variant="ghost" size="icon" type="button" onClick={() => removeRow(idx)} className="text-danger-600 hover:bg-danger-50">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Quantité *</Label>
                  <Input value={row.quantity} onChange={(e) => setRow(idx, 'quantity', e.target.value)} placeholder="1" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Prix unitaire *</Label>
                  <Input value={row.price} onChange={(e) => setRow(idx, 'price', e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Remise (%)</Label>
                  <Input value={row.discount} onChange={(e) => setRow(idx, 'discount', e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Taxe (%)</Label>
                  <Input value={row.taxAmount} onChange={(e) => setRow(idx, 'taxAmount', e.target.value)} placeholder="0" />
                </div>
              </div>

              <p className="tabular mt-2 text-right text-[12.5px] text-neutral-500">
                Total ligne (indicatif) : <strong className="text-neutral-800">{formatXAF(computeLinePreview(row))}</strong>
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-[11.5px] text-neutral-500">TVA globale (%)</Label>
          <Input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-[11.5px] text-neutral-500">Remise globale (XAF)</Label>
          <Input value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-[11.5px] text-neutral-500">Frais de port (XAF)</Label>
          <Input value={shipping} onChange={(e) => setShipping(e.target.value)} />
        </div>
      </div>

      <div className="rounded-card bg-brand-50 px-4 py-3 text-right">
        <p className="text-[11.5px] text-brand-700/70">Total indicatif (recalculé par le serveur)</p>
        <p className="tabular mt-0.5 text-[19px] font-semibold text-brand-800">{formatXAF(grandTotalPreview)}</p>
      </div>

      <Button onClick={() => onSave(buildPayload())} disabled={!canSubmit} loading={saving} size="lg">
        {!saving && 'Enregistrer'}
        {saving && 'Enregistrement…'}
      </Button>
    </div>
  );
}

// ─── Formulaire d'ajout de paiement ────────────────────────────────────────────

/**
 * Formulaire de règlement — solde restant affiché en évidence, raccourci « Solder »
 * pré-remplissant le montant exact. Le montant est borné au solde restant au blur
 * (jamais rejeté au submit — mirror exact du formulaire de paiement des ventes). Le
 * serveur reste l'arbitre final du calcul : ce composant n'affiche le solde qu'à titre
 * indicatif.
 */
function PaymentForm({
  remaining,
  onSave,
  saving,
}: {
  remaining: number;
  onSave: (data: { date: string; amount: string; method: PaymentMethod; notes?: string }) => void;
  saving: boolean;
}) {
  const remainingStr = remaining.toFixed(3);
  const [date, setDate]     = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(remainingStr);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [notes, setNotes]   = useState('');
  const [clamped, setClamped] = useState(false);

  function handleAmountChange(value: string) {
    setAmount(value);
    setClamped(false);
  }

  /** Borne le montant au solde restant à la perte de focus — jamais au submit. */
  function handleAmountBlur() {
    const value = parseFloat(amount);
    if (!Number.isNaN(value) && value > remaining) {
      setAmount(remainingStr);
      setClamped(true);
    }
  }

  function handleSolder() {
    setAmount(remainingStr);
    setClamped(false);
  }

  function buildPayload() {
    return {
      date: new Date(date).toISOString(),
      amount,
      method,
      notes: notes || undefined,
    };
  }

  const amountValue = parseFloat(amount);
  const canSubmit = date !== '' && !Number.isNaN(amountValue) && amountValue > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-card bg-brand-50 px-4 py-3">
        <p className="text-[11.5px] text-brand-700/70">Solde restant</p>
        <p className="tabular mt-0.5 text-[19px] font-semibold text-brand-800">{formatXAF(remainingStr)}</p>
      </div>

      <div className="space-y-1.5">
        <Label>Date *</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Montant *</Label>
          <Button variant="secondary" size="sm" type="button" onClick={handleSolder}>
            Solder
          </Button>
        </div>
        <Input
          type="number"
          step="0.001"
          min="0"
          max={remainingStr}
          value={amount}
          onChange={(e) => handleAmountChange(e.target.value)}
          onBlur={handleAmountBlur}
          className="tabular"
        />
        {clamped && (
          <p className="text-[12px] text-amber-700">
            Montant ramené au solde restant ({formatXAF(remainingStr)}).
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Méthode *</Label>
        <NativeSelect value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
            <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Label>Note</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Note interne…"
        />
      </div>

      <Button onClick={() => onSave(buildPayload())} disabled={!canSubmit} loading={saving} size="lg">
        {!saving && 'Enregistrer'}
        {saving && 'Enregistrement…'}
      </Button>
    </div>
  );
}

// ─── Formulaire de création de retour ──────────────────────────────────────────

/**
 * Sheet de création d'un retour d'achat partiel, ouvert depuis PurchaseDetailView pour un
 * achat COMPLETED. Une ligne par PurchaseDetail de l'achat ; restant = quantité achetée −
 * déjà retourné (indicatif uniquement, `Math.max(0, …)` — le serveur reste l'arbitre final
 * au submit). Aucun champ price/taxAmount/discount/returnUnitId n'est exposé (décision de
 * conception S26 anti-manipulation de prix : ces valeurs sont toujours copiées côté serveur
 * depuis la PurchaseDetail source) ; pas de sélecteur d'unité de retour, mirror de
 * PurchaseForm/SaleForm qui omettent déjà purchaseUnitId/saleUnitId. Seules les lignes dont
 * la quantité saisie est > 0 sont envoyées dans le payload.
 */
function PurchaseReturnForm({
  purchase,
  products,
  returnedQuantities,
  onSave,
  saving,
}: {
  purchase: Purchase;
  products: ProductRef[];
  returnedQuantities: Record<string, number>;
  onSave: (data: unknown) => void;
  saving: boolean;
}) {
  const [date, setDate]           = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]         = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  function setQuantity(detailId: string, value: string) {
    setQuantities((prev) => ({ ...prev, [detailId]: value }));
  }

  const rows = (purchase.details ?? []).map((d) => {
    const purchased = parseFloat(d.quantity) || 0;
    const alreadyReturned = returnedQuantities[d.id] ?? 0;
    const remaining = Math.max(0, purchased - alreadyReturned);
    const value = quantities[d.id] ?? '0';
    const entered = parseFloat(value) || 0;
    const exceeds = entered > remaining;
    return { detail: d, remaining, value, entered, exceeds };
  });

  const hasAnyQuantity = rows.some((r) => r.entered > 0);
  const hasExcess = rows.some((r) => r.exceeds);
  const canSubmit = date !== '' && hasAnyQuantity && !hasExcess;

  function buildPayload() {
    return {
      purchaseId: purchase.id,
      date: new Date(date).toISOString(),
      notes: notes || undefined,
      details: rows
        .filter((r) => r.entered > 0)
        .map((r) => ({ purchaseDetailId: r.detail.id, quantity: r.value })),
    };
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label>Date *</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div>
        <Label className="mb-2 block">Lignes à retourner</Label>
        <div className="flex flex-col gap-2.5">
          {rows.map(({ detail: d, remaining, value, exceeds }) => {
            const prod = products.find((p) => p.id === d.productId);
            return (
              <div key={d.id} className="rounded-card border border-neutral-200 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[13.5px] font-medium text-neutral-800">
                    {prod ? `${prod.code} — ${prod.name}` : d.productId}
                  </p>
                  <p className="text-[11.5px] text-neutral-500">Acheté : {d.quantity}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Quantité à retourner</Label>
                  <Input
                    value={value}
                    max={remaining}
                    onChange={(e) => setQuantity(d.id, e.target.value)}
                  />
                  <p className={cn('text-[11.5px]', exceeds ? 'text-danger-600' : 'text-neutral-500')}>
                    {exceeds ? `Dépasse le restant (${remaining})` : `Restant : ${remaining}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Note</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Note interne…"
        />
      </div>

      <Button onClick={() => onSave(buildPayload())} disabled={!canSubmit} loading={saving} size="lg">
        {!saving && 'Créer le retour'}
        {saving && 'Création…'}
      </Button>
    </div>
  );
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

function PurchaseDetailView({
  purchase,
  products,
  onValidate,
  onDelete,
  validating,
}: {
  purchase: Purchase;
  products: ProductRef[];
  onValidate: () => void;
  onDelete: () => void;
  validating: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  const [returnSheetOpen, setReturnSheetOpen]   = useState(false);

  const { data: payments, isLoading: paymentsLoading, isError: paymentsError } = usePurchasePayments(purchase.id);
  const createPaymentMutation = useCreatePurchasePayment(purchase.id);
  const createReturnMutation  = useCreatePurchaseReturn();
  const { data: returnedQuantities } = useReturnedQuantities(purchase.id, returnSheetOpen);
  const downloadPdfMutation = useDownloadPurchasePdf(purchase.id);
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'generating'>('idle');

  // Solde restant — affichage uniquement, le serveur reste l'arbitre du calcul réel (§17 point A).
  const remaining = Math.max(Number(purchase.grandTotal) - Number(purchase.paidAmount), 0);

  async function handleSavePayment(data: { date: string; amount: string; method: PaymentMethod; notes?: string }) {
    try {
      await createPaymentMutation.mutateAsync(data);
      setPaymentSheetOpen(false);
      toast.success('Paiement enregistré.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'enregistrement du paiement.");
    }
  }

  /**
   * Crée le retour d'achat puis navigue vers l'écran des retours en pré-ouvrant son détail
   * (deep-link `?open=<id>` — pass-through TanStack Router, aucun validateSearch requis
   * côté route cible, cf. purchase-returns/index.tsx). Toast avant navigation.
   */
  async function handleSaveReturn(data: unknown) {
    try {
      const created = await createReturnMutation.mutateAsync(data);
      setReturnSheetOpen(false);
      toast.success(`Retour créé. Référence : ${created.reference}`);
      void navigate({ to: '/purchase-returns', search: { open: created.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la création du retour.');
    }
  }

  /**
   * Déclenche la génération asynchrone du PDF de l'achat. La réponse 202 confirme uniquement
   * la mise en file : le bouton reste en état « Génération… » jusqu'à l'événement Socket.io
   * `pdf:ready` (ou `pdf:generateFailed`) — jamais de « Téléchargé » avant cette confirmation
   * (vocabulaire continu, docs/ux/standards.md). Seul un échec de la requête POST elle-même
   * (pas du job) ramène l'état à idle ici ; l'échec du job est géré par l'écoute socket.
   */
  async function handleDownloadPdf() {
    setPdfStatus('generating');
    try {
      await downloadPdfMutation.mutateAsync();
      toast.success('Génération du PDF en cours…');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la génération du PDF.');
      setPdfStatus('idle');
    }
  }

  // Socket.io — écoute dédiée des événements de génération PDF (S34) pour l'achat affiché.
  // Connexion propre au détail (distincte de celle de PurchasesPage sur stock:updated) afin
  // de comparer chaque événement à purchase.id de l'élément actuellement ouvert dans le Sheet.
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('pdf:ready', (payload: { documentType: string; documentId: string; url: string }) => {
      if (payload.documentType === 'purchase' && payload.documentId === purchase.id) {
        setPdfStatus('idle');
        toast.success('PDF téléchargé.');
        window.open(payload.url, '_blank', 'noopener,noreferrer');
      }
    });
    socket.on('pdf:generateFailed', (payload: { documentType: string; documentId: string }) => {
      if (payload.documentType === 'purchase' && payload.documentId === purchase.id) {
        setPdfStatus('idle');
        toast.error('Erreur lors de la génération du PDF.');
      }
    });
    return () => { socket.disconnect(); };
  }, [purchase.id]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{purchase.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statuts</p>
          <div className="flex gap-1.5">
            <StatusBadge status={purchase.status} />
            <PaymentBadge status={purchase.paymentStatus} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(purchase.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Fournisseur / Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">{purchase.provider?.name ?? purchase.providerId} — {purchase.warehouse?.name ?? purchase.warehouseId}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={pdfStatus === 'generating'}
          onClick={() => void handleDownloadPdf()}
        >
          {pdfStatus === 'generating'
            ? 'Génération…'
            : (<><Download className="h-3.5 w-3.5" />Télécharger en PDF</>)}
        </Button>
      </div>

      {purchase.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{purchase.notes}</div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({purchase.details?.length ?? 0})</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produit</TableHead>
              <TableHead className="text-right">Qté</TableHead>
              <TableHead className="text-right">P.U.</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(purchase.details ?? []).map((d) => {
              const prod = products.find((p) => p.id === d.productId);
              return (
                <TableRow key={d.id}>
                  <TableCell>{prod ? `${prod.code} — ${prod.name}` : d.productId}</TableCell>
                  <TableCell className="tabular text-right">{d.quantity}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(d.price)}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(d.total)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-1.5 rounded-card bg-neutral-50 px-4 py-3">
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>TVA ({purchase.taxRate ?? '0'} %)</span><span className="tabular">{formatXAF(purchase.taxAmount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Remise</span><span className="tabular">− {formatXAF(purchase.discount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Frais de port</span><span className="tabular">{formatXAF(purchase.shipping ?? '0')}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-neutral-200 pt-2 text-[16px] font-semibold text-neutral-900">
          <span>Total</span><span className="tabular">{formatXAF(purchase.grandTotal)}</span>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12.5px] font-semibold text-neutral-700">Paiements ({payments?.length ?? 0})</p>
          {purchase.paymentStatus !== 'PAID' && (
            <Button variant="secondary" size="sm" onClick={() => setPaymentSheetOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Ajouter un paiement
            </Button>
          )}
        </div>

        {paymentsLoading && (
          <div className="flex flex-col gap-2">
            {[1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-field bg-neutral-100" />)}
          </div>
        )}

        {paymentsError && (
          <div className="flex items-center justify-between rounded-card border border-danger-200 bg-danger-50 px-3.5 py-3 text-[13px] text-danger-700">
            <span>Impossible de charger l&apos;historique des paiements.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void qc.invalidateQueries({ queryKey: ['purchase-payments', purchase.id] })}
            >
              Réessayer
            </Button>
          </div>
        )}

        {!paymentsLoading && !paymentsError && (payments?.length ?? 0) === 0 && (
          <div className="rounded-card border border-dashed border-neutral-300 bg-white px-3.5 py-5 text-center text-[13px] text-neutral-500">
            Aucun paiement enregistré pour cet achat.
          </div>
        )}

        {!paymentsLoading && !paymentsError && (payments?.length ?? 0) > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Méthode</TableHead>
                <TableHead className="text-right">Montant</TableHead>
                <TableHead>Référence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(payments ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{formatDate(p.date)}</TableCell>
                  <TableCell>{PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(p.amount)}</TableCell>
                  <TableCell className="tabular text-neutral-500">{p.reference}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {purchase.status === 'PENDING' && (
        <div className="flex gap-2.5 pt-1">
          <Button className="flex-1" onClick={onValidate} loading={validating}>
            {!validating && "Valider l'achat"}
            {validating && 'Validation…'}
          </Button>
          <Button variant="destructive" onClick={onDelete} disabled={validating}>
            <Trash2 className="h-4 w-4" />
            Supprimer
          </Button>
        </div>
      )}

      {/* Achat COMPLETED : pas de cancel() cette session (S25) — seul un retour est possible. */}
      {purchase.status === 'COMPLETED' && (
        <div className="pt-1">
          <Button variant="secondary" onClick={() => setReturnSheetOpen(true)}>
            <Undo2 className="h-4 w-4" />
            Créer un retour
          </Button>
        </div>
      )}

      {/* ── Sheet ajout de paiement ─────────────────────────────────────── */}
      <Sheet open={paymentSheetOpen} onOpenChange={setPaymentSheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Ajouter un paiement</SheetTitle>
            <SheetDescription>Achat {purchase.reference} — le statut est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <PaymentForm
              remaining={remaining}
              onSave={(payload) => void handleSavePayment(payload)}
              saving={createPaymentMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sheet création de retour ────────────────────────────────────── */}
      <Sheet open={returnSheetOpen} onOpenChange={setReturnSheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Créer un retour</SheetTitle>
            <SheetDescription>Achat {purchase.reference} — le total est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <PurchaseReturnForm
              purchase={purchase}
              products={products}
              returnedQuantities={returnedQuantities ?? {}}
              onSave={(payload) => void handleSaveReturn(payload)}
              saving={createReturnMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterProvider, setFilterProvider]   = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus]       = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailId, setDetailId]   = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = usePurchases(page, limit, filterProvider, filterWarehouse, filterStatus, '');
  const { data: detail, isLoading: detailLoading } = usePurchaseDetail(detailId);
  const { data: providerData }  = useProviders();
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const providers  = providerData?.data ?? [];
  const warehouses = warehouseData?.data ?? [];
  const products    = productData?.data ?? [];

  const createMutation   = useCreatePurchase();
  const deleteMutation   = useDeletePurchase();
  const validateMutation = useValidatePurchase();

  // Socket.io — invalider le cache sur stock:updated (la validation d'un achat incrémente le stock)
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('stock:updated', () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['purchase', detailId] });
    });
    return () => { socket.disconnect(); };
  }, [qc, detailId]);

  async function handleSave(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      setSheetOpen(false);
      toast.success(`Achat créé. Référence : ${created.reference}`);
    } catch {
      toast.error("Erreur lors de l'enregistrement de l'achat.");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast.success('Achat supprimé.');
    } catch {
      toast.error('Erreur lors de la suppression.');
    }
  }

  async function handleValidate(id: string) {
    try {
      await validateMutation.mutateAsync(id);
      toast.success('Achat validé. Stock mis à jour.');
    } catch {
      toast.error('Erreur lors de la validation.');
    }
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Achats"
        description="Réceptions fournisseurs et suivi des règlements."
        action={
          <Button onClick={() => setSheetOpen(true)}>
            <Plus className="h-4 w-4" />
            Nouvel achat
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterProvider}
            onChange={(e) => { setFilterProvider(e.target.value); setPage(1); }}
          >
            <option value="">Tous les fournisseurs</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterWarehouse}
            onChange={(e) => { setFilterWarehouse(e.target.value); setPage(1); }}
          >
            <option value="">Tous les entrepôts</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[9rem]"
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          >
            <option value="">Tous les statuts</option>
            <option value="PENDING">En attente</option>
            <option value="COMPLETED">Terminé</option>
            <option value="CANCELLED">Annulé</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={7} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les achats." onRetry={() => void qc.invalidateQueries({ queryKey: ['purchases'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={PackagePlus}
          title="Aucun achat"
          description="Créez votre premier achat pour un fournisseur."
          action={
            <Button onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4" />
              Nouvel achat
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Référence</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Fournisseur</TableHead>
              <TableHead>Entrepôt</TableHead>
              <TableHead className="text-center">Lignes</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Paiement</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const providerName  = providers.find((pr) => pr.id === p.providerId)?.name ?? '—';
              const warehouseName = warehouses.find((w) => w.id === p.warehouseId)?.name ?? '—';
              return (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => setDetailId(p.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{p.reference}</TableCell>
                  <TableCell>{formatDate(p.date)}</TableCell>
                  <TableCell>{providerName}</TableCell>
                  <TableCell>{warehouseName}</TableCell>
                  <TableCell className="tabular text-center">{p.details?.length ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(p.grandTotal)}</TableCell>
                  <TableCell><PaymentBadge status={p.paymentStatus} /></TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className={cn('flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); setDetailId(p.id); }}
                        aria-label="Voir"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {p.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: p.id, reference: p.reference }); }}
                          aria-label="Supprimer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {!isLoading && !isError && totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button variant="secondary" size="icon" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-[13px] text-neutral-500">{page} / {totalPages}</span>
          <Button variant="secondary" size="icon" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* ── Sheet création ───────────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Nouvel achat</SheetTitle>
            <SheetDescription>Fournisseur, entrepôt et lignes — le total est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <PurchaseForm
              providers={providers}
              warehouses={warehouses}
              products={products}
              onSave={(payload) => void handleSave(payload)}
              saving={createMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{detail ? `Achat ${detail.reference}` : 'Chargement…'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && (
              <PurchaseDetailView
                purchase={detail}
                products={products}
                onValidate={() => void handleValidate(detail.id)}
                onDelete={() => setDeleteTarget({ id: detail.id, reference: detail.reference })}
                validating={validateMutation.isPending}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer l&apos;achat {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. L&apos;achat sera définitivement supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && void handleDelete(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
