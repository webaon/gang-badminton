/**
 * WO-3.C — timeline: แปลง event เป็นข้อความไทย
 *
 * 🔴 DoD: "timeline **ไม่แสดง payload ดิบ**" ⇒ อ่านเฉพาะคีย์ที่ whitelist
 *    และ event ที่มียอดเงินรายคนต้องไม่ถึงสมาชิกทั่วไป
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import { buildTimeline, describeEvent, type TimelineEvent } from '@/domain/reports/timeline';

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: crypto.randomUUID(),
    eventType: 'registration.checked_in',
    createdAt: '2026-08-15T03:00:00.000Z',
    actorName: 'แอดมิน',
    payload: {},
    ...overrides,
  };
}

describe('WO-3.C — แปลง event เป็นข้อความ', () => {
  it('event ที่รู้จัก → ข้อความไทย + รายละเอียดจากคีย์ที่ whitelist', () => {
    const item = describeEvent(
      event({
        eventType: 'game.shuttles_corrected',
        payload: { before: '3', after: '6', correlation_id: 'abc-123' },
      }),
    );

    expect(item.title).toBe('แก้จำนวนลูกที่ใช้');
    expect(item.detail).toBe('3 → 6 ลูก');
  });

  it('🔴 คีย์ที่ไม่ได้ whitelist ไม่โผล่ในผลลัพธ์เลย', () => {
    const item = describeEvent(
      event({
        eventType: 'session.transitioned',
        payload: {
          from_status: 'open',
          to_status: 'in_play',
          correlation_id: 'ce-99',
          // ของที่ห้ามหลุดเด็ดขาด
          guest_token: 'SUPER-SECRET-TOKEN',
          internal_note: 'ห้ามโชว์',
        },
      }),
    );

    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain('SUPER-SECRET-TOKEN');
    expect(serialized).not.toContain('ce-99');
    expect(serialized).not.toContain('ห้ามโชว์');
    expect(item.detail).toBe('open → in_play');
  });

  it('🔴 event ที่ไม่รู้จัก → ข้อความกลางๆ ไม่ใช่ payload ดิบ + adminOnly=true แบบ fail-closed (ไม่ใช่ fail-open)', () => {
    const item = describeEvent(
      event({ eventType: 'something.new', payload: { secret: 'ห้ามโชว์' } }),
    );

    expect(item.title).toContain('something.new');
    expect(JSON.stringify(item)).not.toContain('ห้ามโชว์');
    expect(item.detail).toBeNull();
    expect(item.adminOnly).toBe(true);
  });

  it('🔴 [QA source review] event_type ที่ตรงกับ property ของ Object.prototype ต้อง fail-closed เหมือนกัน — ไม่ได้ property สืบทอดมาเป็น "descriptor" หลอกๆ', () => {
    for (const poisonedEventType of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
      const item = describeEvent(event({ eventType: poisonedEventType, payload: { secret: 'ห้ามโชว์' } }));
      expect(item.adminOnly, poisonedEventType).toBe(true);
      expect(item.detail, poisonedEventType).toBeNull();
      expect(JSON.stringify(item)).not.toContain('ห้ามโชว์');
    }
  });

  it('payload ที่เป็นค่าซ้อน (object/array) ไม่ถูกดึงมาแสดง', () => {
    const item = describeEvent(
      event({
        eventType: 'registration.created',
        payload: { status: { nested: 'ห้ามโชว์' } },
      }),
    );

    expect(item.detail).toBeNull();
  });

  it('ข้อความยาวผิดปกติถูกตัด — กัน payload ยัดข้อความยาวมาดันหน้าจอ', () => {
    const item = describeEvent(
      event({ eventType: 'registration.created', payload: { status: 'ก'.repeat(500) } }),
    );

    expect(item.detail!.length).toBeLessThanOrEqual(120);
  });
});

describe('WO-6.5c — descriptor ของ event_type จริงที่เพิ่มใหม่ (ไม่ใช่ key เดิมที่ไม่ตรง)', () => {
  it('registration.confirmed/waitlisted/promoted (ของจริงจาก register_to_session/promote_waitlist) มีข้อความไทยสั้นแล้ว ไม่ fallback', () => {
    expect(describeEvent(event({ eventType: 'registration.confirmed' })).title).toBe('ลงชื่อนัด');
    expect(describeEvent(event({ eventType: 'registration.waitlisted' })).title).toBe('เข้าคิวสำรอง');
    expect(describeEvent(event({ eventType: 'waitlist.promoted' })).title).toBe('เลื่อนจากคิวสำรอง');
  });

  it('game.player_substituted / session.closed_with_charges (ของจริงจาก DB) มีข้อความไทยแล้ว', () => {
    expect(describeEvent(event({ eventType: 'game.player_substituted' })).title).toBe('สลับตัวผู้เล่น');
    const closed = describeEvent(event({ eventType: 'session.closed_with_charges', payload: { charge_count: 5 } }));
    expect(closed.title).toBe('ปิดรอบและสร้างยอดเรียกเก็บ');
    expect(closed.adminOnly).toBe(true);
    expect(closed.detail).toBe('5 รายการ');
  });

  it('🔴 audit.* ทุกตัวเป็น adminOnly — สมาชิกทั่วไปไม่เห็นเลย', () => {
    const auditEvents = [
      'audit.waitlist_promoted_by_admin', 'audit.registration_penalty_waived',
      'audit.credit_overpayment_recorded', 'audit.credit_applied', 'audit.credit_topup',
      'audit.credit_cash_payout', 'audit.credit_charge_returned', 'audit.payment_received_amount_set',
      'audit.role_assigned', 'audit.role_revoked',
    ];
    const items = buildTimeline(auditEvents.map((eventType) => event({ eventType })), false);
    expect(items).toHaveLength(0);
    expect(buildTimeline(auditEvents.map((eventType) => event({ eventType })), true)).toHaveLength(auditEvents.length);
  });

  it('event ของสมาชิกทั่วไป/สังคม (สร้างก๊วน/เพิ่มสมาชิก/ออกจากก๊วน/โอนเจ้าของ/ประกาศ) ไม่ adminOnly', () => {
    for (const eventType of ['gang.created', 'gang.member_added', 'gang.member_left', 'gang.ownership_transferred', 'announcement.published']) {
      expect(describeEvent(event({ eventType })).adminOnly, eventType).toBe(false);
    }
  });

  it('🔴 [planner 31 ต.ค. 2026] การตั้งค่า LINE/บล็อกบัญชี/ผูก-เลิกผูกบัญชี (ข้อมูลส่วนตัวของสมาชิกคนอื่น) + คำขอเข้าก๊วนของคนอื่น = adminOnly ทั้งหมด', () => {
    for (const eventType of [
      'gang.line_config_updated', 'gang.line_toggled', 'gang.line_config_cleared', 'gang.line_login_updated',
      'line.blocked', 'line.unblocked', 'line.account_linked', 'line.account_unlinked',
      'gang.join_requested', 'gang.join_approved', 'gang.join_rejected', 'gang.join_cancelled',
    ]) {
      expect(describeEvent(event({ eventType })).adminOnly, eventType).toBe(true);
    }
  });

  it('audit.role_assigned/revoked อ่าน role_key จาก payload ได้ (whitelist)', () => {
    const item = describeEvent(event({ eventType: 'audit.role_assigned', payload: { role_key: 'treasurer', permissions: ['a', 'b'] } }));
    expect(item.detail).toBe('treasurer');
    expect(JSON.stringify(item)).not.toContain('"a"');
  });
});

describe('WO-3.C DoD — เรื่องเงินไม่ถึงสมาชิกทั่วไป', () => {
  const events = [
    event({ eventType: 'registration.checked_in' }),
    event({ eventType: 'payment.adjusted', payload: { type: 'refund', amount: '-50.00' } }),
    event({ eventType: 'session.charges_committed', payload: { charge_count: 4 } }),
  ];

  it('🔴 สมาชิกทั่วไปเห็นเฉพาะเหตุการณ์ที่ไม่ใช่เรื่องเงิน', () => {
    const items = buildTimeline(events, false);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('เช็คอิน');
    expect(JSON.stringify(items)).not.toContain('-50.00');
  });

  it('คนที่มีสิทธิ์ดูเงินเห็นครบ', () => {
    const items = buildTimeline(events, true);

    expect(items).toHaveLength(3);
    expect(items[1].detail).toBe('refund -50.00 บาท');
  });
});

describe('🔴 [planner G3, 31 ต.ค. 2026] buildTimeline() แยก 2 แกนให้ตรง RLS จริง (0051:273-286) — isFinanceEventType() ตัดสิน', () => {
  const financeEvent = event({ eventType: 'payment.adjusted', payload: { type: 'refund', amount: '-50.00' } });
  const creditFinanceEvent = event({ eventType: 'audit.credit_topup', payload: { reason: 'โบนัส' } });
  const otherAdminOnlyEvent = event({ eventType: 'line.account_linked' });
  const joinAdminOnlyEvent = event({ eventType: 'gang.join_requested' });
  const normalEvent = event({ eventType: 'registration.checked_in' });
  const mixed = [normalEvent, financeEvent, creditFinanceEvent, otherAdminOnlyEvent, joinAdminOnlyEvent];

  it('🔴 canSeeFinance=true, canSeeOtherAdminOnly=false: เห็น event การเงิน (payment.*/audit.credit_*) แต่ไม่เห็น adminOnly อื่น — ตรงกับคนที่มี gang.finance.view อย่างเดียวใน RLS จริง', () => {
    const items = buildTimeline(mixed, true, false);
    const titles = items.map((i) => i.title);
    expect(titles).toContain('ปรับยอด');
    expect(items.some((i) => i.title === 'เติมเครดิตให้สมาชิก')).toBe(true);
    expect(items.some((i) => i.title === 'ผูกบัญชี LINE')).toBe(false);
    expect(items.some((i) => i.title === 'มีคนขอเข้าก๊วน')).toBe(false);
    expect(items.some((i) => i.title === 'เช็คอิน')).toBe(true);
    expect(items).toHaveLength(3); // normal + 2 finance event เท่านั้น
  });

  it('🔴 canSeeFinance=false, canSeeOtherAdminOnly=true: เห็น adminOnly อื่น (line.*/gang.join_*) แต่ไม่เห็น event การเงิน — ตรงกับแอดมินที่ (สมมติ) ไม่มี gang.finance.view', () => {
    const items = buildTimeline(mixed, false, true);
    expect(items.some((i) => i.title === 'ปรับยอด')).toBe(false);
    expect(items.some((i) => i.title === 'เติมเครดิตให้สมาชิก')).toBe(false);
    expect(items.some((i) => i.title === 'ผูกบัญชี LINE')).toBe(true);
    expect(items.some((i) => i.title === 'มีคนขอเข้าก๊วน')).toBe(true);
    expect(items.some((i) => i.title === 'เช็คอิน')).toBe(true);
    expect(items).toHaveLength(3); // normal + 2 other-adminOnly เท่านั้น
  });

  it('ไม่มีสิทธิ์ทั้งคู่: เห็นแค่ event ธรรมดาที่ไม่ใช่ adminOnly', () => {
    const items = buildTimeline(mixed, false, false);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('เช็คอิน');
  });

  it('มีสิทธิ์ทั้งคู่: เห็นครบทุกตัว', () => {
    const items = buildTimeline(mixed, true, true);
    expect(items).toHaveLength(5);
  });

  it('isFinanceEventType() ต้องตรงกับ SQL event_type_is_finance() เป๊ะ (0051:88-96) — payment.% หรือ audit.credit_% เท่านั้น ไม่รวม audit.* อื่นหรือ session.charges_committed', async () => {
    const { isFinanceEventType } = await import('@/domain/reports/timeline');
    expect(isFinanceEventType('payment.created')).toBe(true);
    expect(isFinanceEventType('payment.transitioned')).toBe(true);
    expect(isFinanceEventType('audit.credit_topup')).toBe(true);
    expect(isFinanceEventType('audit.credit_overpayment_recorded')).toBe(true);
    // ไม่ใช่ finance แม้จะเป็น adminOnly (ตรงกับ SQL ที่ event_type_is_finance ⊂ event_type_is_admin_only ไม่ใช่ตรงกัน)
    expect(isFinanceEventType('audit.role_assigned')).toBe(false);
    expect(isFinanceEventType('audit.payment_received_amount_set')).toBe(false);
    expect(isFinanceEventType('session.charges_committed')).toBe(false);
    expect(isFinanceEventType('membership.fees_generated')).toBe(false);
    expect(isFinanceEventType('line.account_linked')).toBe(false);
    expect(isFinanceEventType('gang.join_requested')).toBe(false);
    expect(isFinanceEventType('registration.checked_in')).toBe(false);
  });

  it('backward-compat: ไม่ส่ง canSeeOtherAdminOnly (เรียกแบบ 2 args เดิม) ต้องเท่ากับ canSeeMoney (ไม่พังของเดิมที่ SessionDetailPage.tsx เรียกอยู่)', () => {
    expect(buildTimeline(mixed, true)).toHaveLength(buildTimeline(mixed, true, true).length);
    expect(buildTimeline(mixed, false)).toHaveLength(buildTimeline(mixed, false, false).length);
  });
});
