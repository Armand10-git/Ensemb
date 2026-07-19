import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { BillingService } from './billing.service';
import { QuotaGuard } from './quota.guard';

@Module({
  imports: [PrismaModule],
  providers: [BillingService, QuotaGuard],
  exports: [BillingService, QuotaGuard],
})
export class BillingModule {}
