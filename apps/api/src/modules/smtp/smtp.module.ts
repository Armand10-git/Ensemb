import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { SmtpServerService } from './smtp-server.service';
import { SmtpServerController } from './smtp-server.controller';

@Module({
  imports: [PrismaModule],
  controllers: [SmtpServerController],
  providers: [SmtpServerService],
  exports: [SmtpServerService],
})
export class SmtpModule {}
