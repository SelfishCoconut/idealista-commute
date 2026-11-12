// Serialises async calls and enforces a minimum gap between them.
export class Throttle {
  // parallel: only the START of calls is spaced; they may overlap (for our own server, which queues what needs it).
  constructor(minIntervalMs, { parallel = false } = {}) {
    this.min = minIntervalMs;
    this.parallel = parallel;
    this.next = 0;
    this.chain = Promise.resolve();
    this.last = 0;
  }
  run(fn) {
    if (this.parallel) {
      const start = Math.max(Date.now(), this.next);
      this.next = start + this.min;
      return new Promise((r) => setTimeout(r, start - Date.now())).then(fn);
    }
    const result = this.chain.then(async () => {
      const wait = this.last + this.min - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = result.catch(() => {});
    return result;
  }
}

export class ProviderError extends Error {
  constructor(message, { retryable = false, fatal = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.fatal = fatal; // e.g. bad API key: stop retrying and tell the user
  }
}

export async function withRetry(fn, delays = [2000, 5000]) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.retryable || i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}
