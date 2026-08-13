/**
 * WO-2.2 DoD — auth + โปรไฟล์
 *
 *   1. สมัคร → ได้แถว `profiles` อัตโนมัติ (trigger `on_auth_user_created`)
 *   2. ผู้ใช้ A แก้โปรไฟล์ผู้ใช้ B ไม่ได้
 *   3. คนที่ไม่ได้อยู่ก๊วนเดียวกันมองไม่เห็นโปรไฟล์กัน [D-12]
 *
 * (ข้อ "ไม่ล็อกอิน → redirect ไม่ใช่ 500" ตรวจกับเซิร์ฟเวอร์จริง ไม่ใช่ที่นี่)
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  pool,
  asRole,
  asRoleCommitted,
  visibleCount,
  createFixture,
  addGangMember,
} from '../helpers/db';

/** สร้าง auth user ตรงๆ เพื่อดูพฤติกรรมของ trigger (ไม่ใช้ helper ที่ upsert ทับ) */
async function rawSignUp(opts: {
  email?: string | null;
  meta?: Record<string, string> | null;
}): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2::jsonb)
     returning id`,
    [opts.email ?? null, JSON.stringify(opts.meta ?? {})],
  );
  return row.id;
}

async function profileOf(userId: string) {
  const {
    rows: [row],
  } = await pool.query<{ display_name: string; phone: string | null }>(
    `select display_name, phone from public.profiles where id = $1`,
    [userId],
  );
  return row;
}

// ปิด pool ที่ระดับไฟล์ ไม่ใช่ใน describe แรก — ไม่งั้น describe ถัดไปจะเจอ pool ที่ปิดไปแล้ว
afterAll(async () => {
  await pool.end();
});

describe('WO-2.2 DoD 1 — trigger สร้าง profiles ให้อัตโนมัติ', () => {
  it('สมัครพร้อมชื่อ → ใช้ชื่อที่กรอก', async () => {
    const id = await rawSignUp({
      email: `somchai-${crypto.randomUUID()}@example.com`,
      meta: { display_name: 'สมชาย ใจดี', phone: '0891112222' },
    });

    const profile = await profileOf(id);
    expect(profile).toBeDefined();
    expect(profile.display_name).toBe('สมชาย ใจดี');
    expect(profile.phone).toBe('0891112222');
  });

  it('ไม่ได้กรอกชื่อ → ใช้ส่วนหน้าของอีเมล', async () => {
    const id = await rawSignUp({ email: `nujeab-${Date.now()}@example.com`, meta: {} });
    expect((await profileOf(id)).display_name).toMatch(/^nujeab-/);
  });

  it('ชื่อที่กรอกเป็นช่องว่างล้วน → ตกไปใช้อีเมลแทน (ไม่ปล่อยชื่อว่าง)', async () => {
    const id = await rawSignUp({
      email: `blank-${Date.now()}@example.com`,
      meta: { display_name: '   ' },
    });
    expect((await profileOf(id)).display_name).toMatch(/^blank-/);
  });

  it('🔴 ไม่มีทั้งชื่อและอีเมล → ยังต้องสร้างสำเร็จ ไม่ชน NOT NULL', async () => {
    // เคสนี้เกิดจริงกับ seed และ fixture ของเทสต์ (สร้าง auth.users โดยไม่มี email)
    // ถ้า fallback ไม่จบที่ค่าคงที่ ทั้ง seed และเทสต์ทั้งชุดจะพัง
    const id = await rawSignUp({ email: null, meta: null });
    expect((await profileOf(id)).display_name).toBe('สมาชิกใหม่');
  });

  it('ลบผู้ใช้ → โปรไฟล์หายตามด้วย (FK cascade)', async () => {
    const id = await rawSignUp({ email: `bye-${Date.now()}@example.com`, meta: {} });
    expect(await profileOf(id)).toBeDefined();

    await pool.query(`delete from auth.users where id = $1`, [id]);

    const { rows } = await pool.query(`select 1 from public.profiles where id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });
});

