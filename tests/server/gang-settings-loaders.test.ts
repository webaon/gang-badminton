import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionContext } from '@/domain/permissions/types';

const h = vi.hoisted(() => ({
  ctx: { role: 'member' } as PermissionContext,
  gangVisible: true,
  failedTable: '',
  calls: [] as { table: string; op: string; args: unknown[] }[],
  permission: vi.fn(),
  requireUser: vi.fn(),
  line: vi.fn(),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: (...args: unknown[]) => { h.requireUser(...args); return { id: 'actor' }; } }));
vi.mock('@/server/permissions/gang-context', () => ({ loadGangPermissionContext: (...args: unknown[]) => { h.permission(...args); return h.ctx; } }));
vi.mock('@/server/actions/line', () => ({
  lineStatus: (...args: unknown[]) => h.line(...args),
  lineUsage: (...args: unknown[]) => h.line(...args),
  lineLoginStatus: (...args: unknown[]) => h.line(...args),
}));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({
  from(table: string) {
    const record = (op: string, args: unknown[]) => { h.calls.push({ table, op, args }); return builder; };
    const result = (single = false) => ({
      data: table === 'gangs' ? (h.gangVisible ? { id: 'gang', name: 'ก๊วนทดสอบ', area: null, is_public: false, promptpay_id: null, timezone: 'Asia/Bangkok', cancellation_policy: {}, settings: {} } : null)
        : table === 'gang_members' ? [{ id: 'member', user_id: 'actor', role: 'member', is_monthly_member: false, profiles: { display_name: 'ผู้เล่น' } }]
          : single ? null : [],
      error: h.failedTable === table ? new Error('read failed') : null,
    });
    const builder = {
      select: (...args: unknown[]) => record('select', args),
      eq: (...args: unknown[]) => record('eq', args),
      is: (...args: unknown[]) => record('is', args),
      in: (...args: unknown[]) => record('in', args),
      order: (...args: unknown[]) => record('order', args),
      limit: (...args: unknown[]) => record('limit', args),
      maybeSingle: () => Promise.resolve(result(true)),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return builder;
  },
}) }));

import { loadGangMembers } from '@/server/gangs/members-loader';
import { loadGangSettings } from '@/server/gangs/settings-loader';

beforeEach(() => {
  h.ctx = { role: 'member' }; h.gangVisible = true; h.failedTable = ''; h.calls = [];
  h.permission.mockClear(); h.requireUser.mockClear(); h.line.mockReset();
  h.line.mockResolvedValue({ success: false, error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } });
});

describe('WO-6.6a loader contracts — mocked, no live RLS claim', () => {
  it.each(['admin', 'owner'] as const)('%s settings uses full context and existing reads only', async role => {
    h.ctx = { role };
    const result = await loadGangSettings('gang');
    expect(result.canManage).toBe(true);
    expect(result.settings?.initial.name).toBe('ก๊วนทดสอบ');
    expect(h.permission).toHaveBeenCalledWith('gang', 'actor');
    expect(h.requireUser).toHaveBeenCalledWith('/gangs/gang/settings');
    expect(h.line).toHaveBeenCalledTimes(3);
    expect(h.calls.filter(c => c.op === 'select').map(c => c.table)).toEqual(['gangs', 'gang_pricing_plans', 'gang_pricing_plans', 'gang_skill_levels']);
    expect(h.calls).toContainEqual({ table: 'gang_pricing_plans', op: 'eq', args: ['type', 'monthly'] });
    expect(h.calls).toContainEqual({ table: 'gang_pricing_plans', op: 'in', args: ['type', ['flat_rate', 'court_plus_shuttle']] });
  });

  it('ordinary or delegated member cannot edit settings and does not load admin data', async () => {
    h.ctx = { role: 'member', extra: ['gang.finance.view', 'billing.close'] };
    const result = await loadGangSettings('gang');
    expect(result.canManage).toBe(false);
    expect(result.settings).toBeNull();
    expect(h.line).not.toHaveBeenCalled();
    expect(h.calls.every(c => c.table === 'gangs')).toBe(true);
  });

  it.each(['member', 'admin'] as const)('%s can view members; management is action-gated', async role => {
    h.ctx = { role };
    const result = await loadGangMembers('gang');
    expect(result.canManage).toBe(role === 'admin');
    expect(result.members).toEqual([{ id: 'member', userId: 'actor', displayName: 'ผู้เล่น', role: 'member', isMonthlyMember: false }]);
    expect(h.permission).toHaveBeenCalledWith('gang', 'actor');
    expect(h.calls).toContainEqual({ table: 'gang_members', op: 'eq', args: ['gang_id', 'gang'] });
    expect(h.calls).toContainEqual({ table: 'gang_members', op: 'is', args: ['deleted_at', null] });
  });

  it.each([loadGangMembers, loadGangSettings])('outsider returns 404 even if gang metadata were visible', async load => {
    h.ctx = { role: null };
    await expect(load('gang')).rejects.toThrow('NOT_FOUND');
    expect(h.line).not.toHaveBeenCalled();
    expect(h.calls.every(c => c.table === 'gangs')).toBe(true);
  });

  it.each([loadGangMembers, loadGangSettings])('RLS-hidden or missing gang returns 404 before further reads', async load => {
    h.gangVisible = false;
    await expect(load('gang')).rejects.toThrow('NOT_FOUND');
    expect(h.permission).not.toHaveBeenCalled();
    expect(h.line).not.toHaveBeenCalled();
  });

  it.each([loadGangMembers, loadGangSettings])('query failure is not silently rendered as empty data', async load => {
    h.failedTable = 'gangs';
    await expect(load('gang')).rejects.toThrow('read failed');
    expect(h.permission).not.toHaveBeenCalled();
  });
});
