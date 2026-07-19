import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import { PlatformAdminDashboardService } from '../platform-admin-dashboard.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockPrisma = {
  subscription: {
    findMany: jest.fn(),
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

    expect(mockPrisma.subscription.findMany).not.toHaveBeenCalled();
    expect(result.mrr).toBe('15000');
    expect(result.activeOrganizations).toBe(10);
  });

  it('calcule les métriques Prisma et écrit en cache si miss', async () => {
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.subscription.findMany.mockResolvedValue([
      { plan: { priceMonthly: new Decimal('5000') } },
      { plan: { priceMonthly: new Decimal('15000') } },
    ]);
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

    expect(mockRedis.set).toHaveBeenCalledWith('platform:dashboard:metrics', expect.any(String), 600);
    // MRR = 5000 + 15000 = 20000, retourné en string Decimal
    expect(result.mrr).toBe('20000');
    expect(result.activeOrganizations).toBe(2);
    expect(result.trialingOrganizations).toBe(3);
    expect(result.failedInvoices).toBe(5);
  });

  it('calcule le MRR en Decimal — pas de perte de précision float', async () => {
    mockRedis.get.mockResolvedValue(null);
    // Montant avec décimales
    mockPrisma.subscription.findMany.mockResolvedValue([
      { plan: { priceMonthly: new Decimal('10000.50') } },
      { plan: { priceMonthly: new Decimal('9999.50') } },
    ]);
    mockPrisma.subscription.count.mockResolvedValue(0);
    mockPrisma.organization.count.mockResolvedValue(0);
    mockPrisma.invoice.count.mockResolvedValue(0);

    const result = await service.getMetrics();

    expect(result.mrr).toBe('20000');
  });
});
