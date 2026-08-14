/**
 * WO-2.5-F DoD — guest token ย้ายจาก query string เข้า cookie httpOnly
 *
 *   · `/guest/<id>?t=` เปิดครั้งแรก → ตั้ง cookie → URL ไม่มี token อีก
 *   · เปิดซ้ำใช้ cookie
 *   · token ยังเก็บเป็น hash เท่านั้น
 *
 * เรียก **route handler จริง** (`app/guest/[registrationId]/claim/route.ts`)
 * ไม่ได้จำลอง logic ใหม่ ⇒ ถ้าใครแก้ handler จนพัง เทสต์นี้จับได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { GET: claim } = await import('@/app/guest/[registrationId]/claim/route');
const { GUEST_COOKIE, guestCookieOptions } = await import('@/lib/guest/session');

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`gc-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดที่เปิดรับแขก + แขกหนึ่งคนที่ลงชื่อแล้ว */
async function guestRegistration() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, allow_guests, snapshot, created_by)
     values ($1, 'แขกมาเล่น', now() + interval '2 days', now() + interval '2 days 2 hours', 8, true,
             '{"snapshot_version":1,"cancellation_policy":{"cutoff_hours":12,"allow_cancel_after_cutoff":true,"penalty_type":"full_share"}}'::jsonb,
             $2)
     returning id`,
    [gang.id, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const {
    rows: [invite],
  } = await pool.query<{ token: string }>(
    `select * from public.create_session_invite($1, null, 20, $2)`,
    [session.id, owner],
  );

  const {
    rows: [guest],
  } = await pool.query<{ registration_id: string; guest_token: string }>(
    `select * from public.register_guest($1, $2, null, $3)`,
    [session.id, 'แขกทดสอบ', invite.token],
  );

  return { sessionId: session.id, ...guest };
}

function claimRequest(registrationId: string, token: string | null): Request {
  const url = new URL(`http://localhost:3000/guest/${registrationId}/claim`);
  if (token !== null) url.searchParams.set('t', token);
  return new Request(url);
}

async function callClaim(registrationId: string, token: string | null) {
  return claim(claimRequest(registrationId, token), {
    params: Promise.resolve({ registrationId }),
  });
}

describe('WO-2.5-F DoD — แลก token เป็น cookie', () => {
  it('🔴 token ถูกต้อง → ตั้ง cookie httpOnly แล้ว redirect ไป URL ที่ไม่มี token', async () => {
    const guest = await guestRegistration();

    const response = await callClaim(guest.registration_id, guest.guest_token);

    expect(response.status).toBe(307);

    const location = response.headers.get('location')!;
    expect(location).toContain(`/guest/${guest.registration_id}`);
    // 🔴 หัวใจของ DoD: URL ปลายทางต้องไม่มี token
    expect(location).not.toContain(guest.guest_token);
    expect(new URL(location).search).toBe('');

    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${GUEST_COOKIE}=`);
    expect(setCookie).toContain(guest.guest_token);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain(`Path=/guest/${guest.registration_id}`);
  });

  it('🔴 token ผิด → ไม่ตั้ง cookie เลย (ไม่งั้นจะได้ cookie ขยะติดเครื่อง)', async () => {
    const guest = await guestRegistration();

    const response = await callClaim(guest.registration_id, 'token-ผิด');

    expect(response.status).toBe(307);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('ไม่มี token มาเลย → redirect เฉยๆ ไม่ตั้ง cookie', async () => {
    const guest = await guestRegistration();

    const response = await callClaim(guest.registration_id, null);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('🔴 token ของแขกคนหนึ่ง ใช้กับ registration ของอีกคนไม่ได้', async () => {
    const a = await guestRegistration();
    const b = await guestRegistration();

    const response = await callClaim(b.registration_id, a.guest_token);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('WO-2.5-F — ขอบเขตของ cookie', () => {
  it('🔴 path ผูกกับ registration นั้นคนเดียว ⇒ เบราว์เซอร์ไม่ส่งข้ามแขก', () => {
    const options = guestCookieOptions('11111111-1111-1111-1111-111111111111');

    expect(options.path).toBe('/guest/11111111-1111-1111-1111-111111111111');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('ฐานข้อมูลยังเก็บแค่ hash — plaintext อยู่ใน cookie ของแขกเท่านั้น', async () => {
    const guest = await guestRegistration();

    const {
      rows: [row],
    } = await pool.query<{ matches: boolean; raw: Buffer }>(
      `select guest_access_token_hash = extensions.digest($2, 'sha256') as matches,
              guest_access_token_hash as raw
         from public.session_registrations where id = $1`,
      [guest.registration_id, guest.guest_token],
    );

    expect(row.matches).toBe(true);
    expect(row.raw.toString('utf8')).not.toContain(guest.guest_token);
  });
});
