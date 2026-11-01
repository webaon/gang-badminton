import { describe, expect, it } from 'vitest';
import { financeRange } from '@/server/payments/report-range';

describe('WO-6.5a Q-R1 — Bangkok inclusive calendar dates to UTC half-open instants', () => {
  it('Nov 1–30 means [Oct 31 17:00Z, Nov 30 17:00Z), independent of host TZ', () => {
    expect(financeRange({ from: '2026-11-01', to: '2026-11-30' })).toEqual({
      from: '2026-11-01', to: '2026-11-30', timeZone: 'Asia/Bangkok',
      startUtc: '2026-10-31T17:00:00.000Z', endUtcExclusive: '2026-11-30T17:00:00.000Z',
    });
  });
  it('leap day and year end roll over to the next LOCAL date correctly', () => {
    expect(financeRange({ from: '2028-02-29', to: '2028-02-29' }).endUtcExclusive).toBe('2028-02-29T17:00:00.000Z');
    expect(financeRange({ from: '2026-12-31', to: '2026-12-31' }).endUtcExclusive).toBe('2026-12-31T17:00:00.000Z');
  });
  it.each([
    ['2026-02-29', '2026-03-01'], ['2026-04-31', '2026-05-01'],
    ['2026-11-02', '2026-11-01'], ['2026-1-01', '2026-11-01'],
    ['2026-11-01T00:00:00Z', '2026-11-02'], ['', '2026-11-01'],
    ['0000-01-01', '2026-11-01'], ['2026-11-01', '2026-13-01'],
  ])('rejects invalid/reversed/non-date range %s to %s', (from, to) => {
    expect(() => financeRange({ from, to })).toThrow();
  });
});
