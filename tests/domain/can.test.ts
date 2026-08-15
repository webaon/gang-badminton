/**
 * WO-2.1 DoD — `can()` มี unit test ครบทุก role × action ที่ใช้ใน MVP-0
 * และครอบ feature flag
 *
 * ⚠️ เทสต์นี้เป็น pure unit test ไม่แตะ DB — `domain/` ต้อง test ได้โดยไม่ mock อะไรเลย
 */
import { describe, it, expect } from 'vitest';
import { can, assertCan, allowedActions } from '@/domain/permissions/can';
import { ACTIONS, GANG_ROLES, type Action, type GangRole } from '@/domain/permissions/types';

const ALL_FEATURES = {
  line: true,
  discovery: true,
  guests: true,
  coupons: true,
  statistics: true,
};

/** ตารางคาดหวังแบบเต็ม — role ไหนทำ action ไหนได้บ้าง (features เปิดหมด) */
const EXPECTED: Record<GangRole, Action[]> = {
  member: [
    'gang.view',
    'gang.member.view',
    'session.view',
    'registration.create.self',
    'registration.cancel.self',
    'payment.submit.self',
    'announcement.view',
    'notification.view.self',
  ],
  admin: [
    'gang.view',
    'gang.member.view',
    'session.view',
    'registration.create.self',
    'registration.cancel.self',
    'payment.submit.self',
    'announcement.view',
    'notification.view.self',
    'gang.update',
    'gang.member.manage',
    'gang.skill.manage',
    'gang.pricing.manage',
    'gang.finance.view',
    // [WO-3.B] บันทึกรายรับ-รายจ่ายของก๊วน (ข้อมูลการเงิน — แอดมินเท่านั้น)
    'gang.finance.manage',
    'session.create',
    'session.update',
    'session.transition',
    'session.invite.manage',
    'registration.create.other',
    'registration.create.guest',
    'registration.cancel.other',
    'registration.checkin',
    'registration.no_show',
    'game.manage',
    'billing.close',
    'payment.verify',
    'announcement.manage',
  ],
  owner: [], // เติมด้านล่าง — owner = admin ใน MVP-0
};
EXPECTED.owner = [...EXPECTED.admin];

describe('can() — mapping role → สิทธิ์', () => {
  it('ทุก role ได้สิทธิ์ตรงตามตารางเป๊ะ ไม่มากไม่น้อย', () => {
    for (const role of GANG_ROLES) {
      const actual = allowedActions({ role, features: ALL_FEATURES }).sort();
      const expected = [...EXPECTED[role]].sort();
      expect(actual, `role=${role}`).toEqual(expected);
    }
  });

  it('คนนอกก๊วน (role = null) ทำอะไรไม่ได้เลยสักอย่าง', () => {
    const allowed = ACTIONS.filter((a) => can({ role: null, features: ALL_FEATURES }, a));
    expect(allowed).toEqual([]);
  });

  it('member ทำงานของแอดมินไม่ได้', () => {
    const adminOnly: Action[] = [
      'gang.update',
      'gang.member.manage',
      'session.create',
      'session.transition',
      'registration.checkin',
      'billing.close',
      'payment.verify',
      'game.manage',
    ];
    for (const action of adminOnly) {
      expect(can({ role: 'member', features: ALL_FEATURES }, action), action).toBe(false);
    }
  });

  it('สิทธิ์ของ admin ครอบของ member ทั้งหมด', () => {
    for (const action of EXPECTED.member) {
      expect(can({ role: 'admin', features: ALL_FEATURES }, action), action).toBe(true);
    }
  });

  it('แอดมินองค์กรได้สิทธิ์แอดมินในก๊วน แม้ไม่ได้เป็นสมาชิกก๊วน', () => {
    const ctx = { role: null, orgRole: 'admin' as const, features: ALL_FEATURES };
    expect(can(ctx, 'gang.update')).toBe(true);
    expect(can(ctx, 'session.create')).toBe(true);
    // ตรงกับ is_gang_admin() ใน migration 0010 ที่ยอมรับ organization_members ด้วย
  });
});

describe('can() — feature flag', () => {
  it('🔴 flag ปิด → แม้แต่ owner ก็รับ guest ไม่ได้', () => {
    const off = { ...ALL_FEATURES, guests: false };
    for (const role of GANG_ROLES) {
      expect(can({ role, features: off }, 'registration.create.guest'), role).toBe(false);
      expect(can({ role, features: off }, 'session.invite.manage'), role).toBe(false);
    }
  });

  it('flag เปิด → แอดมินรับ guest ได้ แต่สมาชิกธรรมดายังไม่ได้', () => {
    expect(can({ role: 'admin', features: ALL_FEATURES }, 'registration.create.guest')).toBe(true);
    expect(can({ role: 'member', features: ALL_FEATURES }, 'registration.create.guest')).toBe(false);
  });

  it('ไม่ส่ง features มาเลย → action ที่ต้องใช้ flag ถือว่าปิด (fail-closed)', () => {
    expect(can({ role: 'owner' }, 'registration.create.guest')).toBe(false);
    // แต่ action ที่ไม่ผูกกับ flag ต้องยังทำได้ตามปกติ
    expect(can({ role: 'owner' }, 'session.create')).toBe(true);
  });

  it('flag ปิดไม่กระทบ action ที่ไม่เกี่ยวกับ flag นั้น', () => {
    const noGuests = { ...ALL_FEATURES, guests: false };
    expect(can({ role: 'admin', features: noGuests }, 'session.create')).toBe(true);
    expect(can({ role: 'member', features: noGuests }, 'registration.create.self')).toBe(true);
  });
});

describe('assertCan()', () => {
  it('ผ่านเงียบๆ ถ้ามีสิทธิ์', () => {
    expect(() => assertCan({ role: 'admin', features: ALL_FEATURES }, 'session.create')).not.toThrow();
  });

  it('โยน error ที่มี code = FORBIDDEN ถ้าไม่มีสิทธิ์', () => {
    try {
      assertCan({ role: 'member' }, 'session.create');
      expect.unreachable('ควรโยน error');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('FORBIDDEN');
    }
  });
});
