/**
 * WO-1.4 — เทสต์ที่ปิดช่องโหว่ซึ่ง WO-1.3 เปิดค้างไว้
 *
 * ทั้ง 4 ข้อนี้ถูกจดไว้ใน BACKLOG ตอนจบ WO-1.3 ว่า "RLS ต้องมาปิด"
 * มีเทสต์ตรงนี้เพื่อกันถอยหลัง — ถ้าวันหนึ่งมีคนเผลอ grant เพิ่ม เทสต์จะแดงทันที
 *
 *   1. EXECUTE grant ของ DB functions เปิดโล่งให้ anon
 *   2. GUC guard คุมเฉพาะ UPDATE ไม่คุม INSERT (insert นัดที่ status = 'settled' ได้)
 *   3. (transition_payment ยังไม่มี — เป็นงาน Phase 2 ไม่ได้ปิดใน WO นี้)
 *   4. waitlist → confirmed ตรงๆ ยังทำได้เพราะไม่มีอะไรกันการเขียน registrations
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  asRole,
  createFixture,
  createUser,
  addGangMember,
  registrationsOf,
  reloadPostgrestSchema,
} from '../helpers/db';

/** ทำงานแล้วคืน error code ของ Postgres (undefined = สำเร็จ) */
async function attempt(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  role: 'anon' | 'authenticated' = 'authenticated',
): Promise<string | undefined> {
  try {
    await asRole(role, userId, (c) => c.query(sql, params));
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('WO-1.4 — ช่องโหว่ที่ WO-1.3 เปิดค้างไว้ ต้องถูกปิด', () => {
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let gangId: string;
  let sessionId: string;

  beforeAll(async () => {
    await reloadPostgrestSchema();

    ownerId = await createUser('wg-owner');
    const fx = await createFixture({ ownerId, maxPlayers: 2 });
    gangId = fx.gangId;
    sessionId = fx.sessionId;

    await pool.query(
      `insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')`,
      [fx.orgId, ownerId],
    );
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'owner')`,
      [gangId, ownerId],
    );

    memberId = await createUser('wg-member');
    await addGangMember(gangId, memberId);

    outsiderId = await createUser('wg-outsider');
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  it('ช่องโหว่ 1. anon/authenticated เรียก DB functions ตรงๆ ไม่ได้แล้ว', async () => {
    const fns: [string, string, unknown[]][] = [
      ['register_to_session', 'select public.register_to_session($1, $2)', [sessionId, memberId]],
      ['transition_session', 'select public.transition_session($1, $2)', [sessionId, 'open']],
      [
        'close_session_with_charges',
        `select public.close_session_with_charges($1, '[]'::jsonb, 'open')`,
        [sessionId],
      ],
      ['claim_notifications', 'select * from public.claim_notifications(1)', []],
      [
        'check_rate_limit',
        `select public.check_rate_limit('k', 1, interval '1 hour')`,
        [],
      ],
    ];

    const leaked: string[] = [];
    for (const [name, sql, params] of fns) {
      for (const role of ['anon', 'authenticated'] as const) {
        const code = await attempt(role === 'anon' ? null : memberId, sql, params, role);
        // 42501 = insufficient_privilege (เรียกฟังก์ชันไม่ได้)
        if (code !== '42501') leaked.push(`${name} (${role}) → ${code ?? 'สำเร็จ!'}`);
      }
    }
    expect(leaked, `ฟังก์ชันที่ยังเรียกได้จาก client:\n${leaked.join('\n')}`).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  it('ช่องโหว่ 2. insert นัดใหม่ด้วย status นอก draft ไม่ได้แล้ว', async () => {
    const insertSql = `insert into public.sessions
        (gang_id, title, starts_at, ends_at, max_players, status)
      values ($1, 'ลอง', now() + interval '1 day', now() + interval '1 day 2 hours', 4, $2)`;

    // แอดมินสร้างนัดใหม่ได้ แต่ต้องเริ่มที่ draft เท่านั้น
    expect(await attempt(ownerId, insertSql, [gangId, 'draft'])).toBeUndefined();

    // 🔴 ข้ามไปสถานะปลายทางตรงๆ ไม่ได้ (42501 = RLS with check ไม่ผ่าน)
    const blocked: string[] = [];
    for (const status of ['open', 'in_play', 'billing', 'settled', 'archived', 'cancelled']) {
      const code = await attempt(ownerId, insertSql, [gangId, status]);
      if (code !== '42501') blocked.push(`${status} → ${code ?? 'สำเร็จ!'}`);
    }
    expect(blocked, `status ที่ยัง insert ตรงได้:\n${blocked.join('\n')}`).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  it('ช่องโหว่ 4. เขียน session_registrations ตรงๆ ไม่ได้ — waitlist → confirmed ต้องผ่านฟังก์ชัน', async () => {
    // เตรียมสถานการณ์: max_players = 2, มี 2 confirmed + 1 waitlist
    const users: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await createUser(`wg-player-${i}`);
      await addGangMember(gangId, u);
      users.push(u);
      await pool.query('select public.register_to_session($1, $2)', [sessionId, u]);
    }

    const waiting = (await registrationsOf(sessionId)).find((r) => r.status === 'waitlist')!;
    expect(waiting).toBeDefined();

    // 🔴 คนที่รออยู่ พยายามดันตัวเองเป็น confirmed
    expect(
      await attempt(
        waiting.user_id,
        `update public.session_registrations set status = 'confirmed' where id = $1`,
        [waiting.id],
      ),
    ).toBe('42501');

    // แม้แต่แอดมินก๊วนก็ทำไม่ได้ — ต้องผ่าน promote_waitlist() เท่านั้น
    expect(
      await attempt(
        ownerId,
        `update public.session_registrations set status = 'confirmed' where id = $1`,
        [waiting.id],
      ),
    ).toBe('42501');

    // แทรกแถวใหม่เองก็ไม่ได้ (จะข้ามการนับที่ว่าง)
    expect(
      await attempt(
        ownerId,
        `insert into public.session_registrations (session_id, user_id, status)
         values ($1, $2, 'confirmed')`,
        [sessionId, outsiderId],
      ),
    ).toBe('42501');

    // สถานะจริงต้องไม่ขยับ
    const after = await registrationsOf(sessionId);
    expect(after.find((r) => r.id === waiting.id)!.status).toBe('waitlist');
    expect(after.filter((r) => r.status === 'confirmed')).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  it('สมาชิกธรรมดาแก้ตั้งค่าก๊วนไม่ได้ — เฉพาะแอดมิน', async () => {
    // สมาชิกธรรมดา
    await asRole('authenticated', memberId, async (c) => {
      const r = await c.query(`update public.gangs set name = 'โดนแฮก' where id = $1`, [gangId]);
      expect(r.rowCount, 'สมาชิกธรรมดาไม่ควรแก้ก๊วนได้').toBe(0);
    });

    // คนนอกก๊วน
    await asRole('authenticated', outsiderId, async (c) => {
      const r = await c.query(`update public.gangs set name = 'โดนแฮก' where id = $1`, [gangId]);
      expect(r.rowCount).toBe(0);
    });

    // แอดมินทำได้
    await asRole('authenticated', ownerId, async (c) => {
      const r = await c.query(`update public.gangs set name = 'ชื่อใหม่' where id = $1`, [gangId]);
      expect(r.rowCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  it('🔴 [ADR-007] anon แตะตาราง gangs ไม่ได้แล้ว แม้ก๊วนนั้นเปิดสาธารณะ', async () => {
    const pubOwner = await createUser('wg-pub-owner');
    const pub = await createFixture({ ownerId: pubOwner, maxPlayers: 4 });
    await pool.query(`update public.gangs set is_public = true where id = $1`, [pub.gangId]);

    // ⚠️ เทสต์นี้เคยยืนยันว่า "anon ต้องเห็นก๊วน public" ตาม policy `gangs_select_public`
    //    ของ WO-1.4 — migration 0034 ถอด policy นั้นทิ้งตาม **ADR-007** เพราะ RLS กรอง
    //    ได้แค่แถว ทำให้ `promptpay_id` ของก๊วนสาธารณะหลุดถึงใครก็ได้ที่ถือ anon key
    //    ⇒ คนนอกอ่านก๊วนผ่าน `search_public_gangs()` เท่านั้น (ดู tests/rls/public-gang-exposure)
    expect(
      await attempt(null, `select 1 from public.gangs where id = $1`, [pub.gangId], 'anon'),
    ).toBe('42501');

    // ตารางอื่นแม้แต่ของก๊วน public ก็ต้องไม่หลุด (เหมือนเดิม)
    expect(
      await attempt(null, `select 1 from public.gang_members where gang_id = $1`, [pub.gangId], 'anon'),
    ).toBe('42501');
    expect(
      await attempt(null, `select 1 from public.sessions where gang_id = $1`, [pub.gangId], 'anon'),
    ).toBe('42501');
  });
});
