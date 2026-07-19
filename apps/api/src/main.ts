import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Préfixe global — toutes les routes répondent sous /api/v1 (§17 point AA)
  app.setGlobalPrefix('api/v1');

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

  // Limite la taille du body JSON pour éviter les attaques par payload géant
  app.use(json({ limit: '10kb' }));

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
