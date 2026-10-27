/**
 * Token bucket rate limiter implementation
 * Enforces a maximum number of requests per second
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefillTime: number;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Create a rate limiter
   * @param requestsPerSecond Maximum requests allowed per second
   */
  constructor(requestsPerSecond: number) {
    this.maxTokens = requestsPerSecond;
    this.tokens = requestsPerSecond;
    this.refillRate = requestsPerSecond;
    this.lastRefillTime = Date.now();
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = timePassed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  private processQueue(): void {
    this.refillTokens();

    while (this.queue.length > 0 && this.tokens >= 1) {
      const request = this.queue.shift();
      if (request) {
        this.tokens -= 1;
        request.resolve();
      }
    }

    // Schedule next queue processing if there are waiting requests
    if (this.queue.length > 0) {
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
      setTimeout(() => this.processQueue(), Math.max(waitTime, 10));
    }
  }

  /**
   * Acquire a token to make a request
   * Returns immediately if tokens available, otherwise waits
   */
  async acquire(): Promise<void> {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Get current state for debugging/monitoring
   */
  getState(): { tokens: number; queueLength: number } {
    this.refillTokens();
    return {
      tokens: Math.floor(this.tokens),
      queueLength: this.queue.length,
    };
  }
}
