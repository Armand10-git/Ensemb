import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, ReceiptText, Ban, Mail, MessageSquare, Undo2, Download } from 'lucide-react';
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
import { Tooltip, TooltipTrigger, TooltipContent } from '../../components/ui/tooltip';
import { PageHeader, TableSkeleton, EmptyState, ErrorState } from '../../components/page-states';

// ─── Types ───────────────────────────────────────────────────────────────────

type DocumentStatus = 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED';
type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

interface SaleDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  saleUnitId: string | null;
  price: string;
  taxAmount: string | null;
  taxMethod: string | null;
  discount: string | null;
  discountMethod: string | null;
  quantity: string;
  total: string;
}

interface Sale {
  id: string;
  reference: string;
  date: string;
  clientId: string;
  warehouseId: string;
  taxRate: string | null;
  taxAmount: string | null;
  discount: string | null;
  shipping: string | null;
  grandTotal: string;
  paidAmount: string;
  paymentStatus: PaymentStatus;
  status: DocumentStatus;
  notes: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  client?: { id: string; name: string; email: string | null; phone: string | null };
  warehouse?: { id: string; name: string };
  details?: SaleDetail[];
}

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';

interface PaymentSaleResponse {
  id: string;
  organizationId: string;
  saleId: string;
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

// ─── Types retour de vente (S27 — création depuis SaleDetailView) ────────────

/** SaleReturnDetail minimal — juste ce qu'il faut pour sommer les quantités déjà retournées par ligne. */
interface SaleReturnDetailRef {
  saleDetailId: string;
  quantity: string;
}

/** SaleReturn minimal — utilisé uniquement pour calculer l'aperçu du restant retournable. */
interface SaleReturnRef {
  id: string;
  saleId: string;
  status: 'PENDING' | 'COMPLETED';
  details?: SaleReturnDetailRef[];
}

interface SaleReturnCreated {
  id: string;
  reference: string;
}

interface ClientRef { id: string; name: string }
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

function useSales(
  page: number,
  limit: number,
  clientId: string,
  warehouseId: string,
  status: string,
  paymentStatus: string,
) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (clientId)      params.set('clientId', clientId);
  if (warehouseId)   params.set('warehouseId', warehouseId);
  if (status)        params.set('status', status);
  if (paymentStatus) params.set('paymentStatus', paymentStatus);
  return useQuery<Paginated<Sale>>({
    queryKey: ['sales', page, limit, clientId, warehouseId, status, paymentStatus],
    queryFn: () => api.get<Paginated<Sale>>(`/sales?${params}`),
  });
}

function useSaleDetail(id: string | null) {
  return useQuery<Sale>({
    queryKey: ['sale', id],
    queryFn: () => api.get<Sale>(`/sales/${id!}`),
    enabled: id !== null,
  });
}

function useClients() {
  return useQuery<Paginated<ClientRef>>({
    queryKey: ['clients-all'],
    queryFn: () => api.get<Paginated<ClientRef>>('/partners/clients?limit=200'),
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

function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Sale>('/sales', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales'] }); },
  });
}

function useDeleteSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/sales/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales'] }); },
  });
}

/**
 * Valide une vente (PENDING → COMPLETED) : le stock est décrémenté côté serveur.
 * Invalide la liste des ventes et le détail de la vente concernée (badge de statut).
 */
function useValidateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<Sale>(`/sales/${id}/validate`, {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['sale', data.id] });
    },
  });
}

/**
 * Annule une vente COMPLETED (§18.18) : le stock est restitué côté serveur, raison obligatoire.
 * Invalide la liste des ventes et le détail de la vente concernée (badge de statut).
 */
function useCancelSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.patch<Sale>(`/sales/${id}/cancel`, { reason }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['sale', data.id] });
    },
  });
}

/** Historique des règlements d'une vente, triés chronologiquement par le serveur (date ASC). */
function useSalePayments(saleId: string) {
  return useQuery<PaymentSaleResponse[]>({
    queryKey: ['sale-payments', saleId],
    queryFn: () => api.get<PaymentSaleResponse[]>(`/sales/${saleId}/payments`),
    enabled: saleId !== '',
  });
}

