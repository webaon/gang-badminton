/**
 * WO-6.8 #38 — REAL DB test for `exportFinanceReportCsv()` server action.
 *
 * Mock boundary: same convention as tests/server/dashboard-overview-db.test.ts —
 * `@/lib/supabase/auth` returns a swappable fake user id, `@/lib/supabase/server`
 * returns the service-role client (RLS bypass fine here — this proves the action's
 * OWN gate via `financeReport()`/`financeReader()`, not RLS itself, which is covered
 * elsewhere).
 *
 * DoD per planner: (ก) admin with finance.view gets a CSV with BOM whose money
 * matches financeReport() of the same period; (ข) plain member and outsider are
 * both rejected with the SAME error code financeReport() itself would give them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient } from '../helpers/db';

const h = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { exportFinanceReportCsv, financeReport } from '@/server/actions/finance-report';

beforeAll(async () => {
  // no-op: schema already loaded by other suites in this run; keep file self-contained for pool access
});
afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`fin-csv-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function setup() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-fin-csv-${crypto.randomUUID()}`]);
  const gangId = gang.id;
  const member = await newUser();
  await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, member]);
  const outsider = await newUser();

  const from = '2026-09-01';
  const to = '2026-09-30';

  // รายรับ/รายจ่ายอื่นในช่วง — ให้ financeReport() มีตัวเลขไม่เป็น 0.00 ทุกตัว พิสูจน์ passthrough จริง
  await pool.query(
    `insert into public.gang_incomes (gang_id, amount, category, occurred_on, created_by) values ($1, 500.00, 'สปอนเซอร์', $2, $3)`,
    [gangId, from, owner],
  );
  await pool.query(
    `insert into public.gang_expenses (gang_id, amount, category, occurred_on, created_by) values ($1, 220.00, 'ลูกแบด', $2, $3)`,
    [gangId, from, owner],
  );

  return { gangId, owner, member, outsider, from, to };
}

type World = Awaited<ReturnType<typeof setup>>;
let wp: Promise<World> | undefined;
const world = () => (wp ??= setup());

function unwrap<T>(res: { success: true; data: T } | { success: false; error: unknown }): T {
  if (!res.success) throw res.error;
  return res.data;
}

describe('exportFinanceReportCsv() — real DB', () => {
  it('🔴 (ก) admin (owner, มี gang.finance.view): CSV มี BOM นำหน้า + ยอดเงินตรงกับ financeReport() ของช่วงเดียวกันเป๊ะ', async () => {
    const w = await world();
    h.userId = w.owner;

    const csvRes = await exportFinanceReportCsv(w.gangId, { from: w.from, to: w.to });
    const { csv, filename } = unwrap(csvRes);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(filename).toBe(`finance-report-${w.from}-${w.to}.csv`);

    const reportRes = await financeReport(w.gangId, { from: w.from, to: w.to });
    const report = unwrap(reportRes);

    // เงินทุกตัวต้องเป็น string เดียวกันเป๊ะ (ครอบด้วย "..." ใน CSV) — ไม่มีการแปลง float ที่ไหนเลย
    expect(csv).toContain(`"${report.report.charged}"`);
    expect(csv).toContain(`"${report.actualCost}"`);
    expect(csv).toContain(`"${report.report.collected}"`);
    expect(csv).toContain(`"${report.report.outstanding}"`);
    expect(csv).toContain(`"${report.transferIn}"`);
    expect(csv).toContain(`"${report.refunds}"`);
    expect(csv).toContain(`"${report.report.overpaymentIn}"`);
    expect(csv).toContain(`"${report.report.otherIncome}"`);
    expect(csv).toContain(`"${report.report.expense}"`);
    expect(csv).toContain(`"${report.report.memberPayouts}"`);
    expect(csv).toContain(`"${report.report.netCash}"`);
    expect(csv).toContain(`"${report.report.roundingSurplus}"`);

    // รายรับ/รายจ่ายที่ seed ไว้ต้องโผล่จริงใน CSV (ไม่ใช่แค่ 0.00 ทุกตัว)
    expect(report.report.otherIncome).toBe('500.00');
    expect(report.report.expense).toBe('220.00');
    expect(csv).not.toContain('กำไร');
  });

  it('🔴 (ข) สมาชิกทั่วไป (ไม่มี gang.finance.view): ถูกปฏิเสธด้วย code เดียวกับที่ financeReport() ให้', async () => {
    const w = await world();
    h.userId = w.member;

    const csvRes = await exportFinanceReportCsv(w.gangId, { from: w.from, to: w.to });
    const reportRes = await financeReport(w.gangId, { from: w.from, to: w.to });

    expect(csvRes.success).toBe(false);
    expect(reportRes.success).toBe(false);
    if (!csvRes.success && !reportRes.success) {
      expect(csvRes.error.code).toBe(reportRes.error.code);
      expect(csvRes.error.code).toBe('FORBIDDEN');
    }
  });

  it('🔴 (ข) outsider (ไม่เคยเป็นสมาชิกก๊วนนี้เลย): ถูกปฏิเสธด้วย code เดียวกับที่ financeReport() ให้', async () => {
    const w = await world();
    h.userId = w.outsider;

    const csvRes = await exportFinanceReportCsv(w.gangId, { from: w.from, to: w.to });
    const reportRes = await financeReport(w.gangId, { from: w.from, to: w.to });

    expect(csvRes.success).toBe(false);
    expect(reportRes.success).toBe(false);
    if (!csvRes.success && !reportRes.success) {
      expect(csvRes.error.code).toBe(reportRes.error.code);
      expect(csvRes.error.code).toBe('FORBIDDEN');
    }
  });
});
