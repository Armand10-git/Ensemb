import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { Plus, Trash2, Eye, ChevronLeft, ChevronRight, PackageSearch, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
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

type AdjustmentStatus = 'DRAFT' | 'VALIDATED';
type DetailType = 'ADDITION' | 'SOUSTRACTION';

interface AdjustmentDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  type: DetailType;
  quantity: string;
  unitCost: string;
}

interface Adjustment {
  id: string;
  reference: string;
  date: string;
  warehouseId: string;
  userId: string;
  note: string | null;
  status: AdjustmentStatus;
  createdAt: string;
  details?: AdjustmentDetail[];
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface WarehouseRef { id: string; name: string }
interface ProductRef  { id: string; code: string; name: string }

interface DetailFormRow {
  productId: string;
  productVariantId: string;
  type: DetailType;
  quantity: string;
  unitCost: string;
}

const VITE_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const WS_URL = VITE_API_URL.replace('/api/v1', '');

// ─── API Hooks ───────────────────────────────────────────────────────────────

function useAdjustments(page: number, limit: number, warehouseId: string, status: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (status)      params.set('status', status);
  return useQuery<Paginated<Adjustment>>({
    queryKey: ['adjustments', page, limit, warehouseId, status],
    queryFn: () => api.get<Paginated<Adjustment>>(`/inventory/adjustments?${params}`),
  });
}

function useAdjustmentDetail(id: string | null) {
  return useQuery<Adjustment>({
    queryKey: ['adjustment', id],
    queryFn: () => api.get<Adjustment>(`/inventory/adjustments/${id!}`),
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

function useCreateAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Adjustment>('/inventory/adjustments', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['adjustments'] }); },
  });
}

function useValidateAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<Adjustment>(`/inventory/adjustments/${id}/validate`, {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['adjustments'] });
      void qc.invalidateQueries({ queryKey: ['adjustment', data.id] });
    },
  });
}

function useDeleteAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/inventory/adjustments/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['adjustments'] }); },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmptyRow(): DetailFormRow {
  return { productId: '', productVariantId: '', type: 'ADDITION', quantity: '', unitCost: '' };
}

// ─── Badge statut ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdjustmentStatus }) {
  const map: Record<AdjustmentStatus, { label: string; variant: 'success' | 'warning' }> = {
    DRAFT:     { label: 'Brouillon', variant: 'warning' },
    VALIDATED: { label: 'Validé',    variant: 'success' },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

// ─── Formulaire de création ───────────────────────────────────────────────────

function AdjustmentForm({
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
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<DetailFormRow[]>([makeEmptyRow()]);

  function setRow<K extends keyof DetailFormRow>(idx: number, key: K, value: DetailFormRow[K]) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
  }

  function addRow() { setRows((prev) => [...prev, makeEmptyRow()]); }
  function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

  function buildPayload() {
    return {
      warehouseId,
      date: new Date(date).toISOString(),
      note: note || undefined,
      details: rows.map((r) => ({
        productId: r.productId,
        productVariantId: r.productVariantId || undefined,
        type: r.type,
        quantity: r.quantity,
        unitCost: r.unitCost || undefined,
      })),
    };
  }

  const canSubmit = warehouseId && date && rows.every((r) => r.productId && r.quantity);

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label>Entrepôt *</Label>
        <NativeSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          <option value="">— Sélectionner un entrepôt —</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </NativeSelect>
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
          placeholder="Raison de l'ajustement…"
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

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Type</Label>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRow(idx, 'type', 'ADDITION')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1 rounded-field border px-1.5 py-1.5 text-[12px] font-semibold transition-colors',
                        row.type === 'ADDITION'
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50',
                      )}
                    >
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                      Addition
                    </button>
                    <button
                      type="button"
                      onClick={() => setRow(idx, 'type', 'SOUSTRACTION')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1 rounded-field border px-1.5 py-1.5 text-[12px] font-semibold transition-colors',
                        row.type === 'SOUSTRACTION'
                          ? 'border-danger-500 bg-danger-50 text-danger-700'
                          : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50',
                      )}
                    >
                      <ArrowDownCircle className="h-3.5 w-3.5" />
                      Soustr.
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Quantité *</Label>
                  <Input value={row.quantity} onChange={(e) => setRow(idx, 'quantity', e.target.value)} placeholder="ex. 10" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11.5px] text-neutral-500">Coût unit. (XAF)</Label>
                  <Input value={row.unitCost} onChange={(e) => setRow(idx, 'unitCost', e.target.value)} placeholder="0" />
                </div>
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
          {!validating && 'Valider le stock'}
          {validating && 'Validation…'}
        </Button>
      </div>
    </div>
  );
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

