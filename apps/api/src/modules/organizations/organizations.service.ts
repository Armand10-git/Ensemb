import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { UpdateBrandingDto } from './dto/update-branding.dto';

export interface BrandingResult {
  logoUrl: string | null;
  primaryColor: string | null;
}

/**
 * Service de gestion de l'organisation tenant.
 * Toutes les mutations sont scopées par organizationId extrait du JWT.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * Met à jour uniquement les champs branding fournis dans le DTO.
   * Jamais de mass assignment : spread conditionnel vers Prisma data.
   * Émet l'événement organization:brandingUpdated vers la room org:<organizationId>.
   *
   * @param organizationId  - extrait de req.user (jamais du body)
   * @param dto             - champs validés par UpdateBrandingSchema
   * @returns logoUrl et primaryColor après mise à jour
   */
  async updateBranding(organizationId: string, dto: UpdateBrandingDto): Promise<BrandingResult> {
    const data: { logoUrl?: string; primaryColor?: string } = {};
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl;
    if (dto.primaryColor !== undefined) data.primaryColor = dto.primaryColor;

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data,
      select: { logoUrl: true, primaryColor: true },
    });

    const result: BrandingResult = {
      logoUrl: updated.logoUrl ?? null,
      primaryColor: updated.primaryColor ?? null,
    };

    this.realtimeGateway.server
      .to(`org:${organizationId}`)
      .emit('organization:brandingUpdated', result);

    return result;
  }
}
