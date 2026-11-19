/**
 * Failed sign-ins, counted for the whole instance (one athlete, so there is no one to be fair
 * to by address). Ten failures inside fifteen minutes close sign-in for fifteen minutes.
 * Tempo has no limit of its own, so this keeps Cadence from relaying a password guesser.
 * In memory: a restart clears it, which is fine for one process.
 */
export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

export class LoginThrottle {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while sign-in is closed. */
  locked(): boolean {
    return this.now() < this.lockedUntil;
  }

  recordFailure(): void {
    const t = this.now();
    this.failures = this.failures.filter((at) => t - at < WINDOW_MS);
    this.failures.push(t);
    if (this.failures.length >= MAX_FAILURES) {
      this.lockedUntil = t + LOCK_MS;
      this.failures = [];
    }
  }

  recordSuccess(): void {
    this.failures = [];
  }
}
