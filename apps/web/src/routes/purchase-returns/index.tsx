import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { Trash2, Eye, ChevronLeft, ChevronRight, Undo2, Plus, CheckCircle2, Download } from 'lucide-react';
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

// PurchaseReturn.status ne connaît métier que PENDING/COMPLETED (cf. JSDoc PurchaseReturnService —
// contrairement à Purchase, un retour ne s'annule pas, il n'existe pas d'endpoint /cancel).
type ReturnStatus = 'PENDING' | 'COMPLETED';
type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

interface PurchaseReturnDetail {
  id: string;
  purchaseDetailId: string;
  productId: string;
  productVariantId: string | null;
  returnUnitId: string | null;
  price: string;
  taxAmount: string | null;
  taxMethod: string | null;
  discount: string | null;
  discountMethod: string | null;
  quantity: string;
  total: string;
}

interface PurchaseReturn {
  id: string;
  reference: string;
  date: string;
  userId: string;
  purchaseId: string;
  warehouseId: string;
  taxRate: string | null;
  taxAmount: string | null;
  discount: string | null;
  shipping: string | null;
  grandTotal: string;
  paidAmount: string;
  paymentStatus: PaymentStatus;
  status: ReturnStatus;
  notes: string | null;
  createdAt: string;
  // Uniquement présents sur GET /purchase-returns/:id (PURCHASE_RETURN_SELECT de la liste paginée
  // n'inclut pas ces relations, cf. purchase-return.service.ts) — toujours défensif en `?.`.
  purchase?: { id: string; reference: string };
  warehouse?: { id: string; name: string };
  details?: PurchaseReturnDetail[];
}

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';

interface PaymentReturnResponse {
  id: string;
  organizationId: string;
  saleReturnId: string | null;
  purchaseReturnId: string | null;
  userId: string;
  date: string;
  reference: string;
  amount: string;
  method: PaymentMethod;
  change: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface WarehouseRef { id: string; name: string }
interface ProductRef { id: string; code: string; name: string; price: string }

const VITE_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const WS_URL = VITE_API_URL.replace('/api/v1', '');

// ─── API Hooks ───────────────────────────────────────────────────────────────

function usePurchaseReturns(page: number, limit: number, warehouseId: string, status: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (status)       params.set('status', status);
  return useQuery<Paginated<PurchaseReturn>>({
    queryKey: ['purchase-returns', page, limit, warehouseId, status],
    queryFn: () => api.get<Paginated<PurchaseReturn>>(`/purchase-returns?${params}`),
  });
}

function usePurchaseReturnDetail(id: string | null) {
  return useQuery<PurchaseReturn>({
    queryKey: ['purchase-return', id],
    queryFn: () => api.get<PurchaseReturn>(`/purchase-returns/${id!}`),
    enabled: id !== null,
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

/**
 * Valide un retour d'achat (PENDING → COMPLETED) : le stock est décrémenté côté serveur
 * (restitution au fournisseur). Invalide la liste des retours et le détail du retour concerné
 * (badge de statut).
 */
function useValidatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<PurchaseReturn>(`/purchase-returns/${id}/validate`, {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      void qc.invalidateQueries({ queryKey: ['purchase-return', data.id] });
    },
  });
}

/** Supprime (soft delete) un retour d'achat PENDING — un retour COMPLETED ne peut être supprimé. */
function useDeletePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/purchase-returns/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['purchase-returns'] }); },
  });
}

/** Historique des remboursements d'un retour d'achat, triés chronologiquement par le serveur. */
function usePurchaseReturnPayments(purchaseReturnId: string) {
  return useQuery<PaymentReturnResponse[]>({
    queryKey: ['purchase-return-payments', purchaseReturnId],
    queryFn: () => api.get<PaymentReturnResponse[]>(`/purchase-returns/${purchaseReturnId}/payments`),
    enabled: purchaseReturnId !== '',
  });
}

