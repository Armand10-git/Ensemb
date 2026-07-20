import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { CategoryService } from './catalog.service';
import { BrandService } from './brand.service';
import { CategoriesController } from './categories.controller';
import { BrandsController } from './brands.controller';

@Module({
  imports: [PrismaModule],
  controllers: [CategoriesController, BrandsController],
  providers: [CategoryService, BrandService],
  exports: [CategoryService, BrandService],
})
export class CatalogModule {}
