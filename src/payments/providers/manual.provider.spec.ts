import { ManualProvider } from './manual.provider';

// B6 — the payment screen produced a correct invoice and never once said
// who to pay. The manual provider's entire instruction string was:
//
//   Transfer $5.55 USD. Quote reference PLN-000015 on the transfer. Then
//   tell us the transfer reference number so we can match it.
//
// No account name, no number, no beneficiary — not in the page and not in
// the payload behind it. Every booker who decided to buy stopped there.

function providerWith(env: Record<string, string | undefined>) {
  const provider = new ManualProvider({
    get: (key: string) => env[key],
  } as never);
  jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
  return provider;
}

const CONFIGURED = {
  WHISH_ACCOUNT_NAME: 'Fann SARL',
  WHISH_ACCOUNT_NUMBER: '+961 71 234 567',
};

const input = {
  paymentId: 'pay-1',
  amountUsd: 5.55,
  currency: 'USD',
  userId: 'user-1',
  accountCode: 'PLN-000015',
  planCode: 'day',
  quantity: 1,
} as never;

describe('ManualProvider', () => {
  it('returns who to pay, not just how much', async () => {
    const intent = await providerWith(CONFIGURED).createIntent(input);

    expect(intent.recipient).toMatchObject({
      service: 'Whish Money',
      accountName: 'Fann SARL',
      accountNumber: '+961 71 234 567',
    });
  });

  it('tells the buyer what happens if the transfer fails', async () => {
    const intent = await providerWith(CONFIGURED).createIntent(input);

    expect(intent.recipient?.ifItFails).toEqual(expect.any(String));
    expect(intent.recipient?.ifItFails.length).toBeGreaterThan(0);
  });

  it('keeps the recipient structured rather than appended to the prose', async () => {
    // An account number inside a sentence cannot be made the most
    // prominent thing on the screen, given a copy button, or checked for.
    const intent = await providerWith(CONFIGURED).createIntent(input);

    expect(intent.instructions).not.toContain('Fann SARL');
    expect(intent.instructions).not.toContain('961 71 234 567');
  });

  it('still states the amount and the reference code', async () => {
    const intent = await providerWith(CONFIGURED).createIntent(input);

    expect(intent.instructions).toContain('$5.55');
    expect(intent.instructions).toContain('PLN-000015');
  });

  it('carries optional branch/IBAN detail when configured', async () => {
    const intent = await providerWith({
      ...CONFIGURED,
      WHISH_ACCOUNT_REFERENCE: 'Hamra branch',
      WHISH_SERVICE_LABEL: 'Whish Money (Lebanon)',
    }).createIntent(input);

    expect(intent.recipient?.reference).toBe('Hamra branch');
    expect(intent.recipient?.service).toBe('Whish Money (Lebanon)');
  });

  it('omits the block entirely when the account is not configured', async () => {
    // Not a half-filled one. "Whish Money" above two blank lines looks like
    // the page broke rather than like the shop is not open, and the buyer
    // transfers nothing either way.
    const intent = await providerWith({}).createIntent(input);

    expect(intent.recipient).toBeUndefined();
  });

  it('logs at error level when it cannot name a payee', async () => {
    const provider = providerWith({ WHISH_ACCOUNT_NAME: 'Fann SARL' }); // no number

    await provider.createIntent(input);

    expect((provider as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('WHISH_ACCOUNT_NAME'),
    );
  });

  it('still refuses any inbound webhook', async () => {
    // Confirmation is a person clicking a button; a webhook claiming to be
    // this provider is a mistake or an attempt to skip that step.
    const provider = providerWith(CONFIGURED);

    expect(provider.verifySignature()).toBe(false);
    expect(() => provider.parseWebhook()).toThrow();
  });
});
