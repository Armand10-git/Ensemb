import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PrismaModule } from '../../common/prisma.module';
import { CategoryService } from './catalog.service';
import { BrandService } from './brand.service';
import { UnitService } from './unit.service';
import { ProductService } from './product.service';
import { CategoriesController } from './categories.controller';
import { BrandsController } from './brands.controller';
import { UnitsController } from './units.controller';
import { ProductsController } from './products.controller';

@Module({
  imports: [
    PrismaModule,
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [CategoriesController, BrandsController, UnitsController, ProductsController],
  providers: [CategoryService, BrandService, UnitService, ProductService],
  exports: [CategoryService, BrandService, UnitService, ProductService],
})
export class CatalogModule {}
