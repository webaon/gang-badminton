import { describe, expect, it } from 'vitest';
import { localDateTime } from '../../e2e-browser/date-time';

describe('E2E datetime-local fixtures use the gang wall clock, not the runner TZ', () => {
  it.each([
    ['2026-12-31T16:30:00Z', 2, '2027-01-01T01:30'],
    ['2026-08-31T16:30:00Z', 1, '2026-09-01T00:30'],
    ['2028-02-28T16:30:00Z', 1, '2028-02-29T00:30'],
    ['2026-11-24T09:00:00Z', 30, '2026-11-25T22:00'],
  ] as const)('formats %s plus %s hours as %s in Asia/Bangkok', (instant, hours, expected) => {
    expect(localDateTime(hours, Date.parse(instant))).toBe(expected);
  });
});
