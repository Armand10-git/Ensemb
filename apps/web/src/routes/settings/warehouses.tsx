import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Warehouse as WarehouseIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
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

interface Warehouse {
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedWarehouses {
  data: Warehouse[];
  total: number;
  page: number;
  limit: number;
}

interface WarehouseFormData {
  name: string;
  address: string;
  isDefault: boolean;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useWarehouses(page: number, limit = 20) {
  return useQuery<PaginatedWarehouses>({
    queryKey: ['warehouses', page, limit],
    queryFn: () => api.get<PaginatedWarehouses>(`/warehouses?page=${page}&limit=${limit}`),
  });
}

function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WarehouseFormData) => api.post<Warehouse>('/warehouses', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['warehouses'] }); },
  });
}

function useUpdateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WarehouseFormData> }) =>
      api.patch<Warehouse>(`/warehouses/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['warehouses'] }); },
  });
}

function useDeleteWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/warehouses/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['warehouses'] }); },
  });
}

// ─── Formulaire création / édition ────────────────────────────────────────────

function WarehouseForm({
  initial,
  onSubmit,
  isPending,
  error,
}: {
  initial?: Partial<WarehouseFormData>;
  onSubmit: (data: WarehouseFormData) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<WarehouseFormData>({
    name: initial?.name ?? '',
    address: initial?.address ?? '',
    isDefault: initial?.isDefault ?? false,
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="flex flex-col gap-5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="wh-name">Nom *</Label>
        <Input
          id="wh-name"
          type="text"
          required
          maxLength={100}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wh-address">Adresse</Label>
        <Input
          id="wh-address"
          type="text"
          maxLength={255}
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="wh-default"
          type="checkbox"
          className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          checked={form.isDefault}
          onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
        />
        <Label htmlFor="wh-default" className="font-normal text-neutral-700">
          Entrepôt par défaut
        </Label>
      </div>

      {error && <p className="text-[13px] text-danger-600">{error}</p>}

      <Button type="submit" disabled={isPending} loading={isPending} size="lg">
        {!isPending && 'Enregistrer'}
      </Button>
    </form>
  );
}

// ─── Écran principal ─────────────────────────────────────────────────────────

export function WarehousesPage() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, isError, error, refetch } = useWarehouses(page, limit);
  const createWh = useCreateWarehouse();
  const updateWh = useUpdateWarehouse();
  const deleteWh = useDeleteWarehouse();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Warehouse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Warehouse | null>(null);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(wh: Warehouse) {
    setEditTarget(wh);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createWh.reset();
    updateWh.reset();
  }

  function handleSubmit(formData: WarehouseFormData) {
    if (editTarget) {
      updateWh.mutate(
        { id: editTarget.id, data: formData },
        { onSuccess: closeDialog },
      );
    } else {
      createWh.mutate(formData, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteWh.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const activeError = editTarget ? updateWh.error : createWh.error;
  const isPendingForm = editTarget ? updateWh.isPending : createWh.isPending;
  const rows = data?.data ?? [];
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Entrepôts"
        description="Emplacements de stock de l'organisation."
        action={
          <Button data-testid="add-warehouse" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvel entrepôt
          </Button>
        }
      />

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={4} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les entrepôts.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={WarehouseIcon}
          title="Aucun entrepôt"
          description="Créez votre premier entrepôt pour commencer à gérer votre stock."
          action={
            <Button data-testid="empty-add-warehouse" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Ajouter un entrepôt
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Adresse</TableHead>
              <TableHead>Par défaut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((wh) => (
              <TableRow key={wh.id}>
                <TableCell className="font-semibold text-neutral-900">{wh.name}</TableCell>
                <TableCell className="text-neutral-500">{wh.address ?? '—'}</TableCell>
                <TableCell>
                  {wh.isDefault && <Badge variant="info">Par défaut</Badge>}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${wh.name}`}
                      onClick={() => openEdit(wh)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${wh.name}`}
                      onClick={() => setDeleteTarget(wh)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* ── État partiel — pagination ────────────────────────────────────── */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="mt-4 flex items-center justify-between text-[13px] text-neutral-500">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} entrepôts
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Précédent
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Suivant
            </Button>
          </div>
        </div>
      )}

      {/* ── Sheet création / édition ────────────────────────────────────── */}
      <Sheet open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editTarget ? "Modifier l'entrepôt" : 'Nouvel entrepôt'}</SheetTitle>
            <SheetDescription>
              {editTarget ? 'Modifiez les informations de cet entrepôt.' : 'Créez un nouvel emplacement de stock.'}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <WarehouseForm
              initial={editTarget ? { name: editTarget.name, address: editTarget.address ?? '', isDefault: editTarget.isDefault } : undefined}
              onSubmit={handleSubmit}
              isPending={isPendingForm}
              error={activeError ? (activeError as Error).message : null}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ─────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            deleteWh.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer l'entrepôt {deleteTarget?.name ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Voulez-vous vraiment supprimer l'entrepôt "{deleteTarget?.name ?? ''}" ? Cette action ne peut pas être annulée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteWh.error && (
            <p className="text-[13px] text-danger-600">{(deleteWh.error as Error).message}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteWh.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete"
              disabled={deleteWh.isPending}
              onClick={handleDelete}
            >
              {deleteWh.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default WarehousesPage;