/**
 * Enregistre un remboursement sur un retour d'achat. Invalide l'historique des remboursements,
 * le détail du retour (paidAmount/paymentStatus recalculés côté serveur) et la liste des retours
 * (badge de paiement affiché en colonne).
 */
function useCreatePurchaseReturnPayment(purchaseReturnId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<PaymentReturnResponse>(`/purchase-returns/${purchaseReturnId}/payments`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchase-return-payments', purchaseReturnId] });
      void qc.invalidateQueries({ queryKey: ['purchase-return', purchaseReturnId] });
      void qc.invalidateQueries({ queryKey: ['purchase-returns'] });
    },
  });
}

interface DownloadPdfResponse { status: 'queued' }

/**
 * Déclenche la génération asynchrone du PDF du retour d'achat (S34 — job BullMQ + Puppeteer
 * côté serveur). La réponse 202 confirme uniquement la mise en file d'attente, jamais la
 * disponibilité du fichier : celle-ci n'est connue qu'à la réception de l'événement Socket.io
 * `pdf:ready` (écouté dans PurchaseReturnDetailView, filtré sur documentType/documentId).
 * N'invalide aucune query : la génération ne modifie aucune donnée du retour. `api.post` exige
 * un corps de requête typé — `{}` mirror le patron déjà utilisé pour les mutations sans
 * payload (cf. useValidatePurchaseReturn).
 */
function useDownloadPurchaseReturnPdf(purchaseReturnId: string) {
  return useMutation({
    mutationFn: () => api.post<DownloadPdfResponse>(`/purchase-returns/${purchaseReturnId}/pdf`, {}),
  });
}

// ─── Badges de statut ──────────────────────────────────────────────────────────

