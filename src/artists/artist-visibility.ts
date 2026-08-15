import { Knex } from 'knex';
import { hasActiveSubscription } from '../common/subscription.util';
import { maskDisplayName } from '../common/mask-name.util';

/**
 * Who is looking, and therefore how much of an artist profile they get.
 *
 * 'guest' and 'registered' receive identical DATA — an account on its own
 * unlocks nothing. They are still separate values because the frontend has
 * to ask them for different things: a guest needs "sign in", someone signed
 * in without a plan needs "subscribe". Collapsing them here would push that
 * decision into the client, which does not know why a field is missing.
 */
export type ViewerTier = 'guest' | 'registered' | 'subscribed';

export interface ViewerContext {
  userId?: string;
  role?: string;
  /**
   * Client-generated session id, sent as the X-Session-Id header.
   *
   * A header rather than a query parameter on purpose: search URLs get
   * copied and shared, and a session id embedded in one would follow the
   * link into someone else's browser and merge two people's activity into
   * a single session.
   */
  sessionId?: string;
}

/** Columns everyone sees, whatever their tier. */
const PUBLIC_COLUMNS = [
  'ap.id',
  'ap.user_id',
  'ap.bio',
  'ap.location_city',
  'ap.location_country',
  'ap.languages',
  'ap.is_verified',
  'ap.thumbnail_url',
  'ap.avg_rating',
  'ap.review_count',
  'ap.created_at',
];

/**
 * Fetched for everyone, but transformed before it leaves the server:
 * display_name is masked, base_price_usd becomes a band and is then
 * dropped. They have to be read to be transformed — the band cannot be
 * computed without the figure — so shapeArtistProfile() is what guarantees
 * neither raw value reaches the response.
 */
const DERIVED_SOURCE_COLUMNS = ['ap.display_name', 'ap.base_price_usd'];

/**
 * Never fetched at all below the paying tier.
 *
 * An allowlist rather than a denylist, and that direction is the point:
 * `SELECT ap.*` shipped social_links, the exact price and the real name to
 * anonymous callers, and would have shipped every column added later too. A
 * new column now stays private until someone deliberately adds it here.
 */
const SUBSCRIBER_ONLY_COLUMNS = [
  'ap.social_links',
  'ap.deposit_usd',
  'ap.cancellation_policy',
];

export function profileColumnsFor(tier: ViewerTier): string[] {
  const columns = [...PUBLIC_COLUMNS, ...DERIVED_SOURCE_COLUMNS];
  return tier === 'subscribed' ? [...columns, ...SUBSCRIBER_ONLY_COLUMNS] : columns;
}

/**
 * Price bands for viewers who cannot see the exact figure.
 *
 * Wide enough that the exact number cannot be inferred, narrow enough to be
 * worth showing — a booker with a $300 budget needs to know whether to keep
 * reading, and hiding price entirely just sends them to ask in a message
 * they cannot send yet.
 */
const PRICE_BANDS: { max: number; label: string }[] = [
  { max: 100, label: 'Under $100' },
  { max: 250, label: '$100–$250' },
  { max: 500, label: '$250–$500' },
  { max: 1000, label: '$500–$1,000' },
  { max: 2500, label: '$1,000–$2,500' },
];

export function priceBand(basePriceUsd: unknown): string | null {
  if (basePriceUsd === null || basePriceUsd === undefined) return null;
  // NUMERIC arrives as a string from node-postgres.
  const price = Number(basePriceUsd);
  if (!Number.isFinite(price)) return null;

  const band = PRICE_BANDS.find((b) => price < b.max);
  return band ? band.label : '$2,500+';
}

/**
 * Resolves how much of a profile this viewer may see.
 *
 * Two cases bypass the paywall entirely and both are obvious in hindsight:
 * an artist opening their own public profile should not find their own name
 * masked back at them, and an admin moderating a profile needs the real
 * thing. Neither is a subscription question.
 */
export async function resolveViewerTier(
  db: Knex,
  viewer: ViewerContext,
  profileOwnerId?: string,
): Promise<ViewerTier> {
  if (!viewer.userId) return 'guest';
  if (viewer.role === 'admin') return 'subscribed';
  if (profileOwnerId && viewer.userId === profileOwnerId) return 'subscribed';

  return (await hasActiveSubscription(db, viewer.userId)) ? 'subscribed' : 'registered';
}

/**
 * Applies the tier to a fetched row.
 *
 * Shaping happens here and nowhere else, so there is one place to read when
 * asking "can a guest see this?". Note it deletes rather than overwrites:
 * an undefined property still serialises as absent, but a key left in place
 * with a null value tells a reader the field exists, which is more than a
 * guest needs to know.
 */
export function shapeArtistProfile<T extends Record<string, unknown>>(
  row: T,
  tier: ViewerTier,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = { ...row, viewer_tier: tier };

  if (tier === 'subscribed') {
    shaped.is_masked = false;
    return shaped;
  }

  shaped.display_name = maskDisplayName(row.display_name as string);
  shaped.is_masked = true;

  // A band, not the figure. Computed here from the value we fetched and
  // then dropped, so the exact price never reaches the response.
  shaped.base_price_band = priceBand(row.base_price_usd);

  delete shaped.base_price_usd;
  delete shaped.social_links;
  delete shaped.deposit_usd;
  delete shaped.cancellation_policy;

  return shaped;
}