/**
 * Enregistre un paiement sur une vente. Invalide l'historique des paiements, le détail de
 * la vente (le statut/paidAmount recalculés côté serveur doivent se refléter immédiatement
 * dans PaymentBadge) et la liste des ventes (badge de paiement affiché en colonne).
 */
function useCreateSalePayment(saleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<PaymentSaleResponse>(`/sales/${saleId}/payments`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sale-payments', saleId] });
      void qc.invalidateQueries({ queryKey: ['sale', saleId] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });
}

type SendChannel = 'email' | 'sms';

interface SendSaleResponse { status: 'queued' }

/**
 * Envoie le récapitulatif de la vente au client par email ou SMS (§S24).
 * Traitement asynchrone côté serveur (job en file) : la réponse 202 confirme uniquement la
 * mise en file d'attente, jamais la livraison — l'appelant ne doit donc jamais afficher
 * « Envoyé », seulement « Envoi en cours… ». N'invalide aucune query : l'envoi ne modifie
 * ni le statut ni les données affichées de la vente.
 */
function useSendSale(saleId: string) {
  return useMutation({
    mutationFn: (data: { channel: SendChannel }) =>
      api.post<SendSaleResponse>(`/sales/${saleId}/send`, data),
  });
}

interface DownloadPdfResponse { status: 'queued' }

/**
 * Déclenche la génération asynchrone du PDF de la vente (S34 — job BullMQ + Puppeteer côté
 * serveur). La réponse 202 confirme uniquement la mise en file d'attente, jamais la
 * disponibilité du fichier : celle-ci n'est connue qu'à la réception de l'événement Socket.io
 * `pdf:ready` (écouté dans SaleDetailView, filtré sur documentType/documentId). N'invalide
 * aucune query : la génération ne modifie aucune donnée de la vente. `api.post` exige un
 * corps de requête typé — `{}` mirror le patron déjà utilisé pour les mutations sans payload
 * (cf. useValidateSale).
 */
function useDownloadSalePdf(saleId: string) {
  return useMutation({
    mutationFn: () => api.post<DownloadPdfResponse>(`/sales/${saleId}/pdf`, {}),
  });
}

/**
 * Crée un retour de vente partiel (statut PENDING) — mirror useCreateSale côté retours.
 * Invalide la liste des retours (écran sale-returns/index.tsx, S27).
 */
function useCreateSaleReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<SaleReturnCreated>('/sale-returns', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sale-returns'] }); },
  });
}

/**
 * Quantités déjà retournées par ligne de vente (SaleDetail.id → somme des quantités
 * retournées), pour l'affichage indicatif du restant dans le Sheet de création de retour —
 * le serveur reste l'arbitre final au submit (§17 point A). Le endpoint de liste
 * (GET /sale-returns) ne renvoie pas les lignes (SALE_RETURN_SELECT n'inclut pas `details`,
 * cf. sale-return.service.ts) : on récupère donc la liste des retours COMPLETED de cette
 * vente, puis le détail de chacun (le nombre de retours par vente reste faible en pratique —
 * pas de N+1 côté serveur, uniquement des appels client groupés).
 */
