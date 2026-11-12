/**
 * Test harness สำหรับ concurrency tests ของ WO-1.3
 *
 * 🔴 baseline §Verification บังคับสองข้อ:
 *   1. RPC ยิงผ่าน **supabase-js** (client path เดียวกับ production) เป็นหลัก
 *   2. จุดที่ต้องต่อ Postgres ตรง ให้ต่อผ่าน **pooled port (transaction pooling)**
 *      ไม่ใช่ direct port — เพราะพฤติกรรม GUC/lock ต่างกัน:
 *      transaction pooling คืน connection เข้า pool ทุกครั้งที่จบ transaction
 *      ⇒ GUC ที่ set แบบ local จะไม่รั่วข้าม request ซึ่งเป็นสมมติฐานของ
 *        `set_config('app.allow_transition', ..., true)` ใน transition_session()
 *
 * local pooler = port 54329 (ไม่ใช่ 6543 ที่ baseline อ้าง — นั่นคือพอร์ตของ cloud)
 * บันทึกเป็น D-6 ใน STATE.md
 */
import { Pool, type PoolClient } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

/** connection string ผ่าน pooler — user ต้องเป็น `postgres.<tenant>` (tenant local = pooler-dev) */
export const POOLED_URL =
  process.env.SUPABASE_POOLED_URL ??
  'postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres';

export const API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54321';

/**
 * [planner, 31 ต.ค. 2026] **ห้าม hardcode secret/key ไว้ในไฟล์นี้** — อ่านจาก env ก่อนเสมอ ถ้าไม่มี
 * ให้เรียก `npx supabase status -o env` สดๆตอนรัน (memoize ในหน่วยความจำ ไม่เขียนลงดิสก์/ไม่ log ค่า
 * ออกไปที่ไหนเลย) เท่านั้น — ไม่มี fallback literal ใดๆในซอร์สโค้ด
 *
 * 🔴 เหตุผลที่ย้ายมาแบบนี้ (ไม่ใช่แค่ตามคำสั่ง): ไม่ว่า fallback literal เดิมของ `SERVICE_ROLE_KEY`
 * จะใช้งานได้จริงหรือไม่ก็ตาม (เรื่องนี้มีความเห็นต่างกันระหว่างรอบตรวจ — แจ้ง planner/QA แยกแล้วให้ไป
 * ยืนยันกันเอง ไม่ใช่สิ่งที่ต้องตัดสินในคอมเมนต์นี้) หลักการของ WO นี้คือ **ไม่ hardcode secret-shaped
 * literal ไว้ในซอร์สเลยไม่ว่ากรณีใด** — อ่านจาก env หรือ live `supabase status` เท่านั้น ไม่มี fallback
 * literal ใน git ให้ตรวจสอบ/โต้แย้งได้อีกต่อไป
 */
let cachedSupabaseStatusEnv: Readonly<Record<string, string>> | null = null;

function supabaseStatusEnv(): Readonly<Record<string, string>> {
  if (cachedSupabaseStatusEnv) return cachedSupabaseStatusEnv;
  // execSync (ผ่าน shell) ไม่ใช่ execFileSync — Windows ต้องมี shell ถึงจะ resolve `npx` เป็น `npx.cmd`
  // ผ่าน PATH ได้ (execFileSync เรียกตรงไม่ผ่าน shell เลย ⇒ ENOENT บน Windows)
  const output = execSync('npx supabase status -o env', { encoding: 'utf8' });
  const parsed: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) parsed[m[1]] = m[2];
  }
  cachedSupabaseStatusEnv = parsed;
  return parsed;
}

/** `supabase status -o env`'s legacy `SERVICE_ROLE_KEY`/`ANON_KEY` fields come back redacted in
 *  terminal output — the newer `SECRET_KEY`/`PUBLISHABLE_KEY` fields are the full, usable value
 *  for the same role; prefer those when reading live, exactly as used successfully for `npm run build`
 *  earlier this session. */
