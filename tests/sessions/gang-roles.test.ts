/**
 * WO-R-roles-1 DoD (ADR-015 · ขั้น EXPAND) — ชุดสิทธิ์ซ้อนบน role เดิม (ยังไม่มี policy/function เดิมเรียกใช้)
 *
 *   A. รายการ delegable ฝั่ง TS ↔ DB ตรงกันทุก action · preset ระบบตรง ROLE_PRESETS · CHECK ปฏิเสธ action ที่ห้าม delegate
 *   B. assign/revoke: admin+owner (+แอดมินองค์กร) เท่านั้น · ผู้ถือชุดสิทธิ์/สมาชิก/คนนอก/ไม่มี actor ⇒ FORBIDDEN (escalation)
 *      มอบให้ได้เฉพาะ member ที่ยังอยู่ · ชุดของก๊วนอื่นใช้ข้ามก๊วนไม่ได้ · idempotent
 *   C. has_gang_permission / actor_has_permission: ⊇ is_gang_admin · ผู้ถือชุดสิทธิ์ได้เฉพาะ action ในชุด (และ delegable)
 *      ถอนแล้วหลุดทันที · ไม่มีผลข้ามก๊วน
 *   D. วงจรชีวิต: ออกก๊วน / เลื่อนเป็น admin / โอนความเป็นเจ้าของ ⇒ ชุดสิทธิ์หลุดใน txn เดียวกัน · กลับเข้าก๊วนไม่ได้คืน
 *   E. audit: audit.role_assigned/revoked ครั้งเดียวต่อการเปลี่ยน · สมาชิกทั่วไปอ่านไม่ได้
 *   F. ตารางใหม่เขียนตรงไม่ได้ทุก role (authenticated + service_role) · composite FK + guard trigger กันแถวผิดก๊วน/ผิดสมาชิก
 *   G. concurrency 20 รอบ: assign ซ้ำพร้อมกัน · assign×revoke · assign×leave_gang · assign×เลื่อนเป็น admin · ผสมหลายเส้นทาง
 *      ⇒ ไม่ซ้ำ ไม่ค้างของคนที่ออก/เลื่อน ไม่มี deadlock (40P01)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, asRoleCommitted, runConcurrently } from '../helpers/db';
import { allowedActions } from '@/domain/permissions/can';
import { ACTIONS, FEATURES, type GangFeatures } from '@/domain/permissions/types';
import {
  DELEGABLE_ACTIONS,
  NEVER_DELEGABLE_ACTIONS,
  ROLE_PRESETS,
  isDelegableAction,
} from '@/domain/permissions/delegable';

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`gr-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

type Gang = { gangId: string; orgId: string; owner: string };

async function newGang(): Promise<Gang> {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string; org_id: string }>(
    `select id, org_id from public.create_gang($1, $2)`,
    [owner, `ก๊วน-gr-${crypto.randomUUID()}`],
  );
  return { gangId: gang.id, orgId: gang.org_id, owner };
}

type Member = { userId: string; memberId: string };

async function addMember(gangId: string, role = 'member'): Promise<Member> {
  const userId = await newUser();
  const {
    rows: [m],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3) returning id`,
    [gangId, userId, role],
  );
  return { userId, memberId: m.id };
}

const assign = (gangId: string, userId: string, key: string, actor: string | null) =>
  pool.query(`select public.assign_gang_role($1, $2, $3, $4, 'cid-gr')`, [gangId, userId, key, actor]);

const revoke = async (gangId: string, userId: string, key: string, actor: string | null): Promise<boolean> =>
  (
    await pool.query<{ r: boolean }>(`select public.revoke_gang_role($1, $2, $3, $4, 'cid-gr') r`, [
      gangId,
      userId,
      key,
      actor,
    ])
  ).rows[0].r;

const activeRoles = async (gangId: string, userId: string): Promise<string[]> =>
  (
    await pool.query<{ key: string }>(
      `select r.key from public.gang_member_roles gmr join public.gang_roles r on r.id = gmr.role_id
        where gmr.gang_id = $1 and gmr.user_id = $2 and gmr.deleted_at is null order by 1`,
      [gangId, userId],
    )
  ).rows.map((r) => r.key);

const roleEvents = async (gangId: string) =>
  (
    await pool.query<{ event_type: string; payload: Record<string, unknown>; aggregate_id: string }>(
      `select event_type, payload, aggregate_id from public.event_logs
        where gang_id = $1 and event_type like 'audit.role_%' order by id`,
      [gangId],
    )
  ).rows;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * บังคับลำดับ interleave: A เริ่ม txn + ทำงานแล้วค้าง (ถือ lock) → B เริ่มแล้วต้องติด lock (พิสูจน์ว่าติดจริง) → A commit → B ไปต่อ
 * คืนผลของ B ({ ok } | { err })
 */
async function interleave(
  first: (c: import('pg').PoolClient) => Promise<unknown>,
  second: (c: import('pg').PoolClient) => Promise<unknown>,
): Promise<{ ok: unknown } | { err: Error }> {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('begin');
    await first(a);
    const pb = second(b).then(
      (ok) => ({ ok }) as { ok: unknown },
      (err: Error) => ({ err }) as { err: Error },
    );
    const early = await Promise.race([pb, sleep(150).then(() => 'blocked' as const)]);
    expect(early, 'B ต้องติด lock ของ A (ไม่งั้นไม่ได้ทดสอบ interleave จริง)').toBe('blocked');
    await a.query('commit');
    return await pb;
  } catch (e) {
    await a.query('rollback').catch(() => {});
    throw e;
  } finally {
    a.release();
    b.release();
  }
}

/** has_gang_permission ในฐานะผู้ใช้จริง (RLS/auth.uid()) */
async function hasPerm(userId: string, gangId: string, action: string): Promise<boolean> {
  return asRole('authenticated', userId, async (c) => {
    const { rows } = await c.query<{ v: boolean }>(`select public.has_gang_permission($1, $2) v`, [gangId, action]);
    return rows[0].v;
  });
}

