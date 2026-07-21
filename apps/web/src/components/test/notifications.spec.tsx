import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from '../NotificationBell';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOTIF_ID = 'notif001-0000-0000-0000-000000000001';

function makeNotification(readAt: string | null = null) {
  return {
    id: NOTIF_ID,
    type: 'stock.lowAlert',
    payload: {
      productId: 'p1',
      productName: 'Riz Palmier',
      currentQuantity: '2',
      threshold: 5,
      warehouseId: 'w1',
    },
    readAt,
    createdAt: new Date().toISOString(),
  };
}

function renderBell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Par défaut : 0 non-lues, liste vide
  mockApi.get.mockResolvedValue({ count: 0 });
});

describe('NotificationBell', () => {
  it('affiche le badge avec le bon compteur quand il y a des non-lues', async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ count: 3 });
      return Promise.resolve({ data: [], total: 0, page: 1, limit: 20 });
    });

    renderBell();

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('ouvre le panel et liste les notifications au clic sur la cloche', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ count: 1 });
      return Promise.resolve({ data: [makeNotification()], total: 1, page: 1, limit: 20 });
    });

    renderBell();

    const bell = screen.getByRole('button', { name: /notifications/i });
    await user.click(bell);

    await waitFor(() => {
      expect(screen.getByText(/Riz Palmier/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 unités/i)).toBeInTheDocument();
  });

  it('bouton "Tout marquer comme lu" déclenche le PATCH read-all', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ count: 2 });
      return Promise.resolve({ data: [makeNotification()], total: 1, page: 1, limit: 20 });
    });
    mockApi.patch.mockResolvedValue({ updated: 2 });

    renderBell();

    const bell = screen.getByRole('button', { name: /notifications/i });
    await user.click(bell);

    await waitFor(() => {
      expect(screen.getByText(/Tout marquer comme lu/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Tout marquer comme lu/i));

    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledWith('/notifications/read-all', {});
    });
  });
});
