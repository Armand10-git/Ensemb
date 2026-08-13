import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, FileText, Mail, MessageSquare, ArrowRightLeft } from 'lucide-react';
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

/**
 * Statut d'un devis — sous-ensemble de `DocumentStatus` (API) réellement atteignable
 * par un devis : `AWAITING_PAYMENT` n'existe pas ici, un devis n'étant jamais payé
 * (S28, cf. quotation.service.ts — « AUCUN paymentStatus/paidAmount »).
 */
type QuotationStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';

interface QuotationDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  quoteUnitId: string | null;
  price: string;
  taxAmount: string | null;
  taxMethod: string | null;
  discount: string | null;
  discountMethod: string | null;
  quantity: string;
  total: string;
}

interface Quotation {
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
  status: QuotationStatus;
  notes: string | null;
  createdAt: string;
  client?: { id: string; name: string; email: string | null; phone: string | null };
  warehouse?: { id: string; name: string };
  details?: QuotationDetail[];
}

/** Vente créée par la conversion d'un devis (POST /quotations/:id/convert) — seuls id et
 * reference sont utiles ici (toast + deep-link vers /sales), le reste des champs du
 * SaleResponse retourné par l'API n'est pas exploité par cet écran. */
interface ConvertedSale {
  id: string;
  reference: string;
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface ClientRef { id: string; name: string }
interface WarehouseRef { id: string; name: string }
interface ProductRef { id: string; code: string; name: string; price: string }

/** Ligne du formulaire de création — mirror exact de DetailFormRow (sales/index.tsx) :
 * pas de champ d'unité, le formulaire de vente n'en expose déjà pas dans l'UI. */
interface DetailFormRow {
  productId: string;
  quantity: string;
  price: string;
  discount: string;
  taxAmount: string;
}

// ─── API Hooks ───────────────────────────────────────────────────────────────
// (pas de socket.io ici : contrairement à une vente, aucune action sur un devis — création,
// modification, conversion, suppression — ne mouvemente le stock, cf. quotation.service.ts
// « AUCUN mouvement de stock, jamais ». Rien à écouter en temps réel sur cet écran.)

/** Liste paginée des devis, filtrable par client/entrepôt/statut. */
function useQuotations(
  page: number,
  limit: number,
  clientId: string,
  warehouseId: string,
  status: string,
) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (clientId)    params.set('clientId', clientId);
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (status)      params.set('status', status);
  return useQuery<Paginated<Quotation>>({
    queryKey: ['quotations', page, limit, clientId, warehouseId, status],
    queryFn: () => api.get<Paginated<Quotation>>(`/quotations?${params}`),
  });
}

function useQuotationDetail(id: string | null) {
  return useQuery<Quotation>({
    queryKey: ['quotation', id],
    queryFn: () => api.get<Quotation>(`/quotations/${id!}`),
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

function useCreateQuotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Quotation>('/quotations', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['quotations'] }); },
  });
}

function useDeleteQuotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/quotations/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['quotations'] }); },
  });
}

/**
 * Convertit un devis PENDING en vente (POST /quotations/:id/convert, S28) : le devis
 * passe à COMPLETED et une nouvelle Sale est créée côté serveur. Invalide la liste des
 * devis, le détail du devis converti (badge de statut) et la liste des ventes (la vente
 * créée doit apparaître immédiatement si l'utilisateur navigue vers /sales).
 */
function useConvertQuotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ConvertedSale>(`/quotations/${id}/convert`, {}),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['quotations'] });
      void qc.invalidateQueries({ queryKey: ['quotation', id] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });
}

type SendChannel = 'email' | 'sms';

interface SendQuotationResponse { status: 'queued' }

/**
 * Envoie le récapitulatif du devis au client par email ou SMS — mirror exact de
 * useSendSale (sales/index.tsx, §S24). Traitement asynchrone côté serveur (job en file) :
 * la réponse 202 confirme uniquement la mise en file, jamais la livraison — l'appelant ne
 * doit donc jamais afficher « Envoyé », seulement « Envoi en cours… ». N'invalide aucune
 * query : l'envoi ne modifie ni le statut ni les données affichées du devis.
 */
