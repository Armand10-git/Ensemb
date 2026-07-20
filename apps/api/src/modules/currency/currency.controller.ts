import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { CurrencyService } from './currency.service';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import {
  CreateCurrencySchema,
  UpdateCurrencySchema,
  UpdateDefaultCurrencySchema,
} from './dto/currency.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * Endpoints de gestion des devises.
 *
 * GET /currencies        — public (lecture sans auth)
 * POST /currencies       — PlatformAdminGuard uniquement
 * PATCH /currencies/:id  — PlatformAdminGuard uniquement
 * DELETE /currencies/:id — PlatformAdminGuard uniquement (soft-disable)
 * PATCH /organizations/default-currency — tenant JWT + permission organization.settings.edit
 */
@Controller()
export class CurrencyController {
  constructor(private readonly currencyService: CurrencyService) {}

  /** GET /api/v1/currencies — liste les devises actives, sans authentification. */
  @Get('currencies')
  findAll() {
    return this.currencyService.findAll();
  }

  /** POST /api/v1/currencies — crée une devise (PlatformAdmin seulement). */
  @UseGuards(PlatformAdminGuard)
  @Post('currencies')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown) {
    const result = CreateCurrencySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.currencyService.create(result.data);
  }

  /** PATCH /api/v1/currencies/:id — modifie une devise (PlatformAdmin seulement). */
  @UseGuards(PlatformAdminGuard)
  @Patch('currencies/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const result = UpdateCurrencySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.currencyService.update(id, result.data);
  }

  /** DELETE /api/v1/currencies/:id — désactive une devise (PlatformAdmin seulement). */
  @UseGuards(PlatformAdminGuard)
  @Delete('currencies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.currencyService.remove(id);
  }

  /** PATCH /api/v1/organizations/default-currency — choisit la devise par défaut du tenant. */
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('organization.settings.edit')
  @Patch('organizations/default-currency')
  @HttpCode(HttpStatus.OK)
  updateDefaultCurrency(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = UpdateDefaultCurrencySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.currencyService.updateDefaultCurrency(req.user.organizationId, result.data.currencyId);
  }
}
