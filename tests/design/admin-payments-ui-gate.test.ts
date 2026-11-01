import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('features/payments/admin');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
const files = ['PaymentReview.tsx', 'PaymentReviewPage.tsx', 'ChargeHistory.tsx', 'ChargeHistoryPage.tsx'];

describe('WO-6.5b payment detail/history UI contract', () => {
  it.each(files)('%s uses server money and Astryx layout without direct DB queries', (file) => {
    const code = read(file);
    expect(code).not.toMatch(/domain\/billing|supabase(Server|Admin)|Number\(|parseFloat\(|toFixed\(|\.reduce\(|<div\b|style=|xstyle=|role\s*===/);
  });
  it('review and return clear pending state and lock uncertain results until refreshed', () => {
    for (const file of ['PaymentReview.tsx', 'ChargeHistory.tsx']) {
      const code = read(file);
      expect(code).toMatch(/finally\s*\{\s*busy.current = false; setPending\(false\)/);
      expect(code).toContain('setStale(true)');
      expect(code).toContain('actionError(result.error)');
      expect(code).toContain('if (busy.current) return');
    }
  });
  it('server owns overpayment and return amounts; return never repeats the debt reduction', () => {
    expect(read('PaymentReview.tsx')).toContain('recordOverpayment(detail.id, null, reason)');
    expect(read('ChargeHistory.tsx')).toContain('returnChargeToCredit(history.chargeId, null, reason)');
    expect(read('ChargeHistory.tsx')).not.toContain('addChargeAdjustment');
    expect(read('ChargeHistory.tsx')).toContain('history.creditReturn.canReturn');
    for (const permission of ['verify', 'reject', 'setReceivedAmount', 'recordOverpayment']) {
      expect(read('PaymentReview.tsx')).toContain(`detail.permissions.${permission}`);
    }
  });
  it('both routes enforce authentication and matching gang, with serializable props', () => {
    for (const file of ['PaymentReviewPage.tsx', 'ChargeHistoryPage.tsx']) {
      expect(read(file)).toContain('await requireUser(');
      expect(read(file)).toContain('result.data.gangId !== gangId');
      expect(read(file)).not.toContain('onClick=');
    }
  });
  it('non-image slips have an external open fallback; no raw event payloads', () => {
    expect(read('PaymentReview.tsx')).toContain("detail.slip.kind === 'image'");
    expect(read('PaymentReview.tsx')).toContain('href={detail.slip.url}');
    expect(read('PaymentReview.tsx')).toContain('noopener noreferrer');
    expect(read('ChargeHistory.tsx')).not.toContain('payload');
  });
});
