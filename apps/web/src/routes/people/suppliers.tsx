import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Upload, Download, Pencil, Trash2, ChevronLeft, ChevronRight, Truck } from 'lucide-react';
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

interface Provider {
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

interface PaginatedProviders {
  data: Provider[];
  total: number;
  page: number;
  limit: number;
}

interface ProviderFormData {
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

function useProviders(page: number, limit = 20, search = '') {
  return useQuery<PaginatedProviders>({
    queryKey: ['providers', page, limit, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set('search', search);
      return api.get<PaginatedProviders>(`/partners/providers?${params.toString()}`);
    },
  });
}

function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ProviderFormData>) => api.post<Provider>('/partners/providers', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['providers'] }); },
  });
}

function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ProviderFormData> }) =>
      api.patch<Provider>(`/partners/providers/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['providers'] }); },
  });
}

function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/partners/providers/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['providers'] }); },
  });
}

function useImportProviders() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<ImportReport>('/partners/providers/import', form);
    },
  });
}

function useExportProviders() {
  return useMutation({
    mutationFn: () => api.get<ExportResponse>('/partners/providers/export/excel'),
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

// ─── Formulaire fournisseur ───────────────────────────────────────────────────

function ProviderForm({
  initial,
  onSave,
  saving,
  error,
}: {
  initial?: Partial<ProviderFormData>;
  onSave: (data: Partial<ProviderFormData>) => void;
  saving: boolean;
  error: string | null;
}) {
  const empty: ProviderFormData = { name: '', email: '', phone: '', country: '', city: '', address: '' };
  const [form, setForm] = useState<ProviderFormData>({ ...empty, ...(initial ?? {}) });

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
        <Label htmlFor="pr-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="pr-name"
          required
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pr-email">Email</Label>
          <Input
            id="pr-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pr-phone">Téléphone</Label>
          <Input
            id="pr-phone"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pr-country">Pays</Label>
          <Input
            id="pr-country"
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pr-city">Ville</Label>
          <Input
            id="pr-city"
            value={form.city}
            onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pr-address">Adresse</Label>
        <Input
          id="pr-address"
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
          Import terminé — {report.imported} fournisseur(s) importé(s)
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

export default function SuppliersPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [dialogOpen, setDialogOpen]           = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null);
  const [importReport, setImportReport]       = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, error, refetch } = useProviders(page, 20, search);
  const createMut = useCreateProvider();
  const updateMut = useUpdateProvider();
  const deleteMut = useDeleteProvider();
  const importMut = useImportProviders();
  const exportMut = useExportProviders();

  // Réinitialise la page si la recherche change
  useEffect(() => { setPage(1); }, [search]);

  function closeDialog() {
    setDialogOpen(false);
    setEditingProvider(null);
  }

  const handleSubmit = (form: Partial<ProviderFormData>) => {
    if (editingProvider) {
      updateMut.mutate({ id: editingProvider.id, data: form }, { onSuccess: closeDialog });
    } else {
      createMut.mutate(form, { onSuccess: closeDialog });
    }
  };

  const handleDelete = () => {
    if (!deletingProvider) return;
    deleteMut.mutate(deletingProvider.id, { onSuccess: () => setDeletingProvider(null) });
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importMut.mutate(file, {
      onSuccess: (report) => {
        setImportReport(report);
        void qc.invalidateQueries({ queryKey: ['providers'] });
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
        title="Fournisseurs"
        description="Vos fournisseurs et leurs coordonnées."
        action={
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/v1/partners/providers/template"
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
              data-testid="add-provider-btn"
              onClick={() => { setEditingProvider(null); setDialogOpen(true); }}
            >
              <Plus className="h-4 w-4" />
              Nouveau fournisseur
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
          message={(error as Error).message || 'Impossible de charger les fournisseurs.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {isEmpty && (
        <EmptyState
          icon={Truck}
          title="Aucun fournisseur"
          description="Créez votre premier fournisseur ou importez un fichier CSV."
          action={
            <Button data-testid="empty-add-provider" onClick={() => { setEditingProvider(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4" />
              Nouveau fournisseur
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && !isEmpty && (
        <Table data-testid="providers-table">
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
            {rows.map((provider) => (
              <TableRow key={provider.id} data-testid="provider-row">
                <TableCell className="tabular font-mono text-[12.5px] text-neutral-500">{provider.code}</TableCell>
                <TableCell className="font-semibold text-neutral-900">{provider.name}</TableCell>
                <TableCell className="text-neutral-600">{provider.email ?? '—'}</TableCell>
                <TableCell className="text-neutral-600">{provider.phone ?? '—'}</TableCell>
                <TableCell className="text-neutral-600">{provider.city ?? '—'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${provider.name}`}
                      onClick={() => { setEditingProvider(provider); setDialogOpen(true); }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${provider.name}`}
                      onClick={() => setDeletingProvider(provider)}
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
            {(page - 1) * data.limit + 1}–{Math.min(page * data.limit, data.total)} sur {data.total} fournisseurs
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
            <SheetTitle>{editingProvider ? 'Modifier le fournisseur' : 'Nouveau fournisseur'}</SheetTitle>
            <SheetDescription>Nom, coordonnées et adresse du fournisseur.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ProviderForm
              key={editingProvider?.id ?? 'new'}
              initial={editingProvider ? {
                name:    editingProvider.name,
                email:   editingProvider.email   ?? undefined,
                phone:   editingProvider.phone   ?? undefined,
                country: editingProvider.country ?? undefined,
                city:    editingProvider.city    ?? undefined,
                address: editingProvider.address ?? undefined,
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
      <AlertDialog open={deletingProvider !== null} onOpenChange={(open) => !open && setDeletingProvider(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le fournisseur {deletingProvider?.name ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Le fournisseur sera définitivement supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingProvider(null)}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={deleteMut.isPending} onClick={handleDelete}>
              {deleteMut.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
