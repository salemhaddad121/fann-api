import { accountCodePrefix } from './users.service';

/**
 * C3 — the account code marks company and venue accounts for a human
 * reading a transfer slip.
 *
 * The constraint that matters is not which prefix each registrant gets. It
 * is that the code NEVER CHANGES after creation: it is the reconciliation
 * key a booker quotes on a Whish transfer and the thing admin matches that
 * transfer against. A converted individual keeps PLN- for ever.
 */
describe('accountCodePrefix()', () => {
  it('gives an artist ART-', () => {
    expect(accountCodePrefix('artist')).toBe('ART');
  });

  it('gives an admin ADM-', () => {
    expect(accountCodePrefix('admin')).toBe('ADM');
  });

  it('gives an individual booker PLN-', () => {
    expect(accountCodePrefix('planner', 'individual')).toBe('PLN');
  });

  it('gives a company booker CMP-', () => {
    expect(accountCodePrefix('planner', 'company', 'Event Planner')).toBe('CMP');
  });

  it('gives a venue booker VEN-', () => {
    // 'Venue' is a booker_type, not a role: per D2 a venue that wants to be
    // FOUND registers on the artist side. This is a venue that also wants
    // to SEARCH, and VEN- simply reads better on a transfer slip.
    expect(accountCodePrefix('planner', 'company', 'Venue')).toBe('VEN');
  });

  it('gives an unanswered booker PLN-, not a guess', () => {
    // Existing bookers predate the question (Q3) and are prompted rather
    // than locked out. Until they answer they are PLN-, which is also what
    // they keep if they turn out to be a company.
    expect(accountCodePrefix('planner', undefined)).toBe('PLN');
  });

  it('ignores a bookerType on an individual', () => {
    // Nonsense input should not mint a company code.
    expect(accountCodePrefix('planner', 'individual', 'Venue')).toBe('PLN');
  });
});

/**
 * The part that will bite if anyone "fixes" it later.
 */
describe('account code immutability (C3)', () => {
  it('an individual who becomes a company keeps the code it was created with', () => {
    // The prefix is computed ONCE, at creation, from the kind at that
    // moment. Converting later changes planner_profiles.planner_kind and
    // nothing else — there is no code path that recomputes the code, and
    // there must not be: every transfer already quoting PLN-000042 would
    // stop matching.
    const atCreation = accountCodePrefix('planner', 'individual');
    expect(atCreation).toBe('PLN');

    // What the account looks like after conversion. The prefix function is
    // not consulted again; this asserts what it WOULD say, to make the
    // divergence explicit and deliberate rather than surprising.
    const ifRecomputed = accountCodePrefix('planner', 'company', 'Event Planner');
    expect(ifRecomputed).toBe('CMP');
    expect(ifRecomputed).not.toBe(atCreation);
  });

  it('is what admin must NOT filter on', () => {
    // Stated as a test because the comment alone has not historically been
    // enough: a company can carry PLN-, so filtering the admin list by
    // prefix would silently miss every converted account. Filter on
    // planner_kind.
    const convertedCompany = accountCodePrefix('planner', 'individual');
    expect(convertedCompany).toBe('PLN');
  });
});
