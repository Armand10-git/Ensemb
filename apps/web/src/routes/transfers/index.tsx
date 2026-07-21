import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../../lib/api';

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

interface Toast { id: number; message: string; type: 'success' | 'error' }

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function makeEmptyRow(): DetailFormRow {
  return { productId: '', productVariantId: '', quantity: '' };
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: t.type === 'success' ? '#16a34a' : '#dc2626',
            color: '#fff',
            padding: '12px 20px',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.18)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 280,
          }}
        >
          <span style={{ flex: 1 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  return { toasts, add, dismiss };
}

// ─── Badge statut ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TransferStatus }) {
  const style: React.CSSProperties = {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: status === 'VALIDATED' ? '#dcfce7' : '#fef9c3',
    color: status === 'VALIDATED' ? '#15803d' : '#854d0e',
    border: `1px solid ${status === 'VALIDATED' ? '#86efac' : '#fde047'}`,
  };
  return <span style={style}>{status === 'VALIDATED' ? 'Validé' : 'Brouillon'}</span>;
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ height = 24, width = '100%' }: { height?: number; width?: number | string }) {
  return (
    <div
      style={{
        height,
        width,
        background: 'linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: 4,
      }}
    />
  );
}

// ─── Sheet (panneau latéral) ─────────────────────────────────────────────────

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 1000 }}
      />
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 600,
          background: '#fff', zIndex: 1001, display: 'flex', flexDirection: 'column',
          boxShadow: '-4px 0 24px rgba(0,0,0,.12)', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </div>
        <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>{children}</div>
      </div>
    </>
  );
}

// ─── AlertDialog ─────────────────────────────────────────────────────────────

