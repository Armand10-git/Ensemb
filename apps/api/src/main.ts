import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma.service';

async function bootstrap(): Promise<void> {
  // rawBody: true expose req.rawBody (Buffer) pour la vérification HMAC des webhooks (§17 point V)
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Préfixe global — toutes les routes répondent sous /api/v1 (§17 point AA)
  // /health et /ready sont exclus car appelés sans préfixe par l'orchestrateur
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  // En-têtes de sécurité HTTP (CSP, HSTS, X-Content-Type-Options, X-Frame-Options…)
  app.use(helmet());

  // CORS en liste blanche : sous-domaines *.monapp.cm + localhost en dev
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // outils CLI, Postman
      const allowed = /^https?:\/\/([a-z0-9-]+\.)?monapp\.cm(:\d+)?$|^http:\/\/localhost(:\d+)?$/;
      callback(allowed.test(origin) ? null : new Error('CORS non autorisé'), allowed.test(origin));
    },
    credentials: true,
  });

  // Pipe global : whitelist des propriétés, rejet des champs inconnus
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Fermeture propre de Prisma sur SIGTERM (Kubernetes, PM2)
  app.get(PrismaService).enableShutdownHooks(app);

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
}

bootstrap();
