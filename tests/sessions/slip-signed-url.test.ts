/**
 * R-roles-3 Phase 2 — planner decision 3 follow-up: `slipSignedUrl()` was
 * rewritten from a hardcoded `['owner','admin'].includes(role)` bypass of
 * `can()` to `isOwner || can(ctx, 'payment.verify')` using the loader
 * (server/actions/payments.ts, commit 0126031). Planner required a real
 * test proving: owner/admin/treasurer get the URL, other members get
 * FORBIDDEN, and the slip's own owner gets it regardless of role — "ถ้า
 * storage RLS ไม่ให้ treasurer อ่าน object ให้หยุดแล้วแจ้ง".
 *
 * Checked first (no stop needed): `slipSignedUrl()` calls
 * `admin.storage.from(...).createSignedUrl(...)` using the SERVICE-ROLE
 * client, which bypasses storage RLS entirely — so storage policy cannot
 * block a treasurer here regardless of what it says. The only real gate is
 * the `can()` check this WO just fixed. (Storage RLS for `payment-slips`
 * already recognizes `payment.verify` via `gangs_with_permission()` since
 * migration 0051 anyway — see `payment_slips_select`/`_update` there and
 * `tests/sessions/treasurer-finance.test.ts` lines 267/335, already
 * QA-approved — so even a non-admin path would not have been blocked.)
 *
 * Mock boundary: same convention as every other action test in this repo —
 * `@/lib/supabase/auth`/`@/lib/supabase/server`/`@/lib/supabase/admin` point
 * at `serviceClient()` / a swappable actor id; `slipSignedUrl()` itself and
 * `loadGangPermissionContext()` inside it are real, unmocked, against the
 * real local DB + real storage.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, reloadPostgrestSchema } from '../helpers/db';

const h = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => serviceClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { slipSignedUrl } from '@/server/actions/payments';

afterAll(async () => {
  await pool.end();
});

beforeAll(async () => {
  await reloadPostgrestSchema();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`slip-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function setup() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-slip-${crypto.randomUUID()}`,
  ]);
  const addMember = async (role = 'member') => {
    const u = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [
      gang.id,
      u,
      role,
    ]);
    return u;
  };
  const admin = await addMember('admin');
  const treasurer = await addMember();
  const payer = await addMember();
  const stranger = await addMember();
  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`, [gang.id, treasurer, owner]);

  const {
    rows: [payment],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by, slip_url)
     values ($1, $2, 150, $3, $4) returning id`,
    [gang.id, payer, owner, `${gang.id}/placeholder/slip.jpg`],
  );
  // slip_url จริงต้องมีบรรทัดนี้ก่อน — server ประกอบ path จาก paymentSlipPath() เสมอ ไม่ใช่รับจาก client
  const slipPath = `${gang.id}/${payment.id}/slip.jpg`;
  await pool.query(`update public.payments set slip_url = $2 where id = $1`, [payment.id, slipPath]);

  const admin2 = serviceClient();
  const { error: uploadErr } = await admin2.storage
    .from('payment-slips')
    .upload(slipPath, Buffer.from('fake-slip-bytes'), { contentType: 'image/jpeg', upsert: true });
  if (uploadErr) throw uploadErr;

  return { gangId: gang.id, owner, admin, treasurer, payer, stranger, paymentId: payment.id };
}

type World = Awaited<ReturnType<typeof setup>>;
let wp: Promise<World> | undefined;
const world = () => (wp ??= setup());

describe('slipSignedUrl() — real DB + real storage, planner decision 3', () => {
  it('🔴 owner/admin/treasurer (delegated payment.verify) all get a real signed URL', async () => {
    const w = await world();
    for (const uid of [w.owner, w.admin, w.treasurer]) {
      h.userId = uid;
      const res = await slipSignedUrl(w.paymentId);
      expect(res.success, `uid=${uid}`).toBe(true);
      if (res.success) expect(res.data.url).toMatch(/^https?:\/\//);
    }
  });

  it('slip owner (plain member who paid, no delegated role) gets the URL too', async () => {
    const w = await world();
    h.userId = w.payer;
    const res = await slipSignedUrl(w.paymentId);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.url).toMatch(/^https?:\/\//);
  });

  it('🔴 an unrelated plain member (not owner, not payer, no delegated payment.verify) gets FORBIDDEN', async () => {
    const w = await world();
    h.userId = w.stranger;
    const res = await slipSignedUrl(w.paymentId);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('outsider (not a member of the gang at all) gets FORBIDDEN, not a leak of membership status', async () => {
    const w = await world();
    const outsider = await newUser();
    h.userId = outsider;
    const res = await slipSignedUrl(w.paymentId);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
  });
});
