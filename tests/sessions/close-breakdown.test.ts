/**
 * WO-B12 DoD — หน้าปิดรอบแยกยอดต่อคน (ค่าคอร์ท / ค่าลูก / ค่าปรับ / ปัดเศษ)
 *
 * เรียก server action จริง (`previewSessionCharges` / `closeSessionWithBilling`) กับ DB local
 * โดย mock เฉพาะ auth/headers/cache — ไม่มีสูตรเงินในเทสต์นี้นอกจากการบวกเปรียบเทียบ
 *
 *   1. ทุกแถว court + shuttle + penalty + rounding = amount
 *   2. ผลรวมหมวด = total · ผลรวมหมวด + absorbed − เศษ ผูกกับ roundingSurplus/ต้นทุนจริง
 *   3. preview ตรงกับ charge ที่ close_session เขียนลง DB จริงทุกแถว
 *      (ยกเลิกช้า · สมาชิกรายเดือน · guest · no-check-in · ปัดเศษ · absorb · flat_rate)
 *   4. สิทธิ์ billing.close เดิมยังบังคับ · ชื่อ field เดิมไม่เปลี่ยน
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { pool, serviceClient } from '../helpers/db';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { breakdownCharges } from '@/domain/billing/charge-breakdown';
import type { BillingResult, BillingSnapshot } from '@/domain/billing/session-billing';

const h = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUser: async () => ({ id: h.userId }),
}));
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => serviceClient(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => serviceClient(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { previewSessionCharges, closeSessionWithBilling } from '@/server/actions/billing';

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`b12-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

type Who = 'attended' | 'monthly' | 'guest' | 'late_cancel' | 'no_check_in';

type Opts = {
  kind: 'cps' | 'flat';
  people: Who[];
  mode?: 'ceil_baht' | 'ceil_satang' | 'absorb';
  courtFeeTotal?: string;
  shuttlePrice?: string;
  shuttles?: string;
  monthlyPaysShuttle?: boolean;
  flatAmount?: string;
};

async function setup(opts: Opts) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const snapshot = {
    snapshot_version: 1,
    pricing_plan:
      opts.kind === 'cps'
        ? {
            id: null,
            name: 'ค่าสนาม+ลูก',
            type: 'court_plus_shuttle',
            params: {
              court_fee_total: opts.courtFeeTotal ?? '800.00',
              shuttle_price: opts.shuttlePrice ?? '25.00',
            },
            monthly_member_pays_shuttle: opts.monthlyPaysShuttle ?? true,
          }
        : {
            id: null,
            name: 'เหมาจ่าย',
            type: 'flat_rate',
            params: { amount_per_person: opts.flatAmount ?? '150.00' },
          },
    rounding_policy: { mode: opts.mode ?? 'ceil_baht', surplus_to: 'gang' },
    promptpay_id: '0812345678',
    cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
    skill_levels: [],
  };

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, court_count, snapshot, created_by)
     values ($1, 'แยกยอด', now() - interval '3 hours', now() - interval '1 hour', $2, 2, $3::jsonb, $4)
     returning id`,
    [gang.id, opts.people.length + 4, JSON.stringify(snapshot), owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const regs: { id: string; who: Who }[] = [];
  for (const who of opts.people) {
    if (who === 'guest') {
      const {
        rows: [r],
      } = await pool.query<{ id: string }>(
        `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
         values ($1, $2, 'confirmed', 0, $3) returning id`,
        [session.id, `แขก-${regs.length}`, owner],
      );
      regs.push({ id: r.id, who });
      continue;
    }
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role, is_monthly_member)
       values ($1, $2, 'member', $3)`,
      [gang.id, u, who === 'monthly'],
    );
    const {
      rows: [r],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [session.id, u]);
    regs.push({ id: r.id, who });
  }

  for (const r of regs) {
    if (r.who === 'late_cancel') {
      // นัดเริ่มไปแล้ว ⇒ ยกเลิกตอนนี้เลย cutoff ⇒ ยกเลิกช้าจริงผ่าน cancel_registration()
      await pool.query(`select public.cancel_registration($1, $2)`, [r.id, owner]);
    } else if (r.who !== 'no_check_in') {
      await pool.query(`select public.check_in_registration($1, $2)`, [r.id, owner]);
    }
  }
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  if (opts.kind === 'cps' && opts.shuttles) {
    const checked = regs.filter((r) => r.who !== 'late_cancel' && r.who !== 'no_check_in');
    // games_distinct_players: ต้องมีสี่คนที่ต่างกัน
    const four = [0, 1, 2, 3].map((i) => checked[i % checked.length].id);
    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at, shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, now() - interval '1 hour', now(), $6, $7)`,
      [session.id, ...four, opts.shuttles, owner],
    );
  }

  h.userId = owner;
  return { owner, gangId: gang.id, sessionId: session.id, regs };
}

type Preview = Awaited<ReturnType<typeof previewSessionCharges>> extends infer R
  ? R extends { success: true; data: infer D }
    ? D
    : never
  : never;

async function previewOk(sessionId: string, input?: Parameters<typeof previewSessionCharges>[1]): Promise<Preview> {
  const res = await previewSessionCharges(sessionId, input);
  if (!res.success) throw new Error(`preview failed: ${res.error.code} ${res.error.message}`);
  return res.data;
}

const sat = (xs: string[]) => sumSatang(xs.map(toSatang));

/** ตรวจ invariant ของ preview ล้วนๆ (ข้อ 1–2) */
function expectPreviewInvariants(p: Preview, opts: { fullClose?: boolean } = { fullClose: true }) {
  for (const r of p.rows) {
    const parts = sat([r.breakdown.court, r.breakdown.shuttle, r.breakdown.penalty, r.breakdown.rounding]);
    expect(fromSatang(parts), `${r.displayName} (${r.reason})`).toBe(r.amount);
  }
  const col = (k: 'court' | 'shuttle' | 'penalty' | 'rounding') => sat(p.rows.map((r) => r.breakdown[k]));
  expect(fromSatang(col('court'))).toBe(p.courtCostTotal);
  expect(fromSatang(col('shuttle'))).toBe(p.shuttleCostTotal);
  expect(fromSatang(col('penalty'))).toBe(p.penaltyTotal);
  expect(fromSatang(col('rounding'))).toBe(p.roundingTotal);
  expect(sat([p.courtCostTotal, p.shuttleCostTotal, p.penaltyTotal, p.roundingTotal])).toBe(toSatang(p.total));
  // roundingSurplus (นิยามเดิม: เก็บได้ − ต้นทุนจริง) = เศษรายคนรวม − ต้นทุนที่ไม่มีใครหาร
  // (เฉพาะปิดรอบเต็ม — ยกเลิกกลางคัน ratio<1 ส่วนต่างที่ก๊วนดูดซับอยู่ระดับนัด ไม่ใช่เศษรายคน)
  if (opts.fullClose !== false) {
    expect(toSatang(p.roundingSurplus)).toBe(toSatang(p.roundingTotal) - toSatang(p.absorbedCostTotal));
  }
}

