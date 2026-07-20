import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

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

// ─── Composants ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse" aria-busy="true">
      {[1, 2, 3, 4].map((i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-gray-200 rounded w-full" />
        </td>
      ))}
    </tr>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800"
    >
      <span>{message}</span>
      <button
        onClick={onRetry}
        className="ml-4 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
      >
        Réessayer
      </button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-500">
      <p className="text-lg font-medium">Aucun entrepôt</p>
      <p className="mt-1 text-sm">Créez votre premier entrepôt pour commencer à gérer votre stock.</p>
      <button
        data-testid="empty-add-warehouse"
        onClick={onAdd}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Ajouter un entrepôt
      </button>
    </div>
  );
}

function WarehouseDialog({
  open,
  onClose,
  initial,
  onSubmit,
  isPending,
  error,
}: {
  open: boolean;
  onClose: () => void;
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

  React.useEffect(() => {
    if (open) {
      setForm({
        name: initial?.name ?? '',
        address: initial?.address ?? '',
        isDefault: initial?.isDefault ?? false,
      });
    }
  }, [open, initial?.name, initial?.address, initial?.isDefault]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={initial?.name ? 'Modifier l\'entrepôt' : 'Nouvel entrepôt'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {initial?.name ? 'Modifier l\'entrepôt' : 'Nouvel entrepôt'}
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(form);
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="wh-name">
              Nom <span className="text-red-500">*</span>
            </label>
            <input
              id="wh-name"
              type="text"
              required
              maxLength={100}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="wh-address">
              Adresse
            </label>
            <input
              id="wh-address"
              type="text"
              maxLength={255}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="wh-default"
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
            />
            <label htmlFor="wh-default" className="text-sm text-gray-700">
              Entrepôt par défaut
            </label>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteDialog({
  open,
  warehouseName,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  open: boolean;
  warehouseName: string;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: string | null;
}) {
  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirmer la suppression"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Supprimer l'entrepôt</h2>
        <p className="mb-4 text-sm text-gray-600">
          Voulez-vous vraiment supprimer l'entrepôt{' '}
          <span className="font-semibold text-gray-900">"{warehouseName}"</span> ?
          Cette action ne peut pas être annulée.
        </p>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Annuler
          </button>
          <button
            data-testid="confirm-delete"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </div>
    </div>
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
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Entrepôts</h1>
        <button
          data-testid="add-warehouse"
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Nouvel entrepôt
        </button>
      </div>

      {/* État erreur */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Impossible de charger les entrepôts.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* Tableau */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Nom', 'Adresse', 'Par défaut', 'Actions'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {/* État chargement */}
            {isLoading && [1, 2, 3].map((i) => <SkeletonRow key={i} />)}

            {/* État succès */}
            {!isLoading && !isError && data?.data.map((wh) => (
              <tr key={wh.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{wh.name}</td>
                <td className="px-4 py-3 text-gray-500">{wh.address ?? '—'}</td>
                <td className="px-4 py-3">
                  {wh.isDefault && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                      Par défaut
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      aria-label={`Modifier ${wh.name}`}
                      onClick={() => openEdit(wh)}
                      className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                    >
                      Modifier
                    </button>
                    <button
                      aria-label={`Supprimer ${wh.name}`}
                      onClick={() => setDeleteTarget(wh)}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      Supprimer
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* État vide */}
        {!isLoading && !isError && (!data?.data || data.data.length === 0) && (
          <EmptyState onAdd={openCreate} />
        )}
      </div>

      {/* État partiel — pagination */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} entrepôts
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}

      {/* Modal CRUD */}
      <WarehouseDialog
        open={dialogOpen}
        onClose={closeDialog}
        initial={editTarget ? { name: editTarget.name, address: editTarget.address ?? '', isDefault: editTarget.isDefault } : undefined}
        onSubmit={handleSubmit}
        isPending={isPendingForm}
        error={activeError ? (activeError as Error).message : null}
      />

      {/* AlertDialog suppression */}
      <DeleteDialog
        open={!!deleteTarget}
        warehouseName={deleteTarget?.name ?? ''}
        onCancel={() => { setDeleteTarget(null); deleteWh.reset(); }}
        onConfirm={handleDelete}
        isPending={deleteWh.isPending}
        error={deleteWh.error ? (deleteWh.error as Error).message : null}
      />
    </div>
  );
}

export default WarehousesPage;
