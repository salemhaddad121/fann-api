import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { PaymentProvidersModule } from '../payments/payment-providers.module';

// Exported because minting has to have exactly one implementation. The
// admin confirm button reaches it through AdminModule today, and the
// payment webhook will reach the same method in Wave 7.
@Module({
  imports: [PaymentProvidersModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
