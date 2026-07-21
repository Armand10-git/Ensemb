import React, { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../../lib/api';

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

interface Toast { id: number; message: string; type: 'success' | 'error' }

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function makeEmptyRow(): DetailFormRow {
  return { productId: '', productVariantId: '', type: 'ADDITION', quantity: '', unitCost: '' };
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

function StatusBadge({ status }: { status: AdjustmentStatus }) {
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
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 1000,
        }}
      />
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 560,
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
        width: 400, boxShadow: '0 8px 32px rgba(0,0,0,.16)',
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

  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db',
    fontSize: 14, boxSizing: 'border-box',
  };

  function setRow<K extends keyof DetailFormRow>(idx: number, key: K, value: DetailFormRow[K]) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
  }

  function addRow() { setRows((prev) => [...prev, makeEmptyRow()]); }
  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Entrepôt *</label>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={fieldStyle}>
          <option value="">— Sélectionner un entrepôt —</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date *</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} style={{ ...fieldStyle, resize: 'vertical' }} placeholder="Raison de l'ajustement…" />
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
              <select value={row.productId} onChange={(e) => setRow(idx, 'productId', e.target.value)} style={fieldStyle}>
                <option value="">— Produit —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
              {rows.length > 1 && (
                <button onClick={() => removeRow(idx)} style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, cursor: 'pointer', padding: '0 10px', fontWeight: 700 }}>×</button>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Type</label>
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {(['ADDITION', 'SOUSTRACTION'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setRow(idx, 'type', t)}
                      style={{
                        flex: 1, padding: '6px 4px', borderRadius: 6, border: '1px solid',
                        borderColor: row.type === t ? '#2563eb' : '#d1d5db',
                        background: row.type === t ? '#eff6ff' : '#fff',
                        color: row.type === t ? '#2563eb' : '#374151',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {t === 'ADDITION' ? '＋ Addition' : '－ Soustraction'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Quantité *</label>
                <input
                  type="text"
                  value={row.quantity}
                  onChange={(e) => setRow(idx, 'quantity', e.target.value)}
                  placeholder="ex. 10"
                  style={{ ...fieldStyle, marginTop: 4 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Coût unitaire (XAF)</label>
                <input
                  type="text"
                  value={row.unitCost}
                  onChange={(e) => setRow(idx, 'unitCost', e.target.value)}
                  placeholder="0"
                  style={{ ...fieldStyle, marginTop: 4 }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
        <button
          onClick={() => onSave(buildPayload())}
          disabled={!canSubmit || saving}
          style={{
            flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #d1d5db',
            background: canSubmit && !saving ? '#fff' : '#f9fafb',
            color: canSubmit && !saving ? '#374151' : '#9ca3af',
            fontWeight: 600, cursor: canSubmit && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer en brouillon'}
        </button>

        <button
          onClick={() => onValidate(buildPayload())}
          disabled={!canSubmit || validating}
          style={{
            flex: 1, padding: '10px', borderRadius: 8, border: 'none',
            background: canSubmit && !validating ? '#2563eb' : '#93c5fd',
            color: '#fff', fontWeight: 600,
            cursor: canSubmit && !validating ? 'pointer' : 'default',
          }}
        >
          {validating ? 'Validation…' : 'Valider le stock'}
        </button>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Référence</div>
          <div style={{ fontWeight: 600 }}>{adjustment.reference}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Statut</div>
          <StatusBadge status={adjustment.status} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Date</div>
          <div>{formatDate(adjustment.date)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Entrepôt</div>
          <div>{warehouseName}</div>
        </div>
        {adjustment.note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Note</div>
            <div style={{ fontSize: 14 }}>{adjustment.note}</div>
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Lignes ({adjustment.details?.length ?? 0})</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', border: '1px solid #e5e7eb', fontWeight: 600 }}>Produit</th>
              <th style={{ padding: '8px 10px', textAlign: 'center', border: '1px solid #e5e7eb', fontWeight: 600 }}>Type</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600 }}>Quantité</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600 }}>Coût unit.</th>
            </tr>
          </thead>
          <tbody>
            {(adjustment.details ?? []).map((d) => (
              <tr key={d.id}>
                <td style={{ padding: '8px 10px', border: '1px solid #e5e7eb' }}>{productName(d.productId)}</td>
                <td style={{ padding: '8px 10px', border: '1px solid #e5e7eb', textAlign: 'center' }}>
                  <span style={{ color: d.type === 'ADDITION' ? '#15803d' : '#dc2626', fontWeight: 600 }}>
                    {d.type === 'ADDITION' ? '＋' : '－'}
                  </span>
                </td>
                <td style={{ padding: '8px 10px', border: '1px solid #e5e7eb', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.quantity}</td>
                <td style={{ padding: '8px 10px', border: '1px solid #e5e7eb', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {Number(d.unitCost) === 0 ? '—' : new Intl.NumberFormat('fr-CM', { style: 'currency', currency: 'XAF', maximumFractionDigits: 0 }).format(Number(d.unitCost))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adjustment.status === 'DRAFT' && (
        <button
          onClick={onValidate}
          disabled={validating}
          style={{
            padding: '10px', borderRadius: 8, border: 'none',
            background: validating ? '#93c5fd' : '#2563eb',
            color: '#fff', fontWeight: 600, cursor: validating ? 'default' : 'pointer',
          }}
        >
          {validating ? 'Validation en cours…' : 'Valider — mettre à jour le stock'}
        </button>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function AdjustmentsPage() {
  const qc = useQueryClient();
  const { toasts, add: addToast, dismiss } = useToast();

  const [page, setPage]             = useState(1);
  const [filterWh, setFilterWh]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [showCreate, setShowCreate]     = useState(false);
  const [detailId, setDetailId]         = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Adjustment | null>(null);

  // Données
  const { data, isLoading, isError } = useAdjustments(page, 20, filterWh, filterStatus);
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
        addToast('Ajustement enregistré en brouillon.');
      },
      onError: (e: Error) => addToast(e.message, 'error'),
    });
  }

  function handleCreateAndValidate(payload: unknown) {
    createMut.mutate(payload, {
      onSuccess: (adj) => {
        validateMut.mutate(adj.id, {
          onSuccess: () => {
            setShowCreate(false);
            addToast('Stock mis à jour. Ajustement validé.');
          },
          onError: (e: Error) => addToast(e.message, 'error'),
        });
      },
      onError: (e: Error) => addToast(e.message, 'error'),
    });
  }

  // Handler validation depuis le détail
  function handleValidateDetail() {
    if (!detailId) return;
    validateMut.mutate(detailId, {
      onSuccess: () => addToast('Stock mis à jour. Ajustement validé.'),
      onError: (e: Error) => addToast(e.message, 'error'),
    });
  }

  // Handler suppression
  function handleDelete() {
    if (!deleteTarget) return;
    deleteMut.mutate(deleteTarget.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        addToast('Ajustement supprimé.');
      },
      onError: (e: Error) => {
        setDeleteTarget(null);
        addToast(e.message, 'error');
      },
    });
  }

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  // ─── Rendu ─────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
      <ToastList toasts={toasts} onDismiss={dismiss} />

      <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
        {/* En-tête */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Ajustements de stock</h1>
            <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Gérez les entrées et sorties manuelles de stock.</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
          >
            + Nouvel ajustement
          </button>
        </div>

        {/* Filtres */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <select
            value={filterWh}
            onChange={(e) => { setFilterWh(e.target.value); setPage(1); }}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          >
            <option value="">Tous les entrepôts</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          >
            <option value="">Tous les statuts</option>
            <option value="DRAFT">Brouillon</option>
            <option value="VALIDATED">Validé</option>
          </select>
        </div>

        {/* État chargement */}
        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={44} />)}
          </div>
        )}

        {/* État erreur */}
        {isError && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#dc2626' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠</div>
            <div style={{ fontWeight: 600 }}>Impossible de charger les ajustements</div>
            <button
              onClick={() => void qc.invalidateQueries({ queryKey: ['adjustments'] })}
              style={{ marginTop: 12, padding: '8px 16px', borderRadius: 6, border: '1px solid #dc2626', color: '#dc2626', background: '#fff', cursor: 'pointer' }}
            >
              Réessayer
            </button>
          </div>
        )}

        {/* État vide */}
        {!isLoading && !isError && (data?.data ?? []).length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: '#6b7280' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
            <div style={{ fontWeight: 600, fontSize: 17 }}>Aucun ajustement</div>
            <p style={{ margin: '8px 0 24px', fontSize: 14 }}>Créez votre premier ajustement pour corriger le stock.</p>
            <button
              onClick={() => setShowCreate(true)}
              style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
            >
              + Nouvel ajustement
            </button>
          </div>
        )}

        {/* Tableau */}
        {!isLoading && !isError && (data?.data ?? []).length > 0 && (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', border: '1px solid #e5e7eb', fontWeight: 600 }}>Référence</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', border: '1px solid #e5e7eb', fontWeight: 600 }}>Date</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', border: '1px solid #e5e7eb', fontWeight: 600 }}>Entrepôt</th>
                  <th style={{ padding: '10px 12px', textAlign: 'center', border: '1px solid #e5e7eb', fontWeight: 600 }}>Statut</th>
                  <th style={{ padding: '10px 12px', textAlign: 'center', border: '1px solid #e5e7eb', fontWeight: 600 }}>Lignes</th>
                  <th style={{ padding: '10px 12px', textAlign: 'center', border: '1px solid #e5e7eb', fontWeight: 600 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data!.data.map((adj) => {
                  const wh = warehouses.find((w) => w.id === adj.warehouseId);
                  return (
                    <tr key={adj.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                        {adj.reference}
                      </td>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb' }}>{formatDate(adj.date)}</td>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb', color: '#4b5563' }}>{wh?.name ?? '—'}</td>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb', textAlign: 'center' }}>
                        <StatusBadge status={adj.status} />
                      </td>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb', textAlign: 'center', color: '#6b7280' }}>—</td>
                      <td style={{ padding: '10px 12px', border: '1px solid #e5e7eb', textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                          <button
                            onClick={() => setDetailId(adj.id)}
                            style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}
                          >
                            Voir
                          </button>
                          {adj.status === 'DRAFT' && (
                            <button
                              onClick={() => setDeleteTarget(adj)}
                              style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}
                            >
                              Supprimer
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 13, color: '#6b7280' }}>
              <span>{total} ajustement{total !== 1 ? 's' : ''}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: page <= 1 ? 'default' : 'pointer' }}>
                  ← Précédent
                </button>
                <span style={{ lineHeight: '30px' }}>Page {page} / {totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: page >= totalPages ? 'default' : 'pointer' }}>
                  Suivant →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Sheet — Création */}
      <Sheet open={showCreate} onClose={() => setShowCreate(false)} title="Nouvel ajustement">
        <AdjustmentForm
          warehouses={warehouses}
          products={products}
          onSave={handleSaveDraft}
          onValidate={handleCreateAndValidate}
          saving={createMut.isPending}
          validating={createMut.isPending && validateMut.isPending}
        />
      </Sheet>

      {/* Sheet — Détail */}
      <Sheet
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={detail ? `Ajustement ${detail.reference}` : 'Détail'}
      >
        {detailLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={36} />)}
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
      </Sheet>

      {/* AlertDialog — Suppression */}
      <AlertDialog
        open={deleteTarget !== null}
        title={`Supprimer l'ajustement ${deleteTarget?.reference ?? ''} ?`}
        description="Cette action est irréversible. L'ajustement brouillon sera définitivement supprimé."
        confirmLabel="Supprimer"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteMut.isPending}
      />
    </>
  );
}
