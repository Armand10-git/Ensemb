import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { ExpenseCategoryService } from './expense-category.service';
import { ExpenseCategoryController } from './expense-category.controller';
import { ExpenseService } from './expense.service';
import { ExpenseController } from './expense.controller';

/**
 * Module du domaine dépenses (S29) : catégories de dépenses (référentiel simple, mirror
 * Brand/Category) et dépenses elles-mêmes (CRUD standard avec référence générée).
 *
 * Session volontairement simple — une dépense est un fait comptable unique et immédiat,
 * pas un document commercial avec cycle de vie : PAS de statut PENDING/COMPLETED, PAS de
 * mouvement de stock, PAS de paiement partiel, PAS de transaction Serializable ni de
 * verrouillage optimiste (contrairement à SalesModule/PurchasesModule).
 *
 * DocumentCounterModule est @Global() — pas besoin de l'importer ici.
 * PAS de RealtimeModule (aucune liste "live" attendue pour une dépense, contrairement aux
 * documents commerciaux) ni de MessagingQueueModule (pas d'envoi email/SMS pour une
 * dépense dans cette session).
 */
@Module({
  imports: [PrismaModule],
  controllers: [ExpenseCategoryController, ExpenseController],
  providers: [ExpenseCategoryService, ExpenseService],
  exports: [ExpenseCategoryService, ExpenseService],
})
export class ExpensesModule {}