function useSendQuotation(quotationId: string) {
  return useMutation({
    mutationFn: (data: { channel: SendChannel }) =>
      api.post<SendQuotationResponse>(`/quotations/${quotationId}/send`, data),
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

// ─── Badge de statut ────────────────────────────────────────────────────────────

/**
 * Badge de statut d'un devis — libellés dédiés, distincts de StatusBadge (sales/index.tsx) :
 * un devis n'est jamais « en attente de paiement » ni « terminé » au sens d'une vente,
 * il est « brouillon » jusqu'à sa conversion, puis « converti ».
 */
function QuotationStatusBadge({ status }: { status: QuotationStatus }) {
  const map: Record<QuotationStatus, { label: string; variant: 'warning' | 'success' | 'neutral' }> = {
    PENDING:   { label: 'Brouillon', variant: 'warning' },
    COMPLETED: { label: 'Converti',  variant: 'success' },
    CANCELLED: { label: 'Annulé',    variant: 'neutral' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

// ─── Formulaire de création ───────────────────────────────────────────────────

/** Mirror exact de SaleForm (sales/index.tsx) — même structure de lignes/totaux, seul le
 * libellé du CTA final change (« Créer le devis » plutôt que « Enregistrer »). */
function QuotationForm({
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
        {!saving && 'Créer le devis'}
        {saving && 'Création…'}
      </Button>
    </div>
  );
}

// ─── AlertDialog de conversion ─────────────────────────────────────────────────

/**
 * AlertDialog de conversion d'un devis en vente — nomme le devis, aucune raison requise
 * (contrairement à l'annulation de vente, S21b) : la conversion n'est pas destructive pour
 * le devis (il passe simplement à COMPLETED), elle produit un nouveau document (la vente).
 */
function ConvertQuotationDialog({
  target,
  onOpenChange,
  onConfirm,
  loading,
}: {
  target: { id: string; reference: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (id: string) => void;
  loading: boolean;
}) {
  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Convertir le devis {target?.reference ?? ''} en vente ?</AlertDialogTitle>
          <AlertDialogDescription>
            Cette action est irréversible pour le devis (il passera au statut « Converti » et ne
            pourra plus être modifié), mais elle n&apos;est pas destructive : elle crée une nouvelle
            vente reprenant les mêmes lignes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>Retour</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={() => target && onConfirm(target.id)}
          >
            {loading ? 'Conversion…' : 'Confirmer la conversion'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

/**
 * Vue détail d'un devis — mirror simplifié de SaleDetailView (sales/index.tsx) : aucune
 * section paiements (un devis n'est jamais payé), aucune annulation ni retour (concepts
 * inexistants pour un devis). Les actions propres au devis (conversion, envoi) sont
 * gérées localement ici, à l'image de la création de retour dans SaleDetailView.
 */
function QuotationDetailView({
  quotation,
  products,
  onDelete,
}: {
  quotation: Quotation;
  products: ProductRef[];
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const sendQuotationMutation = useSendQuotation(quotation.id);
  const convertMutation = useConvertQuotation();
  // Canal en cours d'envoi — permet de désactiver/faire tourner le bon bouton (email OU sms)
  // sans que les deux ne s'activent simultanément puisque la mutation est partagée entre eux.
  const [sendingChannel, setSendingChannel] = useState<SendChannel | null>(null);
  const [convertTarget, setConvertTarget] = useState<{ id: string; reference: string } | null>(null);

  /**
   * Déclenche l'envoi asynchrone du récapitulatif du devis. L'API répond 202 dès la mise
   * en file — le toast de succès reste donc au conditionnel (« Envoi en cours… »), jamais
   * « Envoyé », puisque la livraison réelle n'est pas confirmée à ce stade.
   */
  async function handleSend(channel: SendChannel) {
    setSendingChannel(channel);
    try {
      await sendQuotationMutation.mutateAsync({ channel });
      toast.success('Envoi en cours…');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'envoi.");
    } finally {
      setSendingChannel(null);
    }
  }

  /**
   * Convertit le devis en vente puis navigue vers l'écran des ventes en pré-ouvrant son
   * détail (deep-link `?open=<id>` — pass-through TanStack Router, aucun validateSearch
   * requis côté route cible, cf. sale-returns/index.tsx). Toast avant navigation.
   */
  async function handleConvert(id: string) {
    try {
      const sale = await convertMutation.mutateAsync(id);
      setConvertTarget(null);
      toast.success(`Devis converti. Vente créée : ${sale.reference}`);
      void navigate({ to: '/sales', search: { open: sale.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la conversion.');
    }
  }

  // Raison de désactivation des boutons d'envoi — statut non-brouillon ou contact absent
  // (§ instructions S28 : désactivés aussi si quotation.status !== 'PENDING').
  const emailDisabledReason = quotation.status !== 'PENDING'
    ? 'Seul un devis en attente (Brouillon) peut être envoyé.'
    : !quotation.client?.email
      ? "Ce client n'a pas d'adresse email enregistrée."
      : null;
  const smsDisabledReason = quotation.status !== 'PENDING'
    ? 'Seul un devis en attente (Brouillon) peut être envoyé.'
    : !quotation.client?.phone
      ? "Ce client n'a pas de numéro de téléphone enregistré."
      : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{quotation.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statut</p>
          <QuotationStatusBadge status={quotation.status} />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(quotation.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Client / Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">{quotation.client?.name ?? quotation.clientId} — {quotation.warehouse?.name ?? quotation.warehouseId}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={emailDisabledReason ? 0 : undefined}>
              <Button
                variant="secondary"
                size="sm"
                disabled={emailDisabledReason !== null}
                loading={sendingChannel === 'email' && sendQuotationMutation.isPending}
                onClick={() => void handleSend('email')}
              >
                {sendingChannel === 'email' && sendQuotationMutation.isPending
                  ? 'Envoi…'
                  : (<><Mail className="h-3.5 w-3.5" />Envoyer par email</>)}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {emailDisabledReason ?? 'Envoyer le récapitulatif par email'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={smsDisabledReason ? 0 : undefined}>
              <Button
                variant="secondary"
                size="sm"
                disabled={smsDisabledReason !== null}
                loading={sendingChannel === 'sms' && sendQuotationMutation.isPending}
                onClick={() => void handleSend('sms')}
              >
                {sendingChannel === 'sms' && sendQuotationMutation.isPending
                  ? 'Envoi…'
                  : (<><MessageSquare className="h-3.5 w-3.5" />Envoyer par SMS</>)}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {smsDisabledReason ?? 'Envoyer le récapitulatif par SMS'}
          </TooltipContent>
        </Tooltip>
      </div>

      {quotation.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{quotation.notes}</div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({quotation.details?.length ?? 0})</p>
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
            {(quotation.details ?? []).map((d) => {
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
          <span>TVA ({quotation.taxRate ?? '0'} %)</span><span className="tabular">{formatXAF(quotation.taxAmount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Remise</span><span className="tabular">− {formatXAF(quotation.discount ?? '0')}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Frais de port</span><span className="tabular">{formatXAF(quotation.shipping ?? '0')}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-neutral-200 pt-2 text-[16px] font-semibold text-neutral-900">
          <span>Total</span><span className="tabular">{formatXAF(quotation.grandTotal)}</span>
        </div>
      </div>

      <div className="flex gap-2.5 pt-1">
        <Button
          className="flex-1"
          disabled={quotation.status !== 'PENDING'}
          onClick={() => setConvertTarget({ id: quotation.id, reference: quotation.reference })}
        >
          <ArrowRightLeft className="h-4 w-4" />
          Convertir en vente
        </Button>
        {quotation.status === 'PENDING' && (
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
            Supprimer
          </Button>
        )}
      </div>

      {/* ── AlertDialog conversion en vente ─────────────────────────────── */}
      <ConvertQuotationDialog
        target={convertTarget}
        onOpenChange={(open) => !open && setConvertTarget(null)}
        onConfirm={(id) => void handleConvert(id)}
        loading={convertMutation.isPending}
      />
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

/**
 * Écran des devis (S28, §18.4) — mirror de SalesPage (sales/index.tsx) sans section
 * paiements ni annulation/retour : liste paginée + création + détail (Sheet) avec envoi
 * email/SMS et conversion en vente.
 */
export default function QuotationsPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterClient, setFilterClient]       = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus]       = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailId, setDetailId]   = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = useQuotations(page, limit, filterClient, filterWarehouse, filterStatus);
  const { data: detail, isLoading: detailLoading } = useQuotationDetail(detailId);
  const { data: clientData }    = useClients();
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const clients    = clientData?.data ?? [];
  const warehouses = warehouseData?.data ?? [];
  const products   = productData?.data ?? [];

  const createMutation = useCreateQuotation();
  const deleteMutation = useDeleteQuotation();

  async function handleSave(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      setSheetOpen(false);
      toast.success(`Devis créé. Référence : ${created.reference}`);
    } catch {
      toast.error("Erreur lors de l'enregistrement du devis.");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast.success('Devis supprimé.');
    } catch {
      toast.error('Erreur lors de la suppression.');
    }
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Devis"
        description="Propositions commerciales convertibles en vente."
        action={
          <Button onClick={() => setSheetOpen(true)}>
            <Plus className="h-4 w-4" />
            Nouveau devis
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
            <option value="PENDING">Brouillon</option>
            <option value="COMPLETED">Converti</option>
            <option value="CANCELLED">Annulé</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={6} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les devis." onRetry={() => void qc.invalidateQueries({ queryKey: ['quotations'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={FileText}
          title="Aucun devis"
          description="Créez votre premier devis pour un client."
          action={
            <Button onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4" />
              Nouveau devis
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
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((q) => {
              const clientName    = clients.find((c) => c.id === q.clientId)?.name ?? '—';
              const warehouseName = warehouses.find((w) => w.id === q.warehouseId)?.name ?? '—';
              return (
                <TableRow key={q.id} className="cursor-pointer" onClick={() => setDetailId(q.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{q.reference}</TableCell>
                  <TableCell>{formatDate(q.date)}</TableCell>
                  <TableCell>{clientName}</TableCell>
                  <TableCell>{warehouseName}</TableCell>
                  <TableCell className="tabular text-center">{q.details?.length ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(q.grandTotal)}</TableCell>
                  <TableCell><QuotationStatusBadge status={q.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className={cn('flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); setDetailId(q.id); }}
                        aria-label="Voir"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {q.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger-600 hover:bg-danger-50"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: q.id, reference: q.reference }); }}
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
            <SheetTitle>Nouveau devis</SheetTitle>
            <SheetDescription>Client, entrepôt et lignes — le total est recalculé côté serveur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <QuotationForm
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
            <SheetTitle>{detail ? `Devis ${detail.reference}` : 'Chargement…'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && (
              <QuotationDetailView
                quotation={detail}
                products={products}
                onDelete={() => setDeleteTarget({ id: detail.id, reference: detail.reference })}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le devis {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Le devis sera définitivement supprimé.
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
