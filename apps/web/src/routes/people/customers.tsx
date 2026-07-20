import React, { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Client {
  id: string;
  code: number;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedClients {
  data: Client[];
  total: number;
  page: number;
  limit: number;
}

interface ClientFormData {
  name: string;
  email: string;
  phone: string;
  country: string;
  city: string;
  address: string;
}

interface ImportReport {
  imported: number;
  errors: { line: number; message: string }[];
}

interface ExportResponse {
  jobId: string;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useClients(page: number, limit = 20, search = '') {
  return useQuery<PaginatedClients>({
    queryKey: ['clients', page, limit, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set('search', search);
      return api.get<PaginatedClients>(`/partners/clients?${params.toString()}`);
    },
  });
}

function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ClientFormData>) => api.post<Client>('/partners/clients', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['clients'] }); },
  });
}

function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ClientFormData> }) =>
      api.patch<Client>(`/partners/clients/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['clients'] }); },
  });
}

function useDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/partners/clients/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['clients'] }); },
  });
}

function useImportClients() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<ImportReport>('/partners/clients/import', form);
    },
  });
}

function useExportClients() {
  return useMutation({
    mutationFn: () => api.get<ExportResponse>('/partners/clients/export/excel'),
  });
}

// ─── Utilitaire debounce ──────────────────────────────────────────────────────

function useDebounce(value: string, delay = 300) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ─── Composants atomiques ─────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse" aria-busy="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-gray-200 rounded w-full" />
        </td>
      ))}
    </tr>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800">
      <span>{message}</span>
      <button onClick={onRetry} className="ml-4 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700">
        Réessayer
      </button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-500">
      <p className="text-lg font-medium">Aucun client</p>
      <p className="mt-1 text-sm">Créez votre premier client ou importez un fichier CSV.</p>
      <button
        data-testid="empty-add-client"
        onClick={onAdd}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Nouveau client
      </button>
    </div>
  );
}

function Toast({ message, type = 'info' }: { message: string; type?: 'info' | 'success' | 'error' }) {
  const colors = {
    info: 'bg-blue-600',
    success: 'bg-green-600',
    error: 'bg-red-600',
  };
  return (
    <div className={`fixed bottom-6 right-6 z-50 rounded-lg px-5 py-3 text-white shadow-lg ${colors[type]}`} role="status">
      {message}
    </div>
  );
}

// ─── Formulaire client ────────────────────────────────────────────────────────

function ClientDialog({
  open, onClose, initial, onSubmit, isPending, error,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<ClientFormData>;
  onSubmit: (data: Partial<ClientFormData>) => void;
  isPending: boolean;
  error: string | null;
}) {
  const empty: ClientFormData = { name: '', email: '', phone: '', country: '', city: '', address: '' };
  const [form, setForm] = useState<ClientFormData>(empty);

  React.useEffect(() => {
    if (open) setForm({ ...empty, ...(initial ?? {}) });
  }, [open]);

  if (!open) return null;

  const isEdit = Boolean(initial && 'name' in initial);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {isEdit ? 'Modifier le client' : 'Nouveau client'}
        </h2>
        {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="cl-name">
              Nom <span className="text-red-500">*</span>
            </label>
            <input
              id="cl-name"
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {(['email', 'phone', 'country', 'city', 'address'] as const).map(field => (
            <div key={field}>
              <label className="block text-sm font-medium text-gray-700 capitalize" htmlFor={`cl-${field}`}>
                {{ email: 'Email', phone: 'Téléphone', country: 'Pays', city: 'Ville', address: 'Adresse' }[field]}
              </label>
              <input
                id={`cl-${field}`}
                type={field === 'email' ? 'email' : 'text'}
                value={form[field]}
                onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Annuler
            </button>
            <button type="submit" disabled={isPending} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
              {isPending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Dialog de confirmation de suppression ────────────────────────────────────

function DeleteDialog({
  client, onConfirm, onCancel, isPending,
}: {
  client: Client;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Supprimer le client</h2>
        <p className="mt-2 text-sm text-gray-600">
          Voulez-vous supprimer le client <strong>{client.name}</strong> ? Cette action est irréversible.
        </p>
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onCancel} className="rounded-md border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
            Annuler
          </button>
          <button onClick={onConfirm} disabled={isPending} className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
            {isPending ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Rapport d'import CSV ─────────────────────────────────────────────────────

function ImportReportPanel({ report }: { report: ImportReport }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="import-report">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-blue-800">
          Import terminé — {report.imported} client(s) importé(s)
          {report.errors.length > 0 && `, ${report.errors.length} ligne(s) ignorée(s)`}
        </span>
        {report.errors.length > 0 && (
          <button onClick={() => setOpen(o => !o)} className="text-xs text-blue-600 underline">
            {open ? 'Masquer' : 'Voir les erreurs'}
          </button>
        )}
      </div>
      {open && report.errors.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="import-errors">
          {report.errors.map(e => (
            <li key={e.line} className="text-xs text-red-700">
              Ligne {e.line} : {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Écran principal ──────────────────────────────────────────────────────────

export default function CustomersPage() {
  const qc = useQueryClient();
  const [page, setPage]             = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [dialogOpen, setDialogOpen]       = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [deletingClient, setDeletingClient] = useState<Client | null>(null);

  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [toast, setToast]               = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, error, refetch } = useClients(page, 20, search);
  const createMut  = useCreateClient();
  const updateMut  = useUpdateClient();
  const deleteMut  = useDeleteClient();
  const importMut  = useImportClients();
  const exportMut  = useExportClients();

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Réinitialise la page si la recherche change
  React.useEffect(() => { setPage(1); }, [search]);

  const handleSubmit = (form: Partial<ClientFormData>) => {
    if (editingClient) {
      updateMut.mutate({ id: editingClient.id, data: form }, {
        onSuccess: () => { setDialogOpen(false); setEditingClient(null); },
      });
    } else {
      createMut.mutate(form, {
        onSuccess: () => { setDialogOpen(false); },
      });
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importMut.mutate(file, {
      onSuccess: (report) => {
        setImportReport(report);
        void qc.invalidateQueries({ queryKey: ['clients'] });
      },
      onError: (err) => { showToast(err.message, 'error'); },
    });
    e.target.value = '';
  };

  const handleExport = () => {
    exportMut.mutate(undefined, {
      onSuccess: () => {
        showToast("Export en cours… Vous serez notifié lorsqu'il sera prêt.", 'info');
      },
      onError: (err) => { showToast(err.message, 'error'); },
    });
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;
  const isEmpty    = !isLoading && !isError && data?.data?.length === 0;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
        <div className="flex gap-2">
          <a
            href="/api/v1/partners/clients/template"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Télécharger le modèle CSV
          </a>
          <button
            data-testid="import-csv-btn"
            onClick={() => fileRef.current?.click()}
            disabled={importMut.isPending}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {importMut.isPending ? 'Import…' : 'Importer CSV'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleImport}
            data-testid="csv-file-input"
          />
          <button
            data-testid="export-excel-btn"
            onClick={handleExport}
            disabled={exportMut.isPending}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Exporter Excel
          </button>
          <button
            data-testid="add-client-btn"
            onClick={() => { setEditingClient(null); setDialogOpen(true); }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Nouveau client
          </button>
        </div>
      </div>

      {/* Barre de recherche */}
      <div className="mb-4">
        <input
          data-testid="search-input"
          type="search"
          placeholder="Rechercher par nom ou email…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Rapport d'import */}
      {importReport && <div className="mb-4"><ImportReportPanel report={importReport} /></div>}

      {/* États chargement / erreur / vide / tableau */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Erreur lors du chargement des clients.'}
          onRetry={() => void refetch()}
        />
      )}

      {!isError && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm" data-testid="clients-table">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Nom</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Téléphone</th>
                <th className="px-4 py-3">Ville</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading
                ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={6} />)
                : isEmpty
                  ? (
                    <tr>
                      <td colSpan={6}>
                        <EmptyState onAdd={() => { setEditingClient(null); setDialogOpen(true); }} />
                      </td>
                    </tr>
                  )
                  : data?.data.map(client => (
                    <tr key={client.id} className="hover:bg-gray-50" data-testid="client-row">
                      <td className="px-4 py-3">
                        <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">{client.code}</span>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{client.name}</td>
                      <td className="px-4 py-3 text-gray-600">{client.email ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{client.phone ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{client.city ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setEditingClient(client); setDialogOpen(true); }}
                            className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                          >
                            Éditer
                          </button>
                          <button
                            onClick={() => setDeletingClient(client)}
                            className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                          >
                            Supprimer
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            {data ? `${(page - 1) * data.limit + 1}–${Math.min(page * data.limit, data.total)} sur ${data.total} clients` : ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <ClientDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingClient(null); }}
        initial={editingClient ? {
          name:    editingClient.name,
          email:   editingClient.email   ?? undefined,
          phone:   editingClient.phone   ?? undefined,
          country: editingClient.country ?? undefined,
          city:    editingClient.city    ?? undefined,
          address: editingClient.address ?? undefined,
        } : undefined}
        onSubmit={handleSubmit}
        isPending={createMut.isPending || updateMut.isPending}
        error={
          createMut.error ? (createMut.error as Error).message
          : updateMut.error ? (updateMut.error as Error).message
          : null
        }
      />

      {deletingClient && (
        <DeleteDialog
          client={deletingClient}
          onConfirm={() => {
            deleteMut.mutate(deletingClient.id, {
              onSuccess: () => setDeletingClient(null),
            });
          }}
          onCancel={() => setDeletingClient(null)}
          isPending={deleteMut.isPending}
        />
      )}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}
