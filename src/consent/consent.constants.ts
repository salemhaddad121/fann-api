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
export const CONSENT_VERSIONS = {
  terms: '2026-08-11',
  privacy: '2026-08-11',
} as const;

export type ConsentDocument = keyof typeof CONSENT_VERSIONS;
