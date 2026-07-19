import { Test } from '@nestjs/testing';
import { PlatformAdminDashboardService } from '../platform-admin-dashboard.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockPrisma = {
  $queryRaw: jest.fn(),
  subscription: {
    count: jest.fn(),
  },
  organization: {
    count: jest.fn(),
  },
  invoice: {
    count: jest.fn(),
  },
};

describe('PlatformAdminDashboardService', () => {
  let service: PlatformAdminDashboardService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get(PlatformAdminDashboardService);
  });

  it('retourne les données du cache si hit — Prisma non appelé', async () => {
    const cached = JSON.stringify({
      mrr: '15000',
      activeOrganizations: 10,
      trialingOrganizations: 5,
      suspendedOrganizations: 1,
      conversionRate: 0.6667,
      failedInvoices: 2,
      atRiskOrganizations: 3,
    });
    mockRedis.get.mockResolvedValue(cached);

    const result = await service.getMetrics();

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(result.mrr).toBe('15000');
    expect(result.activeOrganizations).toBe(10);
  });

  it('calcule les métriques via $queryRaw (MRR) et Prisma (compteurs), écrit en cache', async () => {
    mockRedis.get.mockResolvedValue(null);
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ mrr: '20000' }]);
    mockPrisma.subscription.count
      .mockResolvedValueOnce(2)   // activeCount
      .mockResolvedValueOnce(3)   // trialingCount
      .mockResolvedValueOnce(4)   // recentActive
      .mockResolvedValueOnce(2);  // recentExpired
    mockPrisma.organization.count
      .mockResolvedValueOnce(1)   // suspendedCount
      .mockResolvedValueOnce(2);  // atRiskCount
    mockPrisma.invoice.count.mockResolvedValue(5);

    const result = await service.getMetrics();

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith('platform:dashboard:metrics', expect.any(String), 600);
    expect(result.mrr).toBe('20000');
    expect(result.activeOrganizations).toBe(2);
    expect(result.trialingOrganizations).toBe(3);
    expect(result.failedInvoices).toBe(5);
  });

  it('MRR retourné en string Decimal exact — pas de perte de précision float', async () => {
    mockRedis.get.mockResolvedValue(null);
    // PostgreSQL retourne le SUM d'un NUMERIC comme string
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ mrr: '10000.50' }]);
    mockPrisma.subscription.count.mockResolvedValue(0);
    mockPrisma.organization.count.mockResolvedValue(0);
    mockPrisma.invoice.count.mockResolvedValue(0);

    const result = await service.getMetrics();

    // new Decimal('10000.50').toString() conserve la précision
    expect(result.mrr).toBe('10000.5');
    expect(typeof result.mrr).toBe('string');
  });
});
