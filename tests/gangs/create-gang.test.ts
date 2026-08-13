/**
 * WO-2.3 DoD
 *
 *   1. สร้างก๊วนแล้วผู้สร้างเป็น owner ทั้ง `organizations` และ `gang_members`
 *      — และต้องเป็น transaction เดียว (ล้มกลางทาง = ไม่ทิ้งขยะ)
 *   2. สมาชิกธรรมดาแก้ตั้งค่าก๊วนไม่ได้ · แอดมินก๊วนอื่นก็ไม่ได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, asRoleCommitted } from '../helpers/db';

async function newUser(email?: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [email ?? `u-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function createGang(ownerId: string, name = `ก๊วนทดสอบ-${crypto.randomUUID()}`) {
  const {
    rows: [gang],
  } = await pool.query<{ id: string; org_id: string; cancellation_policy: unknown }>(
    `select * from public.create_gang($1, $2)`,
    [ownerId, name],
  );
  return gang;
}

afterAll(async () => {
  await pool.end();
});

describe('WO-2.3 DoD 1 — create_gang เป็น atomic และตั้งเจ้าของครบสองชั้น', () => {
  it('สร้างก๊วน → ได้ org + org_member(owner) + gang + gang_member(owner)', async () => {
    const owner = await newUser();
    const gang = await createGang(owner, 'ก๊วนวันอาทิตย์');

    const {
      rows: [counts],
    } = await pool.query<Record<string, string>>(
      `select
         (select count(*) from public.organizations where id = $2)                          as org,
         (select count(*) from public.organization_members
           where org_id = $2 and user_id = $1 and role = 'owner')                           as org_member,
         (select count(*) from public.gangs where id = $3)                                  as gang,
         (select count(*) from public.gang_members
           where gang_id = $3 and user_id = $1 and role = 'owner' and deleted_at is null)   as gang_member,
         (select count(*) from public.event_logs
           where gang_id = $3 and event_type = 'gang.created')                              as event`,
      [owner, gang.org_id, gang.id],
    );

    expect(Object.values(counts).every((v) => Number(v) === 1), JSON.stringify(counts)).toBe(true);
  });

  it('ก๊วนใหม่ได้ cancellation policy ตาม ADR-002 (full_share) ไม่ใช่ {} ว่างๆ', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    const {
      rows: [row],
    } = await pool.query<{ policy: Record<string, unknown> }>(
      `select cancellation_policy as policy from public.gangs where id = $1`,
      [gang.id],
    );

    expect(row.policy.penalty_type).toBe('full_share');
    expect(row.policy.cutoff_hours).toBe(12);
    expect(row.policy.allow_cancel_after_cutoff).toBe(true);
  });

  it('🔴 ชื่อว่าง → VALIDATION_ERROR และ**ไม่ทิ้ง org ค้างไว้**', async () => {
    const owner = await newUser();

    const { rows: before } = await pool.query(`select id from public.organizations`);

    await expect(pool.query(`select * from public.create_gang($1, $2)`, [owner, '   '])).rejects.toThrow(
      /VALIDATION_ERROR/,
    );

    const { rows: after } = await pool.query(`select id from public.organizations`);
    // ถ้าไม่ atomic จะเหลือ org ที่ไม่มีก๊วนค้างอยู่
    expect(after).toHaveLength(before.length);
  });

  it('owner id ที่ไม่มีโปรไฟล์ → NOT_FOUND และไม่สร้างอะไรเลย', async () => {
    const ghost = crypto.randomUUID();
    const { rows: before } = await pool.query(`select id from public.organizations`);

    await expect(
      pool.query(`select * from public.create_gang($1, $2)`, [ghost, 'ก๊วนผี']),
    ).rejects.toThrow(/NOT_FOUND/);

    const { rows: after } = await pool.query(`select id from public.organizations`);
    expect(after).toHaveLength(before.length);
  });

  it('เจ้าของก๊วนใหม่แก้ตั้งค่าก๊วนตัวเองได้ทันที', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    await asRoleCommitted('authenticated', owner, async (c) => {
      const res = await c.query(`update public.gangs set area = 'บางนา' where id = $1`, [gang.id]);
      expect(res.rowCount).toBe(1);
    });
  });
});

describe('WO-2.3 DoD 2 — คนที่ไม่ใช่แอดมินแก้ตั้งค่าก๊วนไม่ได้', () => {
  it('สมาชิกธรรมดา · คนนอก · แอดมินก๊วนอื่น → แก้ไม่ได้', async () => {
    const owner = await newUser();
    const gang = await createGang(owner, 'ก๊วน A');

    const member = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, member],
    );

    const outsider = await newUser();

    const otherOwner = await newUser();
    await createGang(otherOwner, 'ก๊วน B');

    for (const [label, uid] of [
      ['สมาชิกธรรมดา', member],
      ['คนนอกก๊วน', outsider],
      ['owner ของก๊วนอื่น', otherOwner],
    ] as const) {
      await asRole('authenticated', uid, async (c) => {
        const res = await c.query(`update public.gangs set name = 'โดนแฮก' where id = $1`, [
          gang.id,
        ]);
        // RLS กรองแถวทิ้งเงียบๆ — ไม่ raise ⇒ ต้องเช็ค rowCount
        expect(res.rowCount, label).toBe(0);
      });
    }

    const {
      rows: [row],
    } = await pool.query<{ name: string }>(`select name from public.gangs where id = $1`, [gang.id]);
    expect(row.name).toBe('ก๊วน A');
  });

  it('สมาชิกธรรมดาแก้แผนราคา / ระดับฝีมือไม่ได้', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    const member = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, member],
    );

    await asRole('authenticated', member, async (c) => {
      const plan = await c.query(
        `insert into public.gang_pricing_plans (gang_id, name, type, params)
         values ($1, 'ของปลอม', 'flat_rate', '{"amount_per_person": "1.00"}'::jsonb)
         returning id`,
        [gang.id],
      );
      expect(plan.rowCount).toBe(0);
    }).catch((err) => {
      // insert ที่ผิด policy อาจ raise แทนที่จะคืน 0 แถว — ยอมรับทั้งสองแบบ
      expect(String(err)).toMatch(/row-level security|violates/i);
    });

    const { rows } = await pool.query(
      `select 1 from public.gang_pricing_plans where gang_id = $1`,
      [gang.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('WO-2.3 [D-18] — เพิ่มสมาชิกด้วยอีเมล', () => {
  it('เพิ่มคนที่มีบัญชีแล้วเข้าก๊วนได้', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    const email = `invitee-${crypto.randomUUID()}@example.com`;
    const invitee = await newUser(email);

    const {
      rows: [member],
    } = await pool.query<{ user_id: string; role: string }>(
      `select * from public.add_gang_member_by_email($1, $2, 'member', $3)`,
      [gang.id, email, owner],
    );

    expect(member.user_id).toBe(invitee);
    expect(member.role).toBe('member');
  });

  it('อีเมลตัวพิมพ์ใหญ่/มีช่องว่าง ก็หาเจอ', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const email = `MiXeD-${crypto.randomUUID()}@example.com`;
    await newUser(email.toLowerCase());

    const { rows } = await pool.query(
      `select * from public.add_gang_member_by_email($1, $2, 'member', $3)`,
      [gang.id, `  ${email.toUpperCase()}  `, owner],
    );
    expect(rows).toHaveLength(1);
  });

  it('🔴 อีเมลที่ไม่มีบัญชี → NOT_FOUND ที่ไม่บอกว่ามีบัญชีอยู่หรือไม่', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    await expect(
      pool.query(`select * from public.add_gang_member_by_email($1, $2, 'member', $3)`, [
        gang.id,
        'ไม่มีจริง@example.com',
        owner,
      ]),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('เพิ่มคนเดิมซ้ำ → ALREADY_REGISTERED', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const email = `dup-${crypto.randomUUID()}@example.com`;
    await newUser(email);

    await pool.query(`select * from public.add_gang_member_by_email($1, $2, 'member', $3)`, [
      gang.id,
      email,
      owner,
    ]);

    await expect(
      pool.query(`select * from public.add_gang_member_by_email($1, $2, 'member', $3)`, [
        gang.id,
        email,
        owner,
      ]),
    ).rejects.toThrow(/ALREADY_REGISTERED/);
  });

  it('คนที่เคยถูกเอาออก → รับกลับเข้ามาได้ ไม่สร้างแถวซ้ำ', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const email = `rejoin-${crypto.randomUUID()}@example.com`;
    const user = await newUser(email);

    await pool.query(`select * from public.add_gang_member_by_email($1, $2, 'member', $3)`, [
      gang.id,
      email,
      owner,
    ]);
    await pool.query(
      `update public.gang_members set deleted_at = now() where gang_id = $1 and user_id = $2`,
      [gang.id, user],
    );

    const {
      rows: [back],
    } = await pool.query<{ role: string }>(
      `select * from public.add_gang_member_by_email($1, $2, 'admin', $3)`,
      [gang.id, email, owner],
    );
    expect(back.role).toBe('admin');

    const { rows } = await pool.query(
      `select 1 from public.gang_members where gang_id = $1 and user_id = $2`,
      [gang.id, user],
    );
    expect(rows, 'ต้องมีแถวเดียว ไม่ใช่สองแถว').toHaveLength(1);
  });

  it('ไม่บันทึกอีเมลลง event_logs (สมาชิกก๊วนอ่าน timeline ได้)', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const email = `privacy-${crypto.randomUUID()}@example.com`;
    await newUser(email);

    await pool.query(`select * from public.add_gang_member_by_email($1, $2, 'member', $3)`, [
      gang.id,
      email,
      owner,
    ]);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'gang.member_added'`,
      [gang.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].payload)).not.toContain(email);
  });
});
