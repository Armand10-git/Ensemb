import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsService } from '../organizations.service';
import { PrismaService } from '../../../common/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

describe('OrganizationsService', () => {
  let service: OrganizationsService;

  const mockPrisma = {
    organization: {
      update: jest.fn(),
    },
  };

  const mockEmit = jest.fn();
  const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
  const mockRealtimeGateway = {
    server: { to: mockTo },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RealtimeGateway, useValue: mockRealtimeGateway },
      ],
    }).compile();

    service = module.get<OrganizationsService>(OrganizationsService);
  });

  const ORG_ID = 'org-uuid-1234';

  it('met à jour logoUrl seul et émet l\'événement', async () => {
    mockPrisma.organization.update.mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: null,
    });

    const result = await service.updateBranding(ORG_ID, { logoUrl: 'https://cdn.example.com/logo.png' });

    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { logoUrl: 'https://cdn.example.com/logo.png' },
      select: { logoUrl: true, primaryColor: true },
    });
    expect(result).toEqual({ logoUrl: 'https://cdn.example.com/logo.png', primaryColor: null });
    expect(mockTo).toHaveBeenCalledWith(`org:${ORG_ID}`);
    expect(mockEmit).toHaveBeenCalledWith('organization:brandingUpdated', result);
  });

  it('met à jour primaryColor seul et émet l\'événement', async () => {
    mockPrisma.organization.update.mockResolvedValue({
      logoUrl: null,
      primaryColor: '#3B82F6',
    });

    const result = await service.updateBranding(ORG_ID, { primaryColor: '#3B82F6' });

    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { primaryColor: '#3B82F6' },
      select: { logoUrl: true, primaryColor: true },
    });
    expect(result).toEqual({ logoUrl: null, primaryColor: '#3B82F6' });
    expect(mockEmit).toHaveBeenCalledWith('organization:brandingUpdated', result);
  });

  it('met à jour les deux champs ensemble', async () => {
    mockPrisma.organization.update.mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#FFFFFF',
    });

    const result = await service.updateBranding(ORG_ID, {
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#FFFFFF',
    });

    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#FFFFFF' },
      select: { logoUrl: true, primaryColor: true },
    });
    expect(result).toEqual({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#FFFFFF',
    });
  });

  it('ne modifie aucun autre champ (pas de mass assignment)', async () => {
    mockPrisma.organization.update.mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: null,
    });

    await service.updateBranding(ORG_ID, { logoUrl: 'https://cdn.example.com/logo.png' });

    const callArgs = mockPrisma.organization.update.mock.calls[0][0] as { data: Record<string, unknown> };
    // Seul logoUrl doit être présent dans data
    expect(Object.keys(callArgs.data)).toEqual(['logoUrl']);
  });

  it('propage les erreurs DB sans les masquer', async () => {
    const dbError = new Error('DB connection lost');
    mockPrisma.organization.update.mockRejectedValue(dbError);

    await expect(
      service.updateBranding(ORG_ID, { logoUrl: 'https://cdn.example.com/logo.png' }),
    ).rejects.toThrow('DB connection lost');
  });
});
