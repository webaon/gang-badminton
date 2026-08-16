/**
 * WO-4.A DoD — LINE credentials ผ่าน Vault
 *
 *   · 🔴 ไม่มี plaintext token/secret ใน DB — ตารางเก็บแค่ secret id
 *   · 🔴 ค่าที่ตั้งไปแล้วอ่านกลับมาที่หน้าจอไม่ได้ — `gang_line_status()` คืนแค่ 4 ตัวท้าย
 *   · สมาชิกทั่วไป/แอดมินก๊วนอื่น แตะ `gang_line_configs` ไม่ได้
 *   · หมุน token แล้วของเดิมถูกแทนที่ (ไม่ทิ้ง secret ค้างใน Vault)
 *   · เปิด `features.line` ไม่ได้ถ้า credentials ยังไม่ครบ
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, readAccess } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

const TOKEN = 'ACCESS-TOKEN-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-abcdef123456';

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`line-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function newGang() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนไลน์-${crypto.randomUUID()}`,
  ]);
  return { owner, gangId: gang.id };
}

async function setCredentials(
  gangId: string,
  actor: string,
  opts: { token?: string | null; secret?: string | null; liffId?: string | null } = {},
) {
  const { rows } = await pool.query(
    `select * from public.set_gang_line_credentials($1, $2, $3, $4, $5)`,
    [
      gangId,
      opts.token === undefined ? TOKEN : opts.token,
      opts.secret === undefined ? SECRET : opts.secret,
      opts.liffId === undefined ? 'liff-0001' : opts.liffId,
      actor,
    ],
  );
  return rows[0] as { channel_access_token_ref: string | null; channel_secret_ref: string | null };
}

async function status(gangId: string) {
  const {
    rows: [row],
  } = await pool.query<{
    has_access_token: boolean;
    token_last4: string | null;
    has_channel_secret: boolean;
    secret_last4: string | null;
    liff_id: string | null;
    is_enabled: boolean;
  }>(`select * from public.gang_line_status($1)`, [gangId]);
  return row;
}

async function featureLine(gangId: string): Promise<string | null> {
  const {
    rows: [row],
  } = await pool.query<{ line: string | null }>(
    `select features->>'line' as line from public.gangs where id = $1`,
    [gangId],
  );
  return row.line;
}

describe('WO-4.A DoD — ไม่มี plaintext ในฐานข้อมูล', () => {
  it('🔴 ตารางเก็บแค่ secret id — ทั้งแถวไม่มีค่าจริงอยู่เลย', async () => {
    const { owner, gangId } = await newGang();
    const saved = await setCredentials(gangId, owner);

    expect(saved.channel_access_token_ref).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const {
      rows: [row],
    } = await pool.query<{ dump: string }>(
      `select to_jsonb(c)::text as dump from public.gang_line_configs c where gang_id = $1`,
      [gangId],
    );

    expect(row.dump).not.toContain(TOKEN);
    expect(row.dump).not.toContain(SECRET);
  });

  it('ค่าจริงอ่านได้จาก Vault ผ่านฟังก์ชันของ server เท่านั้น', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);

    const {
      rows: [row],
    } = await pool.query<{ access_token: string; channel_secret: string; liff_id: string }>(
      `select * from public.get_gang_line_credentials($1)`,
      [gangId],
    );

    expect(row.access_token).toBe(TOKEN);
    expect(row.channel_secret).toBe(SECRET);
    expect(row.liff_id).toBe('liff-0001');
  });

  it('🔴 event ที่บันทึกไว้ต้องไม่มีค่า credential ติดไปด้วย', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);

    const {
      rows: [event],
    } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'gang.line_config_updated'`,
      [gangId],
    );

    expect(JSON.stringify(event.payload)).not.toContain(TOKEN);
    expect(event.payload.token_changed).toBe(true);
  });
});

describe('WO-4.A DoD — หน้าจอเห็นแค่ค่าที่ปิดบังแล้ว', () => {
  it('🔴 `gang_line_status()` คืนแค่ 4 ตัวท้าย ไม่มีค่าเต็ม', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);

    const row = await status(gangId);

    expect(row.has_access_token).toBe(true);
    expect(row.token_last4).toBe(TOKEN.slice(-4));
    expect(row.secret_last4).toBe(SECRET.slice(-4));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('ก๊วนที่ยังไม่ตั้งค่า → ไม่มีแถวสถานะ (หน้าจอถือว่า "ยังไม่ได้ตั้ง")', async () => {
    const { gangId } = await newGang();
    const { rows } = await pool.query(`select * from public.gang_line_status($1)`, [gangId]);
    expect(rows).toHaveLength(0);
  });
});

describe('WO-4.A DoD — หมุนค่าใหม่', () => {
  it('หมุน token แล้วใช้ secret id เดิม (ไม่ทิ้งใบเก่าค้างใน Vault)', async () => {
    const { owner, gangId } = await newGang();
    const first = await setCredentials(gangId, owner);

    const rotated = 'ACCESS-TOKEN-ROTATED-0987654321';
    const second = await setCredentials(gangId, owner, { token: rotated, secret: null, liffId: null });

    expect(second.channel_access_token_ref).toBe(first.channel_access_token_ref);

    const {
      rows: [row],
    } = await pool.query<{ access_token: string; channel_secret: string }>(
      `select * from public.get_gang_line_credentials($1)`,
      [gangId],
    );
    // token เปลี่ยน · secret เดิมยังอยู่ (ส่ง null = คงค่าเดิม)
    expect(row.access_token).toBe(rotated);
    expect(row.channel_secret).toBe(SECRET);

    const {
      rows: [count],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from vault.secrets where name = 'line_access_token:' || $1`,
      [gangId],
    );
    expect(Number(count.n)).toBe(1);
  });

  it('token สั้นผิดปกติ → VALIDATION_ERROR (และข้อความไม่มีค่าที่กรอก)', async () => {
    const { owner, gangId } = await newGang();

    await expect(setCredentials(gangId, owner, { token: 'สั้นไป' })).rejects.toThrow(
      /VALIDATION_ERROR/,
    );
  });

  it('ถอด LINE ออก → ลบ secret ใน Vault และปิด flag ให้ด้วย', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gangId, owner]);

    await pool.query(`select public.clear_gang_line_credentials($1, $2)`, [gangId, owner]);

    const row = await status(gangId);
    expect(row.has_access_token).toBe(false);
    expect(row.is_enabled).toBe(false);
    expect(await featureLine(gangId)).toBe('false');

    const {
      rows: [count],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from vault.secrets where name like 'line_%:' || $1`,
      [gangId],
    );
    expect(Number(count.n)).toBe(0);
  });
});

describe('WO-4.A DoD — เปิดใช้งานต้องมี credentials ครบ', () => {
  it('🔴 ยังไม่ครบ → VALIDATION_ERROR ตั้งแต่ตอนกด', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner, { secret: null, liffId: null });

    await expect(
      pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gangId, owner]),
    ).rejects.toThrow(/VALIDATION_ERROR/);

    expect(await featureLine(gangId)).toBe('false');
  });

  it('ครบแล้วเปิดได้ และ `gangs.features.line` ตรงกับสวิตช์เสมอ', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);

    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gangId, owner]);
    expect((await status(gangId)).is_enabled).toBe(true);
    expect(await featureLine(gangId)).toBe('true');

    await pool.query(`select public.set_gang_line_enabled($1, false, $2)`, [gangId, owner]);
    expect((await status(gangId)).is_enabled).toBe(false);
    expect(await featureLine(gangId)).toBe('false');
  });

  it('🔴 ล้าง credential ทั้งที่เปิดอยู่ → ปิดสวิตช์ให้เองทันที', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gangId, owner]);

    // ส่งสตริงว่าง = ตั้งใจล้างค่านั้นทิ้ง
    await setCredentials(gangId, owner, { token: '', secret: null, liffId: null });

    expect((await status(gangId)).is_enabled).toBe(false);
    expect(await featureLine(gangId)).toBe('false');
  });
});

describe('WO-4.A DoD — ด่านของฐานข้อมูล', () => {
  it('🔴 สมาชิก/แอดมินของก๊วน แตะตาราง `gang_line_configs` ไม่ได้เลย', async () => {
    const { owner, gangId } = await newGang();
    await setCredentials(gangId, owner);

    const sql = 'select 1 from public.gang_line_configs where gang_id = $1';
    expect(await readAccess(owner, sql, [gangId])).toBe('denied');
    expect(await readAccess(null, sql, [gangId], 'anon')).toBe('denied');
  });

  it('🔴 ผู้ใช้เรียกฟังก์ชันของ LINE ตรงไม่ได้ (service_role เท่านั้น)', async () => {
    const { owner, gangId } = await newGang();

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.get_gang_line_credentials($1)`, [gangId]),
      ).rejects.toThrow(/permission denied/i);
    });

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.set_gang_line_credentials($1, $2)`, [gangId, TOKEN]),
      ).rejects.toThrow(/permission denied/i);
    });

    await asRole('authenticated', owner, async (c) => {
      await expect(c.query(`select public.gang_line_status($1)`, [gangId])).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it('🔴 helper ของ Vault ไม่ถูกเปิดให้ใครเรียกเลย แม้แต่ service_role', async () => {
    const { owner } = await newGang();

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.line_secret_upsert('x', 'y')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