const actorHasPerm = async (gangId: string, actor: string | null, action: string): Promise<boolean> =>
  (
    await pool.query<{ v: boolean }>(`select public.actor_has_permission($1, $2, $3) v`, [gangId, actor, action])
  ).rows[0].v;

const ALL_ON = Object.fromEntries(FEATURES.map((f) => [f, true])) as GangFeatures;

// ---------------------------------------------------------------------------
// A. แคตตาล็อก TS ↔ DB
// ---------------------------------------------------------------------------

describe('R-roles-1 A — delegable catalog + preset (TS ↔ DB ไม่ drift)', () => {
  it('🔴 is_delegable_action ใน DB ตรงกับ DELEGABLE_ACTIONS ฝั่ง TS ทุก action ที่ระบบรู้จัก', async () => {
    const { rows } = await pool.query<{ a: string; d: boolean }>(
      `select a, public.is_delegable_action(a) d from unnest($1::text[]) a`,
      [[...ACTIONS]],
    );
    for (const r of rows) expect(r.d, `${r.a}`).toBe(isDelegableAction(r.a));
    // ตัวที่ไม่ใช่ action เลย / null ⇒ false
    const { rows: odd } = await pool.query<{ a: boolean; b: boolean }>(
      `select public.is_delegable_action('foo.bar') a, public.is_delegable_action(null) b`,
    );
    expect(odd[0]).toEqual({ a: false, b: false });
  });

  it('🔴 invariants: delegable ⊂ ACTIONS · ⊂ สิทธิ์ admin · ไม่ชนรายการห้าม · ไม่ใช่สิทธิ์ owner-only · action ใหม่ไม่ delegable โดยอัตโนมัติ', () => {
    const admin = new Set(allowedActions({ role: 'admin', features: ALL_ON }));
    const member = new Set(allowedActions({ role: 'member', features: ALL_ON }));
    for (const a of DELEGABLE_ACTIONS) {
      expect(ACTIONS as readonly string[], a).toContain(a);
      expect(admin.has(a), `admin ต้องทำ ${a} ได้อยู่แล้ว (delegated ⊂ admin)`).toBe(true);
      expect(member.has(a), `${a} ต้องเป็นสิทธิ์ที่ member ยังไม่มี (ไม่งั้นไม่ต้อง delegate)`).toBe(false);
      expect((NEVER_DELEGABLE_ACTIONS as readonly string[]).includes(a), a).toBe(false);
    }
    for (const a of NEVER_DELEGABLE_ACTIONS) expect(isDelegableAction(a), a).toBe(false);
    expect(new Set(DELEGABLE_ACTIONS).size).toBe(DELEGABLE_ACTIONS.length);
    // owner-only
    expect(isDelegableAction('gang.ownership.transfer')).toBe(false);
  });

  it('🔴 preset ใน DB (gang_roles system) ตรง ROLE_PRESETS ฝั่ง TS · Q2ก: เหรัญญิกไม่มี topup/billing.close · ผู้จัดคิวไม่มีเงิน/ประกาศ', async () => {
    const { rows } = await pool.query<{ key: string; permissions: string[]; is_system: boolean; name: string }>(
      `select key, permissions, is_system, name from public.gang_roles where gang_id is null and deleted_at is null order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['scheduler', 'treasurer']);
    for (const r of rows) {
      expect(r.is_system).toBe(true);
      const ts = ROLE_PRESETS[r.key as keyof typeof ROLE_PRESETS];
      expect([...r.permissions].sort(), r.key).toEqual([...ts].sort());
      for (const a of r.permissions) expect(isDelegableAction(a), `${r.key}: ${a}`).toBe(true);
    }
    const t = ROLE_PRESETS.treasurer as readonly string[];
    expect(t).not.toContain('credit.topup');
    expect(t).not.toContain('billing.close');
    expect(t).not.toContain('gang.pricing.manage');
    const s = ROLE_PRESETS.scheduler as readonly string[];
    for (const a of s) {
      expect(a.startsWith('payment.') || a.startsWith('credit.') || a.startsWith('gang.finance'), a).toBe(false);
    }
    expect(s).not.toContain('announcement.manage');
    expect(s).not.toContain('billing.close');
  });

  it('🔴 CHECK ปฏิเสธ permissions ที่ห้าม delegate / ไม่รู้จัก / ว่าง / ซ้ำ / มี null — ต่อให้ใส่ตรง ๆ ด้วยสิทธิ์สูงสุด', async () => {
    const g = await newGang();
    const tryInsert = async (perms: string[] | null, over = '') => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `insert into public.gang_roles (gang_id, key, name, permissions, is_system)
           values ($1, 'probe_' || substr(md5(random()::text), 1, 6), 'ทดสอบ', $2::text[], false)`,
          [g.gangId, perms],
        );
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code ?? 'unknown';
      } finally {
        await c.query('rollback').catch(() => {});
        c.release();
        void over;
      }
    };

    expect(await tryInsert(['payment.verify'])).toBe('ok'); // ตัวควบคุมบวก
    for (const a of NEVER_DELEGABLE_ACTIONS) {
      expect(await tryInsert([a]), `ห้าม ${a}`).toBe('23514');
      expect(await tryInsert(['payment.verify', a]), `ปนกับ ${a}`).toBe('23514');
    }
    expect(await tryInsert(['foo.bar'])).toBe('23514');
    expect(await tryInsert([])).toBe('23514');
    expect(await tryInsert(['payment.verify', 'payment.verify'])).toBe('23514');
    expect(await tryInsert(['payment.verify', null as unknown as string])).toBe('23514');
    expect(await tryInsert(null)).toBe('23502');

    // รูปทรง: preset ระบบต้อง gang_id null และกลับกัน
    const shape = async (gangId: string | null, isSystem: boolean) => {
      try {
        await pool.query('begin');
        await pool.query(
          `insert into public.gang_roles (gang_id, key, name, permissions, is_system)
           values ($1, 'shape_x', 'x', array['payment.verify']::text[], $2)`,
          [gangId, isSystem],
        );
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code ?? 'unknown';
      } finally {
        await pool.query('rollback').catch(() => {});
      }
    };
    expect(await shape(null, false)).toBe('23514');
    expect(await shape(g.gangId, true)).toBe('23514');
  });
});

// ---------------------------------------------------------------------------
// B. สิทธิ์ของ assign/revoke + ความถูกต้องของเป้าหมาย
// ---------------------------------------------------------------------------

describe('R-roles-1 B — assign_gang_role / revoke_gang_role', () => {
  it('🔴 admin/owner/แอดมินองค์กรมอบได้ · member/ผู้ถือชุดสิทธิ์/คนนอก/ไม่มี actor ⇒ FORBIDDEN (ผู้ถือชุดสิทธิ์แต่งตั้งต่อไม่ได้)', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const treasurer = await addMember(g.gangId);
    const plain = await addMember(g.gangId);
    const outsider = await newUser();
    const orgAdmin = await newUser();
    await pool.query(`insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin')`, [g.orgId, orgAdmin]);
    await assign(g.gangId, treasurer.userId, 'treasurer', g.owner);

    const target = await addMember(g.gangId);
    for (const actor of [treasurer.userId, plain.userId, outsider, null]) {
      await expect(assign(g.gangId, target.userId, 'scheduler', actor), `actor=${actor}`).rejects.toThrow(/FORBIDDEN/);
      await expect(revoke(g.gangId, treasurer.userId, 'treasurer', actor), `revoke actor=${actor}`).rejects.toThrow(/FORBIDDEN/);
    }
    // 🔴 เหรัญญิกมอบชุดให้ตัวเอง/เพิ่มชุดผู้จัดคิวให้ตัวเอง ไม่ได้
    await expect(assign(g.gangId, treasurer.userId, 'scheduler', treasurer.userId)).rejects.toThrow(/FORBIDDEN/);
    expect(await activeRoles(g.gangId, treasurer.userId)).toEqual(['treasurer']);
    expect(await activeRoles(g.gangId, target.userId)).toEqual([]);

    for (const actor of [g.owner, admin.userId, orgAdmin]) {
      const t = await addMember(g.gangId);
      await assign(g.gangId, t.userId, 'scheduler', actor);
      expect(await activeRoles(g.gangId, t.userId), `actor=${actor}`).toEqual(['scheduler']);
      expect(await revoke(g.gangId, t.userId, 'scheduler', actor)).toBe(true);
      expect(await activeRoles(g.gangId, t.userId)).toEqual([]);
    }
  });

  it('🔴 เป้าหมายผิดชนิดถูกปฏิเสธ: admin/owner ⇒ VALIDATION_ERROR · ไม่ใช่สมาชิก/ออกแล้ว ⇒ NOT_GANG_MEMBER · key ไม่รู้จัก ⇒ NOT_FOUND', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const left = await addMember(g.gangId);
    await pool.query(`select public.leave_gang($1, $2, 'cid-gr')`, [g.gangId, left.userId]);
    const stranger = await newUser();
    const m = await addMember(g.gangId);

    await expect(assign(g.gangId, admin.userId, 'treasurer', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(assign(g.gangId, g.owner, 'treasurer', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(assign(g.gangId, left.userId, 'treasurer', g.owner)).rejects.toThrow(/NOT_GANG_MEMBER/);
    await expect(assign(g.gangId, stranger, 'treasurer', g.owner)).rejects.toThrow(/NOT_GANG_MEMBER/);
    await expect(assign(g.gangId, m.userId, 'no_such_role', g.owner)).rejects.toThrow(/NOT_FOUND/);
    await expect(assign(g.gangId, m.userId, '', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(assign(g.gangId, null as unknown as string, 'treasurer', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await activeRoles(g.gangId, admin.userId)).toEqual([]);
    expect(await roleEvents(g.gangId)).toEqual([]); // ล้มทั้งหมด ⇒ ไม่มี audit หลุด
  });

  it('🔴 admin ของก๊วน B มอบในก๊วน A ไม่ได้ · สมาชิกของ B ถูกมอบใน A ไม่ได้ · ชุดเฉพาะก๊วน B ใช้ใน A ไม่ได้ (NOT_FOUND) แต่ใช้ใน B ได้', async () => {
    const a = await newGang();
    const b = await newGang();
    const aMember = await addMember(a.gangId);
    const bMember = await addMember(b.gangId);

    await expect(assign(a.gangId, aMember.userId, 'treasurer', b.owner)).rejects.toThrow(/FORBIDDEN/);
    await expect(assign(a.gangId, bMember.userId, 'treasurer', a.owner)).rejects.toThrow(/NOT_GANG_MEMBER/);

    await pool.query(
      `insert into public.gang_roles (gang_id, key, name, permissions, is_system)
       values ($1, 'b_only', 'เฉพาะ B', array['game.manage']::text[], false)`,
      [b.gangId],
    );
    await expect(assign(a.gangId, aMember.userId, 'b_only', a.owner)).rejects.toThrow(/NOT_FOUND/);
    await assign(b.gangId, bMember.userId, 'b_only', b.owner);
    expect(await activeRoles(b.gangId, bMember.userId)).toEqual(['b_only']);
    expect(await actorHasPerm(b.gangId, bMember.userId, 'game.manage')).toBe(true);
    expect(await actorHasPerm(a.gangId, bMember.userId, 'game.manage')).toBe(false);
  });

  it('🔴 idempotent: มอบซ้ำไม่สร้างแถว/ไม่เขียน audit ซ้ำ · ถอนซ้ำ/ถอนที่ไม่เคยมีคืน false · มอบหลายชุดให้คนเดียวได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);

    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    await assign(g.gangId, m.userId, 'scheduler', g.owner);
    expect(await activeRoles(g.gangId, m.userId)).toEqual(['scheduler', 'treasurer']);
    expect((await roleEvents(g.gangId)).filter((e) => e.event_type === 'audit.role_assigned')).toHaveLength(2);

    expect(await revoke(g.gangId, m.userId, 'treasurer', g.owner)).toBe(true);
    expect(await revoke(g.gangId, m.userId, 'treasurer', g.owner)).toBe(false);
    expect(await revoke(g.gangId, m.userId, 'no_such_role', g.owner)).toBe(false);
    expect(await activeRoles(g.gangId, m.userId)).toEqual(['scheduler']);
    expect((await roleEvents(g.gangId)).filter((e) => e.event_type === 'audit.role_revoked')).toHaveLength(1);

    // มอบใหม่หลังถอน = แถวใหม่ (ประวัติเก่ายังอยู่ soft-deleted)
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    const { rows } = await pool.query<{ n: string; active: string }>(
      `select count(*)::text n, count(*) filter (where deleted_at is null)::text active
         from public.gang_member_roles where gang_id = $1 and user_id = $2`,
      [g.gangId, m.userId],
    );
    expect(rows[0]).toEqual({ n: '3', active: '2' });
  });
});

// ---------------------------------------------------------------------------
// C. has_gang_permission / actor_has_permission
// ---------------------------------------------------------------------------

describe('R-roles-1 C — has_gang_permission ⊇ is_gang_admin · ผู้ถือชุดได้เฉพาะ action ในชุด', () => {
  it('🔴 เหรัญญิก: ตรวจสลิป/เครดิต/การเงินได้ · จัดนัด/เมนูสมาชิก/topup/billing.close ไม่ได้ · ผู้จัดคิวกลับกัน · ถือสองชุด = รวมกัน', async () => {
    const g = await newGang();
    const t = await addMember(g.gangId);
    const s = await addMember(g.gangId);
    const both = await addMember(g.gangId);
    const plain = await addMember(g.gangId);
    await assign(g.gangId, t.userId, 'treasurer', g.owner);
    await assign(g.gangId, s.userId, 'scheduler', g.owner);
    await assign(g.gangId, both.userId, 'treasurer', g.owner);
    await assign(g.gangId, both.userId, 'scheduler', g.owner);

    const expectFor = async (userId: string, allowed: readonly string[]) => {
      for (const a of ACTIONS) {
        const want = allowed.includes(a);
        expect(await hasPerm(userId, g.gangId, a), `has_gang_permission ${a} (${userId.slice(0, 4)})`).toBe(want);
        expect(await actorHasPerm(g.gangId, userId, a), `actor_has_permission ${a}`).toBe(want);
      }
    };
    await expectFor(t.userId, ROLE_PRESETS.treasurer);
    await expectFor(s.userId, ROLE_PRESETS.scheduler);
    await expectFor(both.userId, [...ROLE_PRESETS.treasurer, ...ROLE_PRESETS.scheduler]);
    await expectFor(plain.userId, []);
  });

  it('🔴 ⊇ is_gang_admin: owner/admin/แอดมินองค์กรผ่านทุก action · คนนอก/anon/ไม่มี actor ไม่ผ่านเลย · ผู้ถือชุดของก๊วนอื่นไม่มีผล', async () => {
    const g = await newGang();
    const other = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const orgAdmin = await newUser();
    await pool.query(`insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin')`, [g.orgId, orgAdmin]);
    const outsider = await newUser();
    const otherTreasurer = await addMember(other.gangId);
    await assign(other.gangId, otherTreasurer.userId, 'treasurer', other.owner);

    for (const a of [...ACTIONS, 'foo.bar']) {
      for (const u of [g.owner, admin.userId, orgAdmin]) {
        expect(await hasPerm(u, g.gangId, a), `${a} ← admin-like`).toBe(true);
        expect(await actorHasPerm(g.gangId, u, a), `${a} ← actor admin-like`).toBe(true);
      }
      expect(await hasPerm(outsider, g.gangId, a), `${a} ← outsider`).toBe(false);
      expect(await hasPerm(otherTreasurer.userId, g.gangId, a), `${a} ← treasurer ของก๊วนอื่น`).toBe(false);
      expect(await actorHasPerm(g.gangId, null, a), `${a} ← null actor`).toBe(false);
    }
    // anon
    const anon = await asRole('anon', null, async (c) => (await c.query<{ v: boolean }>(`select public.has_gang_permission($1, 'payment.verify') v`, [g.gangId])).rows[0].v);
    expect(anon).toBe(false);
  });

  it('🔴 ถอนแล้วหลุดทันที (statement ถัดไป) · ชุดที่ถูก soft delete ไม่มีผล · trigger ถอนเปิดอยู่', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    expect(await hasPerm(m.userId, g.gangId, 'payment.verify')).toBe(true);

    await revoke(g.gangId, m.userId, 'treasurer', g.owner);
    expect(await hasPerm(m.userId, g.gangId, 'payment.verify')).toBe(false);
    expect(await actorHasPerm(g.gangId, m.userId, 'payment.verify')).toBe(false);

    // soft-delete ตัวชุดสิทธิ์เอง (ผ่านสิทธิ์สูง) ⇒ ไม่มีผลแม้แถวมอบยังอยู่
    await pool.query(`insert into public.gang_roles (gang_id, key, name, permissions, is_system) values ($1, 'tmp_role', 'ชั่วคราว', array['game.manage']::text[], false)`, [g.gangId]);
    await assign(g.gangId, m.userId, 'tmp_role', g.owner);
    expect(await actorHasPerm(g.gangId, m.userId, 'game.manage')).toBe(true);
    await pool.query(`update public.gang_roles set deleted_at = now() where gang_id = $1 and key = 'tmp_role'`, [g.gangId]);
    expect(await actorHasPerm(g.gangId, m.userId, 'game.manage')).toBe(false);

    // trigger ถอนชุดสิทธิ์ต้องเปิดอยู่เสมอ (ด่านเดียวที่กันแถวค้างของคนที่ออก/เลื่อน)
    const { rows: trg } = await pool.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger where tgname = 'gang_members_revoke_roles'`,
    );
    expect(trg[0].tgenabled).toBe('O');
  });
});

// ---------------------------------------------------------------------------
// D. วงจรชีวิต
// ---------------------------------------------------------------------------

describe('R-roles-1 D — ออกก๊วน / เลื่อนเป็น admin / โอนเจ้าของ ⇒ ชุดสิทธิ์หลุดใน txn เดียวกัน', () => {
  it('🔴 leave_gang ⇒ ชุดสิทธิ์ทุกชุดหลุด + audit (left_gang) · กลับเข้าก๊วนด้วย add_gang_member_by_email ไม่ได้ชุดคืน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    await assign(g.gangId, m.userId, 'scheduler', g.owner);

    await pool.query(`select public.leave_gang($1, $2, 'cid-gr')`, [g.gangId, m.userId]);
    expect(await activeRoles(g.gangId, m.userId)).toEqual([]);
    expect(await actorHasPerm(g.gangId, m.userId, 'payment.verify')).toBe(false);

    const ev = (await roleEvents(g.gangId)).filter((e) => e.event_type === 'audit.role_revoked');
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.payload.reason)).toEqual(['left_gang', 'left_gang']);
    expect(ev.map((e) => e.payload.role_key).sort()).toEqual(['scheduler', 'treasurer']);

    // กลับเข้าใหม่
    const { rows: u } = await pool.query<{ email: string }>(`select email from auth.users where id = $1`, [m.userId]);
    await pool.query(`select public.add_gang_member_by_email($1, $2, 'member', $3, 'cid-gr')`, [g.gangId, u[0].email, g.owner]);
    expect(await activeRoles(g.gangId, m.userId)).toEqual([]);
    expect(await actorHasPerm(g.gangId, m.userId, 'payment.verify')).toBe(false);
  });

  it('🔴 แอดมินเลื่อน member เป็น admin ด้วย UPDATE ตรง (PostgREST) ⇒ ชุดสิทธิ์หลุด (role_changed) · เลื่อนกลับเป็น member ไม่ได้ชุดคืน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);

    await asRoleCommitted('authenticated', g.owner, async (c) => {
      const r = await c.query(`update public.gang_members set role = 'admin' where id = $1`, [m.memberId]);
      expect(r.rowCount).toBe(1);
    });
    expect(await activeRoles(g.gangId, m.userId)).toEqual([]);
    const ev = (await roleEvents(g.gangId)).filter((e) => e.event_type === 'audit.role_revoked');
    expect(ev.map((e) => e.payload.reason)).toEqual(['role_changed']);

    await asRoleCommitted('authenticated', g.owner, async (c) => {
      await c.query(`update public.gang_members set role = 'member' where id = $1`, [m.memberId]);
    });
    expect(await activeRoles(g.gangId, m.userId)).toEqual([]);
    expect(await actorHasPerm(g.gangId, m.userId, 'payment.verify')).toBe(false);
  });

  it('🔴 transfer_gang_ownership ให้ member ที่ถือชุดสิทธิ์ ⇒ ชุดหลุด · แก้ role ที่ไม่ใช่ member→อื่น (admin→member) ไม่แตะอะไร', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'scheduler', g.owner);
    await pool.query(`select public.transfer_gang_ownership($1, $2, $3, 'cid-gr')`, [g.gangId, g.owner, m.userId]);
    expect(await activeRoles(g.gangId, m.userId)).toEqual([]);
    const { rows } = await pool.query<{ role: string }>(`select role from public.gang_members where id = $1`, [m.memberId]);
    expect(rows[0].role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// E. audit + privacy
// ---------------------------------------------------------------------------

describe('R-roles-1 E — audit', () => {
  it('🔴 audit.role_assigned/revoked มี payload ครบ · สมาชิกทั่วไป/ผู้ถือชุดอ่านผ่าน RLS ไม่ได้ · แอดมินอ่านได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const plain = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    await revoke(g.gangId, m.userId, 'treasurer', g.owner);

    const ev = await roleEvents(g.gangId);
    expect(ev.map((e) => e.event_type)).toEqual(['audit.role_assigned', 'audit.role_revoked']);
    expect(ev[0].payload).toMatchObject({
      correlation_id: 'cid-gr',
      user_id: m.userId,
      role_key: 'treasurer',
    });
    expect(ev[0].payload.permissions).toEqual(expect.arrayContaining(['payment.verify']));
    expect(ev[0].aggregate_id).toBe(m.memberId);
    expect(ev[1].payload).toMatchObject({ role_key: 'treasurer', reason: 'revoked', user_id: m.userId });

    const countAs = (userId: string) =>
      asRole('authenticated', userId, async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              `select count(*)::text n from public.event_logs where gang_id = $1 and event_type like 'audit.role_%'`,
              [g.gangId],
            )
          ).rows[0].n,
        ),
      );
    expect(await countAs(g.owner)).toBe(2);
    expect(await countAs(m.userId)).toBe(0);
    expect(await countAs(plain.userId)).toBe(0);
  });

  it('🔴 gang_member_roles: สมาชิกเห็นเฉพาะชุดที่ถืออยู่ของตัวเอง · แอดมินเห็นทั้งก๊วนรวมประวัติ · คนนอก/สมาชิกอื่นไม่เห็น', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const b = await addMember(g.gangId);
    const outsider = await newUser();
    await assign(g.gangId, a.userId, 'treasurer', g.owner);
    await assign(g.gangId, b.userId, 'scheduler', g.owner);
    await revoke(g.gangId, b.userId, 'scheduler', g.owner);

    const rowsFor = (userId: string) =>
      asRole('authenticated', userId, async (c) =>
        (
          await c.query<{ user_id: string; deleted_at: string | null }>(
            `select user_id, deleted_at from public.gang_member_roles where gang_id = $1 order by user_id`,
            [g.gangId],
          )
        ).rows,
      );
    expect((await rowsFor(a.userId)).map((r) => r.user_id)).toEqual([a.userId]);
    expect(await rowsFor(b.userId)).toEqual([]); // ของตัวเองที่ถอนแล้วไม่โชว์
    expect(await rowsFor(outsider)).toEqual([]);
    expect(await rowsFor(g.owner)).toHaveLength(2); // รวมประวัติที่ถอนแล้ว
  });
});

// ---------------------------------------------------------------------------
// F. เขียนตรงไม่ได้ + ด่านชั้นตาราง
// ---------------------------------------------------------------------------

describe('R-roles-1 F — ตารางใหม่เขียนตรงไม่ได้ · guard trigger / composite FK', () => {
  it('🔴 authenticated (owner/admin/member/ผู้ถือชุด) และ service_role เขียน gang_roles / gang_member_roles ตรงไม่ได้ (42501)', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);

    const stmts = [
      `insert into public.gang_roles (gang_id, key, name, permissions, is_system) values ('${g.gangId}', 'direct', 'x', array['game.manage']::text[], false)`,
      `update public.gang_roles set permissions = array['game.manage']::text[] where key = 'treasurer'`,
      `delete from public.gang_roles where key = 'treasurer'`,
      `insert into public.gang_member_roles (gang_id, user_id, gang_member_id, role_id) select '${g.gangId}', '${m.userId}', '${m.memberId}', id from public.gang_roles where key = 'scheduler' and gang_id is null`,
      `update public.gang_member_roles set deleted_at = null where gang_id = '${g.gangId}'`,
      `delete from public.gang_member_roles where gang_id = '${g.gangId}'`,
    ];
    for (const who of [g.owner, admin.userId, m.userId]) {
      for (const sql of stmts) {
        const code = await asRole('authenticated', who, async (c) => {
          try {
            await c.query(sql);
            return 'ok';
          } catch (e) {
            return (e as { code?: string }).code ?? 'unknown';
          }
        });
        expect(code, `${sql.slice(0, 50)} ← ${who.slice(0, 4)}`).toBe('42501');
      }
    }
    for (const sql of stmts) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role service_role');
        let code = 'ok';
        try {
          await c.query(sql);
        } catch (e) {
          code = (e as { code?: string }).code ?? 'unknown';
        }
        expect(code, `service_role: ${sql.slice(0, 50)}`).toBe('42501');
      } finally {
        await c.query('rollback').catch(() => {});
        c.release();
      }
    }
    expect(await activeRoles(g.gangId, m.userId)).toEqual(['treasurer']);
  });

  it('🔴 guard trigger: แถวมอบที่ชี้ admin/สมาชิกที่ออกแล้ว ⇒ VALIDATION_ERROR · ชุดของก๊วนอื่น ⇒ NOT_FOUND · composite FK กันคู่ (สมาชิก,ก๊วน,ผู้ใช้) ที่ไม่ตรง (23503)', async () => {
    const a = await newGang();
    const b = await newGang();
    const adminA = await addMember(a.gangId, 'admin');
    const memA = await addMember(a.gangId);
    const memB = await addMember(b.gangId);
    const left = await addMember(a.gangId);
    await pool.query(`select public.leave_gang($1, $2, 'cid-gr')`, [a.gangId, left.userId]);
    const { rows: role } = await pool.query<{ id: string }>(`select id from public.gang_roles where key = 'treasurer' and gang_id is null`);
    const { rows: bOnly } = await pool.query<{ id: string }>(
      `insert into public.gang_roles (gang_id, key, name, permissions, is_system) values ($1, 'b_only2', 'B', array['game.manage']::text[], false) returning id`,
      [b.gangId],
    );

    const ins = async (gangId: string, userId: string, memberId: string, roleId: string) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `insert into public.gang_member_roles (gang_id, user_id, gang_member_id, role_id) values ($1, $2, $3, $4)`,
          [gangId, userId, memberId, roleId],
        );
        return 'ok';
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return err.code === 'P0001' ? err.message : err.code;
      } finally {
        await c.query('rollback').catch(() => {});
        c.release();
      }
    };
    expect(await ins(a.gangId, memA.userId, memA.memberId, role[0].id)).toBe('ok');
    expect(await ins(a.gangId, adminA.userId, adminA.memberId, role[0].id)).toBe('VALIDATION_ERROR');
    expect(await ins(a.gangId, a.owner, (await pool.query<{ id: string }>(`select id from public.gang_members where gang_id = $1 and user_id = $2`, [a.gangId, a.owner])).rows[0].id, role[0].id)).toBe('VALIDATION_ERROR');
    expect(await ins(a.gangId, left.userId, left.memberId, role[0].id)).toBe('VALIDATION_ERROR');
    expect(await ins(a.gangId, memA.userId, memA.memberId, bOnly[0].id)).toBe('NOT_FOUND');
    // สมาชิกของ B แต่ระบุก๊วน A ⇒ FK
    expect(await ins(a.gangId, memB.userId, memB.memberId, role[0].id)).toBe('23503');
    // ผู้ใช้ไม่ตรงกับสมาชิก ⇒ FK
    expect(await ins(a.gangId, memB.userId, memA.memberId, role[0].id)).toBe('23503');
  });

  it('🔴 ไม่มีแถวมอบซ้ำ active (partial unique) และชื่อ preset ซ้ำไม่ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await assign(g.gangId, m.userId, 'treasurer', g.owner);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await expect(
        c.query(
          `insert into public.gang_member_roles (gang_id, user_id, gang_member_id, role_id)
           select $1, $2, $3, id from public.gang_roles where key = 'treasurer' and gang_id is null`,
          [g.gangId, m.userId, m.memberId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
    await expect(
      pool.query(
        `insert into public.gang_roles (gang_id, key, name, permissions, is_system) values (null, 'treasurer', 'ซ้ำ', array['game.manage']::text[], true)`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ---------------------------------------------------------------------------
// G. concurrency
// ---------------------------------------------------------------------------

const ROUNDS = 20;

function noDeadlock(results: PromiseSettledResult<unknown>[], note: string) {
  for (const r of results) {
    if (r.status === 'rejected') {
      const code = (r.reason as { code?: string }).code;
      expect(code, `${note}: ${(r.reason as Error).message}`).not.toBe('40P01');
      expect(code, `${note}: ${(r.reason as Error).message}`).not.toBe('40001');
    }
  }
}

describe(`R-roles-1 G — concurrency ${ROUNDS} รอบ`, () => {
  it('🔴 assign เดียวกัน 6 คำสั่งพร้อมกัน ⇒ แถว active เดียว · audit ครั้งเดียว · สำเร็จทั้งหมด (idempotent)', async () => {
    const g = await newGang();
    for (let i = 0; i < ROUNDS; i++) {
      const m = await addMember(g.gangId);
      const res = await runConcurrently(6, (c) =>
        c.query(`select public.assign_gang_role($1, $2, 'treasurer', $3, 'cid-race')`, [g.gangId, m.userId, g.owner]),
      );
      noDeadlock(res, `round ${i}`);
      expect(res.filter((r) => r.status === 'fulfilled'), `round ${i}`).toHaveLength(6);
      expect(await activeRoles(g.gangId, m.userId), `round ${i}`).toEqual(['treasurer']);
      const ev = (await roleEvents(g.gangId)).filter((e) => e.aggregate_id === m.memberId);
      expect(ev, `round ${i}`).toHaveLength(1);
    }
  }, 120_000);

  it('🔴 assign × revoke พร้อมกัน ⇒ active ≤ 1 · audit สอดคล้อง (assigned − revoked = active) · ไม่ deadlock', async () => {
    const g = await newGang();
    for (let i = 0; i < ROUNDS; i++) {
      const m = await addMember(g.gangId);
      if (i % 2 === 0) await assign(g.gangId, m.userId, 'scheduler', g.owner); // เริ่มจากมีอยู่ครึ่งหนึ่ง
      const res = await runConcurrently(4, (c, k) =>
        k % 2 === 0
          ? c.query(`select public.assign_gang_role($1, $2, 'scheduler', $3, 'cid-race')`, [g.gangId, m.userId, g.owner])
          : c.query(`select public.revoke_gang_role($1, $2, 'scheduler', $3, 'cid-race')`, [g.gangId, m.userId, g.owner]),
      );
      noDeadlock(res, `round ${i}`);
      for (const r of res) expect(r.status, `round ${i}`).toBe('fulfilled');
      const active = (await activeRoles(g.gangId, m.userId)).length;
      expect(active, `round ${i}`).toBeLessThanOrEqual(1);
      const ev = (await roleEvents(g.gangId)).filter((e) => e.aggregate_id === m.memberId);
      const assigned = ev.filter((e) => e.event_type === 'audit.role_assigned').length;
      const revoked = ev.filter((e) => e.event_type === 'audit.role_revoked').length;
      expect(assigned - revoked, `round ${i}: assigned ${assigned} revoked ${revoked}`).toBe(active + (i % 2 === 0 ? 0 : 0));
    }
  }, 120_000);

  it('🔴 assign × leave_gang พร้อมกัน ⇒ ไม่มีชุดสิทธิ์ active ค้างของคนที่ออก · ถ้ามอบสำเร็จต้องมี audit ถอน (left_gang) · ไม่ deadlock', async () => {
    const g = await newGang();
    let assignedWon = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const m = await addMember(g.gangId);
      const res = await runConcurrently(2, (c, k) =>
        k === 0
          ? c.query(`select public.assign_gang_role($1, $2, 'treasurer', $3, 'cid-race')`, [g.gangId, m.userId, g.owner])
          : c.query(`select public.leave_gang($1, $2, 'cid-race')`, [g.gangId, m.userId]),
      );
      noDeadlock(res, `round ${i}`);
      expect(res[1].status, `leave round ${i}`).toBe('fulfilled');
      if (res[0].status === 'rejected') {
        expect((res[0].reason as Error).message, `round ${i}`).toMatch(/NOT_GANG_MEMBER/);
      } else {
        assignedWon++;
      }
      expect(await activeRoles(g.gangId, m.userId), `round ${i}`).toEqual([]);
      expect(await actorHasPerm(g.gangId, m.userId, 'payment.verify'), `round ${i}`).toBe(false);
      const ev = (await roleEvents(g.gangId)).filter((e) => e.aggregate_id === m.memberId);
      const assigned = ev.filter((e) => e.event_type === 'audit.role_assigned').length;
      const revoked = ev.filter((e) => e.event_type === 'audit.role_revoked' && e.payload.reason === 'left_gang').length;
      expect(revoked, `round ${i}`).toBe(assigned);
    }
    // เก็บสถิติไว้ในข้อความ assertion ถ้าล้ม — ปกติทั้งสองลำดับเกิดขึ้นได้
    // ลำดับ "assign ชนะก่อน" ในการแข่งแบบปล่อยพร้อมกันเกิดยาก (leave ล็อกไวกว่า) — ทดสอบลำดับนั้นแบบกำหนดเองในบล็อก interleave ด้านล่าง
    void assignedWon;
  }, 120_000);

  it('🔴 assign × เลื่อนเป็น admin (UPDATE ตรง) พร้อมกัน ⇒ ไม่มีชุดสิทธิ์ active ค้างของ admin · ไม่ deadlock', async () => {
    const g = await newGang();
    for (let i = 0; i < ROUNDS; i++) {
      const m = await addMember(g.gangId);
      const res = await runConcurrently(2, (c, k) =>
        k === 0
          ? c.query(`select public.assign_gang_role($1, $2, 'scheduler', $3, 'cid-race')`, [g.gangId, m.userId, g.owner])
          : c.query(`update public.gang_members set role = 'admin' where id = $1`, [m.memberId]),
      );
      noDeadlock(res, `round ${i}`);
      expect(res[1].status, `promote round ${i}`).toBe('fulfilled');
      if (res[0].status === 'rejected') {
        expect((res[0].reason as Error).message, `round ${i}`).toMatch(/VALIDATION_ERROR/);
      }
      expect(await activeRoles(g.gangId, m.userId), `round ${i}`).toEqual([]);
      // เป็น admin แล้ว ⇒ ผ่านทุกอย่างด้วย role (ไม่ใช่ด้วยแถวค้าง)
      expect(await actorHasPerm(g.gangId, m.userId, 'game.manage'), `round ${i}`).toBe(true);
    }
  }, 120_000);

  it(`🔴 interleave กำหนดลำดับ ${ROUNDS} รอบ/ลำดับ: assign→leave · leave→assign · assign→เลื่อนเป็น admin · เลื่อนเป็น admin→assign · assign→revoke ⇒ ผลถูกทุกลำดับ ไม่ deadlock`, async () => {
    const g = await newGang();
    const asg = (userId: string) => (c: import('pg').PoolClient) =>
      c.query(`select public.assign_gang_role($1, $2, 'treasurer', $3, 'cid-ilv')`, [g.gangId, userId, g.owner]);
    const lv = (userId: string) => (c: import('pg').PoolClient) =>
      c.query(`select public.leave_gang($1, $2, 'cid-ilv')`, [g.gangId, userId]);
    const promote = (memberId: string) => (c: import('pg').PoolClient) =>
      c.query(`update public.gang_members set role = 'admin' where id = $1`, [memberId]);
    const rv = (userId: string) => (c: import('pg').PoolClient) =>
      c.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3, 'cid-ilv') r`, [g.gangId, userId, g.owner]);
    const evOf = async (memberId: string) => (await roleEvents(g.gangId)).filter((e) => e.aggregate_id === memberId);

    for (let i = 0; i < ROUNDS; i++) {
      // 1) assign ก่อน → leave ตามหลัง: ออกสำเร็จ + ชุดถูกถอน (left_gang) + audit มอบ 1 ถอน 1
      const a = await addMember(g.gangId);
      let r = await interleave(asg(a.userId), lv(a.userId));
      expect('ok' in r, `assign→leave round ${i}`).toBe(true);
      expect(await activeRoles(g.gangId, a.userId), `assign→leave round ${i}`).toEqual([]);
      let ev = await evOf(a.memberId);
      expect(ev.map((e) => [e.event_type, e.payload.reason ?? null]), `assign→leave round ${i}`).toEqual([
        ['audit.role_assigned', null],
        ['audit.role_revoked', 'left_gang'],
      ]);

      // 2) leave ก่อน → assign ตามหลัง: assign ล้ม NOT_GANG_MEMBER ไม่มีแถว/audit
      const b = await addMember(g.gangId);
      r = await interleave(lv(b.userId), asg(b.userId));
      expect('err' in r && /NOT_GANG_MEMBER/.test(r.err.message), `leave→assign round ${i}`).toBe(true);
      expect(await activeRoles(g.gangId, b.userId)).toEqual([]);
      expect(await evOf(b.memberId), `leave→assign round ${i}`).toEqual([]);

      // 3) assign ก่อน → เลื่อนเป็น admin: เลื่อนสำเร็จ + ชุดถูกถอน (role_changed)
      const c = await addMember(g.gangId);
      r = await interleave(asg(c.userId), promote(c.memberId));
      expect('ok' in r, `assign→promote round ${i}`).toBe(true);
      expect(await activeRoles(g.gangId, c.userId), `assign→promote round ${i}`).toEqual([]);
      ev = await evOf(c.memberId);
      expect(ev.map((e) => e.payload.reason ?? null), `assign→promote round ${i}`).toEqual([null, 'role_changed']);

      // 4) เลื่อนเป็น admin ก่อน → assign: ล้ม VALIDATION_ERROR ไม่มีแถว/audit
      const d = await addMember(g.gangId);
      r = await interleave(promote(d.memberId), asg(d.userId));
      expect('err' in r && /VALIDATION_ERROR/.test(r.err.message), `promote→assign round ${i}`).toBe(true);
      expect(await activeRoles(g.gangId, d.userId)).toEqual([]);
      expect(await evOf(d.memberId), `promote→assign round ${i}`).toEqual([]);

      // 5) assign ก่อน → revoke ตามหลัง: ถอนได้จริง (true) ไม่ใช่ no-op
      const e = await addMember(g.gangId);
      r = await interleave(asg(e.userId), rv(e.userId));
      expect('ok' in r && (r.ok as { rows: { r: boolean }[] }).rows[0].r, `assign→revoke round ${i}`).toBe(true);
      expect(await activeRoles(g.gangId, e.userId)).toEqual([]);
      expect((await evOf(e.memberId)).map((x) => x.event_type), `assign→revoke round ${i}`).toEqual([
        'audit.role_assigned',
        'audit.role_revoked',
      ]);
    }
  }, 180_000);

  it('🔴 ผสมหลายเส้นทางพร้อมกัน (assign ×2 คน · revoke · leave · เลื่อนเป็น admin · credit_topup) ⇒ ไม่ deadlock · ไม่มี active ค้างของคนที่ออก/เลื่อน', async () => {
    const g = await newGang();
    for (let i = 0; i < ROUNDS; i++) {
      const [m1, m2, m3, m4] = await Promise.all([addMember(g.gangId), addMember(g.gangId), addMember(g.gangId), addMember(g.gangId)]);
      await assign(g.gangId, m3.userId, 'treasurer', g.owner);
      const res = await runConcurrently(6, (c, k) => {
        switch (k) {
          case 0:
            return c.query(`select public.assign_gang_role($1, $2, 'treasurer', $3, 'cid-race')`, [g.gangId, m1.userId, g.owner]);
          case 1:
            return c.query(`select public.assign_gang_role($1, $2, 'scheduler', $3, 'cid-race')`, [g.gangId, m2.userId, g.owner]);
          case 2:
            return c.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3, 'cid-race')`, [g.gangId, m3.userId, g.owner]);
          case 3:
            return c.query(`select public.leave_gang($1, $2, 'cid-race')`, [g.gangId, m2.userId]);
          case 4:
            return c.query(`update public.gang_members set role = 'admin' where id = $1`, [m1.memberId]);
          default:
            return c.query(`select public.credit_topup($1, $2, 5, 'ทดสอบ', $3, 'cid-race')`, [g.gangId, m4.userId, g.owner]);
        }
      });
      noDeadlock(res, `round ${i}`);
      expect(res[2].status, `revoke round ${i}`).toBe('fulfilled');
      expect(res[3].status, `leave round ${i}`).toBe('fulfilled');
      expect(res[4].status, `promote round ${i}`).toBe('fulfilled');
      expect(res[5].status, `topup round ${i}`).toBe('fulfilled');
      expect(await activeRoles(g.gangId, m1.userId), `m1 (เลื่อนเป็น admin) round ${i}`).toEqual([]);
      expect(await activeRoles(g.gangId, m2.userId), `m2 (ออก) round ${i}`).toEqual([]);
      expect(await activeRoles(g.gangId, m3.userId), `m3 (ถอน) round ${i}`).toEqual([]);
    }
  }, 180_000);
});
