import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationService } from '../notification.service';
import { PrismaService } from '../../../common/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_ID   = 'org00001-0000-0000-0000-000000000001';
const USER_A   = 'user0001-0000-0000-0000-000000000001';
const USER_B   = 'user0002-0000-0000-0000-000000000002';
const NOTIF_ID = 'notif001-0000-0000-0000-000000000001';

const BASE_NOTIF = {
  id: NOTIF_ID,
  organizationId: ORG_ID,
  userId: USER_A,
  type: 'stock.lowAlert',
  payload: { productId: 'p1', productName: 'Riz', currentQuantity: '5', threshold: 10, warehouseId: 'w1' },
  readAt: null,
  createdAt: new Date('2026-07-21T10:00:00Z'),
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  let service: NotificationService;

  let prisma: {
    user: { findMany: jest.Mock };
    notification: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const toEmit = jest.fn();

  beforeEach(async () => {
    const prismaMock = {
      user: { findMany: jest.fn() },
      notification: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    // Par défaut $transaction exécute les deux requêtes en parallèle
    prismaMock.$transaction.mockImplementation((arr: unknown[]) =>
      Promise.all(arr as Promise<unknown>[]),
    );

    const rtMock = { server: { to: jest.fn().mockReturnValue({ emit: toEmit }) } };

    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService,   useValue: prismaMock },
        { provide: RealtimeGateway, useValue: rtMock },
      ],
    }).compile();

    service = module.get(NotificationService);
    prisma  = prismaMock;
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createForOrg ─────────────────────────────────────────────────────────

  it('createForOrg : crée une notification par utilisateur ayant la permission', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: USER_A }, { id: USER_B }]);
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    await service.createForOrg(ORG_ID, 'stock.lowAlert', { productId: 'p1' }, 'reports.quantityAlerts');

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: USER_A, organizationId: ORG_ID, type: 'stock.lowAlert' }),
        expect.objectContaining({ userId: USER_B, organizationId: ORG_ID, type: 'stock.lowAlert' }),
      ]),
    });
    // emit appelé pour chacun
    expect(toEmit).toHaveBeenCalledTimes(2);
  });

  it('createForOrg : ne crée rien et ne lève pas si aucun utilisateur avec la permission', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await expect(
      service.createForOrg(ORG_ID, 'stock.lowAlert', {}, 'reports.quantityAlerts'),
    ).resolves.toBeUndefined();

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalled();
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  it('findAll : retourne les notifications paginées avec filtre unreadOnly', async () => {
    const notifs = [BASE_NOTIF];
    prisma.$transaction.mockResolvedValue([notifs, 1]);

    const result = await service.findAll(ORG_ID, USER_A, 1, 20, true);

    expect(result).toEqual({ data: notifs, total: 1, page: 1, limit: 20 });
    // Le where doit inclure readAt: null pour unreadOnly
    const findManyArg = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(findManyArg).toHaveLength(2);
  });

  // ─── countUnread ──────────────────────────────────────────────────────────

  it('countUnread : retourne le nombre de notifications non lues', async () => {
    prisma.notification.count.mockResolvedValue(3);

    const count = await service.countUnread(ORG_ID, USER_A);

    expect(count).toBe(3);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, userId: USER_A, readAt: null },
    });
  });

  // ─── markAsRead ───────────────────────────────────────────────────────────

  it('markAsRead : pose readAt et retourne la notification mise à jour', async () => {
    prisma.notification.findFirst.mockResolvedValue(BASE_NOTIF);
    const updated = { ...BASE_NOTIF, readAt: new Date() };
    prisma.notification.update.mockResolvedValue(updated);

    const result = await service.markAsRead(NOTIF_ID, ORG_ID, USER_A);

    expect(result.readAt).toBeTruthy();
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: NOTIF_ID },
      data: expect.objectContaining({ readAt: expect.any(Date) }),
    });
  });

  it('markAsRead : lève ForbiddenException si la notification appartient à un autre utilisateur', async () => {
    prisma.notification.findFirst.mockResolvedValue({ ...BASE_NOTIF, userId: USER_B });

    await expect(service.markAsRead(NOTIF_ID, ORG_ID, USER_A)).rejects.toThrow(ForbiddenException);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('markAsRead : lève NotFoundException si la notification est introuvable', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(service.markAsRead(NOTIF_ID, ORG_ID, USER_A)).rejects.toThrow(NotFoundException);
  });

  // ─── markAllAsRead ────────────────────────────────────────────────────────

  it('markAllAsRead : met à jour toutes les notifications non lues et retourne le count', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 5 });

    const count = await service.markAllAsRead(ORG_ID, USER_A);

    expect(count).toBe(5);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, userId: USER_A, readAt: null },
      data: expect.objectContaining({ readAt: expect.any(Date) }),
    });
  });
});
