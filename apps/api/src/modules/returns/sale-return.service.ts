import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { DocumentStatus, DocumentType, PaymentStatus, Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { convertToBase } from '@ensemb/utils';
import { PrismaService } from '../../common/prisma.service';
import { DocumentCounterService } from '../../common/document-counter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  ProductWarehouseService,
  OptimisticLockException,
} from '../inventory/product-warehouse.service';
import { pdfJobName, type PdfJobData } from '../pdf/pdf-job.types';
import type { CreateSaleReturnDto, SaleReturnDetailDto } from './dto/create-sale-return.dto';
import type { UpdateSaleReturnDto } from './dto/update-sale-return.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface SaleReturnDetailResponse {
  id: string;
  saleDetailId: string;
  productId: string;
  productVariantId: string | null;
  returnUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal | null;
  taxMethod: string | null;
  discount: Decimal | null;
  discountMethod: string | null;
  quantity: Decimal;
  total: Decimal;
}

export interface SaleReturnResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  userId: string;
  saleId: string;
  warehouseId: string;
  taxRate: Decimal | null;
  taxAmount: Decimal | null;
  discount: Decimal | null;
  shipping: Decimal | null;
  grandTotal: Decimal;
  paidAmount: Decimal;
  paymentStatus: PaymentStatus;
  status: DocumentStatus;
  notes: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sale?: { id: string; reference: string };
  warehouse?: { id: string; name: string };
  details?: SaleReturnDetailResponse[];
}

/** Résultat d'un mouvement de stock appliqué par validate() — pour stock:updated. */
interface StockUpdate {
  productId: string;
  newQuantity: Decimal;
}

/** Ligne de retour après calcul serveur — jamais confiance dans un total client (§17 point A). */
interface ComputedReturnLine {
  saleDetailId: string;
  productId: string;
  productVariantId: string | null;
  returnUnitId: string | null;
  price: Decimal;
  taxAmount: Decimal;
  taxMethod: string;
  discount: Decimal;
  discountMethod: string;
  quantity: Decimal;
  total: Decimal;
}

// ─── Sélection commune ───────────────────────────────────────────────────────

const SALE_RETURN_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  userId: true,
  saleId: true,
  warehouseId: true,
  taxRate: true,
  taxAmount: true,
  discount: true,
  shipping: true,
  grandTotal: true,
  paidAmount: true,
  paymentStatus: true,
  status: true,
  notes: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DETAIL_SELECT = {
  id: true,
  saleDetailId: true,
  productId: true,
  productVariantId: true,
  returnUnitId: true,
  price: true,
  taxAmount: true,
  taxMethod: true,
  discount: true,
  discountMethod: true,
  quantity: true,
  total: true,
} as const;