function requiredLocalSecret(envVarNames: readonly string[], statusKeys: readonly string[], label: string): string {
  for (const name of envVarNames) {
    const v = process.env[name];
    if (v) return v;
  }
  const status = supabaseStatusEnv();
  for (const key of statusKeys) {
    const v = status[key];
    if (v && !v.includes('...')) return v;
  }
  throw new Error(
    `[tests/helpers/db.ts] หา ${label} ไม่ได้ — export ${envVarNames[0]} เอง หรือรัน \`npx supabase start\` ให้ \`supabase status -o env\` มีค่านี้ (ห้าม hardcode ไว้ในไฟล์)`,
  );
}

export const SERVICE_ROLE_KEY = requiredLocalSecret(
  ['SUPABASE_SERVICE_ROLE_KEY'],
  ['SECRET_KEY', 'SERVICE_ROLE_KEY'],
  'service role key',
);

/** anon key ของ local supabase — ใช้คู่กับ JWT ของ user จริงใน `userClient()` (ต่างจาก SERVICE_ROLE_KEY ที่ bypass RLS) */
export const ANON_KEY = requiredLocalSecret(
  ['SUPABASE_ANON_KEY'],
  ['PUBLISHABLE_KEY', 'ANON_KEY'],
  'anon/publishable key',
);

/** `supabase status` JWT_SECRET ของ local dev — ใช้เซ็น JWT ใน `userClient()` เท่านั้น ไม่ hardcode/ไม่ log */
export const JWT_SECRET = requiredLocalSecret(['SUPABASE_JWT_SECRET'], ['JWT_SECRET'], 'JWT secret');

/**
 * pool ที่ทุกเทสต์ใช้ร่วมกัน — max ต้องมากพอให้ request ที่ยิงพร้อมกัน
 * ได้ connection คนละเส้นจริง ไม่งั้นจะกลายเป็นรันเรียงกันแล้วเทสต์ผ่านแบบหลอกๆ
 */
export const pool = new Pool({ connectionString: POOLED_URL, max: 20 });

