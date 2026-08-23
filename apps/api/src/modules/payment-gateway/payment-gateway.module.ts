import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { PaymentGatewayCredentialService } from './payment-gateway-credential.service';
import { PaymentGatewayCredentialController } from './payment-gateway-credential.controller';
import { TenantPaymentGatewayService } from './tenant-payment-gateway.service';
import { AsyncPaymentService } from './async-payment.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentGatewayCredentialController],
  providers: [PaymentGatewayCredentialService, TenantPaymentGatewayService, AsyncPaymentService],
  exports: [PaymentGatewayCredentialService, TenantPaymentGatewayService, AsyncPaymentService],
})
export class PaymentGatewayModule {}
