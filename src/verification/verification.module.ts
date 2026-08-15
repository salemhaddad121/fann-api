import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { IdentityDocumentsService } from './identity-documents.service';
import { IdentityDocumentsController } from './identity-documents.controller';
import { ConsentModule } from '../consent/consent.module';

// IdentityDocumentsService is exported because AdminModule gates account
// activation on it — hasCompleteVerification() is the single source of
// truth for that rule, so the admin path calls it rather than counting
// approved rows itself.
@Module({
  imports: [ConsentModule],
  controllers: [IdentityDocumentsController],
  providers: [VerificationService, IdentityDocumentsService],
  exports: [VerificationService, IdentityDocumentsService],
})
export class VerificationModule {}
