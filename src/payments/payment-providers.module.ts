import { Module } from '@nestjs/common';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { ManualProvider } from './providers/manual.provider';
import { MockProvider } from './providers/mock.provider';
import { WhishProvider } from './providers/whish.provider';
import { OmtProvider } from './providers/omt.provider';

/**
 * The providers and the registry, on their own.
 *
 * Split out to break a cycle: SubscriptionsService asks which provider is
 * active when creating an intent, and PaymentsModule asks Subscriptions to
 * mint once a webhook confirms. If the registry lived in PaymentsModule
 * those two would import each other, and forwardRef() would paper over a
 * dependency that is genuinely one-directional — nothing in here needs
 * anything from either consumer.
 */
@Module({
  providers: [
    PaymentProviderRegistry,
    ManualProvider,
    MockProvider,
    WhishProvider,
    OmtProvider,
  ],
  exports: [PaymentProviderRegistry, MockProvider],
})
export class PaymentProvidersModule {}
