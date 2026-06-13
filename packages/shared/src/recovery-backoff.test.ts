import { describe, expect, it } from "vitest";
import {
  computeRecoveryBackoffMs,
  isWithinRecoveryBackoff,
  buildRecoveryAttemptState,
  resetRecoveryAttemptState,
  MIN_BACKOFF_MS,
  BACKOFF_MULTIPLIER,
  MAX_BACKOFF_MS,
  MAX_RECOVERY_RETRIES,
} from "./recovery-backoff.js";

describe("computeRecoveryBackoffMs", () => {
  it("returns 0 for attemptCount 0 or negative", () => {
    expect(computeRecoveryBackoffMs(0)).toBe(0);
    expect(computeRecoveryBackoffMs(-1)).toBe(0);
  });

  it("returns MIN_BACKOFF_MS for attempt 1 (30s)", () => {
    expect(computeRecoveryBackoffMs(1)).toBe(MIN_BACKOFF_MS);
    expect(computeRecoveryBackoffMs(1)).toBe(30_000);
  });

  it("returns MIN_BACKOFF_MS * 4 for attempt 2 (2min)", () => {
    expect(computeRecoveryBackoffMs(2)).toBe(30_000 * 4);
    expect(computeRecoveryBackoffMs(2)).toBe(120_000);
  });

  it("returns MIN_BACKOFF_MS * 16 for attempt 3 (8min)", () => {
    expect(computeRecoveryBackoffMs(3)).toBe(30_000 * 16);
    expect(computeRecoveryBackoffMs(3)).toBe(480_000);
  });

  it("caps at MAX_BACKOFF_MS (30min) for attempt 4+", () => {
    // 30_000 * 4^3 = 1_920_000 = 32min, capped at 30min
    expect(computeRecoveryBackoffMs(4)).toBe(MAX_BACKOFF_MS);
    expect(computeRecoveryBackoffMs(5)).toBe(MAX_BACKOFF_MS);
    expect(computeRecoveryBackoffMs(10)).toBe(MAX_BACKOFF_MS);
  });

  it("produces the full expected sequence", () => {
    expect(computeRecoveryBackoffMs(1)).toBe(30_000);     // 30s
    expect(computeRecoveryBackoffMs(2)).toBe(120_000);    // 2min
    expect(computeRecoveryBackoffMs(3)).toBe(480_000);    // 8min
    expect(computeRecoveryBackoffMs(4)).toBe(1_800_000);  // 30min (cap)
    expect(computeRecoveryBackoffMs(5)).toBe(1_800_000);  // 30min (cap)
  });
});

describe("isWithinRecoveryBackoff", () => {
  it("returns false when lastRecoveryAttemptAt is null or undefined", () => {
    expect(isWithinRecoveryBackoff(null, 1)).toBe(false);
    expect(isWithinRecoveryBackoff(undefined, 1)).toBe(false);
  });

  it("returns false when lastRecoveryAttemptAt is empty string", () => {
    expect(isWithinRecoveryBackoff("", 1)).toBe(false);
  });

  it("returns false when lastRecoveryAttemptAt is invalid string", () => {
    expect(isWithinRecoveryBackoff("not-a-date", 1)).toBe(false);
  });

  it("returns true when elapsed time is less than the backoff delay", () => {
    const now = new Date("2025-01-15T12:00:00Z");
    const recent = new Date("2025-01-15T12:00:15Z"); // 15s ago — less than 30s
    expect(isWithinRecoveryBackoff(recent.toISOString(), 1, now)).toBe(true);
  });

  it("returns false when elapsed time equals the backoff delay", () => {
    const now = new Date("2025-01-15T12:00:30Z");
    const old = new Date("2025-01-15T12:00:00Z"); // 30s ago — exactly at limit
    expect(isWithinRecoveryBackoff(old.toISOString(), 1, now)).toBe(false);
  });

  it("returns false when elapsed time exceeds the backoff delay", () => {
    const now = new Date("2025-01-15T12:01:00Z");
    const old = new Date("2025-01-15T12:00:00Z"); // 60s ago — exceeds 30s
    expect(isWithinRecoveryBackoff(old.toISOString(), 1, now)).toBe(false);
  });

  it("uses attemptCount 0 when recoveryAttemptCount is undefined (fallback to MIN)", () => {
    const now = new Date("2025-01-15T12:00:00Z");
    const recent = new Date("2025-01-15T12:00:10Z"); // 10s — within MIN_BACKOFF
    expect(isWithinRecoveryBackoff(recent.toISOString(), undefined, now)).toBe(true);
  });

  it("respects longer backoff for higher attempt counts", () => {
    // For attemptCount=3, backoff is 8min (480s)
    const now = new Date("2025-01-15T12:05:00Z");
    const attempt = new Date("2025-01-15T12:00:00Z"); // 5min ago — within 8min
    expect(isWithinRecoveryBackoff(attempt.toISOString(), 3, now)).toBe(true);

    const later = new Date("2025-01-15T12:10:00Z"); // 10min ago — exceeds 8min
    expect(isWithinRecoveryBackoff(attempt.toISOString(), 3, later)).toBe(false);
  });
});

describe("buildRecoveryAttemptState", () => {
  it("increments from undefined to 1 and stamps a timestamp", () => {
    const state = buildRecoveryAttemptState(undefined);
    expect(state.recoveryAttemptCount).toBe(1);
    expect(state.lastRecoveryAttemptAt).toBeTruthy();
    expect(() => new Date(state.lastRecoveryAttemptAt)).not.toThrow();
  });

  it("increments from 0 to 1", () => {
    const state = buildRecoveryAttemptState(0);
    expect(state.recoveryAttemptCount).toBe(1);
  });

  it("increments from 1 to 2", () => {
    const state = buildRecoveryAttemptState(1);
    expect(state.recoveryAttemptCount).toBe(2);
  });

  it("increments from 5 to 6 (beyond max)", () => {
    const state = buildRecoveryAttemptState(5);
    expect(state.recoveryAttemptCount).toBe(6);
  });

  it("accepts a custom timestamp", () => {
    const fixed = new Date("2025-06-15T10:00:00Z");
    const state = buildRecoveryAttemptState(3, fixed);
    expect(state.recoveryAttemptCount).toBe(4);
    expect(state.lastRecoveryAttemptAt).toBe(fixed.toISOString());
  });
});

describe("resetRecoveryAttemptState", () => {
  it("resets attempt count to 0 and clears the timestamp", () => {
    const state = resetRecoveryAttemptState();
    expect(state.recoveryAttemptCount).toBe(0);
    expect(state.lastRecoveryAttemptAt).toBeNull();
  });
});

describe("constants", () => {
  it("defines MIN_BACKOFF_MS as 30 seconds", () => {
    expect(MIN_BACKOFF_MS).toBe(30_000);
  });

  it("defines BACKOFF_MULTIPLIER as 4", () => {
    expect(BACKOFF_MULTIPLIER).toBe(4);
  });

  it("defines MAX_BACKOFF_MS as 30 minutes", () => {
    expect(MAX_BACKOFF_MS).toBe(1_800_000);
  });

  it("defines MAX_RECOVERY_RETRIES as 5", () => {
    expect(MAX_RECOVERY_RETRIES).toBe(5);
  });
});