export function serviceClient(): SupabaseClient {
  return createClient(API_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * [WO-6.5c, planner 31 ต.ค. 2026] client ของ **user จริง** ที่ RLS มีผลจริง — ต่างจาก `asRole()`
 * ข้างบนที่สวม role ที่ระดับ raw Postgres connection (ข้าม PostgREST ไปเลย) ตัวนี้เซ็น JWT ด้วย
 * `JWT_SECRET` ของ local dev แล้วยิงผ่าน PostgREST จริงด้วย anon key + `Authorization: Bearer`
 * — เส้นทางเดียวกับที่ production ใช้ (`supabaseServer()` คือ client ที่ตั้ง header นี้จาก session
 * cookie) เอาไว้พิสูจน์ RLS end-to-end ให้ server action ตัวที่ไม่ได้ mock DB query เลย
 *
 * HS256 เซ็นมือด้วย `node:crypto` ไม่พึ่ง lib JWT เพิ่ม (payload เล็ก ไม่มี deps ให้ลดความเสี่ยง)
 */
function signLocalJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function userClient(userId: string): SupabaseClient {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signLocalJwt({ sub: userId, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 });
  return createClient(API_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * PostgREST cache ชื่อฟังก์ชันไว้ — หลัง migration ใหม่ต้องสั่ง reload ไม่งั้น RPC จะ 404
 *
 * มี retry เพราะถ้ารันต่อจาก `supabase db reset` ทันที pooler ยังรีสตาร์ตไม่เสร็จ
 * → connection แรกจะโดน ECONNRESET แล้วทั้งไฟล์ fail ทั้งที่โค้ดไม่ได้ผิด
 */
export async function reloadPostgrestSchema(retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`select pg_notify('pgrst', 'reload schema')`);
      await new Promise((r) => setTimeout(r, 1500));
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export type Fixture = {
  orgId: string;
  gangId: string;
  sessionId: string;
};

export async function createUser(displayName: string): Promise<string> {
  const {
    rows: [{ id }],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id) values (gen_random_uuid()) returning id`,
  );
  // trigger `on_auth_user_created` สร้างแถว profile ให้แล้ว (WO-2.2)
  // ⇒ ต้อง upsert ไม่ใช่ insert และต้องเขียนทับชื่อ เพราะ trigger ใส่ค่า fallback
  //   ให้ (user ในเทสต์ไม่มี email) แต่เทสต์อยากได้ชื่อที่ตัวเองกำหนด
  await pool.query(
    `insert into public.profiles (id, display_name) values ($1, $2)
     on conflict (id) do update set display_name = excluded.display_name`,
    [id, displayName],
  );
  return id;
}

/**
 * สร้างก๊วน + นัดหนึ่งใบพร้อมใช้
 *
 * ⚠️ insert sessions ด้วย status ที่ต้องการได้ตรงๆ เพราะ guard เป็น BEFORE **UPDATE**
 *    (baseline บังคับเฉพาะ UPDATE) — สะดวกสำหรับ fixture แต่เป็นช่องที่ควรปิดใน WO-1.4
 *    บันทึกไว้ใน BACKLOG แล้ว
 */
export async function createFixture(opts: {
  ownerId: string;
  maxPlayers: number;
  status?: string;
  allowGuests?: boolean;
  guestsFeature?: boolean;
  cutoffHours?: number;
  startsInHours?: number;
}): Promise<Fixture> {
  const {
    ownerId,
    maxPlayers,
    status = 'open',
    allowGuests = true,
    guestsFeature = true,
    cutoffHours = 12,
    startsInHours = 48,
  } = opts;

  const {
    rows: [org],
  } = await pool.query<{ id: string }>(
    `insert into public.organizations (name, owner_id) values ($1, $2) returning id`,
    [`org-${Date.now()}-${Math.random()}`, ownerId],
  );

  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(
    `insert into public.gangs (org_id, name, features, cancellation_policy)
     values ($1, $2, $3::jsonb, $4::jsonb)
     returning id`,
    [
      org.id,
      `gang-${Date.now()}-${Math.random()}`,
      JSON.stringify({
        line: false,
        discovery: false,
        guests: guestsFeature,
        coupons: false,
        statistics: true,
      }),
      JSON.stringify({ cutoff_hours: cutoffHours, allow_cancel_after_cutoff: true }),
    ],
  );

  // 🔴 snapshot = บันทึกแช่แข็ง ต้องมี cancellation_policy อยู่ในนี้
  //    cancel_registration อ่านจาก snapshot เท่านั้น ไม่อ่าน gangs.cancellation_policy
  const snapshot = {
    snapshot_version: 1,
    cancellation_policy: { cutoff_hours: cutoffHours, allow_cancel_after_cutoff: true },
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } },
    promptpay_id: '0812345678',
  };

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, allow_guests, snapshot, created_by)
     values ($1, $2, now() + ($3 || ' hours')::interval, now() + (($3::numeric + 2) || ' hours')::interval,
             $4, $5, $6, $7::jsonb, $8)
     returning id`,
    [
      gang.id,
      'concurrency-test session',
      String(startsInHours),
      maxPlayers,
      status,
      allowGuests,
      JSON.stringify(snapshot),
      ownerId,
    ],
  );

  return { orgId: org.id, gangId: gang.id, sessionId: session.id };
}

/** เพิ่มสมาชิกก๊วน (บาง flow ต้องการให้มีแถว gang_members อยู่จริง) */
export async function addGangMember(gangId: string, userId: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
    [gangId, userId],
  );
  return row.id;
}

export async function registrationsOf(sessionId: string) {
  const { rows } = await pool.query<{
    id: string;
    user_id: string | null;
    status: string;
    ordering: number;
    created_at: string;
  }>(
    `select id, user_id, status, ordering, created_at
       from public.session_registrations
      where session_id = $1 and deleted_at is null
      order by created_at`,
    [sessionId],
  );
  return rows;
}

export async function countByStatus(sessionId: string): Promise<Record<string, number>> {
  const rows = await registrationsOf(sessionId);
  return rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
}

/**
 * รัน query ในฐานะผู้ใช้จริง เพื่อให้ RLS ทำงาน
 *
 * connection ปกติของเทสต์เป็น `postgres` ซึ่งมี BYPASSRLS ⇒ policy ไม่ถูกตรวจเลย
 * ต้องสวมบทบาทให้ครบสองชั้น:
 *   1. `request.jwt.claims` — `auth.uid()` อ่าน `sub` จากตรงนี้
 *   2. `set local role` — RLS เลือก policy ตาม role (`anon` / `authenticated`)
 *
 * ทั้งคู่ตั้งแบบ transaction-local แล้วปิดท้ายด้วย rollback เสมอ ⇒ สิทธิ์ไม่รั่ว
 * ไปหา query ถัดไปที่ใช้ connection เส้นเดียวกันจาก pool
 */
export async function asRole<T>(
  role: 'anon' | 'authenticated',
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role }),
    ]);
    await client.query(`set local role ${role}`);
    return await fn(client);
  } finally {
    // rollback เสมอ ไม่ว่าสำเร็จหรือไม่ — เทสต์ RLS เป็นการ "อ่าน" เป็นหลัก
    // และการทิ้ง state ไว้จะทำให้เทสต์ถัดไปเพี้ยน
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/**
 * เหมือน `asRole()` แต่ **commit** แทน rollback
 *
 * ใช้เฉพาะเทสต์ที่ต้องพิสูจน์ว่า "เขียนติดจริง" — `asRole()` ที่ rollback เสมอจะทำให้
 * เทสต์แบบนั้นอ่านผลไม่ได้ (rowCount บอกว่า 1 แต่ค่าไม่เปลี่ยนหลังจบ transaction)
 *
 * ⚠️ ทิ้ง state ไว้ในฐานข้อมูล ⇒ ใช้กับ fixture ที่สร้างใหม่เฉพาะเทสต์นั้นเท่านั้น
 *    ห้ามใช้แก้ข้อมูลที่เทสต์อื่นพึ่งพา
 */
export async function asRoleCommitted<T>(
  role: 'anon' | 'authenticated',
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role }),
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * จำนวนแถวที่มองเห็น หรือ `'denied'` ถ้าถูกปฏิเสธตั้งแต่ระดับ GRANT
 *
 * การกันข้อมูลมีสองด่าน: table GRANT (error 42501) แล้วค่อย RLS (คืน 0 แถว)
 * เทสต์ที่ถามว่า "อ่านได้ไหม" ต้องรับได้ทั้งสองแบบ — ไม่งั้นเวลาเราปิดแน่นขึ้น
 * ด้วยการถอด GRANT เทสต์จะกลายเป็นสีแดงทั้งที่ผลลัพธ์ปลอดภัยกว่าเดิม
 */
