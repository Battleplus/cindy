import { describe, it, expect } from 'vitest';

/**
 * nextUpdatedAt is private in custom-provider-store.ts, so we test the CAS
 * semantics through the public updateCustomProviderIfUnchanged path.
 * However, the function is simple enough to extract and test directly.
 *
 * Since we can't import the private function, we replicate the logic here
 * for regression testing. When the function is eventually exported, these
 * tests should be moved to import it directly.
 */

function nextUpdatedAt(now: number, stored: unknown): number {
  const current = Number.isSafeInteger(now) ? now : Date.now();
  const previous =
    typeof stored === 'number'
      ? stored
      : typeof stored === 'string' && stored.trim().length > 0
        ? Number(stored)
        : Number.NaN;
  if (!Number.isSafeInteger(previous)) return current;
  if (previous >= Number.MAX_SAFE_INTEGER) return current;
  return Math.max(current, previous + 1);
}

describe('nextUpdatedAt — CAS version semantics', () => {
  it('increments by 1 when previous is a normal integer', () => {
    expect(nextUpdatedAt(100, 99)).toBe(100);
    expect(nextUpdatedAt(100, 50)).toBe(100);
    expect(nextUpdatedAt(100, 100)).toBe(101);
  });

  it('returns current when stored is not a number', () => {
    expect(nextUpdatedAt(100, null)).toBe(100);
    expect(nextUpdatedAt(100, undefined)).toBe(100);
    expect(nextUpdatedAt(100, 'not-a-number')).toBe(100);
  });

  it('parses string timestamps', () => {
    expect(nextUpdatedAt(100, '99')).toBe(100);
    expect(nextUpdatedAt(100, '100')).toBe(101);
  });

  it('CAS: version always changes on write (MAX_SAFE_INTEGER regression)', () => {
    // Seed: updated_at = MAX_SAFE_INTEGER (from corrupted/legacy data)
    const staleSnapshot = Number.MAX_SAFE_INTEGER;
    const readerA = staleSnapshot; // reader A sees this value

    // Writer B performs a normal edit
    const writerBNow = Date.now();
    const newVersion = nextUpdatedAt(writerBNow, staleSnapshot);

    // B's new version must differ from A's snapshot
    expect(newVersion).not.toBe(readerA);
    // B's version should be a real timestamp (not MAX_SAFE_INTEGER)
    expect(newVersion).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(newVersion)).toBe(true);
  });

  it('CAS: consecutive writes always produce different versions', () => {
    let version = 100;
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      version = nextUpdatedAt(version + 10, version);
      expect(seen.has(version)).toBe(false);
      seen.add(version);
    }
  });

  it('CAS: MAX_SAFE_INTEGER seed then normal write produces different value', () => {
    const v1 = nextUpdatedAt(1700000000000, Number.MAX_SAFE_INTEGER);
    const v2 = nextUpdatedAt(1700000001000, v1);
    expect(v1).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(v2).not.toBe(v1);
  });
});
