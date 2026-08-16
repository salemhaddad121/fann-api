/**
 * Bounds on how deep a public directory listing can be paged.
 *
 * Two separate concerns, both needed:
 *
 * MAX_PAGE_SIZE caps a single response. Without it one request could ask
 * for the entire roster, which is both an expensive query and the easiest
 * possible way to copy the directory.
 *
 * MAX_PAGE caps how far the offset can travel. This is the one that was
 * missing: `page` was validated as any integer >= 1, so ?page=999999
 * compiled to OFFSET 19999960 and Postgres would attempt it — scanning and
 * discarding twenty million rows to return nothing. That is a cheap request
 * to send and an expensive one to answer, which is the shape of problem
 * worth refusing outright rather than rate-limiting.
 *
 * Together they bound enumeration at MAX_PAGE_SIZE * MAX_PAGE records. That
 * is not an anti-scraping measure on its own — a determined scraper walks
 * the pages — it is the inner ring. The edge rate limiting and Bot Fight
 * Mode in front of this are what make walking them expensive.
 *
 * If the roster ever approaches this ceiling, the answer is cursor-based
 * pagination rather than a bigger number: offset pagination degrades badly
 * at depth regardless of what the limit says.
 */
export const MAX_PAGE_SIZE = 50;
export const MAX_PAGE = 200;
