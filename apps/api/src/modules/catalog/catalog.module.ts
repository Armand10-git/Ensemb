import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { CategoryService } from './catalog.service';
import { BrandService } from './brand.service';
import { UnitService } from './unit.service';
import { CategoriesController } from './categories.controller';
import { BrandsController } from './brands.controller';
import { UnitsController } from './units.controller';

@Module({
  imports: [PrismaModule],
  controllers: [CategoriesController, BrandsController, UnitsController],
  providers: [CategoryService, BrandService, UnitService],
  exports: [CategoryService, BrandService, UnitService],
})
export class CatalogModule {}
