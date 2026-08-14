/**
 * WO-2.5-B DoD — `court_plus_shuttle` + นโยบายปัดเศษมีผลจริง
 *
 * 🔴 baseline §Verification เรียกข้อนี้ว่า **blocker**:
 *    "sum(session_charges) − ต้นทุนจริง = rounding surplus ตาม policy
 *     ทุก strategy ทุกจำนวนคน (property-based: หาร 3, 7, 13 คน)"
 *
 * WO-2.8 พิสูจน์ invariant ที่ระดับ `splitEvenly()` ได้ แต่ `flat_rate` ไม่มีการหาร
 * ⇒ **ยังไม่เคยมีเคสจริงที่ surplus ≠ 0 ในเส้นทางคิดเงินจริง** ไฟล์นี้ปิดช่องนั้น
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import { fromSatang, toSatang } from '@/domain/billing/money';
import { distributeExactShares } from '@/domain/billing/rounding';
import {
  calculateSessionCharges,
  courtPlusShuttleCost,
  type BillingSnapshot,
  type Participant,
} from '@/domain/billing/session-billing';
import { DEFAULT_CANCELLATION_POLICY } from '@/domain/policies/cancellation';
import type { RoundingMode } from '@/domain/policies/pricing';

const STARTS_AT = new Date('2026-08-20T12:00:00Z');

function attendee(overrides: Partial<Participant> = {}): Participant {
  return {
    registrationId: crypto.randomUUID(),
    status: 'checked_in',
    cancelledAt: null,
    isMonthlyMember: false,
    ...overrides,
  };
}

function courtSnapshot(
  opts: {
    courtFeeTotal?: string;
    shuttlePrice?: string;
    mode?: RoundingMode;
    monthlyMemberPaysShuttle?: boolean;
  } = {},
): BillingSnapshot {
  return {
    pricingType: 'court_plus_shuttle',
    amountPerPerson: '0',
    courtPlusShuttle: {
      courtFeeTotal: opts.courtFeeTotal ?? '800.00',
      shuttlePrice: opts.shuttlePrice ?? '25.00',
    },
    roundingPolicy: { mode: opts.mode ?? 'ceil_baht', surplusTo: 'gang' },
    monthlyMemberPaysShuttle: opts.monthlyMemberPaysShuttle ?? true,
    cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
  };
}

describe('WO-2.5-B — ต้นทุนจริง = ค่าสนาม + ค่าลูกตามที่ใช้', () => {
  it('คูณจำนวนลูกทศนิยมได้โดยไม่มี float ปน', () => {
    // 25.00 × 3.5 = 87.50 — เลขที่ float ทำพังบ่อยที่สุดคือ .1/.3
    expect(
      fromSatang(courtPlusShuttleCost({ courtFeeTotal: '0', shuttlePrice: '25.00' }, '3.5')),
    ).toBe('87.50');
    expect(
      fromSatang(courtPlusShuttleCost({ courtFeeTotal: '0', shuttlePrice: '25.00' }, '1.3')),
    ).toBe('32.50');
    expect(
      fromSatang(courtPlusShuttleCost({ courtFeeTotal: '800.00', shuttlePrice: '25.00' }, '6')),
    ).toBe('950.00');
  });

  it('🔴 ไม่รู้จำนวนลูก → throw ไม่ใช่คิดเป็น 0', () => {
    expect(() =>
      calculateSessionCharges({
        snapshot: courtSnapshot(),
        participants: [attendee()],
        startsAt: STARTS_AT,
      }),
    ).toThrow(/จำนวนลูก/);
  });

  it('🔴 snapshot ไม่มีราคาคอร์ท/ลูก → throw', () => {
    const broken = { ...courtSnapshot(), courtPlusShuttle: undefined };
    expect(() =>
      calculateSessionCharges({
        snapshot: broken,
        participants: [attendee()],
        startsAt: STARTS_AT,
        shuttlesUsedTotal: '6',
      }),
    ).toThrow(/ค่าสนาม/);
  });
});

/**
 * 🔴 หัวใจของ DoD — เคสจริงที่ `surplus ≠ 0`
 *
 * 800 + 25×6 = 950 บาท หารกับ 3 / 7 / 13 คน ล้วนหารไม่ลงตัว
 */
