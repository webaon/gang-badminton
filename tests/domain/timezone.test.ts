/**
 * WO-2.4 DoD — "เวลาที่แสดง/รับเข้าถูกต้องตาม `gangs.timezone`
 * มี unit test ข้าม timezone" (baseline §Verification)
 *
 * 🔴 เทสต์นี้ต้องผ่านโดยไม่ขึ้นกับ timezone ของเครื่องที่รัน
 *    ถ้ามันผ่านเฉพาะบนเครื่องที่ตั้งเป็นเวลาไทย แปลว่ายังไม่ได้แก้ปัญหาจริง
 */
import { describe, it, expect } from 'vitest';
import {
  formatInTimeZone,
  isValidTimeZone,
  utcToZonedWallClock,
  zonedTimeToUtc,
} from '@/domain/time/timezone';
import { buildSnapshot, SNAPSHOT_VERSION, assertUsableSnapshot } from '@/domain/sessions/snapshot';
import { DEFAULT_CANCELLATION_POLICY } from '@/domain/policies/cancellation';
import { DEFAULT_ROUNDING_POLICY } from '@/domain/policies/pricing';

describe('zonedTimeToUtc — เวลาบนนาฬิกาของก๊วน → instant จริง', () => {
  it('เวลาไทย 19:00 = 12:00 UTC (UTC+7 ตลอดปี)', () => {
    const utc = zonedTimeToUtc('2026-08-20T19:00', 'Asia/Bangkok');
    expect(utc.toISOString()).toBe('2026-08-20T12:00:00.000Z');
  });

  it('เดือนธันวาคมก็ยังเป็น UTC+7 (ไทยไม่มี DST)', () => {
    expect(zonedTimeToUtc('2026-12-20T19:00', 'Asia/Bangkok').toISOString()).toBe(
      '2026-12-20T12:00:00.000Z',
    );
  });

  it('🔴 timezone ที่มี DST — ช่วงฤดูร้อนกับฤดูหนาวต้องได้ offset ต่างกัน', () => {
    // New York: EDT (UTC-4) ในฤดูร้อน · EST (UTC-5) ในฤดูหนาว
    // ถ้าโค้ดคิด offset จากเวลาปัจจุบันแทนที่จะเป็นเวลาของนัด ข้อนี้จะพัง
    expect(zonedTimeToUtc('2026-07-15T19:00', 'America/New_York').toISOString()).toBe(
      '2026-07-15T23:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-01-15T19:00', 'America/New_York').toISOString()).toBe(
      '2026-01-16T00:00:00.000Z',
    );
  });

  it('timezone ที่ offset ไม่ลงตัวเป็นชั่วโมง', () => {
    // Kathmandu = UTC+5:45
    expect(zonedTimeToUtc('2026-08-20T19:00', 'Asia/Kathmandu').toISOString()).toBe(
      '2026-08-20T13:15:00.000Z',
    );
  });

  it('รับวินาทีด้วยได้ และช่องว่างหัวท้ายไม่ทำให้พัง', () => {
    expect(zonedTimeToUtc('  2026-08-20T19:00:30  ', 'Asia/Bangkok').toISOString()).toBe(
      '2026-08-20T12:00:30.000Z',
    );
  });

  it('🔴 เวลาที่ไม่มีอยู่จริงในวันเปลี่ยน DST → โยน ไม่ใช่เลื่อนเงียบๆ', () => {
    // New York 8 มี.ค. 2026 นาฬิกาข้ามจาก 02:00 ไป 03:00 ⇒ 02:30 ไม่มีอยู่บนนาฬิกา
    // ถ้าไม่ตรวจ ผลลัพธ์จะถูกเลื่อนกลับเป็น 01:30 เงียบๆ ⇒ แอดมินกรอก 02:30
    // กดบันทึก แล้วเห็นนัดขึ้นเป็น 01:30 โดยไม่มีคำอธิบาย
    expect(() => zonedTimeToUtc('2026-03-08T02:30', 'America/New_York')).toThrow(/ไม่มีอยู่จริง/);

    // ขอบทั้งสองฝั่งของช่องว่างต้องยังใช้ได้ปกติ
    expect(() => zonedTimeToUtc('2026-03-08T01:59', 'America/New_York')).not.toThrow();
    expect(() => zonedTimeToUtc('2026-03-08T03:00', 'America/New_York')).not.toThrow();
  });

  it('เวลาที่เกิดสองครั้ง (นาฬิกาถอยหลัง) → เลือกครั้งแรก ไม่โยน', () => {
    // New York 1 พ.ย. 2026 เวลา 01:30 เกิดสองรอบ (EDT แล้ว EST)
    // เลือกครั้งแรกเป็นพฤติกรรมที่กำหนดไว้ — สำคัญคือต้องคงเส้นคงวา ไม่ใช่สุ่ม
    const instant = zonedTimeToUtc('2026-11-01T01:30', 'America/New_York');
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('รูปแบบผิด → โยน error ไม่ใช่คืน Invalid Date เงียบๆ', () => {
    for (const bad of ['20/08/2026 19:00', '2026-08-20', 'พรุ่งนี้เย็น', '']) {
      expect(() => zonedTimeToUtc(bad, 'Asia/Bangkok'), bad).toThrow(/รูปแบบเวลาไม่ถูกต้อง/);
    }
  });
});

describe('utcToZonedWallClock — instant → ช่องกรอกเวลา', () => {
  it('แปลงกลับได้ค่าเดิม (round-trip)', () => {
    for (const tz of ['Asia/Bangkok', 'America/New_York', 'Asia/Kathmandu', 'UTC']) {
      for (const wall of ['2026-08-20T19:00', '2026-01-15T07:30', '2026-06-30T23:59']) {
        const utc = zonedTimeToUtc(wall, tz);
        expect(utcToZonedWallClock(utc, tz), `${tz} ${wall}`).toBe(wall);
      }
    }
  });

  it('instant เดียวกัน แสดงต่างกันตาม timezone ของก๊วน', () => {
    const instant = new Date('2026-08-20T12:00:00.000Z');
    expect(utcToZonedWallClock(instant, 'Asia/Bangkok')).toBe('2026-08-20T19:00');
    expect(utcToZonedWallClock(instant, 'UTC')).toBe('2026-08-20T12:00');
    expect(utcToZonedWallClock(instant, 'America/New_York')).toBe('2026-08-20T08:00');
  });
});

describe('formatInTimeZone — แสดงผลให้ผู้ใช้', () => {
  it('แสดงตาม timezone ของก๊วน ไม่ใช่ของเครื่องผู้ใช้', () => {
    const instant = new Date('2026-08-20T12:00:00.000Z');
    const bangkok = formatInTimeZone(instant, 'Asia/Bangkok', { timeStyle: 'short' }, 'en-US');
    const utc = formatInTimeZone(instant, 'UTC', { timeStyle: 'short' }, 'en-US');

    expect(bangkok).not.toBe(utc);
    expect(bangkok).toContain('7');  // 19:00 = 7 PM
    expect(utc).toContain('12');
  });
});

describe('isValidTimeZone', () => {
  it('รับ timezone จริง ปฏิเสธค่ามั่ว', () => {
    expect(isValidTimeZone('Asia/Bangkok')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('buildSnapshot — บันทึกแช่แข็ง', () => {
  const input = {
    pricingPlan: {
      id: 'plan-1',
      name: 'เหมาจ่ายต่อหัว',
      type: 'flat_rate' as const,
      flatRate: { amountPerPerson: '200.00' },
    },
    roundingPolicy: DEFAULT_ROUNDING_POLICY,
    promptpayId: '0812345678',
    cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
    skillLevels: [
      { label: 'มือหนัก', rank: 3 },
      { label: 'มือใหม่', rank: 1 },
      { label: 'มือกลาง', rank: 2 },
    ],
  };

  it('มีคีย์ครบตามที่ baseline บังคับ', () => {
    const snapshot = buildSnapshot(input);

    expect(snapshot.snapshot_version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.pricing_plan.params).toEqual({ amount_per_person: '200.00' });
    expect(snapshot.rounding_policy).toEqual({ mode: 'ceil_baht', surplus_to: 'gang' });
    expect(snapshot.promptpay_id).toBe('0812345678');
    expect(snapshot.cancellation_policy.penalty_type).toBe('full_share');
    expect(snapshot.skill_levels).toHaveLength(3);
  });

  it('skill levels เรียงตาม rank เสมอ ไม่ขึ้นกับลำดับที่ส่งเข้ามา', () => {
    expect(buildSnapshot(input).skill_levels.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('ไม่แก้ array ที่ส่งเข้ามา (ไม่มี side effect)', () => {
    const skillLevels = [{ label: 'ข', rank: 2 }, { label: 'ก', rank: 1 }];
    buildSnapshot({ ...input, skillLevels });
    expect(skillLevels.map((s) => s.rank)).toEqual([2, 1]);
  });

  describe('assertUsableSnapshot', () => {
    it('snapshot ปกติผ่าน', () => {
      expect(() => assertUsableSnapshot(buildSnapshot(input))).not.toThrow();
    });

    it('🔴 snapshot ว่าง/ไม่มี version/ไม่มี pricing_plan → โยน ไม่ใช่คิดเงินมั่ว', () => {
      expect(() => assertUsableSnapshot(null)).toThrow();
      expect(() => assertUsableSnapshot({})).toThrow(/snapshot_version/);
      expect(() => assertUsableSnapshot({ snapshot_version: 1 })).toThrow(/pricing_plan/);
    });

    it('version ใหม่กว่าที่โค้ดรู้จัก → โยน (เกิดตอน rollback deploy)', () => {
      expect(() =>
        assertUsableSnapshot({ snapshot_version: SNAPSHOT_VERSION + 1, pricing_plan: {} }),
      ).toThrow(/ใหม่กว่า/);
    });
  });
});