function AdjustmentDetailView({
  adjustment,
  products,
  warehouses,
  onValidate,
  validating,
}: {
  adjustment: Adjustment;
  products: ProductRef[];
  warehouses: WarehouseRef[];
  onValidate: () => void;
  validating: boolean;
}) {
  const warehouseName = warehouses.find((w) => w.id === adjustment.warehouseId)?.name ?? adjustment.warehouseId;

  function productName(id: string) {
    const p = products.find((x) => x.id === id);
    return p ? `${p.code} — ${p.name}` : id;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{adjustment.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statut</p>
          <StatusBadge status={adjustment.status} />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Date</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(adjustment.date)}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">{warehouseName}</p>
        </div>
      </div>

      {adjustment.note && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{adjustment.note}</div>
      )}

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Lignes ({adjustment.details?.length ?? 0})</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produit</TableHead>
              <TableHead className="text-center">Type</TableHead>
              <TableHead className="text-right">Quantité</TableHead>
              <TableHead className="text-right">Coût unit.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(adjustment.details ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell>{productName(d.productId)}</TableCell>
                <TableCell className="text-center">
                  {d.type === 'ADDITION' ? (
                    <ArrowUpCircle className="mx-auto h-4 w-4 text-brand-600" />
                  ) : (
                    <ArrowDownCircle className="mx-auto h-4 w-4 text-danger-600" />
                  )}
                </TableCell>
                <TableCell className="tabular text-right">{d.quantity}</TableCell>
                <TableCell className="tabular text-right">
                  {Number(d.unitCost) === 0 ? '—' : formatXAF(d.unitCost)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {adjustment.status === 'DRAFT' && (
        <Button onClick={onValidate} loading={validating}>
          {!validating && 'Valider — mettre à jour le stock'}
          {validating && 'Validation en cours…'}
        </Button>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function AdjustmentsPage() {
  const qc = useQueryClient();

  const [page, setPage]                 = useState(1);
  const limit                           = 20;
  const [filterWh, setFilterWh]         = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [showCreate, setShowCreate]     = useState(false);
  const [detailId, setDetailId]         = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Adjustment | null>(null);

  // Données
  const { data, isLoading, isError } = useAdjustments(page, limit, filterWh, filterStatus);
  const { data: detail, isLoading: detailLoading } = useAdjustmentDetail(detailId);
  const { data: warehousesData } = useWarehouses();
  const { data: productsData }   = useProducts();
  const warehouses = warehousesData?.data ?? [];
  const products   = productsData?.data ?? [];

  // Mutations
  const createMut   = useCreateAdjustment();
  const validateMut = useValidateAdjustment();
  const deleteMut   = useDeleteAdjustment();

  // Socket.io — écoute stock:updated → invalide le cache stock
  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const socket: Socket = io(`${WS_URL}/realtime`, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('stock:updated', () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
    });

    return () => { socket.disconnect(); };
  }, [qc]);

  // Handlers création
  function handleSaveDraft(payload: unknown) {
    createMut.mutate(payload, {
      onSuccess: () => {
        setShowCreate(false);
        toast.success('Ajustement enregistré en brouillon.');
      },
      onError: (e: Error) => toast.error(e.message),
    });
  }

  function handleCreateAndValidate(payload: unknown) {
    createMut.mutate(payload, {
      onSuccess: (adj) => {
        validateMut.mutate(adj.id, {
          onSuccess: () => {
            setShowCreate(false);
            toast.success('Stock mis à jour. Ajustement validé.');
          },
          onError: (e: Error) => toast.error(e.message),
        });
      },
      onError: (e: Error) => toast.error(e.message),
    });
  }

  // Handler validation depuis le détail
  function handleValidateDetail() {
    if (!detailId) return;
    validateMut.mutate(detailId, {
      onSuccess: () => toast.success('Stock mis à jour. Ajustement validé.'),
      onError: (e: Error) => toast.error(e.message),
    });
  }

  // Handler suppression
  function handleDelete() {
    if (!deleteTarget) return;
    deleteMut.mutate(deleteTarget.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        toast.success('Ajustement supprimé.');
      },
      onError: (e: Error) => {
        setDeleteTarget(null);
        toast.error(e.message);
      },
    });
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Ajustements de stock"
        description="Gérez les entrées et sorties manuelles de stock."
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Nouvel ajustement
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterWh}
            onChange={(e) => { setFilterWh(e.target.value); setPage(1); }}
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
            <option value="DRAFT">Brouillon</option>
            <option value="VALIDATED">Validé</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={6} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les ajustements." onRetry={() => void qc.invalidateQueries({ queryKey: ['adjustments'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={PackageSearch}
          title="Aucun ajustement"
          description="Créez votre premier ajustement pour corriger le stock."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Nouvel ajustement
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
              <TableHead>Entrepôt</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-center">Lignes</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((adj) => {
              const wh = warehouses.find((w) => w.id === adj.warehouseId);
              return (
                <TableRow key={adj.id} className="cursor-pointer" onClick={() => setDetailId(adj.id)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{adj.reference}</TableCell>
                  <TableCell>{formatDate(adj.date)}</TableCell>
                  <TableCell>{wh?.name ?? '—'}</TableCell>
                  <TableCell><StatusBadge status={adj.status} /></TableCell>
                  <TableCell className="tabular text-center">{adj.details?.length ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); setDetailId(adj.id); }}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Voir
                      </Button>
                      {adj.status === 'DRAFT' && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(adj); }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Supprimer
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
      <Sheet open={showCreate} onOpenChange={setShowCreate}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Nouvel ajustement</SheetTitle>
            <SheetDescription>Entrepôt, lignes et type de mouvement — le stock est mis à jour à la validation.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <AdjustmentForm
              warehouses={warehouses}
              products={products}
              onSave={handleSaveDraft}
              onValidate={handleCreateAndValidate}
              saving={createMut.isPending}
              validating={createMut.isPending && validateMut.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{detail ? `Ajustement ${detail.reference}` : 'Détail'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {!detailLoading && detail && (
              <AdjustmentDetailView
                adjustment={detail}
                products={products}
                warehouses={warehouses}
                onValidate={handleValidateDetail}
                validating={validateMut.isPending}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer l&apos;ajustement {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. L&apos;ajustement brouillon sera définitivement supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={handleDelete}
            >
              {deleteMut.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
