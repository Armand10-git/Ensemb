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
import { ProductWarehouseService, OptimisticLockException } from '../inventory/product-warehouse.service';
import { NotificationService } from '../notifications/notification.service';
import type { CreatePurchaseReturnDto, PurchaseReturnDetailDto } from './dto/create-purchase-return.dto';
import type { UpdatePurchaseReturnDto } from './dto/update-purchase-return.dto';
import type { PaginatedResult } from '../../common/types';

// ─── Types de réponse ────────────────────────────────────────────────────────

export interface PurchaseReturnDetailResponse {
  id: string;
  purchaseDetailId: string;
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

export interface PurchaseReturnResponse {
  id: string;
  organizationId: string;
  reference: string;
  date: Date;
  userId: string;
  purchaseId: string;
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
  purchase?: { id: string; reference: string };
  warehouse?: { id: string; name: string };
  details?: PurchaseReturnDetailResponse[];
}

/** Résultat d'un mouvement de stock appliqué par validate() — pour stock:updated/lowAlert. */
interface StockUpdate {
  productId: string;
  newQuantity: Decimal;
  productName: string;
  stockAlert: number;
}

/**
 * Ligne de retour après calcul serveur. price/taxAmount/taxMethod/discount/discountMethod
 * sont TOUJOURS copiés depuis la PurchaseDetail source — jamais acceptés depuis le body
 * client (§17 point A + décision de conception S26, cf. JSDoc de verifyAndComputeLines).
 */
interface PurchaseReturnDetailComputed {
  purchaseDetailId: string;
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

const PURCHASE_RETURN_SELECT = {
  id: true,
  organizationId: true,
  reference: true,
  date: true,
  userId: true,
  purchaseId: true,
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
  purchaseDetailId: true,
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

const PURCHASE_WAREHOUSE_INCLUDE = {
  purchase: { select: { id: true, reference: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Gestion des retours fournisseurs (S26 — Bloc F/E, §18.6), mirror du domaine Achat
 * (S25 — PurchaseService) en sens inverse pour le mouvement de stock : validate()
 * DÉCRÉMENTE le stock (restitution au fournisseur) au lieu de l'incrémenter.
 *
 * Invariants :
 *  - organizationId extrait du token (anti-IDOR), jamais fourni par le client.
 *  - Le retour référence un Purchase d'origine (purchaseId, fourni par le client mais
 *    vérifié DANS la transaction) qui doit être COMPLETED — on ne retourne que ce qui a
 *    réellement été réceptionné. warehouseId est TOUJOURS copié depuis ce Purchase,
 *    jamais fourni par le client.
 *  - Chaque ligne référence une PurchaseDetail précise (purchaseDetailId) qui DOIT
 *    appartenir au Purchase déclaré — vérifié DANS la transaction (IDOR critique : un
 *    client ne doit jamais pouvoir référencer la ligne d'un autre achat, potentiellement
 *    d'une autre organisation).
 *  - price/taxAmount/taxMethod/discount/discountMethod ne sont JAMAIS fournis par le
 *    client : ils sont copiés depuis la PurchaseDetail source (décision de conception S26,
 *    identique au retour de vente pour cohérence entre les deux domaines). Seuls
 *    purchaseId, date, notes et (purchaseDetailId, quantity, returnUnitId?) par ligne sont
 *    acceptés côté DTO.
 *  - Le total de chaque ligne est recalculé côté serveur avec la même formule que
 *    PurchaseService.computeLineTotal, appliquée à la quantité RETOURNÉE. grandTotal =
 *    somme des totaux de ligne — les champs d'en-tête taxRate/discount/shipping restent à
 *    0 (pas de remise/frais/TVA globale sur un retour, cf. commentaire du modèle Prisma).
 *  - create() vérifie en plus, ligne par ligne, que la quantité retournée (convertie en
 *    unité de base du produit) ne dépasse pas la quantité achetée à l'origine (convertie
 *    de même) — vérification BEST-EFFORT qui ignore les autres retours déjà existants sur
 *    la même ligne. La garde AUTORITATIVE, cumulée sur tous les retours COMPLETED, est
 *    faite dans validate() sous isolation Serializable (cf. JSDoc de validate()).
 *  - create() ne mouvemente jamais le stock : paidAmount = 0, paymentStatus = UNPAID à la
 *    création (remboursements gérés par PaymentReturnService, hors périmètre de cette
 *    session — Agent 4).
 *  - Seul un retour PENDING peut être modifié, validé ou supprimé (§17 point 7) ; un
 *    retour COMPLETED est immuable. Pas de cancel() dans cette session, comme Purchase
 *    (S25) et SaleReturn (S26, Agent 2) — écart assumé.
 *  - validate() est la seule action qui mouvemente le stock d'un retour fournisseur :
 *    décrément de ProductWarehouse via ProductWarehouseService.adjustStock (verrouillage
 *    optimiste, transaction Serializable), conversion d'unité returnUnitId → unité de
 *    stock du produit via convertToBase.
 *
 * ÉCART ASSUMÉ vs PurchaseService.validate() (documenté, pas un oubli) : cette méthode NE
 * retente JAMAIS automatiquement sur un conflit de concurrence (OptimisticLockException ou
 * Prisma P2034) — mirror exact de SaleService.validate(), pas de PurchaseService.validate().
 * La raison est strictement métier : un décrément de stock (restitution au fournisseur,
 * comme une vente) n'est PAS commutatif/fusionnable comme peut l'être un incrément — le
 * même raisonnement que celui déjà écrit dans purchase.service.ts s'applique ici en sens
 * inverse. L'échec d'une seconde tentative sur un décrément peut signifier que le stock est
 * désormais insuffisant, ce qui EST une information métier qu'un retry aveugle masquerait
 * en la transformant silencieusement en une resynchronisation, rompant l'invariant « jamais
 * de stock négatif ». Une ConflictException (409) est donc remontée directement dès le
 * premier conflit — l'appelant (ou l'utilisateur) décide de réessayer, en connaissance de
 * cause de l'état réel du stock au moment de la nouvelle tentative.
 */
@Injectable()
export class PurchaseReturnService {
  private readonly logger = new Logger(PurchaseReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentCounter: DocumentCounterService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly productWarehouseService: ProductWarehouseService,
    private readonly notificationService: NotificationService,
    @InjectQueue('email')
    private readonly emailQueue: Queue<{ organizationId: string; returnId: string; to: string }>,
  ) {}

  /**
   * Crée un retour fournisseur en statut PENDING avec ses lignes dans une transaction
   * simple (pas Serializable — le Serializable n'est nécessaire qu'à validate(), seule
   * méthode qui mouvemente le stock). Référence générée via
   * DocumentCounterService.nextReference. Émet purchaseReturn:created vers
   * org:{organizationId}.
   *
   * @throws NotFoundException si l'achat d'origine ou une PurchaseDetail référencée est
   *         introuvable, ou si un returnUnitId référencé est introuvable.
   * @throws ForbiddenException si l'achat n'appartient pas à l'organisation, si une
   *         PurchaseDetail référencée n'appartient pas à l'achat déclaré (IDOR), ou si un
   *         returnUnitId n'appartient pas à l'organisation.
   * @throws BadRequestException si l'achat n'est pas COMPLETED, ou si une quantité
   *         retournée dépasse la quantité achetée à l'origine (vérification best-effort).
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreatePurchaseReturnDto,
  ): Promise<PurchaseReturnResponse> {
    const purchaseReturn = await this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUnique({
        where: { id: dto.purchaseId },
        select: { id: true, organizationId: true, warehouseId: true, status: true, deletedAt: true },
      });

      if (!purchase || purchase.deletedAt !== null) {
        throw new NotFoundException('Achat introuvable.');
      }
      if (purchase.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
      if (purchase.status !== 'COMPLETED') {
        throw new BadRequestException(
          "Impossible de créer un retour sur un achat qui n'est pas finalisé.",
        );
      }

      const warehouseId = purchase.warehouseId;

      const computed = await this.verifyAndComputeLines(tx, dto.purchaseId, organizationId, dto.details);
      const grandTotal = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

      const reference = await this.documentCounter.nextReference(
        tx,
        organizationId,
        DocumentType.PURCHASE_RETURN,
      );

      return tx.purchaseReturn.create({
        data: {
          organizationId,
          reference,
          date: new Date(dto.date),
          userId,
          purchaseId: dto.purchaseId,
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
        select: {
          ...PURCHASE_RETURN_SELECT,
          ...PURCHASE_WAREHOUSE_INCLUDE,
          details: { select: DETAIL_SELECT },
        },
      });
    });

    this.realtimeGateway.server.to(`org:${organizationId}`).emit('purchaseReturn:created', {
      organizationId,
      purchaseReturnId: purchaseReturn.id,
      purchaseId: purchaseReturn.purchaseId,
      warehouseId: purchaseReturn.warehouseId,
      grandTotal: purchaseReturn.grandTotal,
    });

    return purchaseReturn;
  }

  /**
   * Valide un retour PENDING : décrémente le stock de l'entrepôt du retour pour chaque
   * ligne (regroupées par couple produit/variante, converties dans l'unité de stock du
   * produit via convertToBase si returnUnitId diffère), puis fait passer le statut à
   * COMPLETED — le tout dans une seule transaction Serializable, SANS retry (cf. JSDoc de
   * la classe).
   *
   * Le retour et ses lignes sont relus DANS la transaction Serializable pour éliminer le
   * TOCTOU. La garde de quantité AUTORITATIVE (cumulée sur tous les PurchaseReturn déjà
   * COMPLETED portant sur la même PurchaseDetail source) est appliquée ICI, dans la même
   * transaction Serializable que le décrément de stock qui suit — c'est l'isolation
   * Postgres qui empêche deux validations concurrentes sur la même ligne source de
   * dépasser ensemble le plafond acheté (write skew classique) : une erreur de
   * sérialisation P2034 sur l'une des deux transactions concurrentes est le comportement
   * ATTENDU, pas un bug (cf. rethrowStockConflict).
   *
   * @throws NotFoundException si le retour, une PurchaseDetail source, une unité référencée
   *         ou le ProductWarehouse cible est introuvable (pas de création automatique,
   *         contrairement à l'incrément d'un achat — l'absence de stock dans l'entrepôt
   *         signifie qu'il n'y a rien à restituer).
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   * @throws BadRequestException si le retour n'est pas PENDING, si la quantité retournée
   *         cumulée dépasse la quantité achetée à l'origine, ou si le stock disponible est
   *         insuffisant pour une ligne.
   * @throws ConflictException si un conflit de version optimiste ou de sérialisation
   *         (P2034) survient — remonté immédiatement, sans retry (cf. JSDoc de la classe).
   */
  async validate(id: string, organizationId: string): Promise<PurchaseReturnResponse> {
    let stockUpdates: StockUpdate[] = [];
    let capturedWarehouseId!: string;

    await this.prisma
      .$transaction(
        async (tx) => {
          // 1. Relire le retour + lignes DANS la transaction Serializable (élimine le TOCTOU).
          const existing = await tx.purchaseReturn.findUnique({
            where: { id },
            select: { ...PURCHASE_RETURN_SELECT, details: { select: DETAIL_SELECT } },
          });

          if (!existing || existing.deletedAt !== null) {
            throw new NotFoundException('Retour fournisseur introuvable.');
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

          // 2. Garde autoritative cumulée (cœur de cette session) — DANS la transaction
          // Serializable, avant tout mouvement de stock.
          await this.verifyCumulativeQuantities(tx, existing.details);

          // 3-4. Regroupement par (productId, productVariantId) avec conversion d'unité,
          // puis décrément (garde stock insuffisant AVANT adjustStock).
          const grouped = await this.groupDetailsByProduct(tx, existing.details);
          stockUpdates = await this.moveStock(tx, organizationId, existing.warehouseId, grouped);

          // 5. Statut
          await tx.purchaseReturn.update({ where: { id }, data: { status: 'COMPLETED' } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => this.rethrowStockConflict(err));

    // 6. stock:updated PUIS stock:lowAlert + notification persistée.
    this.emitStockEvents(organizationId, capturedWarehouseId, stockUpdates);

    return this.prisma.purchaseReturn.findUniqueOrThrow({
      where: { id },
      select: {
        ...PURCHASE_RETURN_SELECT,
        ...PURCHASE_WAREHOUSE_INCLUDE,
        details: { select: DETAIL_SELECT },
      },
    });
  }

  /**
   * Retourne la liste paginée des retours fournisseurs de l'organisation.
   * viewAll=false ajoute un filtre WHERE userId = userId (permission records.viewAll,
   * injectée par ViewAllInterceptor).
   */
  async findAll(
    organizationId: string,
    userId: string,
    viewAll: boolean,
    page: number,
    limit: number,
    purchaseId?: string,
    warehouseId?: string,
    status?: DocumentStatus,
    paymentStatus?: PaymentStatus,
  ): Promise<PaginatedResult<PurchaseReturnResponse>> {
    const where: Prisma.PurchaseReturnWhereInput = {
      organizationId,
      deletedAt: null,
      ...(viewAll ? {} : { userId }),
      ...(purchaseId ? { purchaseId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseReturn.findMany({
        where,
        select: PURCHASE_RETURN_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.purchaseReturn.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  /**
   * Retourne un retour fournisseur par ID avec ses lignes, l'achat d'origine et l'entrepôt.
   * Vérifie l'ownership (anti-IDOR).
   */
  async findOne(id: string, organizationId: string): Promise<PurchaseReturnResponse> {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      select: {
        ...PURCHASE_RETURN_SELECT,
        ...PURCHASE_WAREHOUSE_INCLUDE,
        details: { select: DETAIL_SELECT },
      },
    });

    if (!purchaseReturn || purchaseReturn.deletedAt !== null) {
      throw new NotFoundException('Retour fournisseur introuvable.');
    }
    if (purchaseReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return purchaseReturn;
  }

  /**
   * Met à jour un retour PENDING : lignes intégralement remplacées si `details` est fourni
   * (deleteMany + createMany dans la transaction, avec re-vérification IDOR de chaque
   * purchaseDetailId contre le purchaseId existant — RÉUTILISE verifyAndComputeLines,
   * identique à create()), grandTotal recalculé côté serveur dans tous les cas. purchaseId
   * n'est volontairement pas modifiable (cf. JSDoc de UpdatePurchaseReturnSchema).
   *
   * @throws BadRequestException si le retour n'est pas PENDING.
   * @throws NotFoundException / ForbiddenException — cf. create()/verifyAndComputeLines().
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdatePurchaseReturnDto,
  ): Promise<PurchaseReturnResponse> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseReturn.findUnique({
        where: { id },
        select: { ...PURCHASE_RETURN_SELECT, details: { select: DETAIL_SELECT } },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new NotFoundException('Retour fournisseur introuvable.');
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
        const computed = await this.verifyAndComputeLines(
          tx,
          existing.purchaseId,
          organizationId,
          dto.details,
        );
        grandTotal = computed.reduce((acc, d) => acc.plus(d.total), new Decimal(0));

        await tx.purchaseReturnDetail.deleteMany({ where: { purchaseReturnId: id } });
        await tx.purchaseReturnDetail.createMany({
          data: computed.map((d) => ({ purchaseReturnId: id, ...this.toDetailCreateInput(d) })),
        });
      } else {
        grandTotal = existing.details.reduce(
          (acc, d) => acc.plus(new Decimal(d.total)),
          new Decimal(0),
        );
      }

      return tx.purchaseReturn.update({
        where: { id },
        data: {
          date: dto.date ? new Date(dto.date) : undefined,
          notes: dto.notes ?? undefined,
          grandTotal,
        },
        select: {
          ...PURCHASE_RETURN_SELECT,
          ...PURCHASE_WAREHOUSE_INCLUDE,
          details: { select: DETAIL_SELECT },
        },
      });
    });
  }

  /**
   * Soft-delete d'un retour fournisseur — uniquement si statut PENDING.
   * Un retour COMPLETED ne peut jamais être supprimé (§17 point 7).
   */
  async remove(id: string, organizationId: string): Promise<void> {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      select: { organizationId: true, status: true, deletedAt: true },
    });

    if (!purchaseReturn || purchaseReturn.deletedAt !== null) {
      throw new NotFoundException('Retour fournisseur introuvable.');
    }
    if (purchaseReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (purchaseReturn.status !== 'PENDING') {
      throw new BadRequestException(
        'Seul un retour en attente (PENDING) peut être supprimé.',
      );
    }

    await this.prisma.purchaseReturn.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Envoie le récapitulatif d'un retour fournisseur au fournisseur par email (S32, mirror
   * exact de SaleReturnService.send — un seul canal email, pas de body attendu). Enfile un
   * job BullMQ ('purchaseReturn.sendEmail', file 'email') consommé par
   * return-email.worker.ts — aucun appel réseau synchrone, retourne dès que le job est enfilé.
   *
   * @param id - identifiant du retour à envoyer.
   * @param organizationId - organisation de l'utilisateur authentifié (anti-IDOR).
   * @returns `{ status: 'queued' }` dès que le job est enfilé (pas d'attente de l'envoi réel).
   * @throws NotFoundException si le retour est introuvable ou soft-supprimé.
   * @throws ForbiddenException si le retour n'appartient pas à l'organisation.
   * @throws BadRequestException si le fournisseur n'a pas d'adresse email enregistrée.
   */
  async send(id: string, organizationId: string): Promise<{ status: 'queued' }> {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      select: {
        organizationId: true,
        deletedAt: true,
        purchase: { select: { provider: { select: { email: true } } } },
      },
    });

    if (!purchaseReturn || purchaseReturn.deletedAt !== null) {
      throw new NotFoundException('Retour fournisseur introuvable.');
    }
    if (purchaseReturn.organizationId !== organizationId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const to = purchaseReturn.purchase.provider.email;
    if (!to) {
      throw new BadRequestException("Ce fournisseur n'a pas d'adresse email enregistrée.");
    }

    await this.emailQueue.add('purchaseReturn.sendEmail', { organizationId, returnId: id, to });
    return { status: 'queued' };
  }

  // ─── Helpers privés ──────────────────────────────────────────────────────────

  /**
   * Vérifie l'ownership de chaque PurchaseDetail source référencée par les lignes du DTO
   * (DOIT appartenir à purchaseId — IDOR critique, cf. JSDoc de la classe) et de chaque
   * returnUnitId fourni par le client (DOIT appartenir à l'organisation), puis calcule le
   * total de chaque ligne côté serveur avec la même formule que
   * PurchaseService.computeLineTotal, appliquée à la quantité retournée.
   * price/taxAmount/taxMethod/discount/discountMethod sont TOUJOURS copiés depuis la
   * PurchaseDetail source — jamais acceptés depuis le body client.
   *
   * Effectue aussi la vérification de bon sens BEST-EFFORT (PAS la garde autoritative —
   * celle-ci est dans verifyCumulativeQuantities(), appelée uniquement par validate() sous
   * Serializable) : la quantité retournée de cette ligne, convertie en unité de base du
   * produit, ne doit pas dépasser la quantité achetée à l'origine (elle aussi convertie en
   * base) — ignore volontairement les autres retours déjà existants sur la même ligne.
   * Partagée par create() et update() (mêmes règles IDOR et de calcul).
   *
   * @throws NotFoundException si une PurchaseDetail ou un returnUnitId référencé est
   *         introuvable.
   * @throws ForbiddenException si une PurchaseDetail n'appartient pas au purchaseId
   *         déclaré, ou si un returnUnitId n'appartient pas à l'organisation.
   * @throws BadRequestException si une quantité retournée dépasse la quantité achetée à
   *         l'origine (vérification best-effort par ligne).
   */
  private async verifyAndComputeLines(
    tx: Prisma.TransactionClient,
    purchaseId: string,
    organizationId: string,
    details: PurchaseReturnDetailDto[],
  ): Promise<PurchaseReturnDetailComputed[]> {
    const purchaseDetailIds = [...new Set(details.map((d) => d.purchaseDetailId))];
    const sources = await tx.purchaseDetail.findMany({
      where: { id: { in: purchaseDetailIds } },
      select: {
        id: true,
        purchaseId: true,
        productId: true,
        productVariantId: true,
        purchaseUnitId: true,
        price: true,
        taxAmount: true,
        taxMethod: true,
        discount: true,
        discountMethod: true,
        quantity: true,
        product: { select: { unitId: true } },
      },
    });
    const sourceMap = new Map(sources.map((s) => [s.id, s]));

    const returnUnitIds = [
      ...new Set(details.filter((d) => d.returnUnitId).map((d) => d.returnUnitId as string)),
    ];
    const purchaseUnitIds = [
      ...new Set(sources.filter((s) => s.purchaseUnitId).map((s) => s.purchaseUnitId as string)),
    ];
    const allUnitIds = [...new Set([...returnUnitIds, ...purchaseUnitIds])];
    const units =
      allUnitIds.length > 0
        ? await tx.unit.findMany({
            where: { id: { in: allUnitIds }, deletedAt: null },
            select: { id: true, organizationId: true, operator: true, operatorValue: true },
          })
        : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    // Ownership des returnUnitId fournis par le client (IDOR — jamais de confiance
    // implicite dans un ID fourni par le client, contrairement à purchaseUnitId qui vient
    // de la PurchaseDetail source, déjà vérifiée à la création de l'achat, S25).
    for (const unitId of returnUnitIds) {
      const unit = unitMap.get(unitId);
      if (!unit) {
        throw new NotFoundException('Unité de retour introuvable.');
      }
      if (unit.organizationId !== organizationId) {
        throw new ForbiddenException('Accès refusé.');
      }
    }

    const toBase = (qty: Decimal, unitId: string | null, productUnitId: string | null): Decimal => {
      if (!unitId || unitId === productUnitId) return qty;
      const unit = unitMap.get(unitId);
      if (!unit) {
        throw new NotFoundException('Unité introuvable.');
      }
      return convertToBase(qty, unit);
    };

    const computed: PurchaseReturnDetailComputed[] = [];
    for (const d of details) {
      const source = sourceMap.get(d.purchaseDetailId);
      if (!source) {
        throw new NotFoundException("Ligne d'achat introuvable.");
      }
      // IDOR CRITIQUE : la ligne doit appartenir à l'achat déclaré — jamais de confiance
      // dans purchaseDetailId fourni par le client, qui pourrait référencer la ligne d'un
      // AUTRE achat (potentiellement d'une autre organisation).
      if (source.purchaseId !== purchaseId) {
        throw new ForbiddenException("Cette ligne n'appartient pas à l'achat d'origine déclaré.");
      }

      const productUnitId = source.product.unitId;
      const returnQty = new Decimal(d.quantity);
      const returnQtyBase = toBase(returnQty, d.returnUnitId ?? null, productUnitId);
      const sourceQtyBase = toBase(new Decimal(source.quantity), source.purchaseUnitId, productUnitId);

      if (returnQtyBase.greaterThan(sourceQtyBase)) {
        throw new BadRequestException(
          `La quantité retournée (${returnQtyBase.toFixed(3)}) dépasse la quantité achetée ` +
            `à l'origine (${sourceQtyBase.toFixed(3)}).`,
        );
      }

      const price = new Decimal(source.price);
      const taxAmount = new Decimal(source.taxAmount ?? '0');
      const taxMethod = source.taxMethod ?? 'percentage';
      const discount = new Decimal(source.discount ?? '0');
      const discountMethod = source.discountMethod ?? 'percentage';

      // subTotal = price × quantity_retournée (dans l'unité de la ligne, pas la base) —
      // mirror exact de PurchaseService.computeLineTotal, price/quantity dans la même unité.
      const subTotal = price.times(returnQty);
      const taxLine =
        taxMethod === 'percentage' ? subTotal.times(taxAmount).dividedBy(100) : taxAmount;
      const discountLine =
        discountMethod === 'percentage' ? subTotal.times(discount).dividedBy(100) : discount;
      const total = subTotal.plus(taxLine).minus(discountLine);

      computed.push({
        purchaseDetailId: d.purchaseDetailId,
        productId: source.productId,
        productVariantId: source.productVariantId,
        returnUnitId: d.returnUnitId ?? null,
        price,
        taxAmount,
        taxMethod,
        discount,
        discountMethod,
        quantity: returnQty,
        total,
      });
    }

    return computed;
  }

  /**
   * Garde AUTORITATIVE cumulée (le cœur de cette session) — appelée uniquement par
   * validate(), DANS la transaction Serializable qui mouvemente le stock. Pour chaque
   * PurchaseReturnDetail de ce retour, regroupé par purchaseDetailId : somme la quantité
   * déjà retournée sur cette ligne source à travers TOUS les PurchaseReturn au statut
   * COMPLETED (pas ce retour-ci, encore PENDING), ajoute la quantité de ce retour, et
   * vérifie que le total ne dépasse pas la quantité achetée à l'origine — toutes les
   * quantités comparées en unité de BASE du produit (cf. JSDoc de la classe pour le
   * raisonnement sur l'isolation Serializable/write skew).
   *
   * @throws NotFoundException si une PurchaseDetail source ou une unité référencée est
   *         introuvable.
   * @throws BadRequestException si la quantité retournée cumulée dépasse la quantité
   *         achetée à l'origine.
   */
  private async verifyCumulativeQuantities(
    tx: Prisma.TransactionClient,
    details: { purchaseDetailId: string; returnUnitId: string | null; quantity: Decimal }[],
  ): Promise<void> {
    // Regroupe les lignes DE CE retour par purchaseDetailId — cas limite mais possible
    // qu'un retour contienne plusieurs lignes issues de la même ligne d'achat source.
    const byPurchaseDetail = new Map<string, { returnUnitId: string | null; quantity: Decimal }[]>();
    for (const d of details) {
      const arr = byPurchaseDetail.get(d.purchaseDetailId) ?? [];
      arr.push({ returnUnitId: d.returnUnitId, quantity: new Decimal(d.quantity) });
      byPurchaseDetail.set(d.purchaseDetailId, arr);
    }

    for (const [purchaseDetailId, lines] of byPurchaseDetail) {
      // a. PurchaseDetail source + Product (pour productUnitId) DANS LA TRANSACTION.
      const source = await tx.purchaseDetail.findUnique({
        where: { id: purchaseDetailId },
        select: {
          quantity: true,
          purchaseUnitId: true,
          product: { select: { unitId: true } },
        },
      });
      // Défensif : la ligne existe forcément (ownership déjà vérifiée à la création/mise à
      // jour du retour) — NotFoundException plutôt qu'un crash si jamais supprimée entre-temps.
      if (!source) {
        throw new NotFoundException("Ligne d'achat d'origine introuvable.");
      }
      const productUnitId = source.product.unitId;

      // b. Quantité déjà retournée sur CETTE purchaseDetailId à travers TOUS les
      // PurchaseReturn COMPLETED (pas ce retour-ci, encore PENDING).
      const priorReturns = await tx.purchaseReturnDetail.findMany({
        where: { purchaseDetailId, purchaseReturn: { status: 'COMPLETED' } },
        select: { quantity: true, returnUnitId: true },
      });

      const unitIds = new Set<string>();
      if (source.purchaseUnitId && source.purchaseUnitId !== productUnitId) {
        unitIds.add(source.purchaseUnitId);
      }
      for (const l of lines) {
        if (l.returnUnitId && l.returnUnitId !== productUnitId) unitIds.add(l.returnUnitId);
      }
      for (const p of priorReturns) {
        if (p.returnUnitId && p.returnUnitId !== productUnitId) unitIds.add(p.returnUnitId);
      }

      const units =
        unitIds.size > 0
          ? await tx.unit.findMany({
              where: { id: { in: [...unitIds] } },
              select: { id: true, operator: true, operatorValue: true },
            })
          : [];
      const unitMap = new Map(units.map((u) => [u.id, u]));

      const toBase = (qty: Decimal, unitId: string | null): Decimal => {
        if (!unitId || unitId === productUnitId) return qty;
        const unit = unitMap.get(unitId);
        // Défensif : ownership déjà vérifiée à la création du retour (returnUnitId) ou de
        // l'achat (purchaseUnitId) — ne devrait jamais être null.
        if (!unit) {
          throw new NotFoundException('Unité de retour introuvable.');
        }
        return convertToBase(qty, unit);
      };

      // c-d. Quantité de CETTE ligne (cumulée si plusieurs lignes du même retour portent
      // sur la même source) et quantité de la PurchaseDetail SOURCE, en unité de base.
      const sourceBase = toBase(new Decimal(source.quantity), source.purchaseUnitId);
      const cetteLigneBase = lines.reduce(
        (sum, l) => sum.plus(toBase(l.quantity, l.returnUnitId)),
        new Decimal(0),
      );
      const dejaRetourneBase = priorReturns.reduce(
        (sum, p) => sum.plus(toBase(new Decimal(p.quantity), p.returnUnitId)),
        new Decimal(0),
      );

      // e. Vérification autoritative cumulée.
      if (dejaRetourneBase.plus(cetteLigneBase).greaterThan(sourceBase)) {
        throw new BadRequestException(
          `Quantité retournée dépasse la quantité achetée : ` +
            `${dejaRetourneBase.plus(cetteLigneBase).toFixed(3)} demandée au total sur ` +
            `${sourceBase.toFixed(3)} achetée à l'origine.`,
        );
      }
    }
  }

  /**
   * Regroupe les lignes d'un retour par (productId, productVariantId), en convertissant
   * chaque quantité dans l'unité de stock du produit via convertToBase si returnUnitId en
   * diffère — AVANT sommation, pour n'appliquer qu'un seul mouvement de stock cumulé par
   * couple produit/variante (mirror exact de SaleService.groupDetailsByProduct, avec
   * returnUnitId au lieu de saleUnitId).
   */
  private async groupDetailsByProduct(
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
        // Défensif : ne devrait jamais être null (ownership de returnUnitId déjà vérifiée
        // à la création/mise à jour du retour) — NotFoundException plutôt qu'un crash.
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
   * Applique un décrément de stock cumulé par (productId, productVariantId) sous
   * verrouillage optimiste (ProductWarehouseService.adjustStock, version + transaction
   * Serializable déjà ouverte par l'appelant) — mirror exact de
   * SaleService.moveStock(direction: 'decrement').
   *
   * Garde stock insuffisant AVANT tout appel à adjustStock. Aucune création automatique de
   * ProductWarehouse : l'absence de stock dans l'entrepôt du retour signifie qu'il n'y a
   * rien à restituer (contrairement à l'incrément d'un achat, où la première réception EST
   * ce qui crée le stock).
   *
   * @throws NotFoundException si le ProductWarehouse est introuvable dans l'entrepôt.
   * @throws BadRequestException si le stock disponible est insuffisant pour une ligne.
   */
  private async moveStock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    warehouseId: string,
    grouped: Map<string, { productId: string; productVariantId: string | null; quantity: Decimal }>,
  ): Promise<StockUpdate[]> {
    const stockUpdates: StockUpdate[] = [];

    for (const group of grouped.values()) {
      // Filtre product: { organizationId } : protège contre l'IDOR sur productVariantId
      // (patron identique à SaleService.moveStock).
      const pw = await tx.productWarehouse.findFirst({
        where: {
          productId: group.productId,
          warehouseId,
          productVariantId: group.productVariantId ?? null,
          product: { organizationId },
        },
        select: {
          id: true,
          version: true,
          quantity: true,
          product: { select: { stockAlert: true, name: true } },
        },
      });

      if (!pw) {
        throw new NotFoundException(
          "Stock introuvable dans l'entrepôt du retour. " +
            "Ce produit n'a jamais été réceptionné dans cet entrepôt.",
        );
      }

      if (group.quantity.greaterThan(pw.quantity)) {
        throw new BadRequestException(
          `Stock insuffisant pour ${pw.product.name} : ` +
            `disponible ${pw.quantity.toFixed(3)}, demandé ${group.quantity.toFixed(3)}.`,
        );
      }

      const updated = await this.productWarehouseService.adjustStock(
        tx,
        pw.id,
        organizationId,
        group.quantity.negated(),
        pw.version,
      );

      stockUpdates.push({
        productId: group.productId,
        newQuantity: updated.quantity,
        productName: pw.product.name,
        stockAlert: pw.product.stockAlert,
      });
    }

    return stockUpdates;
  }

  /**
   * Convertit les erreurs de concurrence de bas niveau (verrouillage optimiste,
   * sérialisation Postgres P2034) en ConflictException — patron identique à
   * SaleService.rethrowStockConflict.
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
   * Émet stock:updated (toujours) puis stock:lowAlert + notification persistée par produit
   * dont la nouvelle quantité atteint le seuil d'alerte — mirror exact de
   * SaleService.emitStockEvents (un retour fournisseur DIMINUE le stock, donc peut
   * déclencher l'alerte, contrairement à PurchaseService qui ne l'émet jamais).
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

    for (const update of stockUpdates) {
      if (
        update.stockAlert > 0 &&
        update.newQuantity.lessThanOrEqualTo(new Decimal(update.stockAlert))
      ) {
        this.realtimeGateway.server.to(`org:${organizationId}`).emit('stock:lowAlert', {
          productId: update.productId,
          productName: update.productName,
          currentQuantity: update.newQuantity,
          threshold: update.stockAlert,
        });
        // Persiste l'alerte pour les utilisateurs hors-ligne (§17 point I — S18)
        this.notificationService
          .createForOrg(
            organizationId,
            'stock.lowAlert',
            {
              productId: update.productId,
              productName: update.productName,
              currentQuantity: update.newQuantity.toString(),
              threshold: update.stockAlert,
              warehouseId,
            },
            'reports.quantityAlerts',
          )
          .catch((err: unknown) => {
            this.logger.error('Erreur création notification stock.lowAlert (retour fournisseur)', err);
          });
      }
    }
  }

  private toDetailCreateInput(d: PurchaseReturnDetailComputed) {
    return {
      purchaseDetailId: d.purchaseDetailId,
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
