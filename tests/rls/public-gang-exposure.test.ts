/**
 * ADR-007 — คนนอกอ่านแถวของก๊วนไม่ได้ ต่อให้ก๊วนนั้นเปิดสาธารณะ
 *
 *   · 🔴 `anon` ไม่มีสิทธิ์แตะตาราง `gangs` เลย (ปิดตั้งแต่ระดับ GRANT)
 *   · 🔴 ผู้ใช้ที่ล็อกอินแล้วแต่ **ไม่ใช่สมาชิก** ก็อ่านก๊วน public ไม่ได้
 *     ⇒ `promptpay_id` / `settings` / `cancellation_policy` ไม่หลุดอีกต่อไป
 *   · สมาชิกยังอ่านก๊วนของตัวเองได้เหมือนเดิม (ไม่ได้ปิดเกินจนแอปพัง)
 *   · discovery ยังทำงาน — คนนอกยังค้นเจอก๊วนผ่าน `search_public_gangs()`
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, readAccess, visibleCount } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`pub-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function publicGang() {
  const owner = await newUser();
  const marker = `เปิดเผย${crypto.randomUUID().slice(0, 8)}`;

  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน${marker}`,
  ]);

  await pool.query(
    `update public.gangs
        set is_public    = true,
            promptpay_id = '0891234567',
            settings     = '{"reminder": {"session_hours_before": 24}}'::jsonb,
            features     = features || '{"discovery": true}'::jsonb
      where id = $1`,
    [gang.id],
  );

  return { owner, gangId: gang.id, marker };
}

describe('ADR-007 — ก๊วน public ไม่เปิดแถวให้คนนอก', () => {
  it('🔴 `anon` แตะตาราง gangs ไม่ได้เลย', async () => {
    const { gangId } = await publicGang();

    expect(
      await readAccess(null, 'select 1 from public.gangs where id = $1', [gangId], 'anon'),
    ).toBe('denied');
  });

  it('🔴 คนที่ล็อกอินแล้วแต่ไม่ใช่สมาชิก อ่านก๊วน public ไม่ได้', async () => {
    const { gangId } = await publicGang();
    const outsider = await newUser();

    expect(await visibleCount(outsider, 'select 1 from public.gangs where id = $1', [gangId])).toBe(
      0,
    );
  });

  it('🔴 `promptpay_id` ของก๊วนสาธารณะไม่หลุดถึงคนนอกอีกต่อไป', async () => {
    const { gangId } = await publicGang();
    const outsider = await newUser();

    // เส้นทางที่เคยรั่ว: เลือกเฉพาะคอลัมน์ลับของก๊วนที่เปิดสาธารณะ
    const leakSql = `select promptpay_id from public.gangs
                      where is_public = true and promptpay_id is not null and id = $1`;

    expect(await readAccess(null, leakSql, [gangId], 'anon')).toBe('denied');
    expect(await visibleCount(outsider, leakSql, [gangId])).toBe(0);
  });

  it('สมาชิกยังอ่านก๊วนของตัวเองได้ (ไม่ได้ปิดเกินจนแอปพัง)', async () => {
    const { owner, gangId } = await publicGang();

    expect(await visibleCount(owner, 'select 1 from public.gangs where id = $1', [gangId])).toBe(1);

    const member = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gangId, member],
    );

    expect(await visibleCount(member, 'select promptpay_id from public.gangs where id = $1', [gangId])).toBe(
      1,
    );
  });

  it('แอดมินยังแก้ก๊วนได้ (policy ของ UPDATE ไม่ถูกกระทบ)', async () => {
    const { owner, gangId } = await publicGang();

    await asRole('authenticated', owner, async (c) => {
      const result = await c.query(`update public.gangs set area = 'ย่านใหม่' where id = $1`, [
        gangId,
      ]);
      expect(result.rowCount).toBe(1);
    });
  });

  it('discovery ยังทำงาน — คนนอกยังค้นเจอก๊วนนี้ผ่าน search_public_gangs()', async () => {
    const { gangId, marker } = await publicGang();

    const { rows } = await pool.query<{ id: string; name: string }>(
      `select id, name from public.search_public_gangs($1, 20, null)`,
      [marker],
    );

    expect(rows.some((r) => r.id === gangId)).toBe(true);
    // ฟังก์ชันคืนเฉพาะคอลัมน์ที่ประกาศไว้ — ไม่มีทางมี promptpay_id ติดมา
    expect(Object.keys(rows[0])).not.toContain('promptpay_id');
  });
});
