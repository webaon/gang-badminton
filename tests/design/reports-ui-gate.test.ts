import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const feature = readFileSync('features/reports/ReportsPage.tsx', 'utf8');
const route = readFileSync('app/gangs/[gangId]/reports/page.tsx', 'utf8');
describe('6.5b reports use the financeReport contract', () => {
  it('has a thin dynamic route and no UI financial calculations', () => {
    expect(route).toContain('ReportsPage');
    expect(route).not.toMatch(/supabase|calculateFinanceReport|toSatang|fromSatang/);
    expect(feature).not.toMatch(/domain\/billing|calculateFinanceReport|toSatang|fromSatang|parseFloat\(|Number\(|\.reduce\(/);
    expect(feature).toContain('await financeReport(gangId, { from, to })');
  });
  it('displays the loader cash lines and current-balance timestamp without recomputing them', () => {
    for (const field of ['data.transferIn', 'data.refunds', 'report.collected', 'report.overpaymentIn', 'report.memberPayouts', 'report.netCash', 'data.actualCost', 'data.outstandingAsOf', 'data.cashInBySession']) expect(feature).toContain(field);
    expect(feature).toContain('ยอดค้าง ณ');
  });
  it('keeps read/manage permissions separate and reports loader errors', () => {
    expect(feature).toContain("can(ctx, 'gang.finance.view')");
    expect(feature).toContain("can(ctx, 'gang.finance.manage')");
    expect(feature).toContain('actionError(result.error)');
    expect(feature).not.toContain('supabaseAdmin');
  });
});
