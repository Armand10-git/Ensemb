import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, ArrowRightLeft } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/utils';
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

type TransferStatus = 'DRAFT' | 'VALIDATED';

interface TransferDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantity: string;
}

interface StockTransfer {
  id: string;
  reference: string;
  date: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  userId: string;
  note: string | null;
  status: TransferStatus;
  createdAt: string;
  details?: TransferDetail[];
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface WarehouseRef { id: string; name: string }
interface ProductRef  { id: string; code: string; name: string }

interface DetailFormRow {
  productId: string;
  productVariantId: string;
  quantity: string;
}

const VITE_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const WS_URL = VITE_API_URL.replace('/api/v1', '');

// ─── API Hooks ───────────────────────────────────────────────────────────────

function useTransfers(page: number, limit: number, fromWarehouseId: string, toWarehouseId: string, status: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (fromWarehouseId) params.set('fromWarehouseId', fromWarehouseId);
  if (toWarehouseId)   params.set('toWarehouseId', toWarehouseId);
  if (status)          params.set('status', status);
  return useQuery<Paginated<StockTransfer>>({
    queryKey: ['transfers', page, limit, fromWarehouseId, toWarehouseId, status],
    queryFn: () => api.get<Paginated<StockTransfer>>(`/inventory/transfers?${params}`),
  });
}

function useTransferDetail(id: string | null) {
  return useQuery<StockTransfer>({
    queryKey: ['transfer', id],
    queryFn: () => api.get<StockTransfer>(`/inventory/transfers/${id!}`),
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

function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<StockTransfer>('/inventory/transfers', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['transfers'] }); },
  });
}

function useValidateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<StockTransfer>(`/inventory/transfers/${id}/validate`, {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfer', data.id] });
    },
  });
}

function useDeleteTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/inventory/transfers/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['transfers'] }); },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmptyRow(): DetailFormRow {
  return { productId: '', productVariantId: '', quantity: '' };
}

