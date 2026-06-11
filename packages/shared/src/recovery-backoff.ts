// Recovery backoff constants and helpers for the Paperclip heartbeat recovery loop.
// When a recovery re-enqueue fails, we wait longer before retrying the same issue.

/** Minimum backoff before re-enqueueing a recovery for the same issue (30s). */
export const MIN_BACKOFF_MS = 30_000;

/** Exponential multiplier applied after each consecutive failure. */
export const BACKOFF_MULTIPLIER = 4;

/** Maximum backoff cap (30min). No matter how many failures, never wait longer than this. */
export const MAX_BACKOFF_MS = 1_800_000;

/** Max consecutive recovery failures before the issue is paused with a manual-resume requirement. */
export const MAX_RECOVERY_RETRIES = 5;

/**
 * Compute the exponential backoff delay for the given attempt count.
 * Sequence (1-indexed): 30s → 2min → 8min → 30min → 30min (capped)
 */
export function computeRecoveryBackoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  const delay = MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attemptCount - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * Parse a string or null `lastRecoveryAttemptAt` value into a Date.
 * Returns null for null, undefined, or unparseable values.
 */
function parseRecoveryTimestamp(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Return true if the elapsed time since the last recovery attempt is less than
 * the required backoff delay for the given attempt count — meaning we should
 * SKIP re-enqueueing and wait.
 */
export function isWithinRecoveryBackoff(
  lastRecoveryAttemptAt: string | null | undefined,
  recoveryAttemptCount: number | undefined,
  now: Date = new Date(),
): boolean {
  const lastAttempt = parseRecoveryTimestamp(lastRecoveryAttemptAt);
  if (!lastAttempt) return false; // no prior attempt means no cooldown
  const elapsed = now.getTime() - lastAttempt.getTime();
  const requiredDelay = computeRecoveryBackoffMs(recoveryAttemptCount ?? 0);
  return elapsed < requiredDelay;
}

/**
 * Build the `recoveryAttemptCount` and `lastRecoveryAttemptAt` fields to persist
 * into executionState after a recovery attempt. Increments the counter and stamps
 * the current time.
 */
export function buildRecoveryAttemptState(
  previousCount: number | undefined,
  now: Date = new Date(),
): { recoveryAttemptCount: number; lastRecoveryAttemptAt: string } {
  return {
    recoveryAttemptCount: (previousCount ?? 0) + 1,
    lastRecoveryAttemptAt: now.toISOString(),
  };
}

/**
 * Return the recovery‑attempt state that resets the counter (after a successful run).
 */
export function resetRecoveryAttemptState(): { recoveryAttemptCount: number; lastRecoveryAttemptAt: null } {
  return {
    recoveryAttemptCount: 0,
    lastRecoveryAttemptAt: null,
  };
}