describe('WO-2.5-B DoD — money invariant ที่ 3 / 7 / 13 คน (surplus ≠ 0 จริง)', () => {
  const MODES: RoundingMode[] = ['ceil_baht', 'ceil_satang', 'absorb'];

  for (const people of [3, 7, 13]) {
    for (const mode of MODES) {
      it(`${people} คน · ${mode} — sum(charges) − ต้นทุนจริง = surplus`, () => {
        const snapshot = courtSnapshot({ mode });
        const participants = Array.from({ length: people }, () => attendee());

        const result = calculateSessionCharges({
          snapshot,
          participants,
          startsAt: STARTS_AT,
          shuttlesUsedTotal: '6',
        });

        const cost = courtPlusShuttleCost(snapshot.courtPlusShuttle!, '6');
        const collected = toSatang(result.totalCollected);

        expect(result.charges).toHaveLength(people);
        expect(collected - cost).toBe(toSatang(result.roundingSurplus));

        // 🔴 ถ้า surplus เป็น 0 แปลว่าเทสต์นี้ไม่ได้พิสูจน์อะไรเลย
        expect(toSatang(result.roundingSurplus)).not.toBe(0);

        // absorb = ก๊วนรับส่วนต่างเอง ⇒ เก็บได้น้อยกว่าต้นทุน
        if (mode === 'absorb') expect(collected).toBeLessThan(cost);
        else expect(collected).toBeGreaterThan(cost);
      });
    }
  }

  it('🔴 เศษต่อคนใน breakdown บวกกันได้ surplus ของนัดเป๊ะ (reconcile รายคนได้)', () => {
    const snapshot = courtSnapshot();
    const participants = Array.from({ length: 7 }, () => attendee());

    const result = calculateSessionCharges({
      snapshot,
      participants,
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '6',
    });

    const perCharge = result.charges.map((c) => toSatang(String(c.breakdown.rounding_surplus)));
    expect(perCharge.reduce((a, b) => a + b, 0)).toBe(toSatang(result.roundingSurplus));

    // DoD: "rounding_surplus ใน breakdown เป็นค่าจริง ไม่ใช่ 0.00 อีกต่อไป"
    expect(perCharge.some((v) => v !== 0)).toBe(true);
  });

  it('หารลงตัวพอดี → surplus = 0 (ไม่ได้บวกเศษมั่ว)', () => {
    const snapshot = courtSnapshot({ courtFeeTotal: '900.00', shuttlePrice: '0.00' });
    const result = calculateSessionCharges({
      snapshot,
      participants: Array.from({ length: 9 }, () => attendee()),
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '0',
    });

    expect(result.charges.every((c) => c.amount === '100.00')).toBe(true);
    expect(result.roundingSurplus).toBe('0.00');
  });
});

describe('WO-2.5-B DoD — สมาชิกรายเดือน', () => {
  it('ค่าสนาม = 0 เสมอ · ค่าลูกคิดตามจริงเมื่อ monthly_member_pays_shuttle = true', () => {
    const monthly = attendee({ isMonthlyMember: true });
    const snapshot = courtSnapshot({
      courtFeeTotal: '600.00',
      shuttlePrice: '25.00',
      monthlyMemberPaysShuttle: true,
    });

    const result = calculateSessionCharges({
      snapshot,
      participants: [attendee(), attendee(), monthly],
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '4', // ค่าลูก 100 บาท
    });

    const monthlyCharge = result.charges.find((c) => c.registrationId === monthly.registrationId)!;

    // ค่าสนาม 600 หารกับคนที่ไม่ใช่รายเดือน 2 คน = 300 · ค่าลูก 100 หาร 3 คน = 33.34 (ceil_baht → 34)
    expect(monthlyCharge.breakdown.court_fee).toBe('0.00');
    expect(monthlyCharge.amount).toBe('34.00');

    const normal = result.charges.find((c) => c.registrationId !== monthly.registrationId)!;
    expect(normal.breakdown.court_fee).toBe('300.00');
    expect(normal.amount).toBe('334.00');
  });

  it('monthly_member_pays_shuttle = false → รายเดือนไม่จ่ายอะไรเลยในนัดนั้น', () => {
    const monthly = attendee({ isMonthlyMember: true });
    const snapshot = courtSnapshot({
      courtFeeTotal: '600.00',
      shuttlePrice: '25.00',
      monthlyMemberPaysShuttle: false,
    });

    const result = calculateSessionCharges({
      snapshot,
      participants: [attendee(), attendee(), monthly],
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '4',
    });

    const monthlyCharge = result.charges.find((c) => c.registrationId === monthly.registrationId)!;
    expect(monthlyCharge.amount).toBe('0.00');

    // ค่าลูกตกกับคนที่เหลือ 2 คน: (600 + 100) / 2 = 350
    const normal = result.charges.find((c) => c.registrationId !== monthly.registrationId)!;
    expect(normal.amount).toBe('350.00');
  });

  it('🔴 ทุกคนเป็นสมาชิกรายเดือน → ค่าสนามไม่หายไปเฉยๆ แต่เป็นส่วนที่ก๊วนรับเอง', () => {
    const snapshot = courtSnapshot({ courtFeeTotal: '600.00', shuttlePrice: '25.00' });
    const result = calculateSessionCharges({
      snapshot,
      participants: [
        attendee({ isMonthlyMember: true }),
        attendee({ isMonthlyMember: true }),
        attendee({ isMonthlyMember: true }),
      ],
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '4',
    });

    // เก็บได้เฉพาะค่าลูก 100 บาท (ceil_baht: 33.34 → 34 × 3 = 102)
    expect(result.totalCollected).toBe('102.00');
    // ต้นทุน 700 ⇒ ขาด 598 — ตัวเลขนี้ต้องโผล่ในรายงาน ไม่ใช่หายเงียบ
    expect(result.roundingSurplus).toBe('-598.00');
  });
});

