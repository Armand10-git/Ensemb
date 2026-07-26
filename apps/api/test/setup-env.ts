/**
 * Chargement du fichier .env racine du monorepo avant les tests e2e.
 * Jest tourne depuis apps/api/ mais le .env est à la racine Ensemb/.
 * Ce fichier est référencé dans jest.e2e.config.js via setupFiles.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const envPath = join(__dirname, '..', '..', '..', '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// Limite le pool Prisma à 2 connexions en tests pour éviter l'accumulation de
// connexions TIME_WAIT sur le loopback Windows lors des runs Jest séquentiels.
const dbUrl = process.env['DATABASE_URL'];
if (dbUrl && !dbUrl.includes('connection_limit')) {
  process.env['DATABASE_URL'] = `${dbUrl}?connection_limit=2&pool_timeout=10&connect_timeout=30`;
}