function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  if (!open) return null;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 2000 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        background: '#fff', borderRadius: 12, padding: '32px 28px', zIndex: 2001,
        width: 420, boxShadow: '0 8px 32px rgba(0,0,0,.16)',
      }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 17 }}>{title}</h3>
        <p style={{ margin: '0 0 24px', color: '#6b7280', fontSize: 14 }}>{description}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onCancel} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            Annuler
          </button>
          <button onClick={onConfirm} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {loading ? 'Suppression…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
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

  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db',
    fontSize: 14, boxSizing: 'border-box',
  };

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Entrepôt source *</label>
          <select
            value={fromWarehouseId}
            onChange={(e) => {
              setFromWarehouseId(e.target.value);
              // Réinitialise la destination si elle devenait identique
              if (e.target.value === toWarehouseId) setToWarehouseId('');
            }}
            style={fieldStyle}
            data-testid="from-warehouse-select"
          >
            <option value="">— Source —</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Entrepôt destination *</label>
          <select
            value={toWarehouseId}
            onChange={(e) => setToWarehouseId(e.target.value)}
            style={fieldStyle}
            data-testid="to-warehouse-select"
          >
            <option value="">— Destination —</option>
            {destWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {fromWarehouseId && destWarehouses.length === 0 && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626' }}>
              Aucun autre entrepôt disponible.
            </p>
          )}
        </div>
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date *</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          style={{ ...fieldStyle, resize: 'vertical' }}
          placeholder="Raison du transfert…"
        />
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Lignes *</label>
          <button onClick={addRow} style={{ fontSize: 13, padding: '4px 12px', borderRadius: 6, border: '1px solid #2563eb', color: '#2563eb', background: '#fff', cursor: 'pointer' }}>
            + Ajouter une ligne
          </button>
        </div>

        {rows.map((row, idx) => (
          <div key={idx} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
              <select
                value={row.productId}
                onChange={(e) => setRow(idx, 'productId', e.target.value)}
                style={fieldStyle}
              >
                <option value="">— Produit —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
              {rows.length > 1 && (
                <button onClick={() => removeRow(idx)} style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, cursor: 'pointer', padding: '0 10px', fontWeight: 700 }}>×</button>
              )}
            </div>

            <div>
              <label style={{ fontSize: 12, color: '#6b7280' }}>Quantité *</label>
              <input
                type="text"
                value={row.quantity}
                onChange={(e) => setRow(idx, 'quantity', e.target.value)}
                placeholder="ex. 5 ou 2.500"
                style={{ ...fieldStyle, marginTop: 4 }}
              />
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 8 }}>
        <button
          onClick={() => onSave(buildPayload())}
          disabled={!canSubmit || saving || validating}
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 6, border: '1px solid #d1d5db',
            background: '#fff', color: '#374151', cursor: canSubmit ? 'pointer' : 'not-allowed',
            fontWeight: 600, fontSize: 14, opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer en brouillon'}
        </button>
        <button
          onClick={() => onValidate(buildPayload())}
          disabled={!canSubmit || saving || validating}
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 6, border: 'none',
            background: '#2563eb', color: '#fff', cursor: canSubmit ? 'pointer' : 'not-allowed',
            fontWeight: 600, fontSize: 14, opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {validating ? 'Validation…' : 'Valider le transfert'}
        </button>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Référence</p>
          <p style={{ margin: 0, fontWeight: 700, fontFamily: 'monospace' }}>{transfer.reference}</p>
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Statut</p>
          <StatusBadge status={transfer.status} />
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Date</p>
          <p style={{ margin: 0 }}>{formatDate(transfer.date)}</p>
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Source → Destination</p>
          <p style={{ margin: 0 }}>{fromName} → {toName}</p>
        </div>
      </div>

      {transfer.note && (
        <div style={{ background: '#f9fafb', borderRadius: 8, padding: 12, fontSize: 14, color: '#374151' }}>
          {transfer.note}
        </div>
      )}

      <div>
        <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Lignes ({transfer.details?.length ?? 0})</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Produit</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Quantité</th>
            </tr>
          </thead>
          <tbody>
            {(transfer.details ?? []).map((d) => {
              const prod = products.find((p) => p.id === d.productId);
              return (
                <tr key={d.id}>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                    {prod ? `${prod.code} — ${prod.name}` : d.productId}
                  </td>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {d.quantity}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {transfer.status === 'DRAFT' && (
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button
            onClick={onValidate}
            disabled={validating || deleting}
            style={{
              flex: 1, padding: '10px 16px', borderRadius: 6, border: 'none',
              background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              opacity: validating ? 0.7 : 1,
            }}
          >
            {validating ? 'Validation…' : 'Valider le transfert'}
          </button>
          <button
            onClick={onDelete}
            disabled={validating || deleting}
            style={{
              padding: '10px 16px', borderRadius: 6, border: '1px solid #dc2626',
              background: '#fff', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function TransfersPage() {
  const qc = useQueryClient();
  const { toasts, add: addToast, dismiss } = useToast();

  const [page, setPage]   = useState(1);
  const limit             = 20;
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [sheetOpen, setSheetOpen]     = useState(false);
  const [detailId, setDetailId]       = useState<string | null>(null);
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
      addToast('Transfert enregistré en brouillon.');
    } catch {
      addToast("Erreur lors de l'enregistrement.", 'error');
    }
  }

  async function handleValidateNew(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      await validateMutation.mutateAsync(created.id);
      setSheetOpen(false);
      addToast('Transfert validé. Stock mis à jour dans les deux entrepôts.');
    } catch {
      addToast('Erreur lors de la validation.', 'error');
    }
  }

  async function handleValidateExisting(id: string) {
    try {
      await validateMutation.mutateAsync(id);
      addToast('Transfert validé. Stock mis à jour dans les deux entrepôts.');
    } catch {
      addToast('Erreur lors de la validation.', 'error');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      addToast('Transfert supprimé.');
    } catch {
      addToast('Erreur lors de la suppression.', 'error');
    }
  }

  // ── État chargement ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Skeleton height={32} width={220} />
          <Skeleton height={36} width={160} />
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ marginBottom: 12 }}><Skeleton height={48} /></div>
        ))}
      </div>
    );
  }

  // ── État erreur ───────────────────────────────────────────────────────────
  if (isError) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <p style={{ color: '#dc2626', fontSize: 15, marginBottom: 12 }}>
          Impossible de charger les transferts.
        </p>
        <button
          onClick={() => void qc.invalidateQueries({ queryKey: ['transfers'] })}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
        >
          Réessayer
        </button>
      </div>
    );
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div style={{ padding: 32, maxWidth: 1100, margin: '0 auto' }}>
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>

      {/* ── En-tête ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Transferts de stock</h1>
        <button
          onClick={() => setSheetOpen(true)}
          style={{ padding: '9px 18px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
        >
          + Nouveau transfert
        </button>
      </div>

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <select
          value={filterFrom}
          onChange={(e) => { setFilterFrom(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous (source)</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select
          value={filterTo}
          onChange={(e) => { setFilterTo(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous (destination)</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous les statuts</option>
          <option value="DRAFT">Brouillon</option>
          <option value="VALIDATED">Validé</option>
        </select>
      </div>

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '64px 0', color: '#6b7280' }}>
          <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Aucun transfert</p>
          <p style={{ fontSize: 14, marginBottom: 20 }}>Créez votre premier transfert de stock entre entrepôts.</p>
          <button
            onClick={() => setSheetOpen(true)}
            style={{ padding: '9px 18px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          >
            + Nouveau transfert
          </button>
        </div>
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Référence', 'Date', 'Source', 'Destination', 'Statut', 'Lignes', 'Actions'].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const fromName = warehouses.find((w) => w.id === t.fromWarehouseId)?.name ?? '—';
              const toName   = warehouses.find((w) => w.id === t.toWarehouseId)?.name ?? '—';
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{t.reference}</td>
                  <td style={{ padding: '10px 12px' }}>{formatDate(t.date)}</td>
                  <td style={{ padding: '10px 12px' }}>{fromName}</td>
                  <td style={{ padding: '10px 12px' }}>{toName}</td>
                  <td style={{ padding: '10px 12px' }}><StatusBadge status={t.status} /></td>
                  <td style={{ padding: '10px 12px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {t.details?.length ?? '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button
                      onClick={() => setDetailId(t.id)}
                      style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}
                    >
                      Détail
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            ←
          </button>
          <span style={{ padding: '6px 10px', fontSize: 13 }}>{page} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            →
          </button>
        </div>
      )}

      {/* ── Sheet création ───────────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Nouveau transfert">
        <TransferForm
          warehouses={warehouses}
          products={products}
          onSave={(payload) => void handleSaveDraft(payload)}
          onValidate={(payload) => void handleValidateNew(payload)}
          saving={createMutation.isPending && !validateMutation.isPending}
          validating={validateMutation.isPending}
        />
      </Sheet>

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={detail ? `Transfert ${detail.reference}` : 'Chargement…'}
      >
        {detailLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}
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
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        title={`Supprimer le transfert ${deleteTarget?.reference ?? ''} ?`}
        description="Cette action est irréversible. Le transfert sera définitivement supprimé."
        confirmLabel="Supprimer"
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteMutation.isPending}
      />

      <ToastList toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
