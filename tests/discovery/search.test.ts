/**
 * WO-3.E DoD — ค้นหาก๊วนสาธารณะ
 *
 *   · 🔴 ก๊วนที่ `is_public = false` หรือปิด `features.discovery` **ไม่โผล่เลย**
 *     (ยิงฟังก์ชันที่ server action เรียกโดยตรง ไม่ใช่ตรวจแค่ที่ UI)
 *   · ค้นด้วย pg_trgm — คำไทย "บางส่วน" ของชื่อต้องเจอ
 *   · อักขระพิเศษของ LIKE ที่ผู้ใช้พิมพ์ต้องไม่กลายเป็น wildcard
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`dc-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ชื่อก๊วนสุ่มแต่ยังมีคำที่จะใช้ค้นอยู่ข้างใน — เทสต์อื่นสร้างก๊วนทิ้งไว้เยอะ */
async function makeGang(opts: {
  name: string;
  area?: string | null;
  isPublic?: boolean;
  discovery?: boolean;
}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    opts.name,
  ]);

  await pool.query(
    `update public.gangs
        set is_public = $2,
            area      = $3,
            features  = features || jsonb_build_object('discovery', $4::boolean)
      where id = $1`,
    [gang.id, opts.isPublic ?? true, opts.area ?? null, opts.discovery ?? true],
  );

  return { owner, gangId: gang.id };
}

async function search(query: string | null, viewerId: string | null = null) {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    area: string | null;
    member_count: number;
    viewer_status: string | null;
  }>(`select id, name, area, member_count, viewer_status from public.search_public_gangs($1, 50, $2)`, [
    query,
    viewerId,
  ]);
  return rows;
}

describe('WO-3.E DoD — ก๊วนที่ไม่ควรโผล่ต้องไม่โผล่', () => {
  it('🔴 ก๊วนส่วนตัว (is_public = false) ไม่อยู่ในผลค้นหา', async () => {
    const marker = `ส่วนตัว${crypto.randomUUID().slice(0, 8)}`;
    const { gangId } = await makeGang({ name: `ก๊วน${marker}`, isPublic: false });

    const rows = await search(marker);
    expect(rows.some((r) => r.id === gangId)).toBe(false);
  });

  it('🔴 ก๊วนที่ปิด features.discovery ไม่อยู่ในผลค้นหา แม้ is_public = true', async () => {
    const marker = `ปิดค้นหา${crypto.randomUUID().slice(0, 8)}`;
    const { gangId } = await makeGang({ name: `ก๊วน${marker}`, discovery: false });

    const rows = await search(marker);
    expect(rows.some((r) => r.id === gangId)).toBe(false);
  });

  it('ก๊วนที่ถูกลบไปแล้วไม่อยู่ในผลค้นหา', async () => {
    const marker = `ลบแล้ว${crypto.randomUUID().slice(0, 8)}`;
    const { gangId } = await makeGang({ name: `ก๊วน${marker}` });

    expect((await search(marker)).some((r) => r.id === gangId)).toBe(true);

    await pool.query(`update public.gangs set deleted_at = now() where id = $1`, [gangId]);
    expect((await search(marker)).some((r) => r.id === gangId)).toBe(false);
  });

  it('ก๊วนสาธารณะที่เปิด discovery โผล่ พร้อมจำนวนสมาชิก', async () => {
    const marker = `เปิดรับ${crypto.randomUUID().slice(0, 8)}`;
    const { gangId } = await makeGang({ name: `ก๊วน${marker}` });

    const row = (await search(marker)).find((r) => r.id === gangId);
    expect(row).toBeDefined();
    // create_gang ใส่เจ้าของเป็นสมาชิกคนแรกให้แล้ว
    expect(row?.member_count).toBe(1);
  });
});

