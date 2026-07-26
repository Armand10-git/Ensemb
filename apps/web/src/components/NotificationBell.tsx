import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { Bell, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LowAlertPayload {
  productId: string;
  productName: string;
  currentQuantity: string;
  threshold: number;
  warehouseId: string;
}

interface AppNotification {
  id: string;
  type: string;
  payload: LowAlertPayload;
  readAt: string | null;
  createdAt: string;
}

interface PaginatedNotifications {
  data: AppNotification[];
  total: number;
  page: number;
  limit: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

// ─── Composant principal ──────────────────────────────────────────────────────

export function NotificationBell(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Badge — polling 30 s + incrément via Socket.io
  const { data: countData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
    retry: false,
  });

  const unreadCount = countData?.count ?? 0;

  // Liste des 20 dernières notifications (chargée à l'ouverture du panel)
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () =>
      api.get<PaginatedNotifications>('/notifications?limit=20'),
    enabled: open,
    retry: false,
  });

  const notifications = listData?.data ?? [];

  // Marquer une notification comme lue
  const markReadMutation = useMutation({
    mutationFn: (id: string) =>
      api.patch<AppNotification>(`/notifications/${id}/read`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Tout marquer comme lu
  const markAllReadMutation = useMutation({
    mutationFn: () => api.patch<{ updated: number }>('/notifications/read-all', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Socket.io — écoute notification:new → badge++
  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const wsUrl = import.meta.env.VITE_WS_URL ?? 'http://localhost:3000';
    const socket: Socket = io(`${wsUrl}/realtime`, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('notification:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
      if (open) {
        void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient, open]);

  // Ferme le panel au clic extérieur
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleNotificationClick = useCallback(
    (n: AppNotification) => {
      if (!n.readAt) {
        markReadMutation.mutate(n.id);
      }
    },
    [markReadMutation],
  );

  return (
    <div className="relative" ref={panelRef}>
      {/* Bouton cloche */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none"
      >
        <Bell className="h-5 w-5" strokeWidth={1.8} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Panel notifications"
          className="absolute right-0 z-50 mt-2 w-96 overflow-hidden rounded-card border border-neutral-200 bg-white shadow-2 animate-in fade-in-0 zoom-in-95"
        >
          {/* En-tête */}
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
            <h2 className="font-display text-[14px] font-semibold text-neutral-800">Notifications</h2>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                className="text-[12.5px] font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
              >
                Tout marquer comme lu
              </button>
            )}
          </div>

          {/* Corps */}
          <div className="max-h-96 divide-y divide-neutral-100 overflow-y-auto">
            {listLoading && (
              <div className="flex h-24 items-center justify-center text-[13px] text-neutral-400">
                Chargement…
              </div>
            )}

            {!listLoading && notifications.length === 0 && (
              <div className="flex h-24 flex-col items-center justify-center gap-1.5 text-[13px] text-neutral-400">
                <Bell className="h-7 w-7 opacity-30" strokeWidth={1.5} />
                <span>Aucune notification</span>
              </div>
            )}

            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleNotificationClick(n)}
                className={cn(
                  'w-full px-4 py-3 text-left transition-colors hover:bg-neutral-50',
                  !n.readAt && 'bg-brand-50/60',
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex-shrink-0 text-amber-600">
                    <TriangleAlert className="h-4 w-4" strokeWidth={1.8} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-neutral-800">
                      Stock bas&nbsp;: {n.payload.productName}
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-neutral-500">
                      {n.payload.currentQuantity} unités (seuil&nbsp;: {n.payload.threshold})
                    </p>
                    <p className="mt-1 text-[11.5px] text-neutral-400">{relativeTime(n.createdAt)}</p>
                  </div>

                  {!n.readAt && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-500" />}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
