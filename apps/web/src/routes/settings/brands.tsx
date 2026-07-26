import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface Brand {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedBrands {
  data: Brand[];
  total: number;
  page: number;
  limit: number;
}

interface BrandFormData {
  name: string;
  description: string;
  image: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useBrands(page: number, limit = 20) {
  return useQuery<PaginatedBrands>({
    queryKey: ['brands', page, limit],
    queryFn: () => api.get<PaginatedBrands>(`/catalog/brands?page=${page}&limit=${limit}`),
  });
}

function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BrandFormData>) => api.post<Brand>('/catalog/brands', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

function useUpdateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<BrandFormData> }) =>
      api.patch<Brand>(`/catalog/brands/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

function useDeleteBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/brands/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

// ─── Avatar marque ───────────────────────────────────────────────────────────

function BrandAvatar({ name, image }: { name: string; image: string | null }) {
  const [imgError, setImgError] = useState(false);

  if (image && !imgError) {
    return (
      <img
        src={image}
        alt={`Logo ${name}`}
        className="h-8 w-8 rounded-full object-cover"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      aria-label={`Initiale ${name}`}
      className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-[12px] font-semibold text-brand-700"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Formulaire création / édition ───────────────────────────────────────────

function BrandForm({
  initial,
  onSave,
  saving,
}: {
  initial?: Partial<BrandFormData>;
  onSave: (data: Partial<BrandFormData>) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [image, setImage] = useState(initial?.image ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: Partial<BrandFormData> = { name };
    if (description.trim()) payload.description = description;
    if (image.trim()) payload.image = image;
    onSave(payload);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label htmlFor="brand-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="brand-name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brand-description">Description</Label>
        <Textarea
          id="brand-description"
          maxLength={500}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brand-image">URL du logo</Label>
        <Input
          id="brand-image"
          type="url"
          maxLength={2048}
          placeholder="https://exemple.com/logo.png"
          value={image}
          onChange={(e) => setImage(e.target.value)}
        />
        <p className="text-[12px] text-neutral-400">L'upload de fichier sera disponible prochainement</p>
      </div>

      <SheetFooter className="border-0 px-0 pb-0 pt-2">
        <Button type="submit" disabled={saving} loading={saving}>
          {!saving && 'Enregistrer'}
        </Button>
      </SheetFooter>
    </form>
  );
}

// ─── Écran principal ─────────────────────────────────────────────────────────

export function BrandsPage() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, isError, error, refetch } = useBrands(page, limit);
  const createBrand = useCreateBrand();
  const updateBrand = useUpdateBrand();
  const deleteBrand = useDeleteBrand();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Brand | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(brand: Brand) {
    setEditTarget(brand);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createBrand.reset();
    updateBrand.reset();
  }

  function handleSubmit(formData: Partial<BrandFormData>) {
    if (editTarget) {
      updateBrand.mutate(
        { id: editTarget.id, data: formData },
        { onSuccess: closeDialog },
      );
    } else {
      createBrand.mutate(formData, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteBrand.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const isPendingForm = editTarget ? updateBrand.isPending : createBrand.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;
  const rows = data?.data ?? [];

  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader
        title="Marques"
        description="Marques de produits utilisées dans le catalogue."
        action={
          <Button data-testid="add-brand" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvelle marque
          </Button>
        }
      />

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={4} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les marques.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Tag}
          title="Aucune marque"
          description="Créez votre première marque pour enrichir votre catalogue."
          action={
            <Button data-testid="empty-add-brand" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Nouvelle marque
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Logo</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((brand) => (
              <TableRow key={brand.id}>
                <TableCell>
                  <BrandAvatar name={brand.name} image={brand.image} />
                </TableCell>
                <TableCell className="font-semibold text-neutral-900">{brand.name}</TableCell>
                <TableCell className="max-w-xs truncate text-neutral-500">
                  {brand.description ?? '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${brand.name}`}
                      onClick={() => openEdit(brand)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${brand.name}`}
                      onClick={() => setDeleteTarget(brand)}
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
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} marques
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
            <SheetTitle>{editTarget ? 'Modifier la marque' : 'Nouvelle marque'}</SheetTitle>
            <SheetDescription>Nom, description et logo de la marque.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <BrandForm
              key={editTarget?.id ?? 'new'}
              initial={
                editTarget
                  ? { name: editTarget.name, description: editTarget.description ?? '', image: editTarget.image ?? '' }
                  : undefined
              }
              onSave={handleSubmit}
              saving={isPendingForm}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ─────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la marque "{deleteTarget?.name ?? ''}" ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. La marque sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteBrand.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction disabled={deleteBrand.isPending} onClick={handleDelete}>
              {deleteBrand.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default BrandsPage;
