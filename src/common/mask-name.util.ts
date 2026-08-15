/**
 * Masks an artist's display name for viewers without a subscription.
 *
 * The goal is narrow: show enough that a booker can tell two search results
 * apart and recognise the person they were recommended, while withholding
 * enough that the profile cannot be turned into a name to look up on
 * Instagram and book directly. That is the whole commercial basis of the
 * subscription, so this runs on the server and the full name is never sent.
 *
 * The rule is one line: keep the first word, reduce every later word to its
 * initial. It is applied uniformly because there is no reliable way to tell
 * a person's name from a band's — "Cedar & Smoke" and "Karim Nassar" are
 * indistinguishable to code, and guessing wrong in either direction is
 * worse than one consistent rule.
 *
 * Single-word names come back unchanged. There is nothing to abbreviate
 * without destroying the entire label, and a one-word stage name is not a
 * findable identity in the way "first + surname" is.
 */
export function maskDisplayName(displayName: string | null | undefined): string {
  if (!displayName) return '';

  // Collapse any run of whitespace so padded or double-spaced names do not
  // produce empty tokens.
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];

  return words
    .map((word, index) => {
      if (index === 0) return word;

      // Spread rather than charAt: an emoji or any astral-plane character
      // is a surrogate pair, and charAt(0) would slice it in half and emit
      // a lone surrogate.
      const characters = [...word];

      // Connectors and punctuation ("&", "y", "de") are left alone. They
      // carry no identifying information, and "&." reads as a typo.
      if (characters.length <= 1) return word;

      return `${characters[0]}.`;
    })
    .join(' ');
}
