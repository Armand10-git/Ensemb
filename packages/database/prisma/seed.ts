import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Seed de démarrage :
 * - Catalogue global des permissions (89 entrées)
 * - Organisation de démonstration
 * - Rôle "Administrateur" avec toutes les permissions
 * - Utilisateur admin avec mot de passe hashé
 *
 * Idempotent : upsert sur les clés uniques, relançable sans doublon.
 */

const prisma = new PrismaClient();

// ─── Catalogue global des permissions ────────────────────────────────────────

const PERMISSIONS: { name: string; label: string }[] = [
  // Utilisateurs & accès
  { name: 'users.view', label: 'Voir les utilisateurs' },
  { name: 'users.create', label: 'Créer un utilisateur' },
  { name: 'users.edit', label: 'Modifier un utilisateur' },
  { name: 'users.delete', label: 'Supprimer un utilisateur' },
  { name: 'permissions.view', label: 'Voir les permissions' },
  { name: 'permissions.create', label: 'Créer une permission' },
  { name: 'permissions.edit', label: 'Modifier une permission' },
  { name: 'permissions.delete', label: 'Supprimer une permission' },

  // Catalogue produit
  { name: 'products.view', label: 'Voir les produits' },
  { name: 'products.create', label: 'Créer un produit' },
  { name: 'products.edit', label: 'Modifier un produit' },
  { name: 'products.delete', label: 'Supprimer un produit' },
  { name: 'products.import', label: 'Importer des produits' },
  { name: 'barcode.view', label: 'Voir les codes-barres' },

  // Catégories
  { name: 'categories.view', label: 'Voir les catégories' },
  { name: 'categories.create', label: 'Créer une catégorie' },
  { name: 'categories.edit', label: 'Modifier une catégorie' },
  { name: 'categories.delete', label: 'Supprimer une catégorie' },

  // Marques
  { name: 'brands.view', label: 'Voir les marques' },
  { name: 'brands.create', label: 'Créer une marque' },
  { name: 'brands.edit', label: 'Modifier une marque' },
  { name: 'brands.delete', label: 'Supprimer une marque' },

  // Unités
  { name: 'units.view', label: 'Voir les unités' },
  { name: 'units.create', label: 'Créer une unité' },
  { name: 'units.edit', label: 'Modifier une unité' },
  { name: 'units.delete', label: 'Supprimer une unité' },

  // Devises
  { name: 'currencies.view', label: 'Voir les devises' },
  { name: 'currencies.create', label: 'Créer une devise' },
  { name: 'currencies.edit', label: 'Modifier une devise' },
  { name: 'currencies.delete', label: 'Supprimer une devise' },

  // Stock — entrepôts
  { name: 'warehouses.view', label: 'Voir les entrepôts' },
  { name: 'warehouses.create', label: 'Créer un entrepôt' },
  { name: 'warehouses.edit', label: 'Modifier un entrepôt' },
  { name: 'warehouses.delete', label: 'Supprimer un entrepôt' },

  // Transferts de stock
  { name: 'transfers.view', label: 'Voir les transferts' },
  { name: 'transfers.create', label: 'Créer un transfert' },
  { name: 'transfers.edit', label: 'Modifier un transfert' },
  { name: 'transfers.delete', label: 'Supprimer un transfert' },

  // Ajustements de stock
  { name: 'adjustments.view', label: 'Voir les ajustements' },
  { name: 'adjustments.create', label: 'Créer un ajustement' },
  { name: 'adjustments.edit', label: 'Modifier un ajustement' },
  { name: 'adjustments.delete', label: 'Supprimer un ajustement' },

  // Ventes
  { name: 'sales.view', label: 'Voir les ventes' },
  { name: 'sales.create', label: 'Créer une vente' },
  { name: 'sales.edit', label: 'Modifier une vente' },
  { name: 'sales.delete', label: 'Supprimer une vente' },
  { name: 'sales.cancel', label: 'Annuler une vente' },

  // Paiements de ventes
  { name: 'paymentSales.view', label: 'Voir les paiements de ventes' },
  { name: 'paymentSales.create', label: 'Enregistrer un paiement de vente' },
  { name: 'paymentSales.edit', label: 'Modifier un paiement de vente' },
  { name: 'paymentSales.delete', label: 'Supprimer un paiement de vente' },

  // Retours de ventes
  { name: 'saleReturns.view', label: 'Voir les retours de ventes' },
  { name: 'saleReturns.create', label: 'Créer un retour de vente' },
  { name: 'saleReturns.edit', label: 'Modifier un retour de vente' },
  { name: 'saleReturns.delete', label: 'Supprimer un retour de vente' },

  // Point de vente
  { name: 'pos.access', label: 'Accéder à la caisse (POS)' },

  // Achats
  { name: 'purchases.view', label: 'Voir les achats' },
  { name: 'purchases.create', label: 'Créer un achat' },
  { name: 'purchases.edit', label: 'Modifier un achat' },
  { name: 'purchases.delete', label: 'Supprimer un achat' },
  { name: 'purchases.cancel', label: 'Annuler un achat' },

  // Paiements d'achats
  { name: 'paymentPurchases.view', label: 'Voir les paiements fournisseur' },
  { name: 'paymentPurchases.create', label: 'Enregistrer un paiement fournisseur' },
  { name: 'paymentPurchases.edit', label: 'Modifier un paiement fournisseur' },
  { name: 'paymentPurchases.delete', label: 'Supprimer un paiement fournisseur' },

  // Retours d'achats
  { name: 'purchaseReturns.view', label: 'Voir les retours fournisseur' },
  { name: 'purchaseReturns.create', label: 'Créer un retour fournisseur' },
  { name: 'purchaseReturns.edit', label: 'Modifier un retour fournisseur' },
  { name: 'purchaseReturns.delete', label: 'Supprimer un retour fournisseur' },

  // Paiements retours achats
  { name: 'paymentReturns.view', label: 'Voir les paiements de retours' },
  { name: 'paymentReturns.create', label: 'Enregistrer un paiement de retour' },
  { name: 'paymentReturns.edit', label: 'Modifier un paiement de retour' },
  { name: 'paymentReturns.delete', label: 'Supprimer un paiement de retour' },

  // Devis
  { name: 'quotations.view', label: 'Voir les devis' },
  { name: 'quotations.create', label: 'Créer un devis' },
  { name: 'quotations.edit', label: 'Modifier un devis' },
  { name: 'quotations.delete', label: 'Supprimer un devis' },

  // Clients & fournisseurs
  { name: 'customers.view', label: 'Voir les clients' },
  { name: 'customers.create', label: 'Créer un client' },
  { name: 'customers.edit', label: 'Modifier un client' },
  { name: 'customers.delete', label: 'Supprimer un client' },
  { name: 'customers.import', label: 'Importer des clients' },
  { name: 'suppliers.view', label: 'Voir les fournisseurs' },
  { name: 'suppliers.create', label: 'Créer un fournisseur' },
  { name: 'suppliers.edit', label: 'Modifier un fournisseur' },
  { name: 'suppliers.delete', label: 'Supprimer un fournisseur' },
  { name: 'suppliers.import', label: 'Importer des fournisseurs' },

  // Dépenses
  { name: 'expenses.view', label: 'Voir les dépenses' },
  { name: 'expenses.create', label: 'Créer une dépense' },
  { name: 'expenses.edit', label: 'Modifier une dépense' },
  { name: 'expenses.delete', label: 'Supprimer une dépense' },

  // Rapports
  { name: 'reports.warehouse', label: 'Rapport entrepôts' },
  { name: 'reports.quantityAlerts', label: 'Rapport alertes de stock' },
  { name: 'reports.profit', label: 'Rapport bénéfices' },
  { name: 'reports.suppliers', label: 'Rapport fournisseurs' },
  { name: 'reports.customers', label: 'Rapport clients' },
  { name: 'reports.purchases', label: 'Rapport achats' },
  { name: 'reports.sales', label: 'Rapport ventes' },
  { name: 'reports.paymentsPurchaseReturns', label: 'Rapport paiements retours achats' },
  { name: 'reports.paymentsSaleReturns', label: 'Rapport paiements retours ventes' },
  { name: 'reports.paymentsPurchases', label: 'Rapport paiements achats' },
  { name: 'reports.paymentsSales', label: 'Rapport paiements ventes' },

  // Système & organisation
  { name: 'backup.access', label: 'Accéder aux sauvegardes' },
  { name: 'settings.system', label: 'Modifier les réglages système' },
  { name: 'organization.branding.edit', label: 'Modifier le branding (logo/couleurs)' },
  { name: 'billing.view', label: 'Voir la facturation' },
  { name: 'billing.manage', label: 'Gérer la facturation (plan, paiement)' },

  // Transverse
  { name: 'records.viewAll', label: 'Voir tous les enregistrements (pas seulement les siens)' },
];

