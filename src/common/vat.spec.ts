import { DEFAULT_VAT_RATE, resolveVatRate, vatBreakdown } from './vat';

describe('resolveVatRate()', () => {
  it('defaults to Lebanon\u2019s standard rate when nothing is configured', () => {
    expect(resolveVatRate(undefined)).toBe(DEFAULT_VAT_RATE);
    expect(resolveVatRate('')).toBe(DEFAULT_VAT_RATE);
    expect(resolveVatRate('   ')).toBe(DEFAULT_VAT_RATE);
  });

  it('honours an explicit zero, which is the switch for holding VAT off', () => {
    // Must not fall through to the default: this is how VAT is held until
    // the tax registration number exists.
    expect(resolveVatRate('0')).toBe(0);
  });

  it('accepts a configured rate', () => {
    expect(resolveVatRate('0.11')).toBe(0.11);
    expect(resolveVatRate('0.15')).toBe(0.15);
  });

  it.each([['abc'], ['-0.1'], ['1.5'], ['11'], ['NaN']])(
    'falls back to zero, not to the default, for the invalid value %p',
    (raw) => {
      // Deliberately asymmetric. A typo should under-charge and be caught in
      // the books; substituting 11% would over-charge a real customer, and
      // would also quietly ignore a hold someone set on purpose.
      expect(resolveVatRate(raw)).toBe(0);
    },
  );

  it('reads a rate of exactly 1 as valid, and anything above it as not', () => {
    expect(resolveVatRate('1')).toBe(1);
    expect(resolveVatRate('1.0001')).toBe(0);
  });
});

describe('vatBreakdown()', () => {
  it('adds nothing at a zero rate', () => {
    expect(vatBreakdown(15, 0)).toEqual({
      subtotalUsd: 15,
      vatRate: 0,
      vatUsd: 0,
      totalUsd: 15,
    });
  });

  it('computes the three published prices at 11%', () => {
    expect(vatBreakdown(5, 0.11)).toMatchObject({ vatUsd: 0.55, totalUsd: 5.55 });
    expect(vatBreakdown(15, 0.11)).toMatchObject({ vatUsd: 1.65, totalUsd: 16.65 });
    expect(vatBreakdown(100, 0.11)).toMatchObject({ vatUsd: 11, totalUsd: 111 });
  });

  it('keeps the three figures internally consistent', () => {
    // The property an invoice actually needs: net + tax must equal gross
    // exactly, for every quantity. 15 * 0.11 is 1.6500000000000001 in
    // IEEE 754, so summing unrounded floats breaks this.
    for (let quantity = 1; quantity <= 40; quantity++) {
      for (const price of [5, 15, 100]) {
        const b = vatBreakdown(price * quantity, 0.11);
        expect(b.subtotalUsd + b.vatUsd).toBeCloseTo(b.totalUsd, 10);
        expect(Number(b.totalUsd.toFixed(2))).toBe(b.totalUsd);
      }
    }
  });

  it('rounds the tax to cents rather than carrying fractions of one', () => {
    // 3 day passes: 15 * 0.11 = 1.6500000000000001 unrounded.
    const b = vatBreakdown(15, 0.11);
    expect(b.vatUsd).toBe(1.65);
    expect(b.totalUsd).toBe(16.65);
  });

  it('rounds half up at the cent boundary', () => {
    // 0.05 * 0.11 = 0.0055 -> 0.01, not 0.
    expect(vatBreakdown(0.05, 0.11).vatUsd).toBe(0.01);
  });
});
