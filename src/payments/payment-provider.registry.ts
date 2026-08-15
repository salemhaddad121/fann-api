import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider } from './providers/payment-provider.interface';
import { ManualProvider } from './providers/manual.provider';
import { MockProvider } from './providers/mock.provider';
import { WhishProvider } from './providers/whish.provider';
import { OmtProvider } from './providers/omt.provider';

/**
 * Resolves provider instances by code.
 *
 * Two different lookups, and conflating them would be a bug:
 *
 *   active()  — which provider new purchases should use. Config-driven.
 *   byCode()  — which provider a given webhook or existing payment belongs
 *               to. Never config-driven, because a payment created under
 *               one provider must keep being processed by that provider
 *               even after the active one changes. Switching providers
 *               must not strand payments already in flight.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly configService: ConfigService,
    manual: ManualProvider,
    mock: MockProvider,
    whish: WhishProvider,
    omt: OmtProvider,
  ) {
    for (const provider of [manual, mock, whish, omt]) {
      this.providers.set(provider.code, provider);
    }
  }

  /** The provider new purchases go through. Defaults to manual. */
  active(): PaymentProvider {
    const code = this.configService.get<string>('PAYMENT_PROVIDER') ?? 'manual';
    const provider = this.providers.get(code);

    if (!provider) {
      // Falling back rather than throwing: a typo in an env var should not
      // take down purchasing entirely, and manual always works.
      this.logger.error(
        `[Payments] PAYMENT_PROVIDER="${code}" is not a known provider — falling back to manual.`,
      );
      return this.providers.get('manual')!;
    }

    return provider;
  }

  byCode(code: string): PaymentProvider {
    const provider = this.providers.get(code);
    if (!provider) throw new NotFoundException(`Unknown payment provider: ${code}`);
    return provider;
  }

  has(code: string): boolean {
    return this.providers.has(code);
  }

  /** Providers that support polling, for the reconciliation job. */
  pollable(): PaymentProvider[] {
    return [...this.providers.values()].filter((p) => typeof p.getStatus === 'function');
  }
}