describe('WO-2.5-B DoD — 🔴 นัดเก่าที่ snapshot เป็น flat_rate ต้องคิดเหมือนเดิมทุกบาท', () => {
  /** snapshot รูปแบบก่อน WO-2.5-B: ไม่มี courtPlusShuttle / roundingPolicy / monthlyMemberPaysShuttle */
  const legacySnapshot: BillingSnapshot = {
    pricingType: 'flat_rate',
    amountPerPerson: '250.00',
    cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
  };

  it('ยอดต่อคนเท่าเดิม · ไม่มีเศษ · breakdown ยังเป็นชุดเดิม', () => {
    const monthly = attendee({ isMonthlyMember: true });
    const result = calculateSessionCharges({
      snapshot: legacySnapshot,
      participants: [attendee(), attendee(), attendee(), monthly],
      startsAt: STARTS_AT,
      // ส่งจำนวนลูกมาด้วยก็ต้องไม่กระทบ flat_rate
      shuttlesUsedTotal: '99',
    });

    const normal = result.charges.filter((c) => c.registrationId !== monthly.registrationId);
    expect(normal.every((c) => c.amount === '250.00')).toBe(true);
    expect(normal[0].breakdown.flat_rate).toBe('250.00');
    expect(normal[0].breakdown.rounding_surplus).toBe('0.00');
    expect(normal[0].breakdown).not.toHaveProperty('court_fee');

    // สมาชิกรายเดือนยังเป็น 0 เหมือนเดิม
    expect(result.charges.find((c) => c.registrationId === monthly.registrationId)!.amount).toBe(
      '0.00',
    );

    expect(result.totalCollected).toBe('750.00');
    expect(result.roundingSurplus).toBe('0.00');
  });

  it('หาร 3/7/13 คนก็ยังไม่มีเศษ เพราะ flat_rate ไม่ได้หารอะไร', () => {
    for (const people of [3, 7, 13]) {
      const result = calculateSessionCharges({
        snapshot: legacySnapshot,
        participants: Array.from({ length: people }, () => attendee()),
        startsAt: STARTS_AT,
      });

      expect(toSatang(result.totalCollected)).toBe(25000 * people);
      expect(result.roundingSurplus).toBe('0.00');
    }
  });
});

describe('WO-2.5-B — distributeExactShares (ฐานของเศษรายคน)', () => {
  it('บวกกันได้ต้นทุนเป๊ะเสมอ ทุกจำนวนคน', () => {
    for (const total of [95000, 100, 1, 0, 123457]) {
      for (const people of [1, 3, 7, 13]) {
        const shares = distributeExactShares(total, people);
        expect(shares).toHaveLength(people);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        // ต่างกันได้ไม่เกิน 1 สตางค์ — ไม่มีใครรับเศษก้อนโต
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ปฏิเสธ input ที่คิดเงินไม่ได้', () => {
    expect(() => distributeExactShares(100.5, 3)).toThrow(/จำนวนเต็มสตางค์/);
    expect(() => distributeExactShares(100, 0)).toThrow(/จำนวนคน/);
  });
});

describe('WO-2.5-B — ยกเลิกกลางคันกับ court_plus_shuttle (ADR-004)', () => {
  it('เก็บครึ่งเดียว · ส่วนที่ก๊วนดูดซับโผล่ใน surplus', () => {
    const snapshot = courtSnapshot({ courtFeeTotal: '800.00', shuttlePrice: '0.00' });
    const result = calculateSessionCharges({
      snapshot,
      participants: Array.from({ length: 4 }, () => attendee()),
      startsAt: STARTS_AT,
      shuttlesUsedTotal: '0',
      midwayCancelRatio: 0.5,
    });

    expect(result.charges.every((c) => c.amount === '100.00')).toBe(true);
    expect(result.charges[0].breakdown.midway_cancel_ratio).toBe(0.5);
    // เก็บได้ 400 จากต้นทุน 800 ⇒ ก๊วนรับ 400
    expect(result.roundingSurplus).toBe('-400.00');
  });
});
