import { Injectable } from '@nestjs/common';

/**
 * PIN brute-force defense, per-account (Security Architecture §1):
 * 5 consecutive failed attempts lock the account with an ESCALATING cooldown
 * (1 min → 5 min → 15 min per lockout episode). Tracked in memory — the Host
 * is a single process, and every failure/lockout is also persisted to the
 * audit log by the caller, so a restart merely softens, never hides, attacks.
 */
export const PIN_MAX_CONSECUTIVE_FAILURES = 5;
export const PIN_LOCKOUT_COOLDOWN_MINUTES = [1, 5, 15] as const;

interface LockState {
  consecutiveFailures: number;
  lockoutEpisodes: number;
  lockedUntil: number | null;
}

@Injectable()
export class PinLockoutService {
  private readonly states = new Map<string, LockState>();

  /** Milliseconds remaining on the current lock, or 0 if not locked. */
  getLockRemainingMs(employeeId: string, now = Date.now()): number {
    const state = this.states.get(employeeId);
    if (!state?.lockedUntil) return 0;
    return Math.max(0, state.lockedUntil - now);
  }

  /**
   * Records a failed attempt. Returns the lock duration in ms when this
   * failure triggered a lockout, or null when it did not.
   */
  recordFailure(employeeId: string, now = Date.now()): number | null {
    const state = this.states.get(employeeId) ?? {
      consecutiveFailures: 0,
      lockoutEpisodes: 0,
      lockedUntil: null,
    };
    state.consecutiveFailures += 1;

    if (state.consecutiveFailures < PIN_MAX_CONSECUTIVE_FAILURES) {
      this.states.set(employeeId, state);
      return null;
    }

    const cooldownMinutes =
      PIN_LOCKOUT_COOLDOWN_MINUTES[
        Math.min(state.lockoutEpisodes, PIN_LOCKOUT_COOLDOWN_MINUTES.length - 1)
      ];
    state.lockoutEpisodes += 1;
    state.consecutiveFailures = 0;
    state.lockedUntil = now + cooldownMinutes * 60_000;
    this.states.set(employeeId, state);
    return cooldownMinutes * 60_000;
  }

  recordSuccess(employeeId: string): void {
    this.states.delete(employeeId);
  }
}
