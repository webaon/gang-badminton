import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionContext } from '@/domain/permissions/types';

const h = vi.hoisted(() => ({
  ctx: { role: 'owner' } as PermissionContext,
  row: null as Record<string, unknown> | null,
  error: null as Error | null,
  calls: [] as { op: string; args: unknown[] }[],
  permission: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: (...args: unknown[]) => { h.auth(...args); return { id: 'actor' }; } }));
vi.mock('@/server/permissions/gang-context', () => ({ loadGangPermissionContext: (...args: unknown[]) => { h.permission(...args); return h.ctx; } }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({
  from(table: string) {
    h.calls.push({ op: 'from', args: [table] });
    const record = (op: string, args: unknown[]) => { h.calls.push({ op, args }); return builder; };
    const builder = {
      select: (...args: unknown[]) => record('select', args),
      eq: (...args: unknown[]) => record('eq', args),
      is: (...args: unknown[]) => record('is', args),
      maybeSingle: async () => ({ data: h.row, error: h.error }),
    };
    return builder;
  },
}) }));
import { loadSessionEdit } from '@/server/sessions/edit-loader';

beforeEach(() => {
  h.ctx = { role: 'owner' };
  h.row = { id: 'session', title: 'ซ้อม', venue: null, starts_at: '2026-11-14T12:00:00Z', ends_at: '2026-11-14T14:00:00Z', status: 'open', court_count: 7, max_players: 23, allow_guests: false, gangs: { name: 'ก๊วน', timezone: 'Asia/Bangkok' } };
  h.error = null; h.calls = []; h.permission.mockClear(); h.auth.mockClear();
});

describe('session edit loader — mocked RLS transport, not live RLS verification', () => {
  it.each([null, 'member'] as const)('returns 404 for %s without reading edit data', async role => {
    h.ctx = { role };
    await expect(loadSessionEdit('gang', 'session')).rejects.toThrow('NOT_FOUND');
    expect(h.calls).toEqual([]);
  });
  it('accepts delegated session.update, not an unrelated permission', async () => {
    h.ctx = { role: 'member', extra: ['session.update'] };
    expect((await loadSessionEdit('gang', 'session')).canEdit).toBe(true);
    h.ctx = { role: 'member', extra: ['gang.finance.view'] };
    await expect(loadSessionEdit('gang', 'session')).rejects.toThrow('NOT_FOUND');
  });
  it('returns 404 for RLS-hidden or mismatched session', async () => {
    h.row = null;
    await expect(loadSessionEdit('gang', 'foreign-session')).rejects.toThrow('NOT_FOUND');
    expect(h.calls).toContainEqual({ op: 'eq', args: ['id', 'foreign-session'] });
  });
  it('does not turn a read error into a default-filled form', async () => {
    h.error = new Error('read failed');
    await expect(loadSessionEdit('gang', 'session')).rejects.toThrow('read failed');
  });
  it.each(['in_play', 'billing', 'settled', 'cancelled', 'archived'])('marks %s non-editable without changing its data', async status => {
    h.row!.status = status;
    const data = await loadSessionEdit('gang', 'session');
    expect(data.canEdit).toBe(false);
    expect(data.initial.courtCount).toBe(7);
  });
  it('returns real edit values and filters the tenant, session and soft deletion', async () => {
    const data = await loadSessionEdit('gang', 'session');
    expect(data.initial).toEqual({ title: 'ซ้อม', venue: null, startsAtLocal: '2026-11-14T19:00', endsAtLocal: '2026-11-14T21:00', courtCount: 7, maxPlayers: 23, allowGuests: false });
    expect(data.canEdit).toBe(true);
    expect(h.permission).toHaveBeenCalledWith('gang', 'actor');
    expect(h.auth).toHaveBeenCalledWith('/gangs/gang/sessions/session/edit');
    expect(h.calls).toContainEqual({ op: 'eq', args: ['gang_id', 'gang'] });
    expect(h.calls).toContainEqual({ op: 'eq', args: ['id', 'session'] });
    expect(h.calls).toContainEqual({ op: 'is', args: ['deleted_at', null] });
    expect(h.calls.filter(c => c.op === 'from')).toEqual([{ op: 'from', args: ['sessions'] }]);
  });
});
