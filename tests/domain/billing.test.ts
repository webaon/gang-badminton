/**
 * WO-2.8 DoD — SessionBilling + rounding + money invariants
 *
 * 🔴 baseline §Verification บังคับ:
 *    "Money invariants: sum(session_charges) − ต้นทุนจริง = rounding surplus ตาม policy
 *     ทุก strategy ทุกจำนวนคน (property-based: หาร 3, 7, 13 คน)"
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { assertSplitInvariant, splitEvenly, type RoundingMode } from '@/domain/billing/rounding';
import {
  calculateSessionCharges,
  expectedCost,
  type Participant,
} from '@/domain/billing/session-billing';
import { DEFAULT_CANCELLATION_POLICY } from '@/domain/policies/cancellation';

// ---------------------------------------------------------------------------

describe('money — จำนวนเต็มสตางค์ ไม่มี float', () => {
  it('แปลงไป-กลับได้ค่าเดิม', () => {
    for (const amount of ['0.00', '1.00', '150.50', '999999.99', '0.05']) {
      expect(fromSatang(toSatang(amount))).toBe(amount);
    }
  });

  it('เติมทศนิยมให้ครบสองตำแหน่ง', () => {
    expect(toSatang('150')).toBe(15000);
    expect(toSatang('150.5')).toBe(15050);
    expect(fromSatang(15005)).toBe('150.05');
  });

  it('🔴 รูปแบบที่ผิดถูกปฏิเสธ ไม่ปล่อยให้ค่าเพี้ยนไหลเข้าระบบ', () => {
    for (const bad of ['', 'abc', '150.555', '1e3', '150,50', '๑๕๐']) {
      expect(() => toSatang(bad), bad).toThrow(/จำนวนเงินไม่ถูกต้อง/);
    }
  });

  it('🔴 ผลรวมไม่เพี้ยนแบบที่ float เพี้ยน', () => {
    // 0.1 + 0.2 !== 0.3 ใน float — แต่ในสตางค์ต้องตรงเป๊ะ
    expect(sumSatang([toSatang('0.10'), toSatang('0.20')])).toBe(toSatang('0.30'));

    // บวก 150.55 สามครั้ง
    const three = sumSatang([toSatang('150.55'), toSatang('150.55'), toSatang('150.55')]);
    expect(fromSatang(three)).toBe('451.65');
  });
});

// ---------------------------------------------------------------------------

describe('rounding — invariant sum − ต้นทุน = surplus', () => {
  const MODES: RoundingMode[] = ['ceil_baht', 'ceil_satang', 'absorb'];

  it('🔴 property-based: จริงทุก mode ทุกจำนวนคน รวม 3 / 7 / 13 ที่ baseline บังคับ', () => {
    const totals = ['900.00', '1000.00', '1234.56', '0.01', '99999.99'];
    const peopleCounts = [1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 17, 23, 100];

    for (const mode of MODES) {
      for (const totalStr of totals) {
        for (const people of peopleCounts) {
          const total = toSatang(totalStr);
          const result = splitEvenly(total, people, mode);

          // invariant หลัก
          expect(() => assertSplitInvariant(result), `${mode} ${totalStr} ÷ ${people}`).not.toThrow();

          const collected = result.perPerson * people;
          expect(collected - total, `${mode} ${totalStr} ÷ ${people}`).toBe(result.surplus);

          // ทุกคนจ่ายเท่ากันและเป็นจำนวนเต็มสตางค์
          expect(Number.isInteger(result.perPerson)).toBe(true);
        }
      }
    }
  });

  it('ceil_baht — เศษเข้าก๊วน ไม่มีทางเก็บขาด', () => {
    // 900 ÷ 7 = 128.571... → ปัดขึ้นเป็น 129 บาท/คน → เก็บได้ 903 → เกิน 3 บาท
    const result = splitEvenly(toSatang('900.00'), 7, 'ceil_baht');
    expect(fromSatang(result.perPerson)).toBe('129.00');
    expect(fromSatang(result.surplus)).toBe('3.00');
  });

  it('ceil_satang — ปัดละเอียดกว่า เศษน้อยกว่า', () => {
    const result = splitEvenly(toSatang('900.00'), 7, 'ceil_satang');
    expect(fromSatang(result.perPerson)).toBe('128.58');
    expect(fromSatang(result.surplus)).toBe('0.06');
  });

  it('🔴 absorb — ก๊วนดูดซับเอง surplus ติดลบได้', () => {
    const result = splitEvenly(toSatang('900.00'), 7, 'absorb');
    expect(fromSatang(result.perPerson)).toBe('128.57');
    expect(result.surplus).toBeLessThan(0);
    expect(fromSatang(result.surplus)).toBe('-0.01');
  });

  it('หารลงตัว → ไม่มีเศษทุก mode', () => {
    for (const mode of MODES) {
      const result = splitEvenly(toSatang('900.00'), 6, mode);
      expect(fromSatang(result.perPerson)).toBe('150.00');
      expect(result.surplus).toBe(0);
    }
  });

  it('input ที่เป็นไปไม่ได้ถูกปฏิเสธ', () => {
    expect(() => splitEvenly(100, 0, 'ceil_baht')).toThrow();
    expect(() => splitEvenly(100, -1, 'ceil_baht')).toThrow();
    expect(() => splitEvenly(1.5, 2, 'ceil_baht')).toThrow(/จำนวนเต็มสตางค์/);
  });

  it('assertSplitInvariant จับได้ถ้ามีคนแก้สูตรจนเพี้ยน', () => {
    const broken = { perPerson: 100, surplus: 999, total: 300, people: 3 };
    expect(() => assertSplitInvariant(broken)).toThrow(/invariant ปัดเศษพัง/);
  });
});

// ---------------------------------------------------------------------------

const SNAPSHOT = {
  pricingType: 'flat_rate',
  amountPerPerson: '200.00',
  cancellationPolicy: DEFAULT_CANCELLATION_POLICY, // full_share, cutoff 12 ชม.
};

const STARTS_AT = new Date('2026-08-20T12:00:00.000Z');

function participant(
  id: string,
  status: Participant['status'],
  overrides: Partial<Participant> = {},
): Participant {
  return {
    registrationId: id,
    status,
    cancelledAt: overrides.cancelledAt ?? null,
    isMonthlyMember: overrides.isMonthlyMember ?? false,
  };
}

describe('SessionBilling — flat_rate (ADR-002)', () => {
  it('คนที่มาเล่นจ่ายเต็ม', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('a', 'checked_in')],
      startsAt: STARTS_AT,
    });

    expect(result.charges).toHaveLength(1);
    expect(result.charges[0].amount).toBe('200.00');
    expect(result.charges[0].breakdown.reason).toBe('attended');
  });

  it('🔴 เช็คอินแต่ไม่ได้ลงเกมเลย → ยังจ่ายเต็ม (flat_rate คิดต่อหัว ไม่ใช่ต่อเกม)', () => {
    // baseline ระบุเคสนี้ไว้ตรงๆ ใน §Verification
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('นั่งดูทั้งวัน', 'checked_in')],
      startsAt: STARTS_AT,
    });
    expect(result.charges[0].amount).toBe('200.00');
  });

  it('guest จ่ายเหมือนสมาชิก', () => {
    // guest ต่างกันแค่ไม่มี user_id — billing ไม่สนใจ เพราะอ้าง registration_id
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('guest-1', 'checked_in')],
      startsAt: STARTS_AT,
    });
    expect(result.charges[0].amount).toBe('200.00');
  });

  it('waitlist ไม่จ่าย — ไม่เคยได้ที่', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('รอคิว', 'waitlist')],
      startsAt: STARTS_AT,
    });
    expect(result.charges).toHaveLength(0);
  });

  describe('penalty = full_share', () => {
    it('ยกเลิกก่อน cutoff → ไม่จ่าย', () => {
      const early = new Date(STARTS_AT.getTime() - 24 * 60 * 60 * 1000); // 24 ชม. ก่อน
      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants: [participant('ยกเลิกทัน', 'cancelled', { cancelledAt: early })],
        startsAt: STARTS_AT,
      });
      expect(result.charges).toHaveLength(0);
    });

    it('🔴 ยกเลิกหลัง cutoff → จ่ายเท่าคนที่มาเล่น', () => {
      const late = new Date(STARTS_AT.getTime() - 2 * 60 * 60 * 1000); // 2 ชม. ก่อน (cutoff 12)
      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants: [participant('ยกเลิกช้า', 'cancelled', { cancelledAt: late })],
        startsAt: STARTS_AT,
      });
      expect(result.charges).toHaveLength(1);
      expect(result.charges[0].amount).toBe('200.00');
      expect(result.charges[0].breakdown.reason).toBe('late_cancel');
    });

    it('ยกเลิกตรงเวลา cutoff พอดี → ยังถือว่าทัน', () => {
      const exactly = new Date(STARTS_AT.getTime() - 12 * 60 * 60 * 1000);
      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants: [participant('พอดี', 'cancelled', { cancelledAt: exactly })],
        startsAt: STARTS_AT,
      });
      expect(result.charges).toHaveLength(0);
    });

    it('🔴 no-show → จ่ายเต็ม', () => {
      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants: [participant('ไม่มา', 'no_show')],
        startsAt: STARTS_AT,
      });
      expect(result.charges[0].breakdown.reason).toBe('no_show');
      expect(result.charges[0].amount).toBe('200.00');
    });

    it('ได้ที่แล้วไม่เคยเช็คอินจนปิดรอบ → จ่ายเหมือนไม่มา', () => {
      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants: [participant('ลืมเช็คอิน', 'confirmed')],
        startsAt: STARTS_AT,
      });
      expect(result.charges[0].breakdown.reason).toBe('no_check_in');
    });
  });

  describe('penalty = none', () => {
    const lenient = {
      ...SNAPSHOT,
      cancellationPolicy: { ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'none' as const },
    };

    it('ยกเลิกช้า / ไม่มา → ไม่เก็บเงิน', () => {
      const late = new Date(STARTS_AT.getTime() - 1000);
      const result = calculateSessionCharges({
        snapshot: lenient,
        participants: [
          participant('ยกเลิกช้า', 'cancelled', { cancelledAt: late }),
          participant('ไม่มา', 'no_show'),
          participant('มาจริง', 'checked_in'),
        ],
        startsAt: STARTS_AT,
      });

      expect(result.charges).toHaveLength(1);
      expect(result.charges[0].registrationId).toBe('มาจริง');
    });
  });

  it('สมาชิกรายเดือนมาเล่น → ค่าสนามเป็น 0', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('รายเดือน', 'checked_in', { isMonthlyMember: true })],
      startsAt: STARTS_AT,
    });

    expect(result.charges[0].amount).toBe('0.00');
    expect(result.charges[0].breakdown.is_monthly_member).toBe(true);
  });

  it('🔴 ราคาเปลี่ยนหลังสร้างนัด → ใช้ราคาใน snapshot ไม่ใช่ราคาปัจจุบัน', () => {
    // ฟังก์ชันนี้อ่านจาก argument เท่านั้น — ไม่มีทางไปแตะราคาปัจจุบันได้เลย
    // เทสต์นี้ยืนยันว่าเปลี่ยน snapshot แล้วผลเปลี่ยนตาม snapshot
    const cheap = calculateSessionCharges({
      snapshot: { ...SNAPSHOT, amountPerPerson: '150.00' },
      participants: [participant('a', 'checked_in')],
      startsAt: STARTS_AT,
    });
    const pricey = calculateSessionCharges({
      snapshot: { ...SNAPSHOT, amountPerPerson: '350.00' },
      participants: [participant('a', 'checked_in')],
      startsAt: STARTS_AT,
    });

    expect(cheap.charges[0].amount).toBe('150.00');
    expect(pricey.charges[0].amount).toBe('350.00');
  });

  it('🔴 ยกเลิกกลางคัน → เก็บบางส่วนตามสัดส่วนที่แอดมินระบุ', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('a', 'checked_in'), participant('b', 'checked_in')],
      startsAt: STARTS_AT,
      midwayCancelRatio: 0.5,
    });

    expect(result.charges.map((c) => c.amount)).toEqual(['100.00', '100.00']);
    expect(result.charges[0].breakdown.midway_cancel_ratio).toBe(0.5);
  });

  it('ยกเลิกกลางคันแบบไม่เก็บเงินเลย (ratio 0)', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('a', 'checked_in')],
      startsAt: STARTS_AT,
      midwayCancelRatio: 0,
    });
    expect(result.charges[0].amount).toBe('0.00');
  });

  it('ratio นอกช่วง 0-1 ถูกปฏิเสธ', () => {
    for (const ratio of [-0.5, 1.5, Number.NaN]) {
      expect(() =>
        calculateSessionCharges({
          snapshot: SNAPSHOT,
          participants: [participant('a', 'checked_in')],
          startsAt: STARTS_AT,
          midwayCancelRatio: ratio,
        }),
      ).toThrow(/สัดส่วน/);
    }
  });

  describe('🔴 ต้อง raise ไม่ใช่คิดเป็น 0 เงียบๆ (ADR-002)', () => {
    it('pricing โมเดลที่ยังไม่รองรับ', () => {
      expect(() =>
        calculateSessionCharges({
          snapshot: { ...SNAPSHOT, pricingType: 'court_plus_shuttle' },
          participants: [participant('a', 'checked_in')],
          startsAt: STARTS_AT,
        }),
      ).toThrow(/court_plus_shuttle/);
    });

    it('penalty แบบที่ยังไม่รองรับ', () => {
      for (const penaltyType of ['fixed', 'percent'] as const) {
        expect(() =>
          calculateSessionCharges({
            snapshot: {
              ...SNAPSHOT,
              cancellationPolicy: {
                ...DEFAULT_CANCELLATION_POLICY,
                penaltyType,
                penaltyValue: '50',
              },
            },
            participants: [participant('a', 'checked_in')],
            startsAt: STARTS_AT,
          }),
          penaltyType,
        ).toThrow(/penalty/);
      }
    });
  });

  it('🔴 invariant ของนัดจริง: sum(charges) − ต้นทุน = surplus (0 สำหรับ flat_rate)', () => {
    for (const people of [1, 3, 7, 13, 23]) {
      const participants = Array.from({ length: people }, (_, i) =>
        participant(`p${i}`, 'checked_in'),
      );

      const result = calculateSessionCharges({
        snapshot: SNAPSHOT,
        participants,
        startsAt: STARTS_AT,
      });

      const collected = sumSatang(result.charges.map((c) => toSatang(c.amount)));
      const cost = expectedCost(result, SNAPSHOT.amountPerPerson);

      expect(collected - cost, `${people} คน`).toBe(toSatang(result.roundingSurplus));
      expect(result.roundingSurplus).toBe('0.00');
      expect(fromSatang(collected)).toBe(fromSatang(toSatang('200.00') * people));
    }
  });

  it('breakdown มี rounding_surplus ทุกใบ (baseline บังคับให้ reconcile ได้)', () => {
    const result = calculateSessionCharges({
      snapshot: SNAPSHOT,
      participants: [participant('a', 'checked_in'), participant('b', 'no_show')],
      startsAt: STARTS_AT,
    });

    for (const charge of result.charges) {
      expect(charge.breakdown).toHaveProperty('rounding_surplus');
      expect(charge.breakdown).toHaveProperty('flat_rate');
      expect(charge.breakdown).toHaveProperty('reason');
    }
  });
});
