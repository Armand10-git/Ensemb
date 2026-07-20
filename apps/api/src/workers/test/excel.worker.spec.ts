import { Test } from '@nestjs/testing';
import { ExcelWorker } from '../excel.worker';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync:       jest.fn(),
  createReadStream: jest.fn(),
}));

jest.mock('exceljs', () => {
  const addRow    = jest.fn();
  const getRow    = jest.fn(() => ({ font: {}, commit: jest.fn() }));
  const writeFile = jest.fn().mockResolvedValue(undefined);
  const sheet     = { columns: [] as unknown[], addRow, getRow };
  const workbook  = {
    creator: '',
    created: new Date(),
    addWorksheet: jest.fn(() => sheet),
    xlsx: { writeFile },
  };
  // __esModule:true est requis pour que ts-jest honore `.default` avec esModuleInterop
  return { __esModule: true, default: { Workbook: jest.fn(() => workbook) } };
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';

const CLIENTS_ROW = [
  { code: 1, name: 'Acme', email: 'a@acme.cm', phone: null, country: 'CM', city: 'Douala', address: null },
];

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ExcelWorker', () => {
  let worker: ExcelWorker;
  let prisma: { client: { findMany: jest.Mock }; provider: { findMany: jest.Mock } };
  let gateway: { server: { to: jest.Mock } };

  beforeEach(async () => {
    const emitMock = jest.fn();
    const toMock   = jest.fn(() => ({ emit: emitMock }));

    prisma = {
      client:   { findMany: jest.fn().mockResolvedValue(CLIENTS_ROW) },
      provider: { findMany: jest.fn().mockResolvedValue([]) },
    };

    gateway = { server: { to: toMock } };

    const module = await Test.createTestingModule({
      providers: [
        ExcelWorker,
        { provide: PrismaService,    useValue: prisma },
        { provide: RealtimeGateway,  useValue: gateway },
      ],
    }).compile();

    worker = module.get(ExcelWorker);
  });

  it('génère un fichier Excel avec les bons en-têtes', async () => {
    const job = { name: 'partners.export', data: { organizationId: ORG_ID, type: 'clients' as const } };
    await worker.process(job as Parameters<typeof worker.process>[0]);

    const WorkbookMock = jest.requireMock<{ default: { Workbook: jest.Mock } }>('exceljs').default.Workbook;
    expect(WorkbookMock).toHaveBeenCalled();
    const wbInstance = WorkbookMock.mock.results[0]!.value as {
      addWorksheet: jest.Mock;
      xlsx: { writeFile: jest.Mock };
    };
    expect(wbInstance.addWorksheet).toHaveBeenCalledWith('Clients');
    expect(wbInstance.xlsx.writeFile).toHaveBeenCalled();
  });

  it('émet export:completed après génération réussie', async () => {
    const emitMock = jest.fn();
    (gateway.server.to as jest.Mock).mockReturnValue({ emit: emitMock });

    const job = { name: 'partners.export', data: { organizationId: ORG_ID, type: 'clients' as const } };
    await worker.process(job as Parameters<typeof worker.process>[0]);

    expect(gateway.server.to).toHaveBeenCalledWith(`org:${ORG_ID}`);
    expect(emitMock).toHaveBeenCalledWith('export:completed', expect.objectContaining({
      type: 'clients',
      filename: expect.stringContaining(ORG_ID),
      downloadUrl: expect.stringContaining('/export/download/'),
    }));
  });

  it("émet export:failed en cas d'erreur Prisma", async () => {
    prisma.client.findMany.mockRejectedValue(new Error('DB error'));
    const emitMock = jest.fn();
    (gateway.server.to as jest.Mock).mockReturnValue({ emit: emitMock });

    const job = { name: 'partners.export', data: { organizationId: ORG_ID, type: 'clients' as const } };
    await worker.process(job as Parameters<typeof worker.process>[0]);

    expect(emitMock).toHaveBeenCalledWith('export:failed', expect.objectContaining({
      type: 'clients',
    }));
  });

  it('ignore les jobs sans organizationId', async () => {
    const job = { name: 'partners.export', data: { organizationId: undefined, type: 'clients' as const } };
    await expect(
      worker.process(job as unknown as Parameters<typeof worker.process>[0]),
    ).resolves.toBeUndefined();
    expect(prisma.client.findMany).not.toHaveBeenCalled();
  });
});
