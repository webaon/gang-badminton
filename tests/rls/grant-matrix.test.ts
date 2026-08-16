/**
 * ยืนยัน grant matrix ระดับตาราง — ชั้นป้องกันแรก ก่อนที่ RLS จะทำงาน
 *
 * 🔴 ทำไมต้องมีเทสต์นี้
 *
 * migration 0010 เดิมพึ่ง "ไม่ได้ grant = แตะไม่ได้" ซึ่งจริงบน local แต่**ไม่จริงบน cloud**
 * (default ACL ต่างกัน) ⇒ ตอน push ขึ้น cloud พบว่า `anon` มี SELECT บนตาราง server-only
 * ข้อมูลไม่รั่วเพราะ RLS ยังกันอยู่ แต่เหลือกำแพงชั้นเดียวและพฤติกรรมต่างกันสองที่
 *
 * migration 0013 จึงประกาศ matrix ให้ชัด และเทสต์นี้คือตัวกันไม่ให้หลุดอีก
 * — ถ้าใครเพิ่มตารางใหม่แล้วลืม revoke/grant เทสต์จะแดงทันที
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';

/** สิทธิ์ที่ตั้งใจให้ — ตารางที่ไม่อยู่ในนี้ต้องไม่มีสิทธิ์อะไรเลย */
const EXPECTED: Record<string, { anon: string[]; authenticated: string[] }> = {
  // อ่านอย่างเดียว — เขียนผ่าน DB function เท่านั้น [D-13]
  session_registrations: { anon: [], authenticated: ['SELECT'] },
  session_charges: { anon: [], authenticated: ['SELECT'] },
  event_logs: { anon: [], authenticated: ['SELECT'] },
  member_statistics: { anon: [], authenticated: ['SELECT'] },
  notification_logs: { anon: [], authenticated: ['SELECT'] },
  payment_allocations: { anon: [], authenticated: ['SELECT'] },
  payment_adjustments: { anon: [], authenticated: ['SELECT'] },
  member_line_links: { anon: [], authenticated: ['SELECT'] },
  // [WO-3.E] 0033 ถอน INSERT/UPDATE ออก — ขอ/ยกเลิก/อนุมัติผ่าน DB function เท่านั้น
  join_requests: { anon: [], authenticated: ['SELECT'] },

  // อ่าน + เขียนบางส่วน
  profiles: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  organizations: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  organization_members: { anon: [], authenticated: ['SELECT', 'INSERT', 'DELETE'] },
  gangs: { anon: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  gang_members: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  sessions: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  payments: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE'] },
  notifications: { anon: [], authenticated: ['SELECT', 'UPDATE'] },

  // แอดมินจัดการเต็ม (policy FOR ALL)
  gang_skill_levels: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  gang_pricing_plans: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  session_templates: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  coupons: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  gang_expenses: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  gang_incomes: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  announcements: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  games: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  session_invite_tokens: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },

  // 🔴 server-only — ต้องว่างทั้งคู่
  gang_line_configs: { anon: [], authenticated: [] },
  daily_metrics: { anon: [], authenticated: [] },
  rate_limits: { anon: [], authenticated: [] },
};

const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

type GrantRow = { relname: string; grantee: string; priv: string; allowed: boolean };

describe('grant matrix ระดับตาราง', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('ทุกตารางมีสิทธิ์ตรงกับที่ประกาศไว้ ไม่มากไม่น้อย', async () => {
    const { rows } = await pool.query<GrantRow>(
      `select c.relname, r.rolname as grantee, p.priv,
              has_table_privilege(r.rolname, c.oid, p.priv) as allowed
         from pg_class c
         cross join (values ('anon'), ('authenticated')) as r(rolname)
         cross join unnest($1::text[]) as p(priv)
        where c.relnamespace = 'public'::regnamespace
          and c.relkind = 'r'`,
      [DML],
    );

    const actual: Record<string, { anon: string[]; authenticated: string[] }> = {};
    for (const row of rows) {
      actual[row.relname] ??= { anon: [], authenticated: [] };
      if (row.allowed) {
        (actual[row.relname] as Record<string, string[]>)[row.grantee].push(row.priv);
      }
    }

    const problems: string[] = [];
    for (const [table, expected] of Object.entries(actual)) {
      const want = EXPECTED[table];
      if (!want) {
        problems.push(`${table}: ไม่ได้ประกาศไว้ใน EXPECTED (ตารางใหม่? ต้องตัดสินใจสิทธิ์ก่อน)`);
        continue;
      }
      for (const role of ['anon', 'authenticated'] as const) {
        const got = [...expected[role]].sort();
        const exp = [...want[role]].sort();
        if (got.join(',') !== exp.join(',')) {
          problems.push(`${table} (${role}): ได้ [${got}] แต่ควรเป็น [${exp}]`);
        }
      }
    }

    expect(problems, `สิทธิ์ไม่ตรงที่ประกาศ:\n${problems.join('\n')}`).toEqual([]);
  });

  it('🔴 ตาราง server-only ไม่มีสิทธิ์ให้ anon/authenticated แม้แต่ SELECT', async () => {
    const { rows } = await pool.query<{ relname: string; anon: boolean; auth_role: boolean }>(
      `select c.relname,
              has_table_privilege('anon', c.oid, 'SELECT') anon,
              has_table_privilege('authenticated', c.oid, 'SELECT') auth_role
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('gang_line_configs', 'daily_metrics', 'rate_limits')
        order by c.relname`,
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.anon, `${row.relname} ไม่ควรให้ anon อ่านได้`).toBe(false);
      expect(row.auth_role, `${row.relname} ไม่ควรให้ authenticated อ่านได้`).toBe(false);
    }
  });

  it('ทุกตารางใน public เปิด RLS ไว้', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select relname from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity
        order by relname`,
    );
    expect(rows.map((r) => r.relname), 'ตารางที่ยังไม่เปิด RLS').toEqual([]);
  });

  it('service_role ใช้ได้ทุกตาราง (ฝั่ง server ต้องไม่ติดสิทธิ์)', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select relname from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and not has_table_privilege('service_role', c.oid, 'SELECT')
        order by relname`,
    );
    expect(rows.map((r) => r.relname), 'ตารางที่ service_role อ่านไม่ได้').toEqual([]);
  });
});
