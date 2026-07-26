/**
 * globalSetup Jest — attend que le pool global de ports éphémères IPv4 soit
 * suffisamment libre avant de lancer les suites e2e.
 *
 * Sur Windows, les 16 383 ports éphémères (49152–65535) sont partagés entre
 * TOUTES les interfaces réseau (loopback 127.0.0.1 ET adapateurs physiques). Les
 * connexions TIME_WAIT du navigateur (source 10.x.x.x→HTTPS) consomment ce pool
 * global et rendent Prisma incapable d'ouvrir de nouvelles connexions vers Postgres,
 * même via le loopback (erreur EADDRINUSE sur connect()).
 *
 * Ce setup bloque le démarrage tant que le nombre de TIME_WAIT dépasse MAX_TIME_WAIT.
 *
 * ENOBUFS : la sortie complète de `netstat -an` dépasse 1 Mo sur cette machine.
 * On utilise `netstat -an | find /c "TIME_WAIT"` dans cmd.exe — seule la ligne de
 * comptage est capturée par execSync, évitant le dépassement du buffer.
 */
import { execSync } from 'child_process';

const MAX_TIME_WAIT = 13_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes max

function getTimeWaitCount(): number {
  try {
    // `find /c "TIME_WAIT"` reçoit les lignes via pipe et retourne seulement
    // le comptage — la sortie capturée est minuscule, pas de ENOBUFS.
    // Sortie de `find /c` : "---------- STDIN\n       17268\n"
    // On extrait le premier groupe de chiffres.
    const out = execSync('netstat -an | find /c "TIME_WAIT"', {
      encoding: 'utf8',
      timeout: 15_000,
      shell: 'cmd.exe',
    });
    const match = out.match(/(\d+)/);
    return match?.[1] !== undefined ? parseInt(match[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

export default async function globalSetup(): Promise<void> {
  const start = Date.now();
  let count = getTimeWaitCount();

  if (count <= MAX_TIME_WAIT) {
    console.log(`[setup] TIME_WAIT OK (${count}/${MAX_TIME_WAIT}) — démarrage des tests`);
    return;
  }

  console.log(`[setup] TIME_WAIT élevé (${count}/${MAX_TIME_WAIT}) — attente…`);

  while (count > MAX_TIME_WAIT) {
    if (Date.now() - start > MAX_WAIT_MS) {
      console.warn(
        `[setup] Délai dépassé (5 min). TIME_WAIT encore à ${count}. ` +
        `Fermez des onglets navigateur ou attendez ~4 min après la dernière activité réseau.`,
      );
      break;
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    count = getTimeWaitCount();
    console.log(`[setup] TIME_WAIT : ${count} (cible < ${MAX_TIME_WAIT})`);
  }

  if (count <= MAX_TIME_WAIT) {
    console.log(`[setup] TIME_WAIT redescendu à ${count} — démarrage des tests`);
  }
}