function PaymentBadge({ status }: { status: PaymentStatus }) {
  // Vocabulaire retour : « remboursé », jamais « payé » (ce badge reflète PaymentReturn, pas
  // un encaissement) — cohérent avec la colonne « Remboursement » et le Sheet « Ajouter un
  // remboursement » de cet écran.
  const map: Record<PaymentStatus, { label: string; variant: 'danger' | 'warning' | 'success' }> = {
    UNPAID:  { label: 'Non remboursé', variant: 'danger' },
    PARTIAL: { label: 'Partiel',       variant: 'warning' },
    PAID:    { label: 'Remboursé',     variant: 'success' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function StatusBadge({ status }: { status: ReturnStatus }) {
  const map: Record<ReturnStatus, { label: string; variant: 'warning' | 'success' }> = {
    PENDING:   { label: 'En attente', variant: 'warning' },
    COMPLETED: { label: 'Terminé',    variant: 'success' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Libellés français des méthodes de paiement (PaymentReturn.method). */
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  CARD: 'Carte',
  MOBILE_MONEY: 'Mobile Money',
  BANK_TRANSFER: 'Virement bancaire',
};

// ─── Formulaire d'ajout de remboursement ───────────────────────────────────────

/**
 * Formulaire de remboursement — mirror exact de RefundForm (sale-returns/index.tsx) /
 * PaymentForm (purchases/index.tsx), vocabulaire adapté au remboursement. Solde restant
 * affiché en évidence, raccourci « Solder » pré-remplissant le montant exact. Le montant est
 * borné au solde restant au blur (jamais rejeté au submit). Le serveur reste l'arbitre final
 * du calcul : ce composant n'affiche le solde qu'à titre indicatif.
 */
function RefundForm({
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

// ─── Vue détail ───────────────────────────────────────────────────────────────

function PurchaseReturnDetailView({
  purchaseReturn,
  products,
  onValidate,
  onDelete,
  validating,
}: {
  purchaseReturn: PurchaseReturn;
  products: ProductRef[];
  onValidate: () => void;
  onDelete: () => void;
  validating: boolean;
}) {
  const qc = useQueryClient();
  const [refundSheetOpen, setRefundSheetOpen] = useState(false);

  const { data: payments, isLoading: paymentsLoading, isError: paymentsError } = usePurchaseReturnPayments(purchaseReturn.id);
  const createRefundMutation = useCreatePurchaseReturnPayment(purchaseReturn.id);
  const downloadPdfMutation = useDownloadPurchaseReturnPdf(purchaseReturn.id);
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'generating'>('idle');

  // Solde restant — affichage uniquement, le serveur reste l'arbitre du calcul réel (§17 point A).
  const remaining = Math.max(Number(purchaseReturn.grandTotal) - Number(purchaseReturn.paidAmount), 0);

  async function handleSaveRefund(data: { date: string; amount: string; method: PaymentMethod; notes?: string }) {
    try {
      await createRefundMutation.mutateAsync(data);
      setRefundSheetOpen(false);
      toast.success('Remboursement enregistré.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'enregistrement du remboursement.");
    }
  }

  /**
   * Déclenche la génération asynchrone du PDF du retour d'achat. La réponse 202 confirme
   * uniquement la mise en file : le bouton reste en état « Génération… » jusqu'à l'événement
   * Socket.io `pdf:ready` (ou `pdf:generateFailed`) — jamais de « Téléchargé » avant cette
   * confirmation (vocabulaire continu, docs/ux/standards.md). Seul un échec de la requête POST
   * elle-même (pas du job) ramène l'état à idle ici ; l'échec du job est géré par l'écoute socket.
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

  // Socket.io — écoute dédiée des événements de génération PDF (S34) pour le retour affiché.
  // Connexion propre au détail (distincte de celle de PurchaseReturnsPage sur stock:updated)
  // afin de comparer chaque événement à purchaseReturn.id de l'élément actuellement ouvert
  // dans le Sheet.
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('pdf:ready', (payload: { documentType: string; documentId: string; url: string }) => {
      if (payload.documentType === 'purchaseReturn' && payload.documentId === purchaseReturn.id) {
        setPdfStatus('idle');
        toast.success('PDF téléchargé.');
        window.open(payload.url, '_blank', 'noopener,noreferrer');
      }
    });
    socket.on('pdf:generateFailed', (payload: { documentType: string; documentId: string }) => {
      if (payload.documentType === 'purchaseReturn' && payload.documentId === purchaseReturn.id) {
        setPdfStatus('idle');
        toast.error('Erreur lors de la génération du PDF.');
      }
    });
    return () => { socket.disconnect(); };
  }, [purchaseReturn.id]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{purchaseReturn.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statuts</p>
          <div className="flex gap-1.5">
            <StatusBadge status={purchaseReturn.status} />
            <PaymentBadge status={purchaseReturn.paymentStatus} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(purchaseReturn.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Achat d&apos;origine / Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">
            {purchaseReturn.purchase?.reference ?? purchaseReturn.purchaseId} — {purchaseReturn.warehouse?.name ?? purchaseReturn.warehouseId}
          </p>
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

      {purchaseReturn.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{purchaseReturn.notes}</div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({purchaseReturn.details?.length ?? 0})</p>
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
            {(purchaseReturn.details ?? []).map((d) => {
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

      {/* Un retour n'a ni TVA globale, ni remise, ni frais de port indépendants (toujours 0 côté
          serveur, cf. JSDoc PurchaseReturnService.create) — seul le total est affiché. */}
      <div className="flex justify-between rounded-card bg-neutral-50 px-4 py-3 text-[16px] font-semibold text-neutral-900">
        <span>Total</span><span className="tabular">{formatXAF(purchaseReturn.grandTotal)}</span>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12.5px] font-semibold text-neutral-700">Remboursements ({payments?.length ?? 0})</p>
          {purchaseReturn.paymentStatus !== 'PAID' && purchaseReturn.status === 'COMPLETED' && (
            <Button variant="secondary" size="sm" onClick={() => setRefundSheetOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Ajouter un remboursement
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
            <span>Impossible de charger l&apos;historique des remboursements.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void qc.invalidateQueries({ queryKey: ['purchase-return-payments', purchaseReturn.id] })}
            >
              Réessayer
            </Button>
          </div>
        )}

        {!paymentsLoading && !paymentsError && (payments?.length ?? 0) === 0 && (
          <div className="rounded-card border border-dashed border-neutral-300 bg-white px-3.5 py-5 text-center text-[13px] text-neutral-500">
            Aucun remboursement enregistré pour ce retour.
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

      {purchaseReturn.status === 'PENDING' && (
        <div className="flex gap-2.5 pt-1">
          <Button className="flex-1" onClick={onValidate} loading={validating}>
            {!validating && <><CheckCircle2 className="h-4 w-4" />Valider le retour</>}
            {validating && 'Validation…'}
          </Button>
          <Button variant="destructive" onClick={onDelete} disabled={validating}>
            <Trash2 className="h-4 w-4" />
            Supprimer
          </Button>
        </div>
      )}

      {/* ── Sheet ajout de remboursement ────────────────────────────────── */}
      <Sheet open={refundSheetOpen} onOpenChange={setRefundSheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Ajouter un remboursement</SheetTitle>
            <SheetDescription>Retour {purchaseReturn.reference} — le statut est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <RefundForm
              remaining={remaining}
              onSave={(payload) => void handleSaveRefund(payload)}
              saving={createRefundMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

/**
 * Écran des retours d'achat (S27) : liste paginée + détail (Sheet) avec validation, suppression
 * et remboursements. Un retour est TOUJOURS créé depuis PurchaseDetailView (purchases/index.tsx) —
 * cet écran n'expose aucune création, uniquement la gestion du cycle de vie post-création.
 * Deep-link `?open=<id>` lu une seule fois au montage (pas de validateSearch TanStack Router —
 * aucune route du projet ne l'utilise, cf. purchases/index.tsx).
 */
export default function PurchaseReturnsPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus]       = useState('');

  const [detailId, setDetailId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('open'),
  );
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = usePurchaseReturns(page, limit, filterWarehouse, filterStatus);
  const { data: detail, isLoading: detailLoading } = usePurchaseReturnDetail(detailId);
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const warehouses = warehouseData?.data ?? [];
  const products    = productData?.data ?? [];

  const deleteMutation   = useDeletePurchaseReturn();
  const validateMutation = useValidatePurchaseReturn();

  // Socket.io — invalider le cache sur stock:updated (la validation d'un retour décrémente le stock)
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('stock:updated', () => {
      void qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      void qc.invalidateQueries({ queryKey: ['purchase-return', detailId] });
    });
    return () => { socket.disconnect(); };
  }, [qc, detailId]);

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast.success('Retour supprimé.');
    } catch {
      toast.error('Erreur lors de la suppression.');
    }
  }

  async function handleValidate(id: string) {
    try {
      await validateMutation.mutateAsync(id);
      toast.success('Retour validé. Stock mis à jour.');
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
        title="Retours d'achat"
        description="Remboursements et restitutions de stock consécutifs à un achat déjà finalisé."
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
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
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={7} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les retours d'achat." onRetry={() => void qc.invalidateQueries({ queryKey: ['purchase-returns'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Undo2}
          title="Aucun retour d'achat"
          description="Les retours se créent depuis le détail d'un achat terminé."
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Référence</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Achat d&apos;origine</TableHead>
              <TableHead>Entrepôt</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Remboursement</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const warehouseName = warehouses.find((w) => w.id === r.warehouseId)?.name ?? '—';
              return (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{r.reference}</TableCell>
                  <TableCell>{formatDate(r.date)}</TableCell>
                  <TableCell className="tabular text-neutral-600">{r.purchase?.reference ?? r.purchaseId}</TableCell>
                  <TableCell>{warehouseName}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(r.grandTotal)}</TableCell>
                  <TableCell><PaymentBadge status={r.paymentStatus} /></TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className={cn('flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }}
                        aria-label="Voir"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {r.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: r.id, reference: r.reference }); }}
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

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{detail ? `Retour ${detail.reference}` : 'Chargement…'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && (
              <PurchaseReturnDetailView
                purchaseReturn={detail}
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
            <AlertDialogTitle>Supprimer le retour {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Le retour sera définitivement supprimé.
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
