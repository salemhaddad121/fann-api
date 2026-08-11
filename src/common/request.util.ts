import { Request } from 'express';

/**
 * The client's IP address, as best it can be known.
 *
 * On Vercel every request arrives through the edge proxy, so
 * `req.ip`/`socket.remoteAddress` is the proxy — useless as evidence of who
 * accepted terms or completed a verification. `x-forwarded-for` carries the
 * real chain, leftmost being the original client.
 *
 * That header is client-supplied and therefore spoofable in principle. It's
 * trustworthy here only because Vercel overwrites it at the edge; nothing in
 * this codebase should treat it as an authorisation input, only as a
 * recorded attribute.
 *
 * Returns null rather than a placeholder when nothing is available — a
 * missing address should read as missing, not as an address we invented.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  if (raw) {
    const first = raw.split(',')[0]?.trim();
    if (first) return normalise(first);
  }

  const direct = req.ip ?? req.socket?.remoteAddress ?? null;
  return direct ? normalise(direct) : null;
}

// IPv4-mapped IPv6 ("::ffff:1.2.3.4") is how a v4 client shows up on a
// dual-stack socket; store the v4 form so records are comparable.
function normalise(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
