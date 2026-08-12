/**
 * WO-1.5 DoD — "seed รันซ้ำได้ (idempotent)"
 *
 * รัน `supabase/seed/seed.sql` ซ้ำแล้วสถานะต้องเหมือนเดิมเป๊ะ ไม่สร้างซ้ำ ไม่ error
 *
 * ⚠️ เทสต์นี้รัน seed ไฟล์จริงจากดิสก์ ไม่ใช่ก๊อปปี้ ⇒ ถ้าแก้ seed แล้วทำให้
 *    รันซ้ำไม่ได้ เทสต์จะจับได้ทันที
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../helpers/db';

const SEED_PATH = fileURLToPath(new URL('../../supabase/seed/seed.sql', import.meta.url));

/** นับทุกอย่างที่ seed สร้าง — ใช้เทียบก่อน/หลังรันซ้ำ */
async function snapshotCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<Record<string, string>>(`
    select
      (select count(*) from public.organizations)                         as organizations,
      (select count(*) from public.organization_members)                  as organization_members,
      (select count(*) from public.gangs)                                 as gangs,
      (select count(*) from public.gang_members)                          as gang_members,
      (select count(*) from public.gang_skill_levels)                     as gang_skill_levels,
      (select count(*) from public.gang_pricing_plans)                    as gang_pricing_plans,
      (select count(*) from public.sessions)                              as sessions,
      (select count(*) from public.session_registrations)                 as session_registrations,
      (select count(*) from public.session_charges)                       as session_charges,
      (select count(*) from public.announcements)                         as announcements,
      (select count(*) from public.event_logs)                            as event_logs,
      (select count(*) from public.profiles)                              as profiles,
      (select count(*) from auth.users)                                   as auth_users
  `);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

describe('WO-1.5 DoD — seed รันซ้ำได้', () => {
  let seedSql: string;

  beforeAll(async () => {
    seedSql = await readFile(SEED_PATH, 'utf8');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('ข้อมูลที่ seed สร้างครบและถูกต้อง', async () => {
    const {
      rows: [gang],
    } = await pool.query<{ name: string; is_public: boolean }>(
      `select name, is_public from public.gangs where id = '00000000-0000-7000-8000-00000000b001'`,
    );
    expect(gang.name).toBe('ก๊วนแบดวันพุธ');

    // นัดที่กำลังจะถึง: max_players = 8 ⇒ 8 confirmed + 2 waitlist
    const upcoming = await pool.query<{ status: string; n: string }>(
      `select status, count(*)::text n from public.session_registrations
        where session_id = '00000000-0000-7000-8000-00000000d001'
        group by status`,
    );
    const byStatus = Object.fromEntries(upcoming.rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus.confirmed).toBe(8);
    expect(byStatus.waitlist).toBe(2);

    // นัดที่ผ่านมา: ปิดรอบแล้ว มี charges ครบ 6 คน
    const {
      rows: [past],
    } = await pool.query<{ status: string }>(
      `select status from public.sessions where id = '00000000-0000-7000-8000-00000000d002'`,
    );
    expect(past.status).toBe('settled');

    const {
      rows: [charges],
    } = await pool.query<{ n: string; total: string }>(
      `select count(*)::text n, coalesce(sum(amount), 0)::text total
         from public.session_charges
        where session_id = '00000000-0000-7000-8000-00000000d002'`,
    );
    expect(Number(charges.n)).toBe(6);
    expect(charges.total).toBe('1200.00');
  });

  it('seed เดินผ่าน state machine จริง ไม่ยัด status ตรง', async () => {
    // ถ้า seed แอบ UPDATE status เอง จะไม่มี event เหล่านี้
    const { rows } = await pool.query<{ event_type: string; n: string }>(
      `select event_type, count(*)::text n from public.event_logs
        where payload->>'correlation_id' = 'seed'
        group by event_type`,
    );
    const events = Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)]));

    // draft→open ×2, in_play, settled = 4
    expect(events['session.transitioned']).toBe(4);
    expect(events['session.closed_with_charges']).toBe(1);
    expect(events['registration.confirmed']).toBeGreaterThan(0);
    expect(events['registration.waitlisted']).toBe(2);
  });

  it('🔴 รัน seed ซ้ำ 2 รอบ → ไม่มีอะไรเพิ่ม ไม่มี error', async () => {
    const before = await snapshotCounts();

    await pool.query(seedSql);
    const afterFirst = await snapshotCounts();
    expect(afterFirst, 'รอบที่สองต้องไม่สร้างอะไรเพิ่ม').toEqual(before);

    await pool.query(seedSql);
    const afterSecond = await snapshotCounts();
    expect(afterSecond, 'รอบที่สามก็ต้องเหมือนเดิม').toEqual(before);
  });

  it('รัน seed ซ้ำแล้วสถานะของนัดไม่ถูกรีเซ็ตกลับ', async () => {
    await pool.query(seedSql);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `select id, status from public.sessions
        where id in ('00000000-0000-7000-8000-00000000d001',
                     '00000000-0000-7000-8000-00000000d002')
        order by id`,
    );
    expect(rows.map((r) => r.status)).toEqual(['open', 'settled']);
  });
});
