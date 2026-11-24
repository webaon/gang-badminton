/**
 * ADR-015 — domain/permissions/delegable.ts (pure) · ไม่แตะ DB
 * ฝั่ง DB เทียบกันที่ tests/sessions/gang-roles.test.ts
 */
import { describe, it, expect } from 'vitest';
import { allowedActions } from '@/domain/permissions/can';
import { ACTIONS, FEATURES, type GangFeatures } from '@/domain/permissions/types';
import {
  DELEGABLE_ACTIONS,
  NEVER_DELEGABLE_ACTIONS,
  ROLE_PRESETS,
  isDelegableAction,
} from '@/domain/permissions/delegable';

const ALL_ON = Object.fromEntries(FEATURES.map((f) => [f, true])) as GangFeatures;

describe('delegable actions (ADR-015)', () => {
  it('ทุกตัวเป็น action ที่ระบบรู้จัก · admin ทำได้อยู่แล้ว · member ยังไม่มี · ไม่ซ้ำ · ไม่ชนรายการห้าม', () => {
    const admin = new Set(allowedActions({ role: 'admin', features: ALL_ON }));
    const member = new Set(allowedActions({ role: 'member', features: ALL_ON }));
    expect(new Set(DELEGABLE_ACTIONS).size).toBe(DELEGABLE_ACTIONS.length);
    for (const a of DELEGABLE_ACTIONS) {
      expect(ACTIONS as readonly string[]).toContain(a);
      expect(admin.has(a), a).toBe(true);
      expect(member.has(a), a).toBe(false);
      expect(NEVER_DELEGABLE_ACTIONS as readonly string[]).not.toContain(a);
    }
  });

  it('🔴 รายการห้าม delegate ครอบคลุมทางนำไปสู่ escalation และไม่ delegable', () => {
    expect([...NEVER_DELEGABLE_ACTIONS].sort()).toEqual(
      [
        'gang.join_request.manage',
        'gang.line.manage',
        'gang.member.manage',
        'gang.ownership.transfer',
        'gang.pricing.manage',
        'gang.skill.manage',
        'gang.update',
      ].sort(),
    );
    for (const a of NEVER_DELEGABLE_ACTIONS) expect(isDelegableAction(a), a).toBe(false);
  });

  it('🔴 allow-list ปิด: action ที่ไม่ได้ประกาศ (รวมที่เพิ่มในอนาคต) ไม่ delegable · ทุก action ใน ACTIONS แบ่งเป็น delegable / ห้าม / member-level เท่านั้น', () => {
    expect(isDelegableAction('future.thing')).toBe(false);
    expect(isDelegableAction('')).toBe(false);
    const member = new Set(allowedActions({ role: 'member', features: ALL_ON }));
    const adminOnlyUnclassified = ACTIONS.filter(
      (a) =>
        !member.has(a) &&
        a !== 'gang.ownership.transfer' &&
        !isDelegableAction(a) &&
        !(NEVER_DELEGABLE_ACTIONS as readonly string[]).includes(a),
    );
    // action ระดับแอดมินที่ยังไม่ได้ตัดสินว่า delegate ได้หรือไม่ ⇒ ต้องตัดสินใจโดยตั้งใจ (เพิ่มเข้า DELEGABLE หรือ NEVER) ก่อนผ่านเทสต์
    expect(adminOnlyUnclassified, 'ตัดสินใจ action เหล่านี้ใน delegable.ts (มอบได้/ห้ามมอบ)').toEqual([]);
  });

  it('🔴 preset: ทุกตัว delegable · Q2ก — เหรัญญิกไม่มี credit.topup/billing.close/pricing · ผู้จัดคิวไม่มีเงิน/ประกาศ · สองชุดไม่ทับกัน', () => {
    for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
      expect(perms.length, key).toBeGreaterThan(0);
      expect(new Set(perms).size, key).toBe(perms.length);
      for (const a of perms) expect(isDelegableAction(a), `${key}: ${a}`).toBe(true);
    }
    const t = ROLE_PRESETS.treasurer as readonly string[];
    for (const a of ['credit.topup', 'billing.close', 'gang.pricing.manage', 'announcement.manage']) expect(t).not.toContain(a);
    expect(t).toEqual(
      expect.arrayContaining(['payment.verify', 'credit.overpayment.record', 'credit.payout.record', 'credit.return_charge', 'gang.finance.view']),
    );
    const s = ROLE_PRESETS.scheduler as readonly string[];
    for (const a of s) expect(/^(payment|credit)\.|^gang\.finance|^billing\.|^announcement\./.test(a), a).toBe(false);
    expect(s).toEqual(expect.arrayContaining(['session.create', 'registration.checkin', 'game.manage']));
    expect(t.filter((a) => s.includes(a))).toEqual([]);
  });
});
