/**
 * WO-1.5 DoD — "cron route ตรวจ CRON_SECRET" + ฟังก์ชัน sweep ทำงานจริง
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  pool,
  createFixture,
  createUser,
  addGangMember,
  registrationsOf,
} from '../helpers/db';
import { isAuthorizedCronRequest } from '@/server/cron/auth';
import { CRON_JOBS, isCronJobName } from '@/server/cron/jobs';

// ใช้รูปแบบเดียวกับของจริง (`openssl rand -base64 32`) — HTTP header เป็น ByteString
// ⇒ อักขระนอก latin-1 ใส่ไม่ได้ ต้องเป็น ASCII เท่านั้น
const SECRET = 'kQ8Zr2mN5tVxJ7wLpC3fHb9YdA6sE1uG4iO0nT8yK2M=';

function headers(auth?: string): Headers {
  return new Headers(auth ? { authorization: auth } : {});
}

describe('WO-1.5 — cron', () => {
  afterAll(async () => {
    await pool.end();
  });

  // ===========================================================================
  describe('DoD: route ตรวจ CRON_SECRET', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = SECRET;
    });

    it('secret ถูกต้อง → ผ่าน', () => {
      expect(isAuthorizedCronRequest(headers(`Bearer ${SECRET}`))).toBe(true);
    });

    it('ไม่มี header เลย → ไม่ผ่าน', () => {
      expect(isAuthorizedCronRequest(headers())).toBe(false);
    });

    it('secret ผิด → ไม่ผ่าน', () => {
      expect(isAuthorizedCronRequest(headers('Bearer definitely-not-the-secret'))).toBe(false);
    });

    it('secret ถูกแต่ไม่มี Bearer → ไม่ผ่าน', () => {
      expect(isAuthorizedCronRequest(headers(SECRET))).toBe(false);
    });

    it('secret ที่เป็น prefix ของค่าจริง → ไม่ผ่าน (กันเดาทีละตัว)', () => {
      expect(isAuthorizedCronRequest(headers(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false);
      expect(isAuthorizedCronRequest(headers(`Bearer ${SECRET}x`))).toBe(false);
    });

    it('🔴 ไม่ได้ตั้ง CRON_SECRET → ปฏิเสธทุก request (fail-closed)', () => {
      delete process.env.CRON_SECRET;
      expect(isAuthorizedCronRequest(headers(`Bearer ${SECRET}`))).toBe(false);
      expect(isAuthorizedCronRequest(headers('Bearer '))).toBe(false);
      expect(isAuthorizedCronRequest(headers())).toBe(false);
    });

    it('ชื่องานที่ไม่รู้จักถูกปฏิเสธ', () => {
      expect(isCronJobName('waitlist-sweep')).toBe(true);
      expect(isCronJobName('../../etc/passwd')).toBe(false);
      expect(isCronJobName('drop-everything')).toBe(false);
      expect(isCronJobName('toString')).toBe(false); // กัน prototype pollution
    });
  });

  // ===========================================================================
  describe('pg_cron ตั้งตารางไว้ครบ', () => {
    it('job ทุกใบถูก schedule และ active', async () => {
      const { rows } = await pool.query<{ jobname: string; active: boolean }>(
        `select jobname, active from cron.job where jobname like 'gang-badminton-%' order by jobname`,
      );
      expect(rows.map((r) => r.jobname)).toEqual([
        'gang-badminton-notification-sweep',
        'gang-badminton-rate-limits-purge',
        // [WO-3.A] rollup รายคืน — ตี 2 เวลาไทย (19:00 UTC)
        'gang-badminton-rollup',
        'gang-badminton-waitlist-sweep',
      ]);
      expect(rows.every((r) => r.active)).toBe(true);
    });

    it('ทุกงานใน CRON_JOBS มี DB function อยู่จริง', async () => {
      const names = Object.values(CRON_JOBS);
      const { rows } = await pool.query<{ proname: string }>(
        `select proname from pg_proc
          where pronamespace = 'public'::regnamespace and proname = any($1)`,
        [names],
      );
      expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    });
  });

  // ===========================================================================
  describe('ฟังก์ชัน sweep ทำงานจริง', () => {
    it('sweep_waitlist เลื่อนคิวที่หลุด — และไม่เลื่อนเกินที่ว่าง', async () => {
      const owner = await createUser('cron-owner');
      const fx = await createFixture({ ownerId: owner, maxPlayers: 2 });

      const users: string[] = [];
      for (let i = 0; i < 4; i++) {
        const u = await createUser(`cron-player-${i}`);
        await addGangMember(fx.gangId, u);
        users.push(u);
        await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
      }

      // จำลอง "คิวหลุด": ทำให้มีที่ว่างโดยไม่ผ่าน cancel_registration
      // (เช่นแอดมิน mark no_show ซึ่งไม่ได้เรียก promote ในตัว)
      const confirmed = (await registrationsOf(fx.sessionId)).filter(
        (r) => r.status === 'confirmed',
      );
      await pool.query(
        `update public.session_registrations set status = 'no_show' where id = $1`,
        [confirmed[0].id],
      );

      let counts = await registrationsOf(fx.sessionId);
      expect(counts.filter((r) => r.status === 'confirmed')).toHaveLength(1);
      expect(counts.filter((r) => r.status === 'waitlist')).toHaveLength(2);

      const {
        rows: [swept],
      } = await pool.query<{ n: number }>('select public.sweep_waitlist() n');
      expect(swept.n).toBeGreaterThanOrEqual(1);

      counts = await registrationsOf(fx.sessionId);
      // เลื่อนขึ้นมาเต็มที่ว่าง 1 ที่พอดี ไม่เกิน max_players
      expect(counts.filter((r) => r.status === 'confirmed')).toHaveLength(2);
      expect(counts.filter((r) => r.status === 'waitlist')).toHaveLength(1);

      // รันซ้ำต้องไม่เลื่อนเพิ่ม (ไม่มีที่ว่างแล้ว)
      await pool.query('select public.sweep_waitlist()');
      counts = await registrationsOf(fx.sessionId);
      expect(counts.filter((r) => r.status === 'confirmed')).toHaveLength(2);
    });

    it('sweep_stuck_notifications คืนคิวแถวที่ worker ตายทิ้งไว้ + backoff', async () => {
      const owner = await createUser('cron-notif-owner');
      const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
      await addGangMember(fx.gangId, owner);

      // แถวที่ค้าง processing มานาน (worker ตาย) — attempt 1 กับ attempt 3
      await pool.query(
        `insert into public.notifications
           (gang_id, recipient_id, channel, event_type, status, claimed_at, attempt)
         values ($1, $2, 'in_app', 'test.stuck', 'processing', now() - interval '1 hour', 1),
                ($1, $2, 'in_app', 'test.dead',  'processing', now() - interval '1 hour', 3)`,
        [fx.gangId, owner],
      );

      // แถวที่เพิ่ง claim ไป ต้องไม่ถูกแตะ
      await pool.query(
        `insert into public.notifications
           (gang_id, recipient_id, channel, event_type, status, claimed_at, attempt)
         values ($1, $2, 'in_app', 'test.fresh', 'processing', now(), 1)`,
        [fx.gangId, owner],
      );

      await pool.query('select public.sweep_stuck_notifications()');

      const { rows } = await pool.query<{
        event_type: string;
        status: string;
        retry_in_min: string;
      }>(
        `select event_type, status,
                round(extract(epoch from (next_retry_at - now())) / 60)::text retry_in_min
           from public.notifications where gang_id = $1 order by event_type`,
        [fx.gangId],
      );
      const byType = Object.fromEntries(rows.map((r) => [r.event_type, r]));

      // attempt 1 → คืนคิว รอ 5 นาที
      expect(byType['test.stuck'].status).toBe('pending');
      expect(Number(byType['test.stuck'].retry_in_min)).toBe(5);

      // attempt 3 → เกินโควต้า retry ⇒ failed ถาวร
      expect(byType['test.dead'].status).toBe('failed');

      // เพิ่ง claim → ไม่ถูกแตะ
      expect(byType['test.fresh'].status).toBe('processing');
    });

    it('purge_rate_limits ลบเฉพาะแถวที่หมดอายุ', async () => {
      const oldKey = `purge-old-${crypto.randomUUID()}`;
      const newKey = `purge-new-${crypto.randomUUID()}`;

      await pool.query(
        `insert into public.rate_limits (key, window_start, count)
         values ($1, now() - interval '3 days', 5), ($2, now(), 1)`,
        [oldKey, newKey],
      );

      await pool.query(`select public.purge_rate_limits()`);

      const { rows } = await pool.query<{ key: string }>(
        `select key from public.rate_limits where key in ($1, $2)`,
        [oldKey, newKey],
      );
      expect(rows.map((r) => r.key)).toEqual([newKey]);
    });
  });

  // ===========================================================================
  describe('EXECUTE grant ของฟังก์ชัน cron', () => {
    it('anon/authenticated เรียกฟังก์ชัน sweep ไม่ได้', async () => {
      const client = await pool.connect();
      try {
        for (const role of ['anon', 'authenticated']) {
          for (const fn of [
            'select public.sweep_waitlist()',
            'select public.sweep_stuck_notifications()',
            'select public.purge_rate_limits()',
          ]) {
            await client.query('begin');
            await client.query(`set local role ${role}`);
            await expect(client.query(fn), `${role} → ${fn}`).rejects.toThrow(/permission denied/);
            await client.query('rollback');
          }
        }
      } finally {
        client.release();
      }
    });
  });
});

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
