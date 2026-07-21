/**
 * Test d'intégration DocumentCounterService — critère principal S15b.
 *
 * Vérifie que N appels simultanés à nextReference (Promise.all) produisent
 * N références distinctes, sans collision ni trou.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaModule } from '../src/common/prisma.module';
import { DocumentCounterModule } from '../src/common/document-counter.module';
import { DocumentCounterService } from '../src/common/document-counter.service';
import { PrismaService } from '../src/common/prisma.service';

jest.setTimeout(30_000);

const SUFFIX = Date.now();
const ORG_SUBDOMAIN = `e2e-counter-${SUFFIX}`;

let prisma: PrismaClient;
let prismaService: PrismaService;
let documentCounterService: DocumentCounterService;
let orgId: string;

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = new PrismaClient();

  const org = await prisma.organization.create({
    data: { name: 'E2E Counter Org', subdomain: ORG_SUBDOMAIN },
  });
  orgId = org.id;

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      DocumentCounterModule,
    ],
  }).compile();

  prismaService = moduleRef.get(PrismaService);
  documentCounterService = moduleRef.get(DocumentCounterService);
});

afterAll(async () => {
  await prisma.documentCounter.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

// ─── Test de concurrence (critère principal S15b) ────────────────────────────

describe('DocumentCounterService — concurrence', () => {
  it('N=20 créations simultanées produisent 20 références distinctes sans collision ni trou', async () => {
    const N = 20;
    const YEAR = 2026;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        prismaService.$transaction(async (tx) =>
          documentCounterService.nextReference(tx, orgId, 'SALE', YEAR),
        ),
      ),
    );

    // Aucune collision
    const unique = new Set(results);
    expect(unique.size).toBe(N);

    // Aucun trou — les compteurs vont de 1 à N
    const counters = results
      .map((r) => parseInt(r.split('-')[2]!, 10))
      .sort((a, b) => a - b);

    expect(counters[0]).toBe(1);
    expect(counters[N - 1]).toBe(N);

    // Tous les entiers de 1 à N sont présents
    for (let i = 0; i < N; i++) {
      expect(counters[i]).toBe(i + 1);
    }
  });

  it("compteurs SALE et PURCHASE d'une même org sont indépendants (aucun cross-type)", async () => {
    const YEAR = 2025;

    const [refSale, refPurchase] = await Promise.all([
      prismaService.$transaction((tx) =>
        documentCounterService.nextReference(tx, orgId, 'SALE', YEAR),
      ),
      prismaService.$transaction((tx) =>
        documentCounterService.nextReference(tx, orgId, 'PURCHASE', YEAR),
      ),
    ]);

    // Les deux commencent à 1 — compteurs séparés
    expect(refSale).toBe('VTE-2025-000001');
    expect(refPurchase).toBe('ACH-2025-000001');
  });
});
