import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../lib/api';

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

function BellIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
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
        className="relative p-2 rounded-full hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        <BellIcon className="h-6 w-6 text-gray-600" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 text-xs font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Panel notifications"
          className="absolute right-0 mt-2 w-96 bg-white rounded-xl shadow-xl border border-gray-200 z-50 overflow-hidden"
        >
          {/* En-tête */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-800">Notifications</h2>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                className="text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                Tout marquer comme lu
              </button>
            )}
          </div>

          {/* Corps */}
          <div className="max-h-96 overflow-y-auto divide-y divide-gray-100">
            {listLoading && (
              <div className="flex items-center justify-center h-24 text-sm text-gray-400">
                Chargement…
              </div>
            )}

            {!listLoading && notifications.length === 0 && (
              <div className="flex flex-col items-center justify-center h-24 text-sm text-gray-400 gap-1">
                <BellIcon className="h-8 w-8 opacity-30" />
                <span>Aucune notification</span>
              </div>
            )}

            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleNotificationClick(n)}
                className={[
                  'w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors',
                  n.readAt ? 'bg-white' : 'bg-indigo-50',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  {/* Icône type */}
                  <span className="mt-0.5 text-amber-500 flex-shrink-0">⚠</span>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      Stock bas&nbsp;: {n.payload.productName}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {n.payload.currentQuantity} unités (seuil&nbsp;: {n.payload.threshold})
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{relativeTime(n.createdAt)}</p>
                  </div>

                  {!n.readAt && (
                    <span className="mt-1.5 h-2 w-2 rounded-full bg-indigo-500 flex-shrink-0" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
