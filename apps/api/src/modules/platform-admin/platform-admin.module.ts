import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../common/prisma.module';
import { EncryptionModule } from '../../common/encryption.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformAdminAuthService } from './platform-admin-auth.service';
import { PlatformAdminDashboardService } from './platform-admin-dashboard.service';
import { PlatformAdminOrganizationsService } from './platform-admin-organizations.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminAuthController } from './platform-admin-auth.controller';
import { PlatformAdminDashboardController } from './platform-admin-dashboard.controller';
import { PlatformAdminOrganizationsController } from './platform-admin-organizations.controller';

/**
 * Module du staff plateforme.
 *
 * Auth entièrement séparée de l'auth tenant :
 * - JwtModule sans secret statique (passé dynamiquement via ConfigService dans chaque signAsync)
 * - PlatformAdminGuard utilise PLATFORM_JWT_SECRET, jamais JWT_SECRET
 * - Routes exemptes du TenancyMiddleware (configuré dans AppModule)
 */
@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    AuditModule,
    // Secret non posé ici — injecté dynamiquement dans PlatformAdminAuthService via ConfigService
    JwtModule.register({}),
  ],
  controllers: [
    PlatformAdminAuthController,
    PlatformAdminDashboardController,
    PlatformAdminOrganizationsController,
  ],
  providers: [
    PlatformAdminAuthService,
    PlatformAdminDashboardService,
    PlatformAdminOrganizationsService,
    PlatformAdminGuard,
  ],
})
export class PlatformAdminModule {}
