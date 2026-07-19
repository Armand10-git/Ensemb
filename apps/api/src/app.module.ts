import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AuditModule } from './modules/audit/audit.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global : 20 req/min par IP par défaut ; routes spécifiques via @Throttle()
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    RedisModule,
    TenancyModule,
    HealthModule,
    AuthModule,
    RolesModule,
    RealtimeModule,
    AuditModule,
    RegistrationModule,
    OrganizationsModule,
  ],
})
export class AppModule {}
