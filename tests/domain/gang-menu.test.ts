/**
 * WO-6.1a DoD ข้อ 2 — เมนูของ shell: role × feature flag → รายการเมนูตรงกับ `can()`
 * (pure ไม่แตะ DB / framework)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { can } from '@/domain/permissions/can';
import type { Action, GangRole, GangFeatures } from '@/domain/permissions/types';
import { GANG_ROLES } from '@/domain/permissions/types';
import { activeMenuId, buildGangMenu } from '@/domain/navigation/gang-menu';

const G = 'g1';
const ALL_OFF: GangFeatures = { line: false, discovery: false, guests: false, coupons: false, statistics: false };
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('buildGangMenu — member', () => {
  it('statistics เปิด: แท็บ นัด · อันดับ · ฉัน (ยังไม่มี "ยอดเงิน" จนกว่า WO-6.3)', () => {
    const m = buildGangMenu({ role: 'member', features: { ...ALL_OFF, statistics: true } }, G);
    expect(ids(m.tabs)).toEqual(['sessions', 'stats', 'profile']);
    expect(ids(m.side)).toEqual(['sessions', 'members', 'announcements', 'stats', 'profile']);
  });

  it('statistics ปิด: เมนู/แท็บ "อันดับ/สถิติ" หายไปทั้งสองที่', () => {
    const m = buildGangMenu({ role: 'member', features: ALL_OFF }, G);
    expect(ids(m.tabs)).toEqual(['sessions', 'profile']);
    expect(ids(m.side)).toEqual(['sessions', 'members', 'announcements', 'profile']);
  });

  it('ไม่ส่ง features เลย = ถือว่าปิดหมด (fail-closed)', () => {
    expect(ids(buildGangMenu({ role: 'member' }, G).tabs)).toEqual(['sessions', 'profile']);
  });

  it('LINE เปิด ⇒ สมาชิกเห็นเมนู LINE (ผูกบัญชีของตัวเอง) · ปิด ⇒ ไม่เห็น', () => {
    expect(ids(buildGangMenu({ role: 'member', features: { ...ALL_OFF, line: true } }, G).side)).toContain('line');
    expect(ids(buildGangMenu({ role: 'member', features: ALL_OFF }, G).side)).not.toContain('line');
  });
});

describe('buildGangMenu — แท็บ "ยอดเงิน" (ผูก payment.verify จนกว่า WO-6.3)', () => {
  it('member ไม่เห็นยอดเงิน ทั้งแท็บและ sidebar (ไม่ว่า flag ใด)', () => {
    for (const statistics of [false, true]) {
      const m = buildGangMenu({ role: 'member', features: { ...ALL_OFF, statistics } }, G);
      expect(ids(m.tabs)).not.toContain('payments');
      expect(ids(m.side)).not.toContain('payments');
    }
  });

  it('admin / owner เห็นยอดเงิน ทั้งแท็บ (ลำดับที่ 2) และ sidebar', () => {
    for (const role of ['admin', 'owner'] as const) {
      const m = buildGangMenu({ role, features: ALL_OFF }, G);
      expect(ids(m.tabs)[1]).toBe('payments');
      expect(ids(m.side)).toContain('payments');
    }
  });
});

describe('buildGangMenu — admin / owner', () => {
  for (const role of ['admin', 'owner'] as const) {
    it(`${role}: เห็นเมนูแอดมินครบ (discovery ปิด ⇒ ไม่มีคำขอเข้าก๊วน)`, () => {
      const m = buildGangMenu({ role, features: { ...ALL_OFF, statistics: true } }, G);
      expect(ids(m.tabs)).toEqual(['sessions', 'payments', 'stats', 'profile']);
      expect(ids(m.side)).toEqual([
        'dashboard',
        'sessions',
        'templates',
        'members',
        'payments',
        'membership',
        'reports',
        'announcements',
        'stats',
        'settings',
        'line',
        'profile',
      ]);
    });

    it(`${role}: discovery เปิด ⇒ มีเมนูคำขอเข้าก๊วนต่อจากสมาชิก`, () => {
      const m = buildGangMenu({ role, features: { ...ALL_OFF, discovery: true, statistics: true } }, G);
      expect(ids(m.side).slice(2, 5)).toEqual(['templates', 'members', 'join-requests']);
    });

    it(`${role}: statistics ปิด ⇒ ไม่มี stats ทั้งที่เป็นแอดมิน (flag ชนะ role)`, () => {
      const m = buildGangMenu({ role, features: ALL_OFF }, G);
      expect(ids(m.tabs)).not.toContain('stats');
      expect(ids(m.side)).not.toContain('stats');
    });
  }

  it('แอดมินขององค์กรที่เป็นเจ้าของก๊วน (orgRole) ได้เมนูแอดมินเหมือน admin', () => {
    const viaOrg = buildGangMenu({ role: null, orgRole: 'admin', features: ALL_OFF }, G);
    const viaRole = buildGangMenu({ role: 'admin', features: ALL_OFF }, G);
    expect(viaOrg).toEqual(viaRole);
  });
});

describe('buildGangMenu — ไม่ใช่สมาชิก', () => {
  it('เมนูว่างทั้งสองชุด', () => {
    expect(buildGangMenu({ role: null, features: { ...ALL_OFF, statistics: true } }, G)).toEqual({
      tabs: [],
      side: [],
    });
  });
});

describe('เมนูตรงกับ can() ทุก role × flag (ไม่มีกฎซ้ำนอก can)', () => {
  // action ที่แต่ละเมนูอ้าง — ต้องตรงกับ gang-menu.ts (ถ้าเมนูใหม่ลืมผูกสิทธิ์ เทสต์ก้อนถัดไปจะแดง)
  const SIDE_ACTION: Record<string, Action | Action[] | null> = {
    dashboard: 'gang.finance.view',
    sessions: 'session.view',
    templates: 'session.create',
    members: 'gang.member.view',
    'join-requests': 'gang.join_request.manage',
    payments: 'payment.verify',
    membership: 'gang.finance.view',
    reports: 'gang.finance.view',
    announcements: 'announcement.view',
    stats: 'statistics.view',
    settings: 'gang.update',
    line: ['gang.line.manage', 'line.link.self'],
    profile: null,
  };
  const TAB_ACTION: Record<string, Action | Action[] | null> = {
    sessions: 'session.view',
    payments: 'payment.verify',
    stats: 'statistics.view',
    profile: null,
  };
  const ok = (ctx: Parameters<typeof can>[0], a: Action | Action[] | null) =>
    a === null || (Array.isArray(a) ? a : [a]).some((x) => can(ctx, x));

  const featureCombos: GangFeatures[] = [];
  for (const discovery of [false, true])
    for (const statistics of [false, true])
      for (const line of [false, true])
        featureCombos.push({ ...ALL_OFF, discovery, statistics, line });

  for (const role of GANG_ROLES as readonly GangRole[]) {
    for (const features of featureCombos) {
      const label = `${role} · ${JSON.stringify({ d: features.discovery, s: features.statistics, l: features.line })}`;

      it(`${label}: รายการที่ได้ = ทุกเมนูที่ can() อนุญาต เรียงตามนิยาม`, () => {
        const ctx = { role, features };
        const m = buildGangMenu(ctx, G);

        const expectSide = Object.entries(SIDE_ACTION)
          .filter(([, a]) => ok(ctx, a))
          .map(([id]) => id);
        const expectTabs = Object.entries(TAB_ACTION)
          .filter(([, a]) => ok(ctx, a))
          .map(([id]) => id);

        expect(ids(m.side)).toEqual(expectSide);
        expect(ids(m.tabs)).toEqual(expectTabs);
      });
    }
  }
});

describe('href', () => {
  it('เมนูของก๊วนอยู่ใต้ /gangs/:id/ · "ฉัน" ไป /profile', () => {
    const m = buildGangMenu({ role: 'admin', features: { ...ALL_OFF, statistics: true } }, 'abc');
    expect(m.tabs.map((t) => t.href)).toEqual([
      '/gangs/abc/sessions',
      '/gangs/abc/payments',
      '/gangs/abc/stats',
      '/profile',
    ]);
  });
});

describe('activeMenuId', () => {
  const m = buildGangMenu({ role: 'admin', features: { ...ALL_OFF, statistics: true } }, G);

  it('หน้าลูกของนัดถือว่าอยู่ในเมนู "นัด"', () => {
    expect(activeMenuId('/gangs/g1/sessions/s9/pay', m.side)).toBe('sessions');
    expect(activeMenuId('/gangs/g1/sessions', m.side)).toBe('sessions');
    expect(activeMenuId('/gangs/g1/sessions/', m.side)).toBe('sessions');
  });

  it('ไม่ตรงขอบ segment ⇒ ไม่นับ', () => {
    expect(activeMenuId('/gangs/g1/sessionsX', m.side)).toBeNull();
    expect(activeMenuId('/gangs/g2/sessions', m.side)).toBeNull();
  });

  it('แดชบอร์ดชี้ไปหน้า sessions แต่ไม่ถูก highlight ซ้ำกับ "นัด"', () => {
    expect(activeMenuId('/gangs/g1/sessions', m.side)).not.toBe('dashboard');
  });

  it('หน้าอื่น ๆ + /profile + query/hash', () => {
    expect(activeMenuId('/gangs/g1/settings?tab=x', m.side)).toBe('settings');
    expect(activeMenuId('/gangs/g1/payments#top', m.tabs)).toBe('payments');
    expect(activeMenuId('/profile', m.tabs)).toBe('profile');
    expect(activeMenuId('/gangs/g1/line', m.tabs)).toBeNull();
  });
});

describe('กติกา: ไม่ hardcode role ในไฟล์เมนู', () => {
  it("gang-menu.ts ไม่มี role === 'admin' | 'owner' | 'member'", () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../domain/navigation/gang-menu.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/role\s*[!=]==?\s*['"](admin|owner|member)['"]/);
  });
});
