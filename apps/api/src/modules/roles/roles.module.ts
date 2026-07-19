import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { PermissionGuard } from '../auth/guards/permission.guard';

@Module({
  controllers: [RolesController],
  providers: [RolesService, PermissionGuard],
  exports: [RolesService, PermissionGuard],
})
export class RolesModule {}
