import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [ConsentModule],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
