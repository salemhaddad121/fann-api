// Deciding how loudly to report a Redis connection error.
//
// The problem this solves: on serverless, Upstash drops idle TLS
// connections between invocations, so ETIMEDOUT/ECONNRESET arrive as a
// matter of course. ioredis reconnects by itself and nothing is actually
// broken. Logging every one at error level trains you to ignore Redis
// errors — at which point a genuine outage looks exactly like the noise.
//
// So the same error code is read differently depending on context:
//
//   * Before the first successful connect, a timeout is not churn. Nothing
//     has ever worked, which means the URL, TLS setting, or credentials are
//     wrong — a deploy-blocking misconfiguration, reported as such.
//
//   * After a connection has been established, an occasional timeout is
//     expected and reported at debug.
//
//   * Sustained failures escalate. Past the threshold the reconnects are
//     not succeeding, which is an outage regardless of the error code.
//
// Anything that cannot be idle churn — bad credentials, DNS failure,
// connection refused — is always an error, whatever the connection history.

/** Consecutive failures after which idle churn is treated as an outage. */
export const SUSTAINED_ERROR_THRESHOLD = 5;

export type RedisLogLevel = "debug" | "warn" | "error";

export interface RedisErrorVerdict {
  level: RedisLogLevel;
  /** Short machine-ish tag for why this level was chosen. */
  reason: string;
}

export interface RedisErrorContext {
  /** Whether the client has ever reached a ready state. */
  hasConnected: boolean;
  /** Failures since the last successful connect, including this one. */
  consecutiveErrors: number;
}

// Codes that a dropped idle connection legitimately produces.
const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
]);

// Codes that never mean "the connection went idle".
const FATAL_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ERR_TLS_CERT_ALTNAME_INVALID"]);

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "";
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error ?? "");
}

/** Redis replies to bad credentials, which are never transient. */
function isAuthFailure(error: unknown): boolean {
  const message = messageOf(error).toUpperCase();
  return (
    message.includes("NOAUTH") ||
    message.includes("WRONGPASS") ||
    message.includes("INVALID PASSWORD") ||
    message.includes("AUTH FAILED")
  );
}

export function classifyRedisError(
  error: unknown,
  context: RedisErrorContext,
): RedisErrorVerdict {
  if (isAuthFailure(error)) {
    return { level: "error", reason: "authentication" };
  }

  const code = codeOf(error);

  if (FATAL_CODES.has(code)) {
    return { level: "error", reason: `unreachable:${code}` };
  }

  if (TRANSIENT_CODES.has(code)) {
    // Never having connected rules out idle churn — this is configuration.
    if (!context.hasConnected) {
      return { level: "error", reason: "never-connected" };
    }
    if (context.consecutiveErrors >= SUSTAINED_ERROR_THRESHOLD) {
      return { level: "error", reason: "sustained" };
    }
    return { level: "debug", reason: "idle-reconnect" };
  }

  // Unrecognised. Not silenced — an unknown failure that turns out to
  // matter should still be visible — but not escalated to error either,
  // since escalating on ignorance is how the noise problem started.
  return { level: "warn", reason: "unclassified" };
}