function useReturnedQuantities(saleId: string, enabled: boolean) {
  return useQuery<Record<string, number>>({
    queryKey: ['sale-returned-quantities', saleId],
    queryFn: async () => {
      const list = await api.get<Paginated<SaleReturnRef>>(
        `/sale-returns?saleId=${saleId}&status=COMPLETED&limit=100`,
      );
      const details = await Promise.all(
        list.data.map((r) => api.get<SaleReturnRef>(`/sale-returns/${r.id}`)),
      );
      const totals: Record<string, number> = {};
      for (const ret of details) {
        for (const d of ret.details ?? []) {
          totals[d.saleDetailId] = (totals[d.saleDetailId] ?? 0) + (parseFloat(d.quantity) || 0);
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

function StatusBadge({ status }: { status: DocumentStatus }) {
  const map: Record<DocumentStatus, { label: string; variant: 'warning' | 'info' | 'success' | 'neutral' }> = {
    PENDING:          { label: 'En attente',       variant: 'warning' },
    AWAITING_PAYMENT: { label: 'Paiement en cours', variant: 'info' },
    COMPLETED:        { label: 'Terminée',          variant: 'success' },
    CANCELLED:        { label: 'Annulée',           variant: 'neutral' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Libellés français des méthodes de paiement (PaymentSale.method). */
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  CARD: 'Carte',
  MOBILE_MONEY: 'Mobile Money',
  BANK_TRANSFER: 'Virement bancaire',
};

// ─── Formulaire de création ───────────────────────────────────────────────────

function SaleForm({
  clients,
  warehouses,
  products,
  onSave,
  saving,
}: {
  clients: ClientRef[];
  warehouses: WarehouseRef[];
  products: ProductRef[];
  onSave: (data: unknown) => void;
  saving: boolean;
}) {
  const [clientId, setClientId]       = useState('');
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
      clientId,
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

  const canSubmit = clientId && warehouseId && date
    && rows.every((r) => r.productId && r.quantity && r.price);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Client *</Label>
          <NativeSelect value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="client-select">
            <option value="">— Client —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
 * (jamais rejeté au submit — [18.5] "Montant supérieur au solde → borné à la saisie
 * avec explication, pas rejeté au submit"). Le serveur reste l'arbitre final du calcul :
 * ce composant n'affiche le solde qu'à titre indicatif.
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
 * Sheet de création d'un retour de vente partiel, ouvert depuis SaleDetailView pour une
 * vente COMPLETED. Une ligne par SaleDetail de la vente ; restant = quantité vendue −
 * déjà retourné (indicatif uniquement, `Math.max(0, …)` — le serveur reste l'arbitre final
 * au submit). Aucun champ price/taxAmount/discount/returnUnitId n'est exposé (décision de
 * conception S26 anti-manipulation de prix : ces valeurs sont toujours copiées côté serveur
 * depuis la SaleDetail source) ; pas de sélecteur d'unité de retour, mirror de SaleForm qui
 * omet déjà saleUnitId. Seules les lignes dont la quantité saisie est > 0 sont envoyées dans
 * le payload.
 */
function SaleReturnForm({
  sale,
  products,
  returnedQuantities,
  onSave,
  saving,
}: {
  sale: Sale;
  products: ProductRef[];
  returnedQuantities: Record<string, number>;
  onSave: (data: unknown) => void;
  saving: boolean;
}) {
  const [date, setDate]             = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]           = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  function setQuantity(detailId: string, value: string) {
    setQuantities((prev) => ({ ...prev, [detailId]: value }));
  }

  const rows = (sale.details ?? []).map((d) => {
    const sold = parseFloat(d.quantity) || 0;
    const alreadyReturned = returnedQuantities[d.id] ?? 0;
    const remaining = Math.max(0, sold - alreadyReturned);
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
      saleId: sale.id,
      date: new Date(date).toISOString(),
      notes: notes || undefined,
      details: rows
        .filter((r) => r.entered > 0)
        .map((r) => ({ saleDetailId: r.detail.id, quantity: r.value })),
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
                  <p className="text-[11.5px] text-neutral-500">Vendu : {d.quantity}</p>
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

function SaleDetailView({
  sale,
  products,
  onValidate,
  onDelete,
  onCancel,
  validating,
}: {
  sale: Sale;
  products: ProductRef[];
  onValidate: () => void;
  onDelete: () => void;
  onCancel: () => void;
  validating: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  const [returnSheetOpen, setReturnSheetOpen]   = useState(false);

  const { data: payments, isLoading: paymentsLoading, isError: paymentsError } = useSalePayments(sale.id);
  const createPaymentMutation = useCreateSalePayment(sale.id);
  const createReturnMutation  = useCreateSaleReturn();
  const { data: returnedQuantities } = useReturnedQuantities(sale.id, returnSheetOpen);
  const sendSaleMutation = useSendSale(sale.id);
  // Canal en cours d'envoi — permet de désactiver/faire tourner le bon bouton (email OU sms)
  // sans que les deux ne s'activent simultanément puisque la mutation est partagée entre eux.
  const [sendingChannel, setSendingChannel] = useState<SendChannel | null>(null);
  const downloadPdfMutation = useDownloadSalePdf(sale.id);
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'generating'>('idle');

  // Solde restant — affichage uniquement, le serveur reste l'arbitre du calcul réel (§17 point A).
  const remaining = Math.max(Number(sale.grandTotal) - Number(sale.paidAmount), 0);

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
   * Crée le retour de vente puis navigue vers l'écran des retours en pré-ouvrant son détail
   * (deep-link `?open=<id>` — pass-through TanStack Router, aucun validateSearch requis
   * côté route cible, cf. sale-returns/index.tsx). Toast avant navigation.
   */
  async function handleSaveReturn(data: unknown) {
    try {
      const created = await createReturnMutation.mutateAsync(data);
      setReturnSheetOpen(false);
      toast.success(`Retour créé. Référence : ${created.reference}`);
      void navigate({ to: '/sale-returns', search: { open: created.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la création du retour.');
    }
  }

  /**
   * Déclenche l'envoi asynchrone du récapitulatif de la vente. L'API répond 202 dès la mise
   * en file — le toast de succès reste donc au conditionnel (« Envoi en cours… »), jamais
   * « Envoyé », puisque la livraison réelle n'est pas confirmée à ce stade.
   */
  async function handleSend(channel: SendChannel) {
    setSendingChannel(channel);
    try {
      await sendSaleMutation.mutateAsync({ channel });
      toast.success('Envoi en cours…');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'envoi.");
    } finally {
      setSendingChannel(null);
    }
  }

  /**
   * Déclenche la génération asynchrone du PDF de la vente. La réponse 202 confirme uniquement
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

  // Socket.io — écoute dédiée des événements de génération PDF (S34) pour la vente affichée.
  // Connexion propre au détail (distincte de celle de SalesPage sur stock:updated) afin de
  // comparer chaque événement à sale.id de l'élément actuellement ouvert dans le Sheet.
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('pdf:ready', (payload: { documentType: string; documentId: string; url: string }) => {
      if (payload.documentType === 'sale' && payload.documentId === sale.id) {
        setPdfStatus('idle');
        toast.success('PDF téléchargé.');
        window.open(payload.url, '_blank', 'noopener,noreferrer');
      }
    });
    socket.on('pdf:generateFailed', (payload: { documentType: string; documentId: string }) => {
      if (payload.documentType === 'sale' && payload.documentId === sale.id) {
        setPdfStatus('idle');
        toast.error('Erreur lors de la génération du PDF.');
      }
    });
    return () => { socket.disconnect(); };
  }, [sale.id]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{sale.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statuts</p>
          <div className="flex gap-1.5">
            <StatusBadge status={sale.status} />
            <PaymentBadge status={sale.paymentStatus} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(sale.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Client / Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">{sale.client?.name ?? sale.clientId} — {sale.warehouse?.name ?? sale.warehouseId}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={sale.client?.email ? undefined : 0}>
              <Button
                variant="secondary"
                size="sm"
                disabled={!sale.client?.email}
                loading={sendingChannel === 'email' && sendSaleMutation.isPending}
                onClick={() => void handleSend('email')}
              >
                {sendingChannel === 'email' && sendSaleMutation.isPending
                  ? 'Envoi…'
                  : (<><Mail className="h-3.5 w-3.5" />Envoyer par email</>)}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {sale.client?.email
              ? 'Envoyer le récapitulatif par email'
              : "Ce client n'a pas d'adresse email enregistrée."}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={sale.client?.phone ? undefined : 0}>
              <Button
                variant="secondary"
                size="sm"
                disabled={!sale.client?.phone}
                loading={sendingChannel === 'sms' && sendSaleMutation.isPending}
                onClick={() => void handleSend('sms')}
              >
                {sendingChannel === 'sms' && sendSaleMutation.isPending
                  ? 'Envoi…'
                  : (<><MessageSquare className="h-3.5 w-3.5" />Envoyer par SMS</>)}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {sale.client?.phone
              ? 'Envoyer le récapitulatif par SMS'
              : "Ce client n'a pas de numéro de téléphone enregistré."}
          </TooltipContent>
        </Tooltip>

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

      {sale.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{sale.notes}</div>
      )}

      {sale.status === 'CANCELLED' && sale.cancelReason && (
        <div className="rounded-card border border-neutral-200 bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">
          <p className="mb-0.5 text-[11.5px] font-semibold text-neutral-500">Raison de l&apos;annulation</p>
          {sale.cancelReason}
        </div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({sale.details?.length ?? 0})</p>
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
            {(sale.details ?? []).map((d) => {
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
          <span>TVA ({sale.taxRate ?? '0'} %)</span><span className="tabular">{formatXAF(sale.taxAmount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Remise</span><span className="tabular">− {formatXAF(sale.discount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Frais de port</span><span className="tabular">{formatXAF(sale.shipping ?? '0')}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-neutral-200 pt-2 text-[16px] font-semibold text-neutral-900">
          <span>Total</span><span className="tabular">{formatXAF(sale.grandTotal)}</span>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12.5px] font-semibold text-neutral-700">Paiements ({payments?.length ?? 0})</p>
          {sale.paymentStatus !== 'PAID' && (
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
              onClick={() => void qc.invalidateQueries({ queryKey: ['sale-payments', sale.id] })}
            >
              Réessayer
            </Button>
          </div>
        )}

        {!paymentsLoading && !paymentsError && (payments?.length ?? 0) === 0 && (
          <div className="rounded-card border border-dashed border-neutral-300 bg-white px-3.5 py-5 text-center text-[13px] text-neutral-500">
            Aucun paiement enregistré pour cette vente.
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

      {sale.status === 'PENDING' && (
        <div className="flex gap-2.5 pt-1">
          <Button className="flex-1" onClick={onValidate} loading={validating}>
            {!validating && 'Valider la vente'}
            {validating && 'Validation…'}
          </Button>
          <Button variant="destructive" onClick={onDelete} disabled={validating}>
            <Trash2 className="h-4 w-4" />
            Supprimer
          </Button>
        </div>
      )}

      {sale.status === 'COMPLETED' && (
        <div className="flex gap-2.5 pt-1">
          <Button variant="destructive" className="flex-1" onClick={onCancel}>
            <Ban className="h-4 w-4" />
            Annuler la vente
          </Button>
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
            <SheetDescription>Vente {sale.reference} — le statut est recalculé côté serveur.</SheetDescription>
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
            <SheetDescription>Vente {sale.reference} — le total est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <SaleReturnForm
              sale={sale}
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

// ─── AlertDialog d'annulation ───────────────────────────────────────────────────

/**
 * AlertDialog d'annulation de vente (§18.18) : nomme la vente, exige une raison
 * (min 3 caractères, patron standards.md — irréversible = raison obligatoire).
 */
function CancelSaleDialog({
  target,
  onOpenChange,
  onConfirm,
  loading,
}: {
  target: { id: string; reference: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (id: string, reason: string) => void;
  loading: boolean;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (target === null) setReason('');
  }, [target]);

  const canConfirm = reason.trim().length >= 3;

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Annuler la vente {target?.reference ?? ''} ?</AlertDialogTitle>
          <AlertDialogDescription>
            Cette action est irréversible : le stock décrémenté sera restitué. Un paiement déjà
            encaissé n&apos;est pas remboursé automatiquement.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label>Raison de l&apos;annulation *</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Ex. erreur de saisie, produit défectueux…"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>Retour</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm || loading}
            onClick={() => target && onConfirm(target.id, reason.trim())}
          >
            {loading ? 'Annulation…' : "Confirmer l'annulation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function SalesPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterClient, setFilterClient]     = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus]     = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  // Deep-link `?open=<id>` lu une seule fois au montage (pas de validateSearch TanStack
  // Router — mirror exact du patron sale-returns/index.tsx, S27) : utilisé après conversion
  // d'un devis en vente (quotations/index.tsx, S30) pour pré-ouvrir le détail de la vente créée.
  const [detailId, setDetailId]   = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('open'),
  );
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = useSales(page, limit, filterClient, filterWarehouse, filterStatus, '');
  const { data: detail, isLoading: detailLoading } = useSaleDetail(detailId);
  const { data: clientData }    = useClients();
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const clients    = clientData?.data ?? [];
  const warehouses = warehouseData?.data ?? [];
  const products   = productData?.data ?? [];

  const createMutation   = useCreateSale();
  const deleteMutation   = useDeleteSale();
  const validateMutation = useValidateSale();
  const cancelMutation   = useCancelSale();

  // Socket.io — invalider le cache sur stock:updated (la validation d'une vente décrémente le stock)
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('stock:updated', () => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['sale', detailId] });
    });
    return () => { socket.disconnect(); };
  }, [qc, detailId]);

  async function handleSave(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      setSheetOpen(false);
      toast.success(`Vente créée. Référence : ${created.reference}`);
    } catch {
      toast.error("Erreur lors de l'enregistrement de la vente.");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast.success('Vente supprimée.');
    } catch {
      toast.error('Erreur lors de la suppression.');
    }
  }

  async function handleValidate(id: string) {
    try {
      await validateMutation.mutateAsync(id);
      toast.success('Vente validée. Stock mis à jour.');
    } catch {
      toast.error('Erreur lors de la validation.');
    }
  }

  async function handleCancel(id: string, reason: string) {
    try {
      await cancelMutation.mutateAsync({ id, reason });
      setCancelTarget(null);
      toast.success('Vente annulée. Stock restitué.');
    } catch {
      toast.error("Erreur lors de l'annulation.");
    }
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Ventes"
        description="Factures classiques hors point de vente."
        action={
          <Button onClick={() => setSheetOpen(true)}>
            <Plus className="h-4 w-4" />
            Nouvelle vente
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterClient}
            onChange={(e) => { setFilterClient(e.target.value); setPage(1); }}
          >
            <option value="">Tous les clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
            <option value="COMPLETED">Terminée</option>
            <option value="CANCELLED">Annulée</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={7} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les ventes." onRetry={() => void qc.invalidateQueries({ queryKey: ['sales'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={ReceiptText}
          title="Aucune vente"
          description="Créez votre première vente pour un client."
          action={
            <Button onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4" />
              Nouvelle vente
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
              <TableHead>Client</TableHead>
              <TableHead>Entrepôt</TableHead>
              <TableHead className="text-center">Lignes</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Paiement</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const clientName    = clients.find((c) => c.id === s.clientId)?.name ?? '—';
              const warehouseName = warehouses.find((w) => w.id === s.warehouseId)?.name ?? '—';
              return (
                <TableRow key={s.id} className="cursor-pointer" onClick={() => setDetailId(s.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{s.reference}</TableCell>
                  <TableCell>{formatDate(s.date)}</TableCell>
                  <TableCell>{clientName}</TableCell>
                  <TableCell>{warehouseName}</TableCell>
                  <TableCell className="tabular text-center">{s.details?.length ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(s.grandTotal)}</TableCell>
                  <TableCell><PaymentBadge status={s.paymentStatus} /></TableCell>
                  <TableCell><StatusBadge status={s.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className={cn('flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); setDetailId(s.id); }}
                        aria-label="Voir"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {s.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: s.id, reference: s.reference }); }}
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
            <SheetTitle>Nouvelle vente</SheetTitle>
            <SheetDescription>Client, entrepôt et lignes — le total est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <SaleForm
              clients={clients}
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
            <SheetTitle>{detail ? `Vente ${detail.reference}` : 'Chargement…'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && (
              <SaleDetailView
                sale={detail}
                products={products}
                onValidate={() => void handleValidate(detail.id)}
                onDelete={() => setDeleteTarget({ id: detail.id, reference: detail.reference })}
                onCancel={() => setCancelTarget({ id: detail.id, reference: detail.reference })}
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
            <AlertDialogTitle>Supprimer la vente {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. La vente sera définitivement supprimée.
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

      {/* ── AlertDialog annulation ────────────────────────────────────────── */}
      <CancelSaleDialog
        target={cancelTarget}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        onConfirm={(id, reason) => void handleCancel(id, reason)}
        loading={cancelMutation.isPending}
      />
    </div>
  );
}
