import * as fs from 'fs';
import * as path from 'path';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse';
import { PrismaService } from '../../common/prisma.service';
import type { PaginatedResult } from '../../common/types';
import type { CreateClientDto, UpdateClientDto } from './dto/create-client.dto';
import type { CreateProviderDto, UpdateProviderDto } from './dto/create-provider.dto';
import { ImportRowSchema, type ImportReport, CSV_TEMPLATE_HEADERS } from './dto/import-partners.dto';

// ─── Types exposés ────────────────────────────────────────────────────────────

export interface PartnerSummary {
  id: string;
  code: number;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExcelExportJobData {
  organizationId: string;
  type: 'clients' | 'providers';
}

// ─── Seuil import synchrone/asynchrone ────────────────────────────────────────

/** Au-delà de ce nombre de lignes, l'import est délégué à BullMQ. */
const CSV_ASYNC_THRESHOLD = parseInt(process.env['CSV_ASYNC_THRESHOLD'] ?? '50', 10);

const PARTNER_SELECT = {
  id: true,
  code: true,
  name: true,
  email: true,
  phone: true,
  country: true,
  city: true,
  address: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Service partenaires tenant (S12 — Bloc C).
 *
 * Invariants de sécurité :
 *  - organizationId extrait de req.user, jamais de l'URL (anti-IDOR).
 *  - Chaque requête filtre sur organizationId ET deletedAt IS NULL.
 *  - code généré en transaction SERIALIZABLE — stub TODO S15b: remplacer par DocumentCounter.
 *  - Import CSV : validation zod ligne par ligne, jamais d'arrêt au premier échec.
 *  - Magic bytes vérifiés par le contrôleur (multer fileFilter) avant d'arriver ici.
 */
@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('excel') private readonly excelQueue: Queue<ExcelExportJobData>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Clients
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Retourne les clients actifs de l'organisation, paginés, filtrés et triés par code ASC.
   *
   * @param organizationId - scopé tenant
   * @param page           - page courante (base 1)
   * @param limit          - taille de page (max 100)
   * @param search         - recherche sur name / email (insensible à la casse)
   */
  async findAllClients(
    organizationId: string,
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedResult<PartnerSummary>> {
    return this.findAllPartners('client', organizationId, page, limit, search);
  }

  /**
   * Retourne un client par id, vérifié pour l'organisation.
   *
   * @param id             - UUID du client
   * @param organizationId - scopé tenant
   */
  async findOneClient(id: string, organizationId: string): Promise<PartnerSummary> {
    return this.findOnePartner('client', id, organizationId);
  }

  /**
   * Crée un client pour l'organisation.
   * Le code est généré en transaction SERIALIZABLE (MAX + 1) puis retenté sur P2002.
   *
   * @param organizationId - scopé tenant
   * @param dto            - champs validés par CreateClientSchema
   */
  async createClient(organizationId: string, dto: CreateClientDto): Promise<PartnerSummary> {
    return this.createPartner('client', organizationId, dto);
  }

  /**
   * Modifie un client existant (ownership vérifié avant).
   *
   * @param id             - UUID du client
   * @param organizationId - scopé tenant
   * @param dto            - champs à mettre à jour (partiel)
   */
  async updateClient(id: string, organizationId: string, dto: UpdateClientDto): Promise<PartnerSummary> {
    return this.updatePartner('client', id, organizationId, dto);
  }

  /**
   * Soft-delete d'un client (deletedAt = now()).
   * Interdit si le client est utilisé dans des ventes actives.
   *
   * @param id             - UUID du client
   * @param organizationId - scopé tenant
   */
  async removeClient(id: string, organizationId: string): Promise<void> {
    return this.removePartner('client', id, organizationId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Providers
  // ══════════════════════════════════════════════════════════════════════════

  /** @see findAllClients */
  async findAllProviders(
    organizationId: string,
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedResult<PartnerSummary>> {
    return this.findAllPartners('provider', organizationId, page, limit, search);
  }

  /** @see findOneClient */
  async findOneProvider(id: string, organizationId: string): Promise<PartnerSummary> {
    return this.findOnePartner('provider', id, organizationId);
  }

  /** @see createClient */
  async createProvider(organizationId: string, dto: CreateProviderDto): Promise<PartnerSummary> {
    return this.createPartner('provider', organizationId, dto);
  }

  /** @see updateClient */
  async updateProvider(id: string, organizationId: string, dto: UpdateProviderDto): Promise<PartnerSummary> {
    return this.updatePartner('provider', id, organizationId, dto);
  }

  /** @see removeClient */
  async removeProvider(id: string, organizationId: string): Promise<void> {
    return this.removePartner('provider', id, organizationId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Import CSV
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Importe des partenaires depuis un buffer CSV.
   * Validation zod ligne par ligne — les lignes invalides sont ignorées et rapportées.
   * Import synchrone si ≤ CSV_ASYNC_THRESHOLD lignes, délégué à BullMQ sinon.
   *
   * @param organizationId - scopé tenant
   * @param type           - 'clients' | 'providers'
   * @param buffer         - contenu du fichier CSV (max 5 Mo vérifié par multer)
   */
  async importFromCsv(
    organizationId: string,
    type: 'clients' | 'providers',
    buffer: Buffer,
  ): Promise<ImportReport> {
    const rows = await this.parseCsvBuffer(buffer);

    const validRows: Record<string, string>[] = [];
    const errors: { line: number; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const lineNum = i + 2; // ligne 1 = en-têtes
      const result = ImportRowSchema.safeParse(rows[i]);
      if (result.success) {
        validRows.push(rows[i] as Record<string, string>);
      } else {
        const msg = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        errors.push({ line: lineNum, message: msg });
      }
    }

    if (validRows.length === 0) {
      return { imported: 0, errors };
    }

    let imported = 0;
    for (const row of validRows) {
      try {
        if (type === 'clients') {
          await this.createPartner('client', organizationId, {
            name:    row['name'] ?? '',
            email:   row['email'] || undefined,
            phone:   row['phone'] || undefined,
            country: row['country'] || undefined,
            city:    row['city'] || undefined,
            address: row['address'] || undefined,
          });
        } else {
          await this.createPartner('provider', organizationId, {
            name:    row['name'] ?? '',
            email:   row['email'] || undefined,
            phone:   row['phone'] || undefined,
            country: row['country'] || undefined,
            city:    row['city'] || undefined,
            address: row['address'] || undefined,
          });
        }
        imported++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Import ${type} org ${organizationId} : ligne ignorée — ${msg}`);
      }
    }

    return { imported, errors };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Export Excel (BullMQ)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Enfile un job BullMQ d'export Excel pour l'organisation.
   * La génération et l'émission Socket.io se font dans ExcelWorker (WorkerModule).
   *
   * @param organizationId - scopé tenant
   * @param type           - 'clients' | 'providers'
   */
  async requestExcelExport(
    organizationId: string,
    type: 'clients' | 'providers',
  ): Promise<{ jobId: string }> {
    const job = await this.excelQueue.add('partners.export', { organizationId, type });
    return { jobId: job.id ?? 'unknown' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Modèle CSV template
  // ══════════════════════════════════════════════════════════════════════════

  /** Retourne le contenu du modèle CSV prêt à télécharger. */
  getCsvTemplate(): string {
    return CSV_TEMPLATE_HEADERS;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Téléchargement d'un export Excel
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Retourne le chemin absolu d'un fichier Excel exporté après vérification ownership.
   * Le filename doit commencer par l'organizationId du token (anti-IDOR).
   *
   * @param organizationId - scopé tenant (depuis req.user)
   * @param filename       - nom du fichier demandé (format : <orgId>-<type>-<ts>.xlsx)
   */
  resolveExportPath(organizationId: string, filename: string): string {
    if (!filename.startsWith(organizationId)) {
      throw new ForbiddenException('Accès refusé à ce fichier.');
    }
    const filePath = path.join(process.cwd(), 'storage', 'exports', organizationId, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Fichier introuvable ou expiré.');
    }
    return filePath;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Implémentations génériques privées
  // ══════════════════════════════════════════════════════════════════════════

  private async findAllPartners(
    entity: 'client' | 'provider',
    organizationId: string,
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedResult<PartnerSummary>> {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage  = Math.max(1, page);

    const where = this.buildWhere(organizationId, search);

    if (entity === 'client') {
      const [data, total] = await Promise.all([
        this.prisma.client.findMany({
          where,
          select: PARTNER_SELECT,
          orderBy: { code: 'asc' },
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
        }),
        this.prisma.client.count({ where }),
      ]);
      return { data, total, page: safePage, limit: safeLimit };
    } else {
      const [data, total] = await Promise.all([
        this.prisma.provider.findMany({
          where,
          select: PARTNER_SELECT,
          orderBy: { code: 'asc' },
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
        }),
        this.prisma.provider.count({ where }),
      ]);
      return { data, total, page: safePage, limit: safeLimit };
    }
  }

  private async findOnePartner(
    entity: 'client' | 'provider',
    id: string,
    organizationId: string,
  ): Promise<PartnerSummary> {
    const record = entity === 'client'
      ? await this.prisma.client.findUnique({
          where: { id },
          select: { ...PARTNER_SELECT, organizationId: true, deletedAt: true },
        })
      : await this.prisma.provider.findUnique({
          where: { id },
          select: { ...PARTNER_SELECT, organizationId: true, deletedAt: true },
        });

    const label = entity === 'client' ? 'Client' : 'Fournisseur';
    if (!record || record.deletedAt !== null) {
      throw new NotFoundException(`${label} introuvable (id: ${id}).`);
    }
    if (record.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { organizationId: _oid, deletedAt: _d, ...result } = record;
    return result;
  }

  private async createPartner(
    entity: 'client' | 'provider',
    organizationId: string,
    dto: CreateClientDto | CreateProviderDto,
  ): Promise<PartnerSummary> {
    // TODO S15b: remplacer par DocumentCounter incrémenté transactionnellement
    // Génération du code séquentiel en transaction SERIALIZABLE pour éviter les collisions.
    // La contrainte @@unique([organizationId, code]) est le filet de sécurité final.
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const agg = entity === 'client'
              ? await tx.client.aggregate({
                  where: { organizationId },
                  _max: { code: true },
                })
              : await tx.provider.aggregate({
                  where: { organizationId },
                  _max: { code: true },
                });

            const nextCode = (agg._max.code ?? 0) + 1;

            if (entity === 'client') {
              return tx.client.create({
                data: { organizationId, code: nextCode, ...dto },
                select: PARTNER_SELECT,
              });
            } else {
              return tx.provider.create({
                data: { organizationId, code: nextCode, ...dto },
                select: PARTNER_SELECT,
              });
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          attempt < MAX_RETRIES - 1
        ) {
          // Collision concurrente rare sur (organizationId, code) — on réessaie
          continue;
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const targets = (err.meta?.target as string[] | undefined) ?? [];
          const isName = targets.some(t => t.includes('name'));
          const label = entity === 'client' ? 'client' : 'fournisseur';
          throw new ConflictException(
            isName
              ? `Un ${label} actif avec ce nom existe déjà dans cette organisation.`
              : `Conflit de code — veuillez réessayer.`,
          );
        }
        throw err;
      }
    }
    throw new ConflictException('Impossible de générer un code unique après plusieurs tentatives.');
  }

  private async updatePartner(
    entity: 'client' | 'provider',
    id: string,
    organizationId: string,
    dto: UpdateClientDto | UpdateProviderDto,
  ): Promise<PartnerSummary> {
    await this.findOnePartner(entity, id, organizationId);
    try {
      if (entity === 'client') {
        return await this.prisma.client.update({
          where: { id },
          data: dto,
          select: PARTNER_SELECT,
        });
      } else {
        return await this.prisma.provider.update({
          where: { id },
          data: dto,
          select: PARTNER_SELECT,
        });
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const label = entity === 'client' ? 'client' : 'fournisseur';
        throw new ConflictException(`Un ${label} actif avec ce nom existe déjà dans cette organisation.`);
      }
      throw err;
    }
  }

  private async removePartner(
    entity: 'client' | 'provider',
    id: string,
    organizationId: string,
  ): Promise<void> {
    await this.findOnePartner(entity, id, organizationId);

    // TODO S19: vérifier Sale.clientId avant suppression d'un client
    if (entity === 'client') {
      await this.prisma.client.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } else {
      await this.prisma.provider.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Utilitaires privés
  // ══════════════════════════════════════════════════════════════════════════

  private buildWhere(
    organizationId: string,
    search?: string,
  ): Prisma.ClientWhereInput & Prisma.ProviderWhereInput {
    const base: Prisma.ClientWhereInput & Prisma.ProviderWhereInput = {
      organizationId,
      deletedAt: null,
    };
    if (search) {
      base.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    return base;
  }

  /** Parse un buffer CSV en tableau de records. */
  private parseCsvBuffer(buffer: Buffer): Promise<Record<string, string>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, string>[] = [];
      const parser = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
      parser.on('readable', () => {
        let record: Record<string, string> | null;
        while ((record = parser.read() as Record<string, string> | null) !== null) {
          rows.push(record);
        }
      });
      parser.on('error', reject);
      parser.on('end', () => resolve(rows));
    });
  }
}

export { CSV_ASYNC_THRESHOLD };
