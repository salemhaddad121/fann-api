import { maskDisplayName } from './mask-name.util';

describe('maskDisplayName()', () => {
  it('reduces a surname to an initial', () => {
    expect(maskDisplayName('Karim Nassar')).toBe('Karim N.');
  });

  it('masks every word after the first', () => {
    expect(maskDisplayName('Rania Saab Khoury')).toBe('Rania S. K.');
  });

  it('leaves a single-word name alone', () => {
    // Nothing can be abbreviated without destroying the whole label, and a
    // one-word stage name is not a findable identity the way a surname is.
    expect(maskDisplayName('Cedar')).toBe('Cedar');
  });

  it('keeps connectors intact in a band name', () => {
    // "Cedar & S." rather than "Cedar &. S." — a one-character word carries
    // no identifying information and "&." reads as a typo.
    expect(maskDisplayName('Cedar & Smoke')).toBe('Cedar & S.');
  });

  it('masks Arabic script by grapheme, not byte', () => {
    expect(maskDisplayName('كريم نصار')).toBe('كريم ن.');
  });

  it('does not split an emoji in half', () => {
    // charAt(0) on an astral-plane character emits a lone surrogate, which
    // renders as a replacement glyph.
    expect(maskDisplayName('DJ 🎧Beats')).toBe('DJ 🎧.');
  });

  it('collapses padding and double spaces', () => {
    expect(maskDisplayName('  Karim   Nassar  ')).toBe('Karim N.');
  });

  it('returns an empty string for missing input', () => {
    expect(maskDisplayName(null)).toBe('');
    expect(maskDisplayName(undefined)).toBe('');
    expect(maskDisplayName('')).toBe('');
    expect(maskDisplayName('   ')).toBe('');
  });

  it('never leaks a full surname', () => {
    // The property that actually matters, stated as one.
    const masked = maskDisplayName('Karim Nassar');
    expect(masked).not.toContain('Nassar');
  });
});