const SALE_WAREHOUSE_INCLUDE = {
  sale: { select: { id: true, reference: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des retours de vente (S26 — Bloc F/E, §18.6), mirror du domaine Vente/Achat en sens
 * inverse partiel : create() suit le patron de SaleService.create (transaction simple, pas de
 * mouvement de stock), validate() suit le patron de PurchaseService.validate (incrément de stock
 * = mouvement commutatif, retry automatique sur conflit de concurrence).
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - Un retour ne peut être créé que sur un Sale COMPLETED de l'organisation — warehouseId est
 *    TOUJOURS copié depuis sale.warehouseId, jamais fourni par le client.
 *  - Chaque ligne référence une SaleDetail précise (saleDetailId) qui DOIT appartenir au Sale
 *    déclaré (dto.saleId) — vérifié dans la transaction (anti-IDOR + anti-TOCTOU) : une ligne
 *    de retour ne peut jamais référencer la ligne d'un AUTRE Sale que celui déclaré.
 *  - price/taxAmount/taxMethod/discount/discountMethod de chaque ligne sont TOUJOURS copiés
 *    depuis la SaleDetail source — jamais saisis par le client (anti-manipulation de prix sur
 *    un retour). Le total de ligne est recalculé côté serveur avec la même formule que
 *    SaleService.computeLineTotal, appliquée à la quantité RETOURNÉE (non convertie — la
 *    conversion d'unité ne sert qu'aux comparaisons de stock, jamais aux montants).
 *  - grandTotal = somme des totaux de ligne ; taxRate/taxAmount/discount/shipping d'en-tête
 *    restent à 0 (pas de remise/frais de port/TVA globale indépendante sur un retour partiel).
 *  - create() effectue une vérification best-effort (quantité retournée ≤ quantité vendue sur
 *    CETTE ligne) qui ignore les autres retours déjà existants — c'est une garde de bon sens,
 *    PAS la garde autoritative anti-concurrence. La garde AUTORITATIVE cumulée (qui tient
 *    compte de TOUS les retours COMPLETED déjà existants sur chaque ligne source) est faite
 *    dans validate(), sous transaction Serializable, seule capable de protéger contre le write
 *    skew de deux validations concurrentes sur la même ligne (cf. JSDoc de validate()).
 *  - Seul un retour PENDING peut être modifié ou supprimé (§17 point 7) ; un retour COMPLETED
 *    est immuable.
 *  - validate() est la seule action qui mouvemente le stock d'un retour de vente : incrément de
 *    ProductWarehouse via ProductWarehouseService.adjustStock (verrouillage optimiste,
 *    transaction Serializable), conversion d'unité returnUnitId → unité de stock du produit via
 *    convertToBase. Comme un achat (S25), un incrément ne peut jamais échouer pour cause de
 *    stock insuffisant, et l'absence de ProductWarehouse déclenche sa création (défensif —
 *    ne devrait normalement jamais arriver puisque la vente d'origine l'a forcément déjà créé).
 *  - Pas de stock:lowAlert émis par validate() : une incrémentation ne déclenche jamais une
 *    alerte de stock bas (mirror exact de PurchaseService.emitStockEvents) — aucun besoin
 *    d'injecter NotificationService dans ce service.
 */
@Injectable()
export class SaleReturnService {
  private readonly logger = new Logger(SaleReturnService.name);

  /**
   * Nombre maximal de tentatives de validate() en cas de conflit de concurrence
   * (OptimisticLockException / Prisma P2034) sur le ProductWarehouse cible OU sur la garde
   * autoritative cumulée (write skew Serializable, §17 point 5). Un incrément de stock étant
   * toujours fusionnable, on retente au lieu de remonter un 409 dès le premier conflit — mirror
   * exact du raisonnement de PurchaseService.MAX_VALIDATE_ATTEMPTS : au-delà de ce plafond
   * (beaucoup plus de 2 écrivains simultanés que ce que la session exerce en pratique), on
   * abandonne et on remonte ConflictException comme le ferait SaleService.validate() sans retry.
   */
  private static readonly MAX_VALIDATE_ATTEMPTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; returnId: string; to: string }>,
    @InjectQueue('sms')
    private readonly smsQueue: Queue<{ organizationId: string; returnId: string; to: string }>,
    // File BullMQ de génération PDF (S34) — mirror exact d'emailQueue/smsQueue.
    @InjectQueue('pdf')
    private readonly pdfQueue: Queue<PdfJobData>,
  ) {}

  /**
   * Crée un retour de vente en statut PENDING avec ses lignes dans une transaction simple
   * (pas de mouvement de stock — cf. validate()). Référence générée via
   * DocumentCounterService.nextReference. Émet saleReturn:created vers org:{organizationId}.
   *
   * @throws NotFoundException si la vente d'origine, une ligne de vente, un produit ou une
   *         unité de retour est introuvable.
   * @throws ForbiddenException si la vente n'appartient pas à l'organisation, ou si une ligne
   *         de retour référence une SaleDetail qui n'appartient pas à la vente déclarée (IDOR).
   * @throws BadRequestException si la vente n'est pas COMPLETED, ou si une quantité retournée
   *         dépasse (best-effort, cf. JSDoc de classe) la quantité vendue sur cette ligne.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateSaleReturnDto,
  ): Promise<SaleReturnResponse> {
    const saleReturn = await this.prisma.$transaction(async (tx) => {
      // 1. Charge la vente d'origine DANS la transaction (anti-TOCTOU).
      const sale = await tx.sale.findUnique({
        where: { id: dto.saleId },
        select: { id: true, organizationId: true, deletedAt: true, status: true, warehouseId: true },
      });

      if (!sale || sale.deletedAt !== null) {
        throw new NotFoundException("Vente d'origine introuvable.");
      }
      if (sale.organizationId !== organizationId) {
        throw new ForbiddenException("Accès refusé à la vente d'origine.");
      }
      if (sale.status !== 'COMPLETED') {
        throw new BadRequestException(
          "Impossible de créer un retour sur une vente qui n'est pas finalisée.",
        );
      }

      // 2. warehouseId toujours copié depuis la vente — jamais fourni par le client.
      const warehouseId = sale.warehouseId;

      // 3-5. Charge chaque SaleDetail source, vérifie l'IDOR et calcule les lignes.
      const computed = await this.computeReturnLines(tx, dto.saleId, dto.details);

      const grandTotal = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

      // 6. Référence via DocumentCounter.
      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.SALE_RETURN,
      );

      // 7. Création du SaleReturn + lignes en une seule opération imbriquée.
      return tx.saleReturn.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          userId,
          saleId: dto.saleId,
          warehouseId,
          taxRate: new Decimal(0),
          taxAmount: new Decimal(0),
          discount: new Decimal(0),
          shipping: new Decimal(0),
          grandTotal,
          paidAmount: new Decimal(0),
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          notes: dto.notes,
          details: { create: computed.map((d) => this.toDetailCreateInput(d)) },
        },
        select: { ...SALE_RETURN_SELECT, ...SALE_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });

    // 8. Émission temps réel.
    this.realtimeGateway.server.to(`org:${organizationId}`).emit('saleReturn:created', {
      organizationId,
      saleReturnId: saleReturn.id,
      saleId: saleReturn.saleId,
      warehouseId: saleReturn.warehouseId,
      grandTotal: saleReturn.grandTotal,
    });

    return saleReturn;
  }

  /**
   * Valide un retour de vente PENDING : incrémente le stock de l'entrepôt du retour pour
   * chaque ligne (regroupées par couple produit/variante, converties dans l'unité de stock du
   * produit via convertToBase si returnUnitId diffère), puis fait passer le statut à COMPLETED
   * — le tout dans une seule transaction Serializable.
   *
   * Le retour et ses lignes sont relus DANS la transaction Serializable pour éliminer le
   * TOCTOU. La garde AUTORITATIVE cumulée (quantité déjà retournée à travers TOUS les
   * SaleReturn COMPLETED existants sur chaque SaleDetail source + cette ligne ≤ quantité vendue
   * à l'origine) est appliquée ICI, dans la même transaction Serializable que le mouvement de
   * stock — c'est l'isolation Postgres qui empêche deux validations concurrentes sur la même
   * ligne de dépasser ensemble le plafond (write skew classique : chacune verrait « 0 déjà
   * retourné » si elles lisaient avant que l'autre commit ; Serializable détecte le conflit et
   * fait échouer l'une des deux avec une erreur de sérialisation P2034 — c'est voulu et NORMAL,
   * pas un bug, cf. rethrowStockConflict).
   *
   * ÉCART ASSUMÉ vs SaleService.validate() (documenté, pas un oubli), IDENTIQUE au raisonnement
   * de PurchaseService.validate() : cette méthode retente automatiquement (jusqu'à
   * MAX_VALIDATE_ATTEMPTS tentatives) sur un conflit de concurrence (OptimisticLockException ou
   * Prisma P2034), alors que SaleService.validate() ne retente jamais. La raison est
   * strictement métier : un incrément de stock (retour de vente) est commutatif et toujours
   * fusionnable — deux validations concurrentes de +5 et +7 ont pour seul résultat correct +12,
   * quel que soit l'ordre d'application. Un décrément de stock (vente) ne l'est pas : retenter
   * masquerait silencieusement une information métier (stock désormais insuffisant). Retenter
   * un retour ne rompt rien : dans le pire cas (MAX_VALIDATE_ATTEMPTS tentatives toutes en
   * conflit), on retombe sur le même ConflictException 409 que SaleService, en dernier recours.
   *
   * @throws NotFoundException si le retour, une SaleDetail source ou une unité référencée est
   *         introuvable.
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   * @throws BadRequestException si le retour n'est pas PENDING, ou si la quantité déjà
   *         retournée cumulée (tous retours COMPLETED confondus) + cette ligne dépasse la
   *         quantité vendue à l'origine.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation (P2034)
   *         persiste après MAX_VALIDATE_ATTEMPTS tentatives.
   */
  async validate(id: string, organizationId: string): Promise<SaleReturnResponse> {
    let stockUpdates: StockUpdate[] = [];
    let capturedWarehouseId!: string;

    for (let attempt = 1; attempt <= SaleReturnService.MAX_VALIDATE_ATTEMPTS; attempt++) {
      stockUpdates = [];
      try {
        await this.prisma.$transaction(
          async (tx) => {
            // 1. Relire le retour + lignes DANS la transaction Serializable (élimine le TOCTOU).
            const existing = await tx.saleReturn.findUnique({
              where: { id },
              select: { ...SALE_RETURN_SELECT, details: { select: DETAIL_SELECT } },
            });

            if (!existing || existing.deletedAt !== null) {
              throw new NotFoundException('Retour de vente introuvable.');
            }
            if (existing.organizationId !== organizationId) {
              throw new ForbiddenException('Accès refusé.');
            }
            if (existing.status !== 'PENDING') {
              throw new BadRequestException(
                'Seul un retour en attente (PENDING) peut être validé.',
              );
            }

            capturedWarehouseId = existing.warehouseId;

            // 2. Garde autoritative cumulée — cœur anti-concurrence de cette méthode.
            await this.enforceReturnQuantityCeiling(tx, existing.details);

            // 3-4. Regroupement par (productId, productVariantId) + incrément de stock
            // (création du ProductWarehouse si absent, aucune garde stock insuffisant).
            const grouped = await this.groupReturnDetailsByProduct(tx, existing.details);
            stockUpdates = await this.moveStock(tx, organizationId, existing.warehouseId, grouped);

            // 5. Statut
            await tx.saleReturn.update({ where: { id }, data: { status: 'COMPLETED' } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break; // succès — sort de la boucle de retry
      } catch (err) {
        const isConcurrencyConflict =
          err instanceof OptimisticLockException ||
          (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034');

        if (isConcurrencyConflict && attempt < SaleReturnService.MAX_VALIDATE_ATTEMPTS) {
          // Un incrément est toujours fusionnable — aucune décision métier perdue en retentant.
          continue;
        }
        // Dernière tentative épuisée (conflit persistant), ou erreur non liée à la concurrence
        // (NotFoundException/ForbiddenException/BadRequestException) : relancée immédiatement,
        // sans consommer de tentative supplémentaire pour ces dernières.
        this.rethrowStockConflict(err);
      }
    }

    // 6. Émission temps réel — stock:updated uniquement (pas de lowAlert sur un incrément).
    this.emitStockEvents(organizationId, capturedWarehouseId, stockUpdates);

    return this.prisma.saleReturn.findUniqueOrThrow({
      where: { id },
      select: { ...SALE_RETURN_SELECT, ...SALE_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
    });
  }

  /**
   * Retourne la liste paginée des retours de vente de l'organisation.
   * viewAll=false ajoute un filtre WHERE userId = userId (permission records.viewAll,
   * injectée par ViewAllInterceptor).
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    saleId?: string,
    warehouseId?: string,
    status?: DocumentStatus,
    paymentStatus?: PaymentStatus,
  ): Promise<PaginatedResult<SaleReturnResponse>> {
    const where: Prisma.SaleReturnWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(saleId ? { saleId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.saleReturn.findMany({
        where,
        select: SALE_RETURN_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.saleReturn.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un retour de vente par ID avec ses lignes, sa vente d'origine et son entrepôt.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<SaleReturnResponse> {
    const saleReturn = await this.prisma.saleReturn.findUnique({
      where: { id },
      select: { ...SALE_RETURN_SELECT, ...SALE_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
    });

    if (!saleReturn || saleReturn.deletedAt !== null) {
      throw new NotFoundException('Retour de vente introuvable.');
    }
    if (saleReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return saleReturn;
  }

  /**
   * Met à jour un retour de vente PENDING : lignes intégralement remplacées si `details` est
   * fourni (deleteMany + createMany dans la transaction, avec re-vérification IDOR contre le
   * MÊME saleId existant — réutilise computeReturnLines), grandTotal recalculé côté serveur
   * dans tous les cas. saleId et warehouseId ne sont jamais modifiables (cf. DTO).
   *
   * @throws BadRequestException si le retour n'est pas PENDING.
   * @throws NotFoundException / ForbiddenException — cf. create().
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateSaleReturnDto,
  ): Promise<SaleReturnResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.saleReturn.findUnique({
        where: { id },
        select: { ...SALE_RETURN_SELECT, details: { select: DETAIL_SELECT } },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException('Retour de vente introuvable.');
      }
      if (existing.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
      if (existing.status !== 'PENDING') {
        throw new BadRequestException(
          'Seul un retour en attente (PENDING) peut être modifié.',
        );
      }

      let grandTotal: Decimal;
      if (dto.details) {
        const computed = await this.computeReturnLines(tx, existing.saleId, dto.details);
        grandTotal = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

        await tx.saleReturnDetail.deleteMany({ where: { saleReturnId: id } });
        await tx.saleReturnDetail.createMany({
          data: computed.map((d) => ({ saleReturnId: id, ...this.toDetailCreateInput(d) })),
        });
      } else {
        grandTotal = existing.details.reduce(
          (acc, d) => acc.plus(new Decimal(d.total)),
          new Decimal(0),
        );
      }

      return tx.saleReturn.update({
        where: { id },
        data: {
          date: dto.date ? new Date(dto.date) : undefined,
          notes: dto.notes ?? undefined,
          grandTotal,
        },
        select: { ...SALE_RETURN_SELECT, ...SALE_WAREHOUSE_INCLUDE, details: { select: DETAIL_SELECT } },
      });
    });
  }

  /**
   * Soft-delete d'un retour de vente — uniquement si statut PENDING.
   * Un retour COMPLETED ne peut jamais être supprimé (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const saleReturn = await this.prisma.saleReturn.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!saleReturn || saleReturn.deletedAt !== null) {
      throw new NotFoundException('Retour de vente introuvable.');
    }
    if (saleReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (saleReturn.status !== 'PENDING') {
      throw new BadRequestException(
        'Seul un retour en attente (PENDING) peut être supprimé.',
      );
    }

    await this.prisma.saleReturn.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Envoie le récapitulatif d'un retour de vente au client par email ou SMS (S32/S33, mirror
   * exact de PurchaseReturnService.send). Enfile un job BullMQ
   * ('saleReturn.sendEmail'/'saleReturn.sendSms', file 'email'/'sms') consommé par le worker
   * dédié — aucun appel réseau synchrone, retourne dès que le job est enfilé.
   *
   * @param id - identifiant du retour à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @param channel - canal d'envoi : 'email' (nécessite client.email) ou 'sms' (nécessite client.phone).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si le retour est introuvable ou soft-supprimé.
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   * @throws BadRequestException si le client n'a pas de contact enregistré pour le canal demandé.
   */
  async send(
    id: string,
    organizationId: string,
    channel: 'email' | 'sms',
  ): Promise<{ status: 'queued' }> {
    const saleReturn = await this.prisma.saleReturn.findUnique({
      where: { id },
      select: {
        organizationId: true,
        deletedAt: true,
        sale: { select: { client: { select: { email: true, phone: true } } } },
      },
    });

    if (!saleReturn || saleReturn.deletedAt !== null) {
      throw new NotFoundException('Retour de vente introuvable.');
    }
    if (saleReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (channel === 'email') {
      const to = saleReturn.sale.client.email;
      if (!to) {
        throw new BadRequestException("Ce client n'a pas d'adresse email enregistrée.");
      }
      await this.emailQueue.add('saleReturn.sendEmail', { organizationId, returnId: id, to });
      return { status: 'queued' };
    }

    const to = saleReturn.sale.client.phone;
    if (!to) {
      throw new BadRequestException("Ce client n'a pas de numéro de téléphone enregistré.");
    }
    await this.smsQueue.add('saleReturn.sendSms', { organizationId, returnId: id, to });
    return { status: 'queued' };
  }

  /**
   * Enfile la génération PDF du retour de vente (S34) — mirror exact de SaleService.generatePdf.
   *
   * @param id - identifiant du retour à générer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @param requestedBy - utilisateur ayant déclenché la génération (traçabilité uniquement).
   * @returns `{ status: 'queued' }` dès que le job est enfilé.
   * @throws NotFoundException si le retour est introuvable ou soft-supprimé.
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   */
  async generatePdf(
    id: string,
    organizationId: string,
    requestedBy: string,
  ): Promise<{ status: 'queued' }> {
    const saleReturn = await this.prisma.saleReturn.findUnique({
      where: { id },
      select: { id: true, organizationId: true, deletedAt: true },
    });

    if (!saleReturn || saleReturn.deletedAt !== null) {
      throw new NotFoundException('Retour de vente introuvable.');
    }
    if (saleReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    await this.pdfQueue.add(pdfJobName('saleReturn'), {
      organizationId,
      documentType: 'saleReturn',
      documentId: id,
      requestedBy,
    });
    return { status: 'queued' };
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Charge chaque SaleDetail source référencée par les lignes du DTO, vérifie qu'elle
   * appartient bien au Sale déclaré (anti-IDOR — une ligne de retour ne doit jamais pouvoir
   * référencer la ligne d'un AUTRE Sale), effectue la vérification best-effort de quantité
   * (retour ≤ vendu sur CETTE ligne, ignorant les autres retours existants — la garde
   * autoritative cumulée est dans validate()), puis calcule chaque ligne (price/taxAmount/
   * taxMethod/discount/discountMethod copiés depuis la source, total recalculé côté serveur).
   * Partagé par create() et update().
   *
   * @throws NotFoundException si une SaleDetail, un produit ou une unité est introuvable.
   * @throws ForbiddenException si une SaleDetail n'appartient pas au Sale déclaré.
   * @throws BadRequestException si la quantité retournée dépasse (best-effort) la quantité
   *         vendue à l'origine sur cette ligne.
   */
  private async computeReturnLines(
    tx: Prisma.TransactionClient,
    saleId: string,
    details: SaleReturnDetailDto[],
  ): Promise<ComputedReturnLine[]> {
    const saleDetailIds = [...new Set(details.map((d) => d.saleDetailId))];
    const saleDetails = await tx.saleDetail.findMany({
      where: { id: { in: saleDetailIds } },
      select: {
        id: true,
        saleId: true,
        productId: true,
        productVariantId: true,
        saleUnitId: true,
        price: true,
        taxAmount: true,
        taxMethod: true,
        discount: true,
        discountMethod: true,
        quantity: true,
      },
    });
    const saleDetailMap = new Map(saleDetails.map((d) => [d.id, d]));

    // Vérifie l'existence + l'appartenance au Sale déclaré AVANT tout calcul (IDOR critique).
    for (const line of details) {
      const source = saleDetailMap.get(line.saleDetailId);
      if (!source) {
        throw new NotFoundException('Ligne de vente introuvable.');
      }
      if (source.saleId !== saleId) {
        throw new ForbiddenException(
          "Cette ligne n'appartient pas à la vente d'origine déclarée.",
        );
      }
    }

    // Unité de stock de chaque produit référencé (pour les conversions de comparaison).
    const productIds = [...new Set(saleDetails.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

    // Unit référencées par returnUnitId (lignes du retour) et saleUnitId (lignes sources).
    const unitIds = new Set<string>();
    for (const line of details) {
      if (line.returnUnitId) unitIds.add(line.returnUnitId);
    }
    for (const d of saleDetails) {
      if (d.saleUnitId) unitIds.add(d.saleUnitId);
    }
    const units =
      unitIds.size > 0
        ? await tx.unit.findMany({
            where: { id: { in: [...unitIds] } },
            select: { id: true, operator: true, operatorValue: true },
          })
        : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    return details.map((line) => {
      const source = saleDetailMap.get(line.saleDetailId)!;
      const productUnitId = productUnitMap.get(source.productId) ?? null;
      const quantity = new Decimal(line.quantity);

      // Vérification best-effort (§ JSDoc de classe) : conversion en unité de base pour comparer.
      let returnQtyBase = quantity;
      if (line.returnUnitId && line.returnUnitId !== productUnitId) {
        const unit = unitMap.get(line.returnUnitId);
        if (!unit) {
          throw new NotFoundException('Unité de retour introuvable.');
        }
        returnQtyBase = convertToBase(returnQtyBase, unit);
      }

      let sourceQtyBase = new Decimal(source.quantity);
      if (source.saleUnitId && source.saleUnitId !== productUnitId) {
        const unit = unitMap.get(source.saleUnitId);
        if (!unit) {
          throw new NotFoundException('Unité de vente introuvable.');
        }
        sourceQtyBase = convertToBase(sourceQtyBase, unit);
      }

      if (returnQtyBase.greaterThan(sourceQtyBase)) {
        throw new BadRequestException(
          `La quantité retournée (${returnQtyBase.toFixed(3)}) dépasse la quantité vendue à ` +
            `l'origine (${sourceQtyBase.toFixed(3)}).`,
        );
      }

      // Total recalculé côté serveur, avec la quantité RETOURNÉE (non convertie) et les
      // price/taxMethod/discountMethod copiés depuis la ligne source — jamais depuis le body
      // client (§17 point A + décision de conception S26).
      const price = new Decimal(source.price);
      const taxAmount = new Decimal(source.taxAmount ?? '0');
      const taxMethod = source.taxMethod ?? 'percentage';
      const discount = new Decimal(source.discount ?? '0');
      const discountMethod = source.discountMethod ?? 'percentage';
      const total = this.computeLineTotal({ price, quantity, taxAmount, taxMethod, discount, discountMethod });

      return {
        saleDetailId: line.saleDetailId,
        productId: source.productId,
        productVariantId: source.productVariantId,
        returnUnitId: line.returnUnitId ?? null,
        price,
        taxAmount,
        taxMethod,
        discount,
        discountMethod,
        quantity,
        total,
      };
    });
  }

  /**
   * Applique la garde autoritative cumulée (le cœur anti-concurrence de validate()) : pour
   * chaque SaleReturnDetail de ce retour, regroupé par saleDetailId (une même saleDetailId ne
   * devrait apparaître qu'une fois par retour en pratique, mais reste défensif ici), vérifie que
   * la quantité déjà retournée à travers TOUS les SaleReturn COMPLETED existants sur cette
   * SaleDetail, plus la quantité de cette ligne (toutes deux converties en unité de BASE du
   * produit), ne dépasse pas la quantité vendue à l'origine (également en unité de base).
   *
   * DOIT être appelée DANS la même transaction Serializable que le mouvement de stock qui suit
   * (cf. JSDoc de validate()) — c'est l'isolation Postgres, pas cette méthode elle-même, qui
   * empêche deux validations concurrentes de dépasser ensemble le plafond.
   *
   * @throws NotFoundException si une SaleDetail, un produit ou une unité est introuvable.
   * @throws BadRequestException si le total cumulé dépasse la quantité vendue à l'origine.
   */
  private async enforceReturnQuantityCeiling(
    tx: Prisma.TransactionClient,
    details: { saleDetailId: string; returnUnitId: string | null; quantity: Decimal }[],
  ): Promise<void> {
    const saleDetailIds = [...new Set(details.map((d) => d.saleDetailId))];

    const saleDetails = await tx.saleDetail.findMany({
      where: { id: { in: saleDetailIds } },
      select: { id: true, productId: true, saleUnitId: true, quantity: true },
    });
    const saleDetailMap = new Map(saleDetails.map((d) => [d.id, d]));

    const productIds = [...new Set(saleDetails.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

    // Tous les retours COMPLETED déjà existants sur ces mêmes lignes sources (ce retour-ci est
    // encore PENDING à ce stade — naturellement exclu du filtre status: 'COMPLETED').
    const priorReturnDetails = await tx.saleReturnDetail.findMany({
      where: { saleDetailId: { in: saleDetailIds }, saleReturn: { status: 'COMPLETED' } },
      select: { saleDetailId: true, quantity: true, returnUnitId: true },
    });

    const unitIds = new Set<string>();
    for (const d of details) if (d.returnUnitId) unitIds.add(d.returnUnitId);
    for (const d of saleDetails) if (d.saleUnitId) unitIds.add(d.saleUnitId);
    for (const p of priorReturnDetails) if (p.returnUnitId) unitIds.add(p.returnUnitId);

    const units =
      unitIds.size > 0
        ? await tx.unit.findMany({
            where: { id: { in: [...unitIds] } },
            select: { id: true, operator: true, operatorValue: true },
          })
        : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    const toBase = (qty: Decimal, unitId: string | null, productUnitId: string | null): Decimal => {
      if (!unitId || unitId === productUnitId) return qty;
      const unit = unitMap.get(unitId);
      if (!unit) {
        throw new NotFoundException('Unité introuvable.');
      }
      return convertToBase(qty, unit);
    };

    // Regroupe défensivement les lignes COURANTES par saleDetailId (converties en base AVANT
    // sommation — une même saleDetailId ne devrait apparaître qu'une fois par retour en
    // pratique, cf. commentaire du modèle SaleReturnDetail).
    const currentBySaleDetailId = new Map<string, Decimal>();
    for (const d of details) {
      const source = saleDetailMap.get(d.saleDetailId);
      if (!source) {
        throw new NotFoundException('Ligne de vente introuvable.');
      }
      const productUnitId = productUnitMap.get(source.productId) ?? null;
      const lineBase = toBase(new Decimal(d.quantity), d.returnUnitId, productUnitId);
      currentBySaleDetailId.set(
        d.saleDetailId,
        (currentBySaleDetailId.get(d.saleDetailId) ?? new Decimal(0)).plus(lineBase),
      );
    }

    for (const [saleDetailId, cetteLigneBase] of currentBySaleDetailId) {
      const source = saleDetailMap.get(saleDetailId)!;
      const productUnitId = productUnitMap.get(source.productId) ?? null;
      const sourceBase = toBase(new Decimal(source.quantity), source.saleUnitId, productUnitId);

      const dejaRetourneBase = priorReturnDetails
        .filter((p) => p.saleDetailId === saleDetailId)
        .reduce(
          (acc, p) => acc.plus(toBase(new Decimal(p.quantity), p.returnUnitId, productUnitId)),
          new Decimal(0),
        );

      const totalDemande = dejaRetourneBase.plus(cetteLigneBase);
      if (totalDemande.greaterThan(sourceBase)) {
        throw new BadRequestException(
          `Quantité retournée dépasse la quantité vendue : ${totalDemande.toFixed(3)} demandée ` +
            `au total sur ${sourceBase.toFixed(3)} vendue à l'origine.`,
        );
      }
    }
  }

  /**
   * Regroupe les lignes d'un retour par (productId, productVariantId), en convertissant
   * chaque quantité dans l'unité de stock du produit via convertToBase si returnUnitId en
   * diffère — AVANT sommation, pour n'appliquer qu'un seul mouvement de stock cumulé par
   * couple produit/variante. Mirror exact de SaleService.groupDetailsByProduct /
   * PurchaseService.groupDetailsByProduct, adapté au champ returnUnitId.
   */
  private async groupReturnDetailsByProduct(
    tx: Prisma.TransactionClient,
    details: {
      productId: string;
      productVariantId: string | null;
      returnUnitId: string | null;
      quantity: Decimal;
    }[],
  ): Promise<Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>> {
    const productIds = [...new Set(details.map((d) => d.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitId: true },
    });
    const productUnitMap = new Map(products.map((p) => [p.id, p.unitId]));

    const returnUnitIds = [
      ...new Set(details.filter((d) => d.returnUnitId).map((d) => d.returnUnitId as string)),
    ];
    const units =
      returnUnitIds.length > 0
        ? await tx.unit.findMany({
            where: { id: { in: returnUnitIds } },
            select: { id: true, operator: true, operatorValue: true },
          })
        : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    const grouped = new Map<
      string,
      { productId: string; productVariantId: string | null; quantity: Decimal }
    >();
    for (const detail of details) {
      const productUnitId = productUnitMap.get(detail.productId) ?? null;
      let qty = new Decimal(detail.quantity);
      if (detail.returnUnitId && detail.returnUnitId !== productUnitId) {
        const unit = unitMap.get(detail.returnUnitId);
        // Défensif : ne devrait jamais être null (ownership de returnUnitId déjà vérifiée à
        // la création du retour) — NotFoundException plutôt qu'un crash TypeScript.
        if (!unit) {
          throw new NotFoundException('Unité de retour introuvable.');
        }
        qty = convertToBase(qty, unit);
      }
      const key = `${detail.productId}::${detail.productVariantId ?? ''}`;
      const g = grouped.get(key);
      if (g) {
        g.quantity = g.quantity.plus(qty);
      } else {
        grouped.set(key, {
          productId: detail.productId,
          productVariantId: detail.productVariantId,
          quantity: qty,
        });
      }
    }
    return grouped;
  }

  /**
   * Applique un incrément de stock cumulé par (productId, productVariantId) sous verrouillage
   * optimiste (ProductWarehouseService.adjustStock, version + transaction Serializable déjà
   * ouverte par l'appelant). Mirror exact de PurchaseService.moveStock.
   *
   * Aucune garde stock insuffisant — un incrément ne peut jamais échouer pour ce motif. Chaque
   * delta est vérifié fini et strictement positif avant tout accès — une Unit mal configurée ne
   * doit jamais produire un incrément silencieusement nul ou infini.
   *
   * Si la ligne ProductWarehouse n'existe pas encore, elle est créée ICI, DANS LA MÊME
   * TRANSACTION Serializable, avec quantity=0/version=0, puis immédiatement incrémentée — reste
   * défensif (ne devrait normalement jamais arriver : la vente d'origine a forcément déjà créé
   * cette ligne de stock en la décrémentant).
   *
   * @throws ForbiddenException si le ProductWarehouse trouvé n'appartient pas à organizationId.
   * @throws BadRequestException si la quantité convertie est nulle, négative ou non finie.
   */
  private async moveStock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    warehouseId: string,
    grouped: Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>,
  ): Promise<StockUpdate[]> {
    const stockUpdates: StockUpdate[] = [];

    for (const group of grouped.values()) {
      // Garde de cohérence (§17 point A) : une Unit mal configurée (operatorValue "0") ferait
      // produire à convertToBase soit 0 (incrément silencieux nul) soit +Infinity (division par
      // zéro — Decimal ne lève pas d'exception). Un incrément de retour doit toujours être fini
      // et strictement positif.
      if (!group.quantity.isFinite() || group.quantity.lessThanOrEqualTo(0)) {
        throw new BadRequestException(
          "Quantité invalide après conversion d'unité — vérifiez la configuration de l'unité de retour utilisée.",
        );
      }

      // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId.
      const pw = await tx.productWarehouse.findFirst({
        where: {
          productId: group.productId,
          warehouseId,
          productVariantId: group.productVariantId ?? null,
          product: { organizationId },
        },
        select: { id: true, version: true },
      });

      let productWarehouseId: string;
      let expectedVersion: number;

      if (pw) {
        productWarehouseId = pw.id;
        expectedVersion = pw.version;
      } else {
        // Défensif : première apparition de ce (produit, entrepôt, variante) — ne devrait
        // normalement jamais arriver pour un retour de vente.
        const created = await tx.productWarehouse.create({
          data: {
            productId: group.productId,
            warehouseId,
            productVariantId: group.productVariantId ?? null,
            quantity: new Decimal(0),
            version: 0,
          },
          select: { id: true, version: true },
        });
        productWarehouseId = created.id;
        expectedVersion = created.version;
      }

      const updated = await this.productWarehouseService.adjustStock(
        tx,
        productWarehouseId,
        organizationId,
        group.quantity,
        expectedVersion,
      );

      stockUpdates.push({
        productId: group.productId,
        newQuantity: updated.quantity,
      });
    }

    return stockUpdates;
  }

  /**
   * Convertit les erreurs de concurrence de bas niveau (verrouillage optimiste, sérialisation
   * Postgres P2034) en ConflictException — les autres erreurs sont relancées telles quelles.
   */
  private rethrowStockConflict(err: unknown): never {
    if (err instanceof OptimisticLockException) {
      throw new ConflictException(
        'Conflit de version sur le stock : un autre utilisateur a modifié le stock simultanément. Veuillez réessayer.',
      );
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConflictException('Conflit de concurrence détecté. Veuillez réessayer.');
    }
    throw err;
  }

  /**
   * Émet stock:updated vers org:{organizationId} — pas de stock:lowAlert ici (n'a de sens
   * qu'à la baisse du stock, jamais à la hausse d'un retour de vente).
   */
  private emitStockEvents(
    organizationId: string,
    warehouseId: string,
    stockUpdates: StockUpdate[],
  ): void {
    this.realtimeGateway.server.to(`org:${organizationId}`).emit('stock:updated', {
      warehouseId,
      products: stockUpdates.map((u) => ({ productId: u.productId, newQuantity: u.newQuantity })),
    });
  }

  /**
   * Calcule le total d'une ligne côté serveur :
   *   subTotal = price × quantity
   *   taxLigne = taxMethod === 'percentage' ? subTotal × (taxAmount / 100) : taxAmount
   *   remiseLigne = discountMethod === 'percentage' ? subTotal × (discount / 100) : discount
   *   total = subTotal + taxLigne − remiseLigne
   * Mirror exact de SaleService.computeLineTotal, mais reçoit les champs déjà copiés depuis la
   * SaleDetail source (jamais depuis le body client, cf. décision de conception S26) plutôt
   * qu'un DTO brut.
   */
  private computeLineTotal(input: {
    price: Decimal;
    quantity: Decimal;
    taxAmount: Decimal;
    taxMethod: string;
    discount: Decimal;
    discountMethod: string;
  }): Decimal {
    const subTotal = input.price.times(input.quantity);
    const taxLine =
      input.taxMethod === 'percentage'
        ? subTotal.times(input.taxAmount).dividedBy(100)
        : input.taxAmount;
    const discountLine =
      input.discountMethod === 'percentage'
        ? subTotal.times(input.discount).dividedBy(100)
        : input.discount;
    return subTotal.plus(taxLine).minus(discountLine);
  }

  private toDetailCreateInput(d: ComputedReturnLine) {
    return {
      saleDetailId: d.saleDetailId,
      productId: d.productId,
      productVariantId: d.productVariantId,
      returnUnitId: d.returnUnitId,
      price: d.price,
      taxAmount: d.taxAmount,
      taxMethod: d.taxMethod,
      discount: d.discount,
      discountMethod: d.discountMethod,
      quantity: d.quantity,
      total: d.total,
    };
  }
}