export async function readAccess(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  role: 'anon' | 'authenticated' = 'authenticated',
): Promise<number | 'denied'> {
  try {
    return await visibleCount(userId, sql, params, role);
  } catch (err) {
    if ((err as { code?: string }).code === '42501') return 'denied';
    throw err;
  }
}

/** ทางลัดสำหรับเคสที่ต้องการแค่จำนวนแถวที่ผู้ใช้คนนั้น "มองเห็น" */
export async function visibleCount(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  role: 'anon' | 'authenticated' = 'authenticated',
): Promise<number> {
  return asRole(role, userId, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `select count(*)::text n from (${sql}) q`,
      params,
    );
    return Number(rows[0].n);
  });
}

/**
 * ยิงงานหลายชิ้นให้ "ออกตัวพร้อมกันจริง"
 *
 * แค่ Promise.all เฉยๆ ยังไม่พอ เพราะแต่ละงานต้องรอจับ connection จาก pool
 * ก่อน ซึ่งทำให้ทยอยเริ่มไม่พร้อมกัน — จับ connection ให้ครบก่อน แล้วค่อย
 * ปล่อยพร้อมกันด้วย barrier เดียว
 */
export async function runConcurrently<T>(
  count: number,
  task: (client: PoolClient, index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = clients.map((client, i) =>
    barrier.then(() => task(client, i)),
  );

  release();

  try {
    return await Promise.allSettled(running);
  } finally {
    clients.forEach((c) => c.release());
  }
}
