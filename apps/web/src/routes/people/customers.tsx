import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Upload, Download, Pencil, Trash2, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button, buttonVariants } from '../../components/ui/button';
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
  SheetFooter,
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
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ─── Formulaire client ────────────────────────────────────────────────────────

function ClientForm({
  initial,
  onSave,
  saving,
  error,
}: {
  initial?: Partial<ClientFormData>;
  onSave: (data: Partial<ClientFormData>) => void;
  saving: boolean;
  error: string | null;
}) {
  const empty: ClientFormData = { name: '', email: '', phone: '', country: '', city: '', address: '' };
  const [form, setForm] = useState<ClientFormData>({ ...empty, ...(initial ?? {}) });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {error && (
        <p className="rounded-card border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-[13px] text-danger-700">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="cl-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="cl-name"
          required
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cl-email">Email</Label>
          <Input
            id="cl-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cl-phone">Téléphone</Label>
          <Input
            id="cl-phone"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cl-country">Pays</Label>
          <Input
            id="cl-country"
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cl-city">Ville</Label>
          <Input
            id="cl-city"
            value={form.city}
            onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cl-address">Adresse</Label>
        <Input
          id="cl-address"
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
        />
      </div>

      <SheetFooter className="border-0 px-0 pb-0 pt-2">
        <Button type="submit" disabled={saving} loading={saving}>
          {!saving && 'Enregistrer'}
          {saving && 'Enregistrement…'}
        </Button>
      </SheetFooter>
    </form>
  );
}

// ─── Rapport d'import CSV ─────────────────────────────────────────────────────

function ImportReportPanel({ report }: { report: ImportReport }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-card border border-info-200 bg-info-50 p-4" data-testid="import-report">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-info-700">
          Import terminé — {report.imported} client(s) importé(s)
          {report.errors.length > 0 && `, ${report.errors.length} ligne(s) ignorée(s)`}
        </p>
        {report.errors.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} type="button">
            {open ? 'Masquer' : 'Voir les erreurs'}
          </Button>
        )}
      </div>
      {open && report.errors.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="import-errors">
          {report.errors.map((e) => (
            <li key={e.line} className="flex items-center gap-2 text-[12.5px] text-neutral-700">
              <Badge variant="danger">Ligne {e.line}</Badge>
              {e.message}
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
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [dialogOpen, setDialogOpen]       = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [deletingClient, setDeletingClient] = useState<Client | null>(null);
  const [importReport, setImportReport]   = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, error, refetch } = useClients(page, 20, search);
  const createMut = useCreateClient();
  const updateMut = useUpdateClient();
  const deleteMut = useDeleteClient();
  const importMut = useImportClients();
  const exportMut = useExportClients();

  // Réinitialise la page si la recherche change
  useEffect(() => { setPage(1); }, [search]);

  function closeDialog() {
    setDialogOpen(false);
    setEditingClient(null);
  }

  const handleSubmit = (form: Partial<ClientFormData>) => {
    if (editingClient) {
      updateMut.mutate({ id: editingClient.id, data: form }, { onSuccess: closeDialog });
    } else {
      createMut.mutate(form, { onSuccess: closeDialog });
    }
  };

  const handleDelete = () => {
    if (!deletingClient) return;
    deleteMut.mutate(deletingClient.id, { onSuccess: () => setDeletingClient(null) });
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importMut.mutate(file, {
      onSuccess: (report) => {
        setImportReport(report);
        void qc.invalidateQueries({ queryKey: ['clients'] });
      },
      onError: (err) => { toast.error(err.message); },
    });
    e.target.value = '';
  };

  const handleExport = () => {
    exportMut.mutate(undefined, {
      onSuccess: () => { toast.info("Export en cours… Vous serez notifié lorsqu'il sera prêt."); },
      onError: (err) => { toast.error(err.message); },
    });
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;
  const rows        = data?.data ?? [];
  const isEmpty      = !isLoading && !isError && rows.length === 0;

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Clients"
        description="Vos clients et leurs coordonnées."
        action={
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/v1/partners/clients/template"
              className={cn(buttonVariants({ variant: 'secondary' }))}
            >
              <Download className="h-4 w-4" />
              Télécharger le modèle CSV
            </a>
            <Button
              variant="secondary"
              type="button"
              data-testid="import-csv-btn"
              onClick={() => fileRef.current?.click()}
              disabled={importMut.isPending}
              loading={importMut.isPending}
            >
              {!importMut.isPending && <Upload className="h-4 w-4" />}
              {importMut.isPending ? 'Import…' : 'Importer CSV'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void handleImport(e)}
              data-testid="csv-file-input"
            />
            <Button
              variant="secondary"
              type="button"
              data-testid="export-excel-btn"
              onClick={handleExport}
              disabled={exportMut.isPending}
              loading={exportMut.isPending}
            >
              {!exportMut.isPending && <Download className="h-4 w-4" />}
              Exporter Excel
            </Button>
            <Button
              data-testid="add-client-btn"
              onClick={() => { setEditingClient(null); setDialogOpen(true); }}
            >
              <Plus className="h-4 w-4" />
              Nouveau client
            </Button>
          </div>
        }
      />

      {/* ── Barre de recherche ───────────────────────────────────────────── */}
      <div className="mb-4">
        <Input
          data-testid="search-input"
          type="search"
          placeholder="Rechercher par nom ou email…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {/* ── Rapport d'import ─────────────────────────────────────────────── */}
      {importReport && <div className="mb-4"><ImportReportPanel report={importReport} /></div>}

      {/* ── État chargement ──────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={6} />}

      {/* ── État erreur ──────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les clients.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {isEmpty && (
        <EmptyState
          icon={Users}
          title="Aucun client"
          description="Créez votre premier client ou importez un fichier CSV."
          action={
            <Button data-testid="empty-add-client" onClick={() => { setEditingClient(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4" />
              Nouveau client
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && !isEmpty && (
        <Table data-testid="clients-table">
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Téléphone</TableHead>
              <TableHead>Ville</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((client) => (
              <TableRow key={client.id} data-testid="client-row">
                <TableCell className="tabular font-mono text-[12.5px] text-neutral-500">{client.code}</TableCell>
                <TableCell className="font-semibold text-neutral-900">{client.name}</TableCell>
                <TableCell className="text-neutral-600">{client.email ?? '—'}</TableCell>
                <TableCell className="text-neutral-600">{client.phone ?? '—'}</TableCell>
                <TableCell className="text-neutral-600">{client.city ?? '—'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${client.name}`}
                      onClick={() => { setEditingClient(client); setDialogOpen(true); }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${client.name}`}
                      onClick={() => setDeletingClient(client)}
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

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {!isLoading && !isError && totalPages > 1 && data && (
        <div className="mt-4 flex items-center justify-between text-[13px] text-neutral-500">
          <span>
            {(page - 1) * data.limit + 1}–{Math.min(page * data.limit, data.total)} sur {data.total} clients
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Précédent
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              Suivant
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Sheet création / édition ────────────────────────────────────── */}
      <Sheet open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editingClient ? 'Modifier le client' : 'Nouveau client'}</SheetTitle>
            <SheetDescription>Nom, coordonnées et adresse du client.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ClientForm
              key={editingClient?.id ?? 'new'}
              initial={editingClient ? {
                name:    editingClient.name,
                email:   editingClient.email   ?? undefined,
                phone:   editingClient.phone   ?? undefined,
                country: editingClient.country ?? undefined,
                city:    editingClient.city    ?? undefined,
                address: editingClient.address ?? undefined,
              } : undefined}
              onSave={handleSubmit}
              saving={createMut.isPending || updateMut.isPending}
              error={
                createMut.error ? (createMut.error as Error).message
                : updateMut.error ? (updateMut.error as Error).message
                : null
              }
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ─────────────────────────────────────── */}
      <AlertDialog open={deletingClient !== null} onOpenChange={(open) => !open && setDeletingClient(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le client {deletingClient?.name ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Le client sera définitivement supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingClient(null)}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={deleteMut.isPending} onClick={handleDelete}>
              {deleteMut.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
