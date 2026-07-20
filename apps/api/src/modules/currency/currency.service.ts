import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import type { CreateCurrencyDto, UpdateCurrencyDto } from './dto/currency.dto';

/**
 * Service de gestion des devises de plateforme.
 *
 * Les devises sont globales (pas de organizationId) : un PlatformAdmin les gère,
 * les tenants lisent et choisissent leur devise par défaut.
 *
 * Soft-disable via isActive = false — jamais de suppression physique.
 */
@Injectable()
export class CurrencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne toutes les devises actives.
   * Accessible sans authentification (utilisé sur l'écran d'inscription).
   */
  async findAll(): Promise<{ id: string; code: string; name: string; symbol: string; symbolPosition: string; decimalPlaces: number; isActive: boolean }[]> {
    return this.prisma.currency.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, symbol: true, symbolPosition: true, decimalPlaces: true, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Retourne toutes les devises (actives et inactives) — usage PlatformAdmin uniquement.
   */
  async findAllAdmin(): Promise<{ id: string; code: string; name: string; symbol: string; symbolPosition: string; decimalPlaces: number; isActive: boolean }[]> {
    return this.prisma.currency.findMany({
      select: { id: true, code: true, name: true, symbol: true, symbolPosition: true, decimalPlaces: true, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Crée une devise.
   * Rejette en 409 si un code identique existe déjà (actif ou non).
   *
   * @param dto - champs validés par CreateCurrencySchema
   */
  async create(dto: CreateCurrencyDto) {
    const existing = await this.prisma.currency.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException(`Une devise avec le code "${dto.code}" existe déjà.`);
    }
    return this.prisma.currency.create({
      data: {
        code: dto.code,
        name: dto.name,
        symbol: dto.symbol,
        symbolPosition: dto.symbolPosition,
        decimalPlaces: dto.decimalPlaces,
        isActive: dto.isActive,
      },
      select: { id: true, code: true, name: true, symbol: true, symbolPosition: true, decimalPlaces: true, isActive: true },
    });
  }

  /**
   * Modifie les champs fournis d'une devise existante.
   * Lève 404 si la devise n'existe pas.
   *
   * @param id  - UUID de la devise
   * @param dto - champs à mettre à jour (partiel)
   */
  async update(id: string, dto: UpdateCurrencyDto) {
    await this.findOneOrThrow(id);
    return this.prisma.currency.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.symbol !== undefined && { symbol: dto.symbol }),
        ...(dto.symbolPosition !== undefined && { symbolPosition: dto.symbolPosition }),
        ...(dto.decimalPlaces !== undefined && { decimalPlaces: dto.decimalPlaces }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      select: { id: true, code: true, name: true, symbol: true, symbolPosition: true, decimalPlaces: true, isActive: true },
    });
  }

  /**
   * Désactive une devise (soft-disable : isActive = false).
   * Lève 404 si la devise n'existe pas.
   *
   * @param id - UUID de la devise
   */
  async remove(id: string): Promise<void> {
    await this.findOneOrThrow(id);
    await this.prisma.currency.update({ where: { id }, data: { isActive: false } });
  }

  /**
   * Définit la devise par défaut de l'organisation du tenant.
   * Lève 404 si la devise n'existe pas ou est inactive.
   *
   * @param organizationId - extrait de req.user (jamais du body)
   * @param currencyId     - UUID de la devise choisie
   */
  async updateDefaultCurrency(organizationId: string, currencyId: string): Promise<{ defaultCurrencyId: string }> {
    const currency = await this.prisma.currency.findUnique({ where: { id: currencyId, isActive: true } });
    if (!currency) {
      throw new NotFoundException(`Devise introuvable ou inactive (id: ${currencyId}).`);
    }
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { defaultCurrencyId: currencyId },
    });
    return { defaultCurrencyId: currencyId };
  }

  private async findOneOrThrow(id: string) {
    const currency = await this.prisma.currency.findUnique({ where: { id } });
    if (!currency) throw new NotFoundException(`Devise introuvable (id: ${id}).`);
    return currency;
  }
}