/** ปิดรอบจริง แล้วเทียบ preview กับแถว session_charges ใน DB (ข้อ 3) */
async function expectMatchesDb(sessionId: string, p: Preview) {
  const closed = await closeSessionWithBilling(sessionId);
  if (!closed.success) throw new Error(`close failed: ${closed.error.code} ${closed.error.message}`);
  expect(closed.data.total).toBe(p.total);
  expect(closed.data.chargeCount).toBe(p.chargedCount);

  const { rows } = await pool.query<{
    registration_id: string;
    amount: string;
    breakdown: Record<string, string | boolean>;
  }>(
    `select registration_id, amount::text, breakdown from public.session_charges
      where session_id = $1 and type = 'session'`,
    [sessionId],
  );
  expect(rows).toHaveLength(p.chargedCount);

  const byReg = new Map(p.rows.map((r) => [r.registrationId, r]));
  for (const db of rows) {
    const row = byReg.get(db.registration_id)!;
    expect(row, 'ทุกแถวใน DB ต้องอยู่ใน preview').toBeDefined();
    expect(row.amount).toBe(db.amount);
    expect(row.reason).toBe(db.breakdown.reason);
    expect(row.breakdown.rounding).toBe(db.breakdown.rounding_surplus ?? '0.00');

    const isPenalty = db.breakdown.reason !== 'attended';
    const dbParts =
      db.breakdown.court_fee !== undefined
        ? toSatang(String(db.breakdown.court_fee)) + toSatang(String(db.breakdown.shuttle_fee))
        : toSatang(String(db.breakdown.flat_rate));
    const prevParts = sat([row.breakdown.court, row.breakdown.shuttle, row.breakdown.penalty]) + toSatang(row.breakdown.rounding);
    // ที่ DB เขียน (court_fee+shuttle_fee รวมเศษแล้ว หรือ flat_rate) = ส่วนที่แยกได้ + เศษ
    expect(prevParts, `DB ${db.registration_id}`).toBe(toSatang(db.amount));
    if (db.breakdown.court_fee !== undefined) expect(dbParts).toBe(toSatang(db.amount));
    // ค่าปรับอยู่ช่อง penalty ทั้งก้อน · คนมาเล่นไม่มี penalty
    if (isPenalty) {
      expect(toSatang(row.breakdown.court) + toSatang(row.breakdown.shuttle)).toBe(0);
    } else {
      expect(toSatang(row.breakdown.penalty)).toBe(0);
    }
  }
  // คนที่ไม่ถูกเก็บ: ศูนย์ทุกช่อง
  const charged = new Set(rows.map((r) => r.registration_id));
  for (const r of p.rows.filter((x) => !charged.has(x.registrationId))) {
    expect(r.amount).toBe('0.00');
    expect(sat(Object.values(r.breakdown))).toBe(0);
  }
  const sumDb = sumSatang(rows.map((r) => toSatang(r.amount)));
  expect(fromSatang(sumDb)).toBe(p.total);
}

