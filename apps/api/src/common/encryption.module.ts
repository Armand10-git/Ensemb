import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/** Module global — EncryptionService injecté partout sans import explicite. */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
