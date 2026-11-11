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

  it('🔴 event ที่ไม่รู้จัก → ข้อความกลางๆ ไม่ใช่ payload ดิบ', () => {
    const item = describeEvent(
      event({ eventType: 'something.new', payload: { secret: 'ห้ามโชว์' } }),
    );

    expect(item.title).toContain('something.new');
    expect(JSON.stringify(item)).not.toContain('ห้ามโชว์');
    expect(item.detail).toBeNull();
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
  it('registration.confirmed/waitlisted (ของจริงจาก register_to_session) มีข้อความไทยแล้ว ไม่ fallback', () => {
    expect(describeEvent(event({ eventType: 'registration.confirmed' })).title).toBe('ลงชื่อเข้าร่วม (ได้ที่เล่น)');
    expect(describeEvent(event({ eventType: 'registration.waitlisted' })).title).toBe('ลงชื่อเข้าร่วม (เข้าคิวรอ)');
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

  it('event ของสมาชิกทั่วไป (สร้างก๊วน/เพิ่มสมาชิก/ประกาศ) ไม่ adminOnly', () => {
    for (const eventType of ['gang.created', 'gang.member_added', 'gang.member_left', 'announcement.published', 'line.account_linked', 'line.account_unlinked']) {
      expect(describeEvent(event({ eventType })).adminOnly, eventType).toBe(false);
    }
  });

  it('การตั้งค่า LINE/บล็อกบัญชี เป็น adminOnly (เครื่องมือแอดมิน)', () => {
    for (const eventType of ['gang.line_config_updated', 'gang.line_toggled', 'gang.line_config_cleared', 'gang.line_login_updated', 'line.blocked', 'line.unblocked']) {
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