describe('WO-3.E DoD — ค้นด้วย pg_trgm', () => {
  it('🔴 ค้นภาษาไทย "บางส่วน" ของชื่อก๊วนแล้วเจอ', async () => {
    const marker = `บางแค${crypto.randomUUID().slice(0, 6)}`;
    const { gangId } = await makeGang({ name: `ก๊วนแบด${marker}ยามเย็น` });

    const rows = await search(marker);
    expect(rows.some((r) => r.id === gangId)).toBe(true);
  });

  it('ค้นจากพื้นที่ (area) ก็เจอ', async () => {
    const marker = `รังสิต${crypto.randomUUID().slice(0, 6)}`;
    const { gangId } = await makeGang({
      name: `ก๊วนเช้าวันเสาร์ ${crypto.randomUUID().slice(0, 6)}`,
      area: `${marker} ปทุมธานี`,
    });

    const rows = await search(marker);
    expect(rows.some((r) => r.id === gangId)).toBe(true);
  });

  it('พิมพ์ผิดเล็กน้อยยังเจอ (similarity ของ trigram ไม่ใช่ substring ตรงตัว)', async () => {
    const suffix = crypto.randomUUID().slice(0, 6);
    const { gangId } = await makeGang({ name: `Badminton Bangkhae ${suffix}` });

    const rows = await search(`Badmintn Bangkhae ${suffix}`);
    expect(rows.some((r) => r.id === gangId)).toBe(true);
  });

  it('คำค้นที่ไม่เกี่ยวกันเลย → ไม่เจอ', async () => {
    const { gangId } = await makeGang({ name: `ก๊วนบางแค${crypto.randomUUID().slice(0, 6)}` });

    const rows = await search(`ปิงปองเชียงใหม่${crypto.randomUUID().slice(0, 6)}`);
    expect(rows.some((r) => r.id === gangId)).toBe(false);
  });

  it('🔴 พิมพ์ `%` ไม่ได้ก๊วนทั้งแพลตฟอร์ม (escape wildcard ของ LIKE)', async () => {
    await makeGang({ name: `ก๊วนทดสอบ${crypto.randomUUID().slice(0, 6)}` });

    expect(await search('%')).toHaveLength(0);
    expect(await search('_')).toHaveLength(0);
  });

  it('คำค้นว่าง = รายการก๊วนล่าสุด (ยังกรอง public/discovery เหมือนเดิม)', async () => {
    const { gangId: hidden } = await makeGang({
      name: `ก๊วนซ่อน${crypto.randomUUID().slice(0, 6)}`,
      isPublic: false,
    });
    const { gangId: shown } = await makeGang({
      name: `ก๊วนโชว์${crypto.randomUUID().slice(0, 6)}`,
    });

    const rows = await search(null);
    expect(rows.some((r) => r.id === shown)).toBe(true);
    expect(rows.some((r) => r.id === hidden)).toBe(false);
  });

  it('🔴 query นี้ใช้ index trgm ของ 0002 ได้จริง — ไม่ใช่ LIKE ที่ต้องสแกนทั้งตาราง', async () => {
    // ตารางเทสต์เล็กเกินกว่าที่ planner จะเลือก index เอง ⇒ ปิด seq scan เพื่อพิสูจน์ว่า
    // เงื่อนไขที่เขียนไว้ "ใช้ index ได้" จริง (ถ้าเขียนเป็น LIKE เปล่าจะเลือก index ไม่ได้เลย)
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const { rows } = await client.query<Record<string, string>>(
        `explain select id from public.gangs
          where name operator(extensions.%) 'บางแค' or name ilike '%บางแค%'`,
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/gangs_name_trgm_idx/);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });
});

describe('WO-3.E — viewer_status', () => {
  it('บอกได้ว่าเป็นสมาชิกอยู่แล้ว / ขอค้างไว้ / ยังขอได้', async () => {
    const marker = `สถานะ${crypto.randomUUID().slice(0, 8)}`;
    const { owner, gangId } = await makeGang({ name: `ก๊วน${marker}` });

    const outsider = await newUser();
    const requester = await newUser();

    await pool.query(`select public.request_to_join_gang($1, $2)`, [gangId, requester]);

    const statusFor = async (viewer: string) =>
      (await search(marker, viewer)).find((r) => r.id === gangId)?.viewer_status ?? null;

    expect(await statusFor(owner)).toBe('member');
    expect(await statusFor(requester)).toBe('pending');
    expect(await statusFor(outsider)).toBeNull();
  });
});
