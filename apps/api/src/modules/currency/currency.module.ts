import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CurrencyService } from './currency.service';
import { CurrencyController } from './currency.controller';
import { PrismaModule } from '../../common/prisma.module';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';

@Module({
  imports: [
    PrismaModule,
    // JwtService requis par PlatformAdminGuard (vérification PLATFORM_JWT_SECRET)
    JwtModule.register({}),
  ],
  controllers: [CurrencyController],
  // PlatformAdminGuard déclaré ici pour que le DI puisse le résoudre dans CurrencyController
  providers: [CurrencyService, PlatformAdminGuard],
  exports: [CurrencyService],
})
export class CurrencyModule {}
