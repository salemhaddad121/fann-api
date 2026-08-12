import {
  classifyRedisError,
  SUSTAINED_ERROR_THRESHOLD,
} from './redis-error';

function err(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const CONNECTED = { hasConnected: true, consecutiveErrors: 1 };

describe('classifyRedisError', () => {
  // The case that prompted this: Upstash drops idle TLS connections between
  // serverless invocations, ioredis reconnects, nothing is broken.
  it('treats an occasional timeout on a healthy client as routine', () => {
    const verdict = classifyRedisError(err('ETIMEDOUT'), CONNECTED);
    expect(verdict.level).toBe('debug');
    expect(verdict.reason).toBe('idle-reconnect');
  });

  it('treats the other idle-drop codes the same way', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN']) {
      expect(classifyRedisError(err(code), CONNECTED).level).toBe('debug');
    }
  });

  // Before the first successful connect there is no connection to have gone
  // idle, so the same code means the config is wrong.
  it('escalates a timeout when the client has never connected', () => {
    const verdict = classifyRedisError(err('ETIMEDOUT'), {
      hasConnected: false,
      consecutiveErrors: 1,
    });
    expect(verdict.level).toBe('error');
    expect(verdict.reason).toBe('never-connected');
  });

  // The point of the whole exercise: a real outage must not stay hidden
  // behind the same code that idle churn uses.
  it('escalates once failures are sustained', () => {
    const belowThreshold = classifyRedisError(err('ETIMEDOUT'), {
      hasConnected: true,
      consecutiveErrors: SUSTAINED_ERROR_THRESHOLD - 1,
    });
    expect(belowThreshold.level).toBe('debug');

    const atThreshold = classifyRedisError(err('ETIMEDOUT'), {
      hasConnected: true,
      consecutiveErrors: SUSTAINED_ERROR_THRESHOLD,
    });
    expect(atThreshold.level).toBe('error');
    expect(atThreshold.reason).toBe('sustained');
  });

  it('always escalates bad credentials, however healthy the client looks', () => {
    for (const message of [
      'NOAUTH Authentication required.',
      'WRONGPASS invalid username-password pair',
      'ERR invalid password',
    ]) {
      const verdict = classifyRedisError(new Error(message), CONNECTED);
      expect(verdict.level).toBe('error');
      expect(verdict.reason).toBe('authentication');
    }
  });

  it('always escalates codes that cannot mean an idle drop', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED']) {
      const verdict = classifyRedisError(err(code), CONNECTED);
      expect(verdict.level).toBe('error');
      expect(verdict.reason).toContain('unreachable');
    }
  });

  // Escalating on ignorance is how the noise problem started, but silencing
  // on ignorance hides real faults — so unknown sits in between.
  it('warns on an unrecognised error rather than silencing or escalating', () => {
    const verdict = classifyRedisError(err('ESOMETHINGNEW'), CONNECTED);
    expect(verdict.level).toBe('warn');
    expect(verdict.reason).toBe('unclassified');
  });

  it('does not throw on a malformed error value', () => {
    expect(() => classifyRedisError(undefined, CONNECTED)).not.toThrow();
    expect(() => classifyRedisError('a string', CONNECTED)).not.toThrow();
    expect(classifyRedisError(null, CONNECTED).level).toBe('warn');
  });
});
