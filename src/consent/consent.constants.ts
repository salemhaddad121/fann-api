// The version label stored against each acceptance.
//
// Bump the relevant entry whenever the wording of that document changes.
// Existing rows are left alone — they are the record of what a user
// actually agreed to at the time — so an old value here is not stale data,
// it is the evidence.
//
// Dated rather than numbered: "which text was live on that date" is
// answerable from the repo history, whereas "v3" is not.
//
// These must stay in step with the documents the frontend renders at
// /terms and /privacy.
//
// `marketing` is not a document anyone reads at a URL — it is the wording
// of the opt-in itself, on the signup form and the account screen. It is
// versioned all the same, and for the same reason: §24.2 consent has to be
// specific, so "they agreed to marketing" is only evidence if we can say
// which sentence they were shown when they did.
export const CONSENT_VERSIONS = {
  terms: '2026-08-11',
  privacy: '2026-08-11',
  marketing: '2026-09-08',
} as const;

export type ConsentDocument = keyof typeof CONSENT_VERSIONS;

/**
 * Documents that are conditions of using the platform, and so cannot be
 * withdrawn while the account exists — refusing them is closing the
 * account, which is a different flow.
 *
 * Kept as data rather than a hardcoded check so the withdrawal endpoint
 * refuses "withdraw my acceptance of the Terms" by rule instead of by
 * omission.
 */
export const MANDATORY_DOCUMENTS: readonly ConsentDocument[] = ['terms', 'privacy'];
