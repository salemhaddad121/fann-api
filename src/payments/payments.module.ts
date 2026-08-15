import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { MockCheckoutController } from './mock-checkout.controller';
import { WebhooksService } from './webhooks.service';
import { PaymentProvidersModule } from './payment-providers.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

// SubscriptionsModule is imported for mintForPayment — the same function
// the admin confirm button calls. Two callers, one implementation of the
// stacking rules.
//
// The registry comes from PaymentProvidersModule rather than living here,
// so SubscriptionsModule can use it without importing this module back.
@Module({
  imports: [PaymentProvidersModule, SubscriptionsModule],
  controllers: [WebhooksController, MockCheckoutController],
  providers: [WebhooksService],
})
export class PaymentsModule {}
