import { EmailService } from './email.service';

// No RESEND_API_KEY, so send() logs instead of calling the provider — which
// is what makes the outgoing HTML inspectable here.
function makeService(values: Record<string, string | undefined> = {}) {
  const config = { get: <T>(k: string) => values[k] as T | undefined };
  const service = new EmailService(config as any);
  const sent: { to: string; subject: string; html: string }[] = [];
  jest.spyOn(service, 'send').mockImplementation(async (input: any) => {
    sent.push(input);
  });
  return { service, sent };
}

const base = {
  to: 'planner@example.com',
  userId: 'user-1',
  subject: 'New artists this month',
  html: '<p>Six new photographers joined.</p>',
  unsubscribeToken: 'user-1.signature',
};

describe('EmailService.sendMarketingEmail()', () => {
  it('refuses to send to someone who has not opted in', async () => {
    // §24.2. The check is here rather than in the caller because "remember
    // to check consent" is the instruction that gets missed on the fourth
    // campaign, not the first.
    const { service, sent } = makeService();

    const delivered = await service.sendMarketingEmail({
      ...base,
      hasConsent: async () => false,
    });

    expect(delivered).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('sends to someone who has', async () => {
    const { service, sent } = makeService();

    const delivered = await service.sendMarketingEmail({
      ...base,
      hasConsent: async () => true,
    });

    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('New artists this month');
  });

  it('always carries an unsubscribe link', async () => {
    // The other half of §24.2, and the reason callers cannot supply their
    // own footer: this one cannot be forgotten.
    const { service, sent } = makeService({ FRONTEND_URL: 'https://www.fann.guru' });

    await service.sendMarketingEmail({ ...base, hasConsent: async () => true });

    expect(sent[0].html).toContain('https://www.fann.guru/unsubscribe?token=');
    expect(sent[0].html).toContain('Unsubscribe');
  });

  it('url-encodes the token so a signature cannot break the link', async () => {
    const { service, sent } = makeService({ FRONTEND_URL: 'https://www.fann.guru' });

    await service.sendMarketingEmail({
      ...base,
      unsubscribeToken: 'user-1.sig+with/slashes=',
      hasConsent: async () => true,
    });

    expect(sent[0].html).toContain('token=user-1.sig%2Bwith%2Fslashes%3D');
  });

  it('says the unsubscribe does not affect account email', async () => {
    // Otherwise people decline marketing and then wonder why they stopped
    // getting booking notifications — or worse, do not unsubscribe at all
    // because they are afraid of losing them.
    const { service, sent } = makeService();

    await service.sendMarketingEmail({ ...base, hasConsent: async () => true });

    expect(sent[0].html).toMatch(/account, bookings or payments/i);
  });

  it('keeps the body it was given', async () => {
    const { service, sent } = makeService();

    await service.sendMarketingEmail({ ...base, hasConsent: async () => true });

    expect(sent[0].html).toContain('Six new photographers joined.');
  });
});