describe('WO-2.2 DoD 2 — แก้โปรไฟล์คนอื่นไม่ได้', () => {
  it('🔴 A แก้โปรไฟล์ B → ไม่มีแถวถูกแตะ (RLS กรองเงียบๆ ไม่ raise)', async () => {
    const a = await rawSignUp({ email: `a-${Date.now()}@example.com`, meta: {} });
    const b = await rawSignUp({ email: `b-${Date.now()}@example.com`, meta: {} });
    const before = await profileOf(b);

    await asRole('authenticated', a, async (c) => {
      const res = await c.query(`update public.profiles set display_name = 'โดนแฮก' where id = $1`, [
        b,
      ]);
      // นี่คือกับดักที่ `assertAffected()` มีไว้จับ — query "สำเร็จ" แต่ไม่มีอะไรเปลี่ยน
      expect(res.rowCount).toBe(0);
    });

    expect((await profileOf(b)).display_name).toBe(before.display_name);
  });

  it('A แก้โปรไฟล์ตัวเองได้', async () => {
    const a = await rawSignUp({ email: `self-${Date.now()}@example.com`, meta: {} });

    // ต้อง commit จริงเพื่อพิสูจน์ว่าเขียนติด ไม่ใช่แค่ rowCount บอกว่า 1
    await asRoleCommitted('authenticated', a, async (c) => {
      const res = await c.query(
        `update public.profiles set display_name = 'ชื่อใหม่ของฉัน' where id = $1`,
        [a],
      );
      expect(res.rowCount).toBe(1);
    });

    expect((await profileOf(a)).display_name).toBe('ชื่อใหม่ของฉัน');
  });

  it('A สร้างแถว profile ให้ id ของคนอื่นไม่ได้', async () => {
    const a = await rawSignUp({ email: `ins-a-${Date.now()}@example.com`, meta: {} });
    const victim = await rawSignUp({ email: `ins-v-${Date.now()}@example.com`, meta: {} });

    // ลบของ victim ทิ้งก่อนเพื่อให้ insert มีโอกาสสำเร็จถ้า policy หละหลวม
    await pool.query(`delete from public.profiles where id = $1`, [victim]);

    await asRole('authenticated', a, async (c) => {
      await expect(
        c.query(`insert into public.profiles (id, display_name) values ($1, 'ปลอม')`, [victim]),
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });
});

describe('WO-2.2 DoD 3 — [D-12] เห็นโปรไฟล์เฉพาะคนในก๊วนเดียวกัน', () => {
  it('คนละก๊วน → มองไม่เห็นกัน · ก๊วนเดียวกัน → เห็น', async () => {
    const owner = await rawSignUp({ email: `owner-${Date.now()}@example.com`, meta: {} });
    const mate = await rawSignUp({ email: `mate-${Date.now()}@example.com`, meta: {} });
    const stranger = await rawSignUp({ email: `stranger-${Date.now()}@example.com`, meta: {} });

    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
    await addGangMember(fx.gangId, owner);
    await addGangMember(fx.gangId, mate);

    const sql = 'select 1 from public.profiles where id = $1';

    // เห็นตัวเองเสมอ
    expect(await visibleCount(owner, sql, [owner])).toBe(1);
    // เห็นเพื่อนร่วมก๊วน
    expect(await visibleCount(owner, sql, [mate])).toBe(1);
    // 🔴 ไม่เห็นคนนอกก๊วน — กัน enumerate ผู้ใช้ทั้งแพลตฟอร์ม
    expect(await visibleCount(owner, sql, [stranger])).toBe(0);
    expect(await visibleCount(stranger, sql, [owner])).toBe(0);

    // เข้าก๊วนแล้วถึงจะเห็น
    await addGangMember(fx.gangId, stranger);
    expect(await visibleCount(owner, sql, [stranger])).toBe(1);
  });

  it('anon ไม่เห็นโปรไฟล์ใครเลย', async () => {
    const someone = await rawSignUp({ email: `anon-target-${Date.now()}@example.com`, meta: {} });
    await asRole('anon', null, async (c) => {
      await expect(
        c.query('select 1 from public.profiles where id = $1', [someone]),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
