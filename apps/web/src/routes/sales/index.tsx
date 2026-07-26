import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, ReceiptText } from 'lucide-react';
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
  createdAt: string;
  client?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: SaleDetail[];
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

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
      <div className="grid grid-cols-2 gap-3">
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

              <div className="grid grid-cols-4 gap-2">
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

      <div className="grid grid-cols-3 gap-3">
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

// ─── Vue détail ───────────────────────────────────────────────────────────────

function SaleDetailView({
  sale,
  products,
  onDelete,
}: {
  sale: Sale;
  products: ProductRef[];
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
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

      {sale.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{sale.notes}</div>
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

      {sale.status === 'PENDING' && (
        <Button variant="destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
          Supprimer
        </Button>
      )}
    </div>
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
  const [detailId, setDetailId]   = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = useSales(page, limit, filterClient, filterWarehouse, filterStatus, '');
  const { data: detail, isLoading: detailLoading } = useSaleDetail(detailId);
  const { data: clientData }    = useClients();
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const clients    = clientData?.data ?? [];
  const warehouses = warehouseData?.data ?? [];
  const products   = productData?.data ?? [];

  const createMutation = useCreateSale();
  const deleteMutation  = useDeleteSale();

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

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="mx-auto max-w-6xl p-8">
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
        <div className="mb-4 flex gap-2.5">
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
    </div>
  );
}