// ─── Badge statut ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TransferStatus }) {
  const map: Record<TransferStatus, { label: string; variant: 'success' | 'warning' }> = {
    DRAFT:     { label: 'Brouillon', variant: 'warning' },
    VALIDATED: { label: 'Validé',    variant: 'success' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

// ─── Formulaire de création ───────────────────────────────────────────────────

function TransferForm({
  warehouses,
  products,
  onSave,
  onValidate,
  saving,
  validating,
}: {
  warehouses: WarehouseRef[];
  products: ProductRef[];
  onSave: (data: unknown) => void;
  onValidate: (data: unknown) => void;
  saving: boolean;
  validating: boolean;
}) {
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId]     = useState('');
  const [date, setDate]   = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote]   = useState('');
  const [rows, setRows]   = useState<DetailFormRow[]>([makeEmptyRow()]);

  function setRow<K extends keyof DetailFormRow>(idx: number, key: K, value: DetailFormRow[K]) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
  }

  function addRow() { setRows((prev) => [...prev, makeEmptyRow()]); }
  function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

  function buildPayload() {
    return {
      fromWarehouseId,
      toWarehouseId,
      date: new Date(date).toISOString(),
      note: note || undefined,
      details: rows.map((r) => ({
        productId: r.productId,
        productVariantId: r.productVariantId || undefined,
        quantity: r.quantity,
      })),
    };
  }

  const canSubmit = fromWarehouseId && toWarehouseId && fromWarehouseId !== toWarehouseId
    && date && rows.every((r) => r.productId && r.quantity);

  // Entrepôts disponibles pour la destination (exclut la source sélectionnée)
  const destWarehouses = warehouses.filter((w) => w.id !== fromWarehouseId);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Entrepôt source *</Label>
          <NativeSelect
            value={fromWarehouseId}
            onChange={(e) => {
              setFromWarehouseId(e.target.value);
              // Réinitialise la destination si elle devenait identique
              if (e.target.value === toWarehouseId) setToWarehouseId('');
            }}
            data-testid="from-warehouse-select"
          >
            <option value="">— Source —</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
        </div>

        <div className="space-y-1.5">
          <Label>Entrepôt destination *</Label>
          <NativeSelect
            value={toWarehouseId}
            onChange={(e) => setToWarehouseId(e.target.value)}
            data-testid="to-warehouse-select"
          >
            <option value="">— Destination —</option>
            {destWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          {fromWarehouseId && destWarehouses.length === 0 && (
            <p className="text-[12px] text-danger-600">Aucun autre entrepôt disponible.</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Date *</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label>Note</Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Raison du transfert…"
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
                <NativeSelect value={row.productId} onChange={(e) => setRow(idx, 'productId', e.target.value)}>
                  <option value="">— Produit —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                </NativeSelect>
                {rows.length > 1 && (
                  <Button variant="ghost" size="icon" type="button" onClick={() => removeRow(idx)} className="text-danger-600 hover:bg-danger-50">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="space-y-1">
                <Label className="text-[11.5px] text-neutral-500">Quantité *</Label>
                <Input
                  value={row.quantity}
                  onChange={(e) => setRow(idx, 'quantity', e.target.value)}
                  placeholder="ex. 5 ou 2.500"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2.5 pt-1">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() => onSave(buildPayload())}
          disabled={!canSubmit}
          loading={saving}
        >
          {!saving && 'Enregistrer en brouillon'}
          {saving && 'Enregistrement…'}
        </Button>
        <Button
          className="flex-1"
          onClick={() => onValidate(buildPayload())}
          disabled={!canSubmit}
          loading={validating}
        >
          {!validating && 'Valider le transfert'}
          {validating && 'Validation…'}
        </Button>
      </div>
    </div>
  );
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

function TransferDetailView({
  transfer,
  warehouses,
  products,
  onValidate,
  onDelete,
  validating,
  deleting,
}: {
  transfer: StockTransfer;
  warehouses: WarehouseRef[];
  products: ProductRef[];
  onValidate: () => void;
  onDelete: () => void;
  validating: boolean;
  deleting: boolean;
}) {
  const fromName = warehouses.find((w) => w.id === transfer.fromWarehouseId)?.name ?? transfer.fromWarehouseId;
  const toName   = warehouses.find((w) => w.id === transfer.toWarehouseId)?.name ?? transfer.toWarehouseId;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{transfer.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statut</p>
          <StatusBadge status={transfer.status} />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(transfer.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Source → Destination</p>
          <p className="text-[13.5px] text-neutral-800">{fromName} → {toName}</p>
        </div>
      </div>

      {transfer.note && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{transfer.note}</div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({transfer.details?.length ?? 0})</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produit</TableHead>
              <TableHead className="text-right">Quantité</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(transfer.details ?? []).map((d) => {
              const prod = products.find((p) => p.id === d.productId);
              return (
                <TableRow key={d.id}>
                  <TableCell>{prod ? `${prod.code} — ${prod.name}` : d.productId}</TableCell>
                  <TableCell className="tabular text-right">{d.quantity}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {transfer.status === 'DRAFT' && (
        <div className="flex gap-2.5 pt-1">
          <Button className="flex-1" onClick={onValidate} loading={validating} disabled={deleting}>
            {!validating && 'Valider le transfert'}
            {validating && 'Validation…'}
          </Button>
          <Button variant="destructive" onClick={onDelete} disabled={validating} loading={deleting}>
            {!deleting && (
              <>
                <Trash2 className="h-4 w-4" />
                Supprimer
              </>
            )}
            {deleting && 'Suppression…'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function TransfersPage() {
  const qc = useQueryClient();

  const [page, setPage]   = useState(1);
  const limit              = 20;
  const [filterFrom, setFilterFrom]     = useState('');
  const [filterTo, setFilterTo]         = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [sheetOpen, setSheetOpen]       = useState(false);
  const [detailId, setDetailId]         = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = useTransfers(page, limit, filterFrom, filterTo, filterStatus);
  const { data: detail, isLoading: detailLoading } = useTransferDetail(detailId);
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const warehouses = warehouseData?.data ?? [];
  const products   = productData?.data ?? [];

  const createMutation   = useCreateTransfer();
  const validateMutation = useValidateTransfer();
  const deleteMutation   = useDeleteTransfer();

  // Socket.io — invalider le cache sur stock:updated
  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const socket: Socket = io(WS_URL + '/realtime', {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('stock:updated', () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfer', detailId] });
    });
    return () => { socket.disconnect(); };
  }, [qc, detailId]);

  async function handleSaveDraft(payload: unknown) {
    try {
      await createMutation.mutateAsync(payload);
      setSheetOpen(false);
      toast.success('Transfert enregistré en brouillon.');
    } catch {
      toast.error("Erreur lors de l'enregistrement.");
    }
  }

  async function handleValidateNew(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      await validateMutation.mutateAsync(created.id);
      setSheetOpen(false);
      toast.success('Transfert validé. Stock mis à jour dans les deux entrepôts.');
    } catch {
      toast.error('Erreur lors de la validation.');
    }
  }

  async function handleValidateExisting(id: string) {
    try {
      await validateMutation.mutateAsync(id);
      toast.success('Transfert validé. Stock mis à jour dans les deux entrepôts.');
    } catch {
      toast.error('Erreur lors de la validation.');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast.success('Transfert supprimé.');
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
        title="Transferts de stock"
        description="Déplacements de stock entre entrepôts."
        action={
          <Button onClick={() => setSheetOpen(true)}>
            <Plus className="h-4 w-4" />
            Nouveau transfert
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setPage(1); }}
          >
            <option value="">Tous (source)</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); setPage(1); }}
          >
            <option value="">Tous (destination)</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[9rem]"
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          >
            <option value="">Tous les statuts</option>
            <option value="DRAFT">Brouillon</option>
            <option value="VALIDATED">Validé</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={7} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les transferts." onRetry={() => void qc.invalidateQueries({ queryKey: ['transfers'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={ArrowRightLeft}
          title="Aucun transfert"
          description="Créez votre premier transfert de stock entre entrepôts."
          action={
            <Button onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4" />
              Nouveau transfert
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
              <TableHead>Source</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-center">Lignes</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => {
              const fromName = warehouses.find((w) => w.id === t.fromWarehouseId)?.name ?? '—';
              const toName   = warehouses.find((w) => w.id === t.toWarehouseId)?.name ?? '—';
              return (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => setDetailId(t.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{t.reference}</TableCell>
                  <TableCell>{formatDate(t.date)}</TableCell>
                  <TableCell>{fromName}</TableCell>
                  <TableCell>{toName}</TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell className="tabular text-center">{t.details?.length ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => { e.stopPropagation(); setDetailId(t.id); }}
                      aria-label="Détail"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
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
            <SheetTitle>Nouveau transfert</SheetTitle>
            <SheetDescription>Entrepôt source, destination et lignes de produits à déplacer.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <TransferForm
              warehouses={warehouses}
              products={products}
              onSave={(payload) => void handleSaveDraft(payload)}
              onValidate={(payload) => void handleValidateNew(payload)}
              saving={createMutation.isPending && !validateMutation.isPending}
              validating={validateMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{detail ? `Transfert ${detail.reference}` : 'Chargement…'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && (
              <TransferDetailView
                transfer={detail}
                warehouses={warehouses}
                products={products}
                onValidate={() => void handleValidateExisting(detail.id)}
                onDelete={() => setDeleteTarget({ id: detail.id, reference: detail.reference })}
                validating={validateMutation.isPending}
                deleting={deleteMutation.isPending}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le transfert {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Le transfert sera définitivement supprimé.
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