// ─── Organisation & admin de démonstration ───────────────────────────────────

const DEMO_ORG = {
  name: 'Organisation Démo',
  subdomain: 'demo',
};

const DEMO_ADMIN = {
  firstname: 'Admin',
  lastname: 'Démo',
  email: 'admin@demo.ensemb.cm',
  username: 'admin',
  /** Mot de passe en clair uniquement pour le seed de démo — ne jamais stocker en clair en prod. */
  passwordPlain: 'Admin@1234!',
};

async function main(): Promise<void> {
  console.log('🌱 Seed démarré…');

  // 1. Upsert de toutes les permissions
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: { label: perm.label },
      create: perm,
    });
  }
  console.log(`✔  ${PERMISSIONS.length} permissions insérées/mises à jour`);

  // 2. Organisation de démo (idempotent sur le subdomain)
  const org = await prisma.organization.upsert({
    where: { subdomain: DEMO_ORG.subdomain },
    update: {},
    create: DEMO_ORG,
  });
  console.log(`✔  Organisation "${org.name}" (id: ${org.id})`);

  // 3. Rôle Administrateur avec toutes les permissions
  const allPerms = await prisma.permission.findMany({ select: { id: true } });

  const adminRole = await prisma.role.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Administrateur' } },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Administrateur',
      label: 'Administrateur',
      description: 'Accès complet à toutes les fonctionnalités',
    },
  });
  console.log(`✔  Rôle "${adminRole.name}" (id: ${adminRole.id})`);

  // Assignation des permissions au rôle (upsert de chaque liaison)
  for (const perm of allPerms) {
    await prisma.permissionOnRole.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: perm.id },
    });
  }
  console.log(`✔  ${allPerms.length} permissions assignées au rôle Administrateur`);

  // 4. Utilisateur admin
  const hashedPassword = await bcrypt.hash(DEMO_ADMIN.passwordPlain, 12);

  const adminUser = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: DEMO_ADMIN.email } },
    update: {},
    create: {
      organizationId: org.id,
      firstname: DEMO_ADMIN.firstname,
      lastname: DEMO_ADMIN.lastname,
      email: DEMO_ADMIN.email,
      username: DEMO_ADMIN.username,
      password: hashedPassword,
    },
  });
  console.log(`✔  Utilisateur admin "${adminUser.email}" (id: ${adminUser.id})`);

  // Assignation du rôle à l'utilisateur
  await prisma.roleOnUser.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });
  console.log(`✔  Rôle Administrateur assigné à l'utilisateur admin`);

  // 5. Plans tarifaires (idempotent sur le name)
  const PLANS = [
    {
      name: 'starter',
      label: 'Starter',
      priceMonthly: 5000,
      priceAnnual: 50000,
      trialDurationDays: 30,
      trialRevenueCapAmount: 500000,
      maxUsers: 5,
      maxWarehouses: 1,
      maxProducts: 500,
      isActive: true,
    },
    {
      name: 'pro',
      label: 'Pro',
      priceMonthly: 15000,
      priceAnnual: 150000,
      trialDurationDays: 30,
      trialRevenueCapAmount: 2000000,
      maxUsers: 20,
      maxWarehouses: 5,
      maxProducts: null,
      isActive: true,
    },
    {
      name: 'enterprise',
      label: 'Enterprise',
      priceMonthly: 40000,
      priceAnnual: 400000,
      trialDurationDays: 30,
      trialRevenueCapAmount: null,
      maxUsers: null,
      maxWarehouses: null,
      maxProducts: null,
      isActive: true,
    },
  ];

  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: {
        label: plan.label,
        priceMonthly: plan.priceMonthly,
        priceAnnual: plan.priceAnnual,
        trialDurationDays: plan.trialDurationDays,
        trialRevenueCapAmount: plan.trialRevenueCapAmount,
        maxUsers: plan.maxUsers,
        maxWarehouses: plan.maxWarehouses,
        maxProducts: plan.maxProducts,
        isActive: plan.isActive,
      },
      create: plan,
    });
  }
  console.log(`✔  ${PLANS.length} plans insérés/mis à jour`);

  // 6. PlatformSetting : fenêtre de lancement (modifiable sans redéploiement)
  await prisma.platformSetting.upsert({
    where: { key: 'launchPromoEndsAt' },
    update: {},
    create: { key: 'launchPromoEndsAt', value: '"2026-09-30T23:59:59Z"' },
  });
  console.log('✔  PlatformSetting launchPromoEndsAt insérée/mise à jour');

  console.log('🎉 Seed terminé avec succès.');
}

main()
  .catch((err: unknown) => {
    console.error('❌ Erreur lors du seed :', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