// ---------------------------------------------------------------------------

describe('WO-B12 — แยกยอดต่อคน: preview ตรงกับ charge ที่ปิดรอบเขียนจริง', () => {
  it('🔴 court_plus_shuttle · หารไม่ลงตัว · ยกเลิกช้า + รายเดือน + guest + ไม่ได้เช็คอิน', async () => {
    const t = await setup({
      kind: 'cps',
      people: ['attended', 'attended', 'attended', 'monthly', 'guest', 'late_cancel', 'no_check_in'],
      courtFeeTotal: '800.00',
      shuttlePrice: '25.00',
      shuttles: '6.5',
    });
    const p = await previewOk(t.sessionId);

    expectPreviewInvariants(p);
    expect(p.pricingType).toBe('court_plus_shuttle');
    expect(p.chargedCount).toBe(7);
    // มีค่าปรับจริง (ยกเลิกช้า + ไม่เช็คอิน) และมีเศษปัดจริง
    expect(toSatang(p.penaltyTotal)).toBeGreaterThan(0);
    expect(toSatang(p.roundingTotal)).toBeGreaterThan(0);
    expect(p.rows.find((r) => r.reason === 'late_cancel')!.breakdown.penalty).not.toBe('0.00');
    expect(p.rows.find((r) => r.reason === 'no_check_in')!.breakdown.penalty).not.toBe('0.00');
    // สมาชิกรายเดือนไม่จ่ายค่าคอร์ท แต่จ่ายค่าลูก
    const monthly = p.rows.find((r) => r.isMonthlyMember)!;
    expect(monthly.breakdown.court).toBe('0.00');
    expect(toSatang(monthly.breakdown.shuttle)).toBeGreaterThan(0);

    await expectMatchesDb(t.sessionId, p);
  });

  it('โหมด absorb (เก็บน้อยกว่าต้นทุน) · เศษติดลบ', async () => {
    const t = await setup({
      kind: 'cps',
      people: ['attended', 'attended', 'attended', 'attended', 'attended', 'attended', 'attended'],
      mode: 'absorb',
      shuttles: '6',
    });
    const p = await previewOk(t.sessionId);
    expectPreviewInvariants(p);
    expect(toSatang(p.roundingSurplus)).toBeLessThan(0);
    expect(toSatang(p.roundingTotal)).toBeLessThan(0);
    await expectMatchesDb(t.sessionId, p);
  });

  it('ceil_satang · สมาชิกรายเดือนไม่จ่ายค่าลูก (monthly_member_pays_shuttle = false)', async () => {
    const t = await setup({
      kind: 'cps',
      people: ['attended', 'attended', 'attended', 'monthly', 'monthly'],
      mode: 'ceil_satang',
      courtFeeTotal: '700.00',
      shuttles: '5.5',
      monthlyPaysShuttle: false,
    });
    const p = await previewOk(t.sessionId);
    expectPreviewInvariants(p);
    for (const r of p.rows.filter((x) => x.isMonthlyMember)) {
      expect(r.amount).toBe('0.00');
    }
    await expectMatchesDb(t.sessionId, p);
  });

  it('🔴 ทุกคนเป็นสมาชิกรายเดือน → ค่าคอร์ทไม่มีใครหาร ก๊วนรับเอง (absorbedCostTotal)', async () => {
    const t = await setup({
      kind: 'cps',
      people: ['monthly', 'monthly', 'monthly', 'monthly'],
      courtFeeTotal: '600.00',
      shuttles: '4',
    });
    const p = await previewOk(t.sessionId);
    expectPreviewInvariants(p);
    expect(p.absorbedCostTotal).toBe('600.00');
    expect(p.courtCostTotal).toBe('0.00');
    expect(toSatang(p.roundingSurplus)).toBe(-60000 + toSatang(p.roundingTotal));
    await expectMatchesDb(t.sessionId, p);
  });

  it('flat_rate · ราคาต่อหัวอยู่ช่อง court · ค่าปรับแยกช่อง · ไม่มีเศษ', async () => {
    const t = await setup({
      kind: 'flat',
      people: ['attended', 'attended', 'monthly', 'guest', 'late_cancel', 'no_check_in'],
      flatAmount: '150.00',
    });
    const p = await previewOk(t.sessionId);
    expectPreviewInvariants(p);
    expect(p.pricingType).toBe('flat_rate');
    expect(p.shuttleCostTotal).toBe('0.00');
    expect(p.roundingTotal).toBe('0.00');
    // 2 attended + guest = 3 × 150 ที่ช่อง court · ปรับ 2 คน × 150 · รายเดือน 0
    expect(p.courtCostTotal).toBe('450.00');
    expect(p.penaltyTotal).toBe('300.00');
    expect(p.total).toBe('750.00');
    await expectMatchesDb(t.sessionId, p);
  });

  it('ยกเลิกกลางคัน (ratio 0.5): ทุกแถวยังรวมเท่ายอดเดิม', async () => {
    const t = await setup({
      kind: 'cps',
      people: ['attended', 'attended', 'attended', 'monthly', 'late_cancel'],
      shuttles: '3.5',
    });
    const p = await previewOk(t.sessionId, { toStatus: 'cancelled', midwayCancelRatio: 0.5 });
    expectPreviewInvariants(p, { fullClose: false });
    expect(toSatang(p.total)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ความเข้ากันได้ + สิทธิ์
// ---------------------------------------------------------------------------

describe('WO-B12 — field เดิมไม่เปลี่ยน · สิทธิ์ billing.close ยังบังคับ', () => {
  it('field เดิมของ BillingPreview / ChargePreviewRow ยังอยู่ครบและความหมายเดิม', async () => {
    const t = await setup({ kind: 'flat', people: ['attended', 'attended', 'no_check_in'] });
    const p = await previewOk(t.sessionId);

    for (const k of [
      'sessionStatus',
      'pricingType',
      'roundingSurplus',
      'rows',
      'total',
      'chargedCount',
      'checkedInCount',
      'needsConfirmation',
      'warnings',
    ]) {
      expect(p, k).toHaveProperty(k);
    }
    for (const k of ['registrationId', 'displayName', 'status', 'reason', 'amount', 'isMonthlyMember']) {
      expect(p.rows[0], k).toHaveProperty(k);
    }
    expect(p.sessionStatus).toBe('in_play');
    expect(p.checkedInCount).toBe(2);
    expect(p.chargedCount).toBe(3);
    expect(p.total).toBe('450.00');
    expect(p.roundingSurplus).toBe('0.00');
  });

  it('🔴 member ธรรมดาเรียก preview → FORBIDDEN · ไม่เห็นตัวเลขใดๆ', async () => {
    const t = await setup({ kind: 'flat', people: ['attended', 'attended'] });
    const member = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [
      t.gangId,
      member,
    ]);
    h.userId = member;
    const res = await previewSessionCharges(t.sessionId);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('FORBIDDEN');

    // คนนอกก๊วนก็ไม่ได้
    h.userId = await newUser();
    const outsider = await previewSessionCharges(t.sessionId);
    expect(outsider.success).toBe(false);

    // แอดมินยังเห็น
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [
      t.gangId,
      admin,
    ]);
    h.userId = admin;
    expect((await previewSessionCharges(t.sessionId)).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ตัวแยกยอด (pure) — ต้องปฏิเสธเมื่อผลของเอนจินกับส่วนที่แยกไม่ตรงกัน
// ---------------------------------------------------------------------------

describe('WO-B12 — breakdownCharges() ปฏิเสธตัวเลขที่ไม่ reconcile', () => {
  const snapshot: BillingSnapshot = {
    pricingType: 'court_plus_shuttle',
    amountPerPerson: '0',
    courtPlusShuttle: { courtFeeTotal: '100.00', shuttlePrice: '10.00' },
    cancellationPolicy: {
      cutoffHours: 12,
      allowCancelAfterCutoff: true,
      penaltyType: 'full_share',
      midwayCancelRatio: 1,
      promotedGraceHours: 3,
    } as BillingSnapshot['cancellationPolicy'],
  };

  it('amount/rounding ที่ถูกแก้ให้ไม่ตรงกับส่วนที่ควรจ่าย → throw (ไม่ส่งเลขหลอกให้ UI)', () => {
    const tampered: BillingResult = {
      charges: [
        {
          registrationId: 'a',
          amount: '60.00',
          breakdown: { reason: 'attended', is_monthly_member: false, rounding_surplus: '0.00' },
        },
        {
          registrationId: 'b',
          amount: '60.00',
          breakdown: { reason: 'attended', is_monthly_member: false, rounding_surplus: '0.00' },
        },
      ],
      totalCollected: '120.00',
      roundingSurplus: '0.00',
    };
    // ต้นทุน 100 + 10×2 = 120 หาร 2 = 60 ตรงพอดี → ผ่าน
    expect(() => breakdownCharges({ result: tampered, snapshot, shuttlesUsedTotal: '2' })).not.toThrow();
    // จำนวนลูกไม่ตรงกับที่เอนจินใช้ → ส่วนที่ควรจ่ายเพี้ยน → ต้อง throw
    expect(() => breakdownCharges({ result: tampered, snapshot, shuttlesUsedTotal: '3' })).toThrow(/แยกยอดไม่ตรง/);
  });
});
