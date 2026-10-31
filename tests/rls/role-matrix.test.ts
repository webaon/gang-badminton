/**
 * R-roles-0 (ADR-015) — GOLDEN ROLE-MATRIX: ภาพถ่ายสิทธิ์ตาม role ของระบบ "ตอนนี้" (ก่อนเพิ่มชุดสิทธิ์)
 *
 * ทำไมมี: ADR-015 จะเปลี่ยน `is_gang_admin(...)` → `has_gang_permission(...)` ใน ~35 policy และ ~9 DB function
 *   ทีละกลุ่ม (expand → migrate → contract) — ไฟล์นี้คือด่านที่พิสูจน์ว่า "ไม่มีใครเสียสิทธิ์ ไม่มีใครได้สิทธิ์เพิ่ม"
 *   ในทุกขั้นก่อนที่จะมีผู้ถือชุดสิทธิ์จริง ต้องผ่านบนโค้ดปัจจุบันและผ่านเท่าเดิมหลังทุก migration ของ ADR-015
 *
 * ครอบคลุม (ตาม ADR-015 §Context):
 *   1. can() ทุก action × {owner, admin, member, คนนอก, แอดมินองค์กร} × feature flag เปิดทั้งหมด/ปิดทั้งหมด
 *   2. RLS probe จริง (role authenticated/anon) ทุกตาราง + storage policy ที่ ADR ไล่ไว้ × select/insert/update/delete
 *      × {owner, admin, member, payer(เจ้าของสลิป), orgAdmin(แอดมินองค์กรที่ไม่ใช่สมาชิกก๊วน), outsider, anon}
 *   3. ตัวช่วย RLS: is_gang_admin / is_session_admin / is_payment_visible ต่อ identity
 *   4. DB function ที่เช็ค role/แอดมินเอง (เรียกด้วย service_role + p_actor_id) × actor ทุกตัว
 *   5. EXECUTE grant ของฟังก์ชันทั้งหมดข้างบน (anon/authenticated/service_role)
 *   6. inventory: รายชื่อ policy + function ที่อ้างตัวช่วยแอดมิน/เช็ค role — ถ้ามีตัวใหม่โผล่ ต้องเข้า matrix ก่อน
 *
 * ผลที่คาดอยู่ใน `role-matrix.golden.json` (เทียบ deep-equal) — สร้างใหม่ด้วย ROLE_MATRIX_UPDATE=1
 *   ⚠️ การ "อัปเดต golden" = การตัดสินว่าสิทธิ์เปลี่ยนโดยตั้งใจ ต้องผ่าน QA/planner ดู diff ของไฟล์ JSON
 *   ⚠️ กัน regenerate โดยไม่ตั้งใจ: มี invariants ในโค้ด (ด้านล่าง) ที่ golden ใหม่ก็ต้องผ่าน — คนนอก/anon เขียนอะไรไม่ได้,
 *      สมาชิกทั่วไปเขียนตารางแอดมินไม่ได้, admin ทำได้ทุกอย่างที่ member ทำได้
 *
 * ไม่แตะ policy/function/migration ใดๆ — อ่านและ probe อย่างเดียว (ทุก probe รันใน txn แล้ว rollback)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pool, asRole, createUser, reloadPostgrestSchema } from '../helpers/db';
import { allowedActions } from '@/domain/permissions/can';
import { FEATURES, type GangFeatures, type PermissionContext } from '@/domain/permissions/types';

const GOLDEN_PATH = join(__dirname, 'role-matrix.golden.json');
const UPDATE = process.env.ROLE_MATRIX_UPDATE === '1';

type Identity = 'owner' | 'admin' | 'member' | 'payer' | 'orgAdmin' | 'outsider' | 'anon';
const IDENTITIES: Identity[] = ['owner', 'admin', 'member', 'payer', 'orgAdmin', 'outsider', 'anon'];

type Golden = {
  can: Record<string, Record<string, string[]>>;
  rls: Record<string, Record<Identity, string>>;
  helpers: Record<string, Record<Identity, string>>;
  functions: Record<string, Record<string, string>>;
  grants: Record<string, Record<string, boolean>>;
  inventory: { policies: string[]; functions: string[] };
};

const observed: Golden = { can: {}, rls: {}, helpers: {}, functions: {}, grants: {}, inventory: { policies: [], functions: [] } };

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

type World = {
  users: Record<Exclude<Identity, 'anon'>, string> & { extra: string; extra2: string };
  spareRegs: string[];
  gang: string;
  org: string;
  memberRowId: string;
  payerMemberRowId: string;
  session: string;
  draftSession: string;
  regPayer: string;
  regMember: string;
  chargePayer: string;
  chargeMember: string;
  payPayer: string;
  payMember: string;
  announcementPublished: string;
};

let W: World;

const SNAPSHOT = {
  snapshot_version: 1,
  pricing_plan: { id: null, name: 'เหมาจ่าย', type: 'flat_rate', params: { amount_per_person: '150.00' } },
  rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
  promptpay_id: '0812345678',
  cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
  skill_levels: [],
};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pool.query<T extends object ? T : never>(sql, params)).rows[0] as T;
}

async function openSession(gang: string, owner: string, max: number, title: string): Promise<string> {
  const s = await one<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, $2, now() + interval '48 hours', now() + interval '50 hours', $3, $4::jsonb, $5) returning id`,
    [gang, title, max, JSON.stringify(SNAPSHOT), owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [s.id, owner]);
  return s.id;
}

async function buildWorld(): Promise<World> {
  const owner = await createUser('rm-owner');
  const admin = await createUser('rm-admin');
  const member = await createUser('rm-member');
  const payer = await createUser('rm-payer');
  const orgAdmin = await createUser('rm-orgadmin');
  const outsider = await createUser('rm-outsider');
  const extra = await createUser('rm-extra');
  const extra2 = await createUser('rm-extra2');

  const g = await one<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-rm-${crypto.randomUUID()}`]);
  const org = await one<{ org_id: string }>(`select org_id from public.gangs where id = $1`, [g.id]);
  await pool.query(
    `insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin') on conflict do nothing`,
    [org.org_id, orgAdmin],
  );

  const mk = async (user: string, role: string) =>
    (
      await one<{ id: string }>(
        `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3) returning id`,
        [g.id, user, role],
      )
    ).id;
  await mk(admin, 'admin');
  await mk(extra2, 'member'); // ผู้รับเครดิตใน probe ฟังก์ชัน (ไม่มีหนี้ ⇒ ไม่ถูกหักอัตโนมัติ)
  const memberRowId = await mk(member, 'member');
  const payerMemberRowId = await mk(payer, 'member');

  const session = await openSession(g.id, owner, 6, 'นัดหลัก');
  const draftSession = (
    await one<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
       values ($1, 'ร่าง', now() + interval '3 days', now() + interval '3 days 2 hours', 4, 'draft', $2::jsonb, $3) returning id`,
      [g.id, JSON.stringify(SNAPSHOT), owner],
    )
  ).id;

  const reg = async (user: string) =>
    (await one<{ id: string }>(`select id from public.register_to_session($1, $2)`, [session, user])).id;
  const regPayer = await reg(payer);
  const regMember = await reg(member);

  // games ต้องการผู้เล่น 4 ใบ → guest 4 ใบ
  const guestRegs: string[] = [];
  for (let i = 0; i < 4; i++) {
    guestRegs.push(
      (
        await one<{ id: string }>(
          `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
           values ($1, $2, 'confirmed', $3, $4) returning id`,
          [session, `แขก-${i}`, 10 + i, owner],
        )
      ).id,
    );
  }

  // แขกอีก 4 ใบสำหรับ probe insert games (ต้องไม่ซ้ำกับเกมที่มีอยู่ ไม่งั้นตกที่ constraint แทนที่จะวัดสิทธิ์)
  const spareRegs: string[] = [];
  for (let i = 0; i < 4; i++) {
    spareRegs.push(
      (
        await one<{ id: string }>(
          `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
           values ($1, $2, 'confirmed', $3, $4) returning id`,
          [session, `แขกสำรอง-${i}`, 30 + i, owner],
        )
      ).id,
    );
  }

  // ตารางตั้งค่า/การเงินของก๊วน
  await pool.query(`insert into public.gang_skill_levels (gang_id, label, rank) values ($1, 'ระดับ 1', 1)`, [g.id]);
  await pool.query(`insert into public.gang_pricing_plans (gang_id, name, type) values ($1, 'เหมาจ่าย', 'flat_rate')`, [g.id]);
  await pool.query(
    `insert into public.session_templates (gang_id, name, recurrence, max_players) values ($1, 'ทุกพุธ', '{"freq":"weekly"}'::jsonb, 8)`,
    [g.id],
  );
  await pool.query(`insert into public.coupons (gang_id, code, discount_type, discount_value) values ($1, 'RM10', 'fixed', 10)`, [g.id]);
  await pool.query(`insert into public.gang_expenses (gang_id, category, amount) values ($1, 'ค่าสนาม', 100)`, [g.id]);
  await pool.query(`insert into public.gang_incomes (gang_id, category, amount) values ($1, 'สปอนเซอร์', 500)`, [g.id]);

  const annPub = (
    await one<{ id: string }>(
      `insert into public.announcements (gang_id, title, body, published_at) values ($1, 'ประกาศ', 'เนื้อหา', now()) returning id`,
      [g.id],
    )
  ).id;
  await pool.query(`insert into public.announcements (gang_id, title, body) values ($1, 'ร่างประกาศ', 'ยังไม่เผยแพร่')`, [g.id]);

  await pool.query(
    `insert into public.session_invite_tokens (session_id, token_hash, expires_at) values ($1, decode(md5(random()::text), 'hex'), now() + interval '1 day')`,
    [session],
  );
  await pool.query(
    `insert into public.games (session_id, court_no, player1_registration_id, player2_registration_id, player3_registration_id, player4_registration_id)
     values ($1, 1, $2, $3, $4, $5)`,
    [session, guestRegs[0], guestRegs[1], guestRegs[2], guestRegs[3]],
  );

  await pool.query(`insert into public.notification_logs (gang_id, channel, success) values ($1, 'in_app', true)`, [g.id]);
  await pool.query(`insert into public.member_line_links (gang_id, user_id, line_user_id) values ($1, $2, $3)`, [g.id, member, `U-rm-${crypto.randomUUID()}`]);
  await pool.query(`insert into public.join_requests (gang_id, user_id) values ($1, $2)`, [g.id, outsider]);
  await pool.query(
    `insert into public.member_statistics (gang_id, gang_member_id) values ($1, $2), ($1, $3)`,
    [g.id, memberRowId, payerMemberRowId],
  );

  // event_logs: เรื่องเงิน (admin เท่านั้น) / audit / เหตุการณ์ทั่วไปของนัด
  await pool.query(
    `insert into public.event_logs (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
     values ($1, $2, 'payment.created', 'payment', gen_random_uuid(), $3, '{}'::jsonb),
            ($1, $2, 'audit.test_probe', 'gang', $1, $3, '{}'::jsonb),
            ($1, $2, 'session.opened', 'session', $2, $3, '{}'::jsonb)`,
    [g.id, session, owner],
  );

  // หนี้ + สลิป: payer มีหนี้ผูก registration (type session) และ monthly_fee; member มีหนี้ monthly_fee
  const chargePayer = (
    await one<{ id: string }>(
      `insert into public.session_charges (gang_id, type, session_id, registration_id, amount) values ($1, 'session', $2, $3, 100) returning id`,
      [g.id, session, regPayer],
    )
  ).id;
  const chargeMember = (
    await one<{ id: string }>(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount) values ($1, 'monthly_fee', $2, '1971-01-01', 80) returning id`,
      [g.id, memberRowId],
    )
  ).id;

  const mkPay = async (payerUser: string, chargeId: string, verified: boolean) => {
    const p = await one<{ id: string }>(
      `select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [g.id, payerUser, [chargeId], owner],
    );
    if (verified) {
      await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payerUser]);
      await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, owner]);
    }
    return p.id;
  };
  const payPayer = await mkPay(payer, chargePayer, true);
  const payMember = await mkPay(member, chargeMember, false);
  await pool.query(
    `insert into public.payment_adjustments (session_charge_id, type, amount, reason) values ($1, 'credit', -10, 'ส่วนลด')`,
    [chargePayer],
  );

  // เครดิต: payer ได้ topup จากแอดมิน (ledger + balance) · member ได้อีกก้อน
  await pool.query(`select public.credit_topup($1, $2, 20, 'ชดเชย', $3)`, [g.id, payer, owner]);
  await pool.query(`select public.credit_topup($1, $2, 5, 'ชดเชย', $3)`, [g.id, member, owner]);

  // storage: สลิป (เจ้าของ = payer / member) · gang-assets · announcement-images
  const obj = (bucket: string, name: string, ownerId: string | null) =>
    pool.query(`insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)`, [bucket, `${g.id}/${name}`, ownerId]);
  await obj('payment-slips', 'payer-slip.png', payer);
  await obj('payment-slips', 'member-slip.png', member);
  await obj('gang-assets', 'logo.png', owner);
  await obj('announcement-images', 'a.png', owner);

  return {
    users: { owner, admin, member, payer, orgAdmin, outsider, extra, extra2 },
    spareRegs,
    gang: g.id,
    org: org.org_id,
    memberRowId,
    payerMemberRowId,
    session,
    draftSession,
    regPayer,
    regMember,
    chargePayer,
    chargeMember,
    payPayer,
    payMember,
    announcementPublished: annPub,
  };
}

// ---------------------------------------------------------------------------
// probe helpers
// ---------------------------------------------------------------------------

const uidOf = (id: Identity): string | null => (id === 'anon' ? null : W.users[id]);

/** แทนที่ {uid} ด้วยผู้ใช้ของ identity (uuid เท่านั้น ไม่มีข้อมูลจากภายนอก) */
const bind = (sql: string, id: Identity) => sql.replaceAll('{uid}', uidOf(id) ?? '00000000-0000-0000-0000-000000000000');

async function probe(id: Identity, kind: 'select' | 'insert' | 'update' | 'delete', sql: string): Promise<string> {
  const role = id === 'anon' ? 'anon' : 'authenticated';
  try {
    return await asRole(role, uidOf(id), async (c) => {
      if (kind === 'select') {
        const { rows } = await c.query<{ n: string }>(`select count(*)::text n from (${bind(sql, id)}) q`);
        return `rows:${rows[0].n}`;
      }
      const r = await c.query(bind(sql, id));
      if (kind === 'insert') return r.rowCount && r.rowCount > 0 ? 'allow' : 'deny';
      return r.rowCount && r.rowCount > 0 ? 'allow' : 'deny';
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    // 42501 = ไม่มี GRANT หรือ RLS WITH CHECK ไม่ผ่าน · อื่นๆ = ผ่าน RLS แต่ตกที่ constraint/FK (บันทึกรหัสไว้ — ยังเป็น "ผ่านด่านสิทธิ์")
    return code === '42501' ? 'deny' : `err:${code}`;
  }
}

type Probe = { key: string; sel?: string; ins?: string; upd?: string; del?: string };

function probes(): Probe[] {
  const g = W.gang;
  const u = W.users;
  return [
    {
      key: 'gangs',
      sel: `select 1 from public.gangs where id = '${g}'`,
      ins: `insert into public.gangs (org_id, name) values ('${W.org}', 'rm-ins-${crypto.randomUUID()}')`,
      upd: `update public.gangs set name = name where id = '${g}'`,
      del: `delete from public.gangs where id = '${g}'`,
    },
    {
      key: 'gang_members',
      sel: `select 1 from public.gang_members where gang_id = '${g}' and deleted_at is null`,
      ins: `insert into public.gang_members (gang_id, user_id, role) values ('${g}', '${u.extra}', 'member')`,
      upd: `update public.gang_members set role = role where id = '${W.memberRowId}'`,
      del: `delete from public.gang_members where id = '${W.memberRowId}'`,
    },
    {
      key: 'gang_skill_levels',
      sel: `select 1 from public.gang_skill_levels where gang_id = '${g}'`,
      ins: `insert into public.gang_skill_levels (gang_id, label, rank) values ('${g}', 'x', 99)`,
      upd: `update public.gang_skill_levels set label = label where gang_id = '${g}'`,
      del: `delete from public.gang_skill_levels where gang_id = '${g}'`,
    },
    {
      key: 'gang_pricing_plans',
      sel: `select 1 from public.gang_pricing_plans where gang_id = '${g}'`,
      ins: `insert into public.gang_pricing_plans (gang_id, name, type) values ('${g}', 'x', 'flat_rate')`,
      upd: `update public.gang_pricing_plans set name = name where gang_id = '${g}'`,
      del: `delete from public.gang_pricing_plans where gang_id = '${g}'`,
    },
    {
      key: 'session_templates',
      sel: `select 1 from public.session_templates where gang_id = '${g}'`,
      ins: `insert into public.session_templates (gang_id, name, recurrence, max_players) values ('${g}', 'x', '{}'::jsonb, 4)`,
      upd: `update public.session_templates set name = name where gang_id = '${g}'`,
      del: `delete from public.session_templates where gang_id = '${g}'`,
    },
    {
      key: 'coupons',
      sel: `select 1 from public.coupons where gang_id = '${g}'`,
      ins: `insert into public.coupons (gang_id, code, discount_type, discount_value) values ('${g}', 'X${Date.now()}', 'fixed', 1)`,
      upd: `update public.coupons set code = code where gang_id = '${g}'`,
      del: `delete from public.coupons where gang_id = '${g}'`,
    },
    {
      key: 'gang_expenses',
      sel: `select 1 from public.gang_expenses where gang_id = '${g}'`,
      ins: `insert into public.gang_expenses (gang_id, category, amount) values ('${g}', 'x', 1)`,
      upd: `update public.gang_expenses set category = category where gang_id = '${g}'`,
      del: `delete from public.gang_expenses where gang_id = '${g}'`,
    },
    {
      key: 'gang_incomes',
      sel: `select 1 from public.gang_incomes where gang_id = '${g}'`,
      ins: `insert into public.gang_incomes (gang_id, category, amount) values ('${g}', 'x', 1)`,
      upd: `update public.gang_incomes set category = category where gang_id = '${g}'`,
      del: `delete from public.gang_incomes where gang_id = '${g}'`,
    },
    {
      key: 'announcements',
      sel: `select 1 from public.announcements where gang_id = '${g}'`,
      ins: `insert into public.announcements (gang_id, title, body) values ('${g}', 'x', 'y')`,
      upd: `update public.announcements set title = title where gang_id = '${g}'`,
      del: `delete from public.announcements where gang_id = '${g}'`,
    },
    {
      key: 'sessions',
      sel: `select 1 from public.sessions where gang_id = '${g}'`,
      ins: `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
             values ('${g}', 'x', now() + interval '5 days', now() + interval '5 days 2 hours', 4, 'draft', '{}'::jsonb, '{uid}')`,
      upd: `update public.sessions set title = title where gang_id = '${g}'`,
      del: `delete from public.sessions where id = '${W.draftSession}'`,
    },
    {
      key: 'session_invite_tokens',
      sel: `select 1 from public.session_invite_tokens where session_id = '${W.session}'`,
      ins: `insert into public.session_invite_tokens (session_id, token_hash, expires_at) values ('${W.session}', decode(md5(random()::text), 'hex'), now() + interval '1 day')`,
      upd: `update public.session_invite_tokens set expires_at = expires_at where session_id = '${W.session}'`,
      del: `delete from public.session_invite_tokens where session_id = '${W.session}'`,
    },
    {
      key: 'games',
      sel: `select 1 from public.games where session_id = '${W.session}'`,
      ins: `insert into public.games (session_id, court_no, player1_registration_id, player2_registration_id, player3_registration_id, player4_registration_id)
             values ('${W.session}', 2, '${W.spareRegs[0]}', '${W.spareRegs[1]}', '${W.spareRegs[2]}', '${W.spareRegs[3]}')`,
      upd: `update public.games set court_no = court_no where session_id = '${W.session}'`,
      del: `delete from public.games where session_id = '${W.session}'`,
    },
    {
      key: 'session_charges',
      sel: `select 1 from public.session_charges where gang_id = '${g}'`,
      ins: `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount) values ('${g}', 'monthly_fee', '${W.memberRowId}', '1972-01-01', 1)`,
      upd: `update public.session_charges set amount = amount where gang_id = '${g}'`,
      del: `delete from public.session_charges where gang_id = '${g}'`,
    },
    {
      key: 'payments',
      sel: `select 1 from public.payments where gang_id = '${g}'`,
      ins: `insert into public.payments (gang_id, payer_user_id, amount) values ('${g}', '{uid}', 10)`,
      upd: `update public.payments set amount = amount where gang_id = '${g}'`,
      del: `delete from public.payments where gang_id = '${g}'`,
    },
    {
      key: 'payment_allocations',
      sel: `select 1 from public.payment_allocations where payment_id in ('${W.payPayer}', '${W.payMember}')`,
      ins: `insert into public.payment_allocations (payment_id, session_charge_id, amount) values ('${W.payMember}', '${W.chargeMember}', 1)`,
      upd: `update public.payment_allocations set amount = amount where payment_id in ('${W.payPayer}', '${W.payMember}')`,
      del: `delete from public.payment_allocations where payment_id in ('${W.payPayer}', '${W.payMember}')`,
    },
    {
      key: 'payment_adjustments',
      sel: `select 1 from public.payment_adjustments where session_charge_id in ('${W.chargePayer}', '${W.chargeMember}')`,
      ins: `insert into public.payment_adjustments (session_charge_id, type, amount, reason) values ('${W.chargePayer}', 'credit', -1, 'x')`,
      upd: `update public.payment_adjustments set amount = amount where session_charge_id = '${W.chargePayer}'`,
      del: `delete from public.payment_adjustments where session_charge_id = '${W.chargePayer}'`,
    },
    {
      key: 'notification_logs',
      sel: `select 1 from public.notification_logs where gang_id = '${g}'`,
      ins: `insert into public.notification_logs (gang_id, channel, success) values ('${g}', 'in_app', true)`,
      upd: `update public.notification_logs set success = success where gang_id = '${g}'`,
      del: `delete from public.notification_logs where gang_id = '${g}'`,
    },
    {
      key: 'member_line_links',
      sel: `select 1 from public.member_line_links where gang_id = '${g}'`,
      ins: `insert into public.member_line_links (gang_id, user_id, line_user_id) values ('${g}', '{uid}', 'U-probe')`,
      upd: `update public.member_line_links set line_user_id = line_user_id where gang_id = '${g}'`,
      del: `delete from public.member_line_links where gang_id = '${g}'`,
    },
    {
      key: 'join_requests',
      sel: `select 1 from public.join_requests where gang_id = '${g}'`,
      ins: `insert into public.join_requests (gang_id, user_id) values ('${g}', '{uid}')`,
      upd: `update public.join_requests set user_id = user_id where gang_id = '${g}'`,
      del: `delete from public.join_requests where gang_id = '${g}'`,
    },
    {
      key: 'event_logs',
      sel: `select 1 from public.event_logs where gang_id = '${g}'`,
      ins: `insert into public.event_logs (gang_id, event_type) values ('${g}', 'rm.probe')`,
      upd: `update public.event_logs set event_type = event_type where gang_id = '${g}'`,
      del: `delete from public.event_logs where gang_id = '${g}'`,
    },
    {
      key: 'member_statistics',
      sel: `select 1 from public.member_statistics where gang_id = '${g}'`,
      ins: `insert into public.member_statistics (gang_id, gang_member_id) values ('${g}', '${W.memberRowId}')`,
      upd: `update public.member_statistics set gang_id = gang_id where gang_id = '${g}'`,
      del: `delete from public.member_statistics where gang_id = '${g}'`,
    },
    {
      key: 'credit_ledger',
      sel: `select 1 from public.credit_ledger where gang_id = '${g}'`,
      ins: `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, reason) values ('${g}', '{uid}', 999, 'admin_topup', 1, 1, 'x')`,
      upd: `update public.credit_ledger set reason = reason where gang_id = '${g}'`,
      del: `delete from public.credit_ledger where gang_id = '${g}'`,
    },
    {
      key: 'credit_balances',
      sel: `select 1 from public.credit_balances where gang_id = '${g}'`,
      ins: `insert into public.credit_balances (gang_id, user_id) values ('${g}', '${u.extra}')`,
      upd: `update public.credit_balances set balance = balance where gang_id = '${g}'`,
      del: `delete from public.credit_balances where gang_id = '${g}'`,
    },
    // storage.objects — เลือกด้วย prefix `<gang_id>/` (policy ใช้ storage.foldername(name)[1])
    {
      key: 'storage.payment-slips',
      sel: `select 1 from storage.objects where bucket_id = 'payment-slips' and name like '${g}/%'`,
      ins: `insert into storage.objects (bucket_id, name, owner) values ('payment-slips', '${g}/probe-{uid}.png', '{uid}')`,
      upd: `update storage.objects set name = name where bucket_id = 'payment-slips' and name like '${g}/%'`,
      del: `delete from storage.objects where bucket_id = 'payment-slips' and name like '${g}/%'`,
    },
    {
      key: 'storage.gang-assets',
      sel: `select 1 from storage.objects where bucket_id = 'gang-assets' and name like '${g}/%'`,
      ins: `insert into storage.objects (bucket_id, name, owner) values ('gang-assets', '${g}/probe-{uid}.png', '{uid}')`,
      upd: `update storage.objects set name = name where bucket_id = 'gang-assets' and name like '${g}/%'`,
      del: `delete from storage.objects where bucket_id = 'gang-assets' and name like '${g}/%'`,
    },
    {
      key: 'storage.announcement-images',
      sel: `select 1 from storage.objects where bucket_id = 'announcement-images' and name like '${g}/%'`,
      ins: `insert into storage.objects (bucket_id, name, owner) values ('announcement-images', '${g}/probe-{uid}.png', '{uid}')`,
      upd: `update storage.objects set name = name where bucket_id = 'announcement-images' and name like '${g}/%'`,
      del: `delete from storage.objects where bucket_id = 'announcement-images' and name like '${g}/%'`,
    },
  ];
}

// ---------------------------------------------------------------------------
// DB function probes (service_role = connection ของเทสต์ + p_actor_id)
// ---------------------------------------------------------------------------

type Actor = Identity | 'nobody';
const ACTORS: Actor[] = ['owner', 'admin', 'member', 'payer', 'orgAdmin', 'outsider', 'nobody'];
const actorId = (a: Actor): string | null => (a === 'nobody' || a === 'anon' ? null : W.users[a]);

async function callFn(sql: string, params: unknown[], pre?: { sql: string; params: unknown[] }): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (pre) await c.query(pre.sql, pre.params); // เตรียมสถานะใน txn เดียวกัน (rollback ทิ้งทั้งหมด)
    await c.query(sql, params);
    return 'allow';
  } catch (err) {
    const e = err as { message?: string };
    return e.message === 'FORBIDDEN' ? 'deny' : `err:${e.message}`;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

type FnCase = {
  name: string;
  sql: string;
  params: (actor: string | null) => unknown[];
  pre?: { sql: string; params: unknown[] };
};
let fnCases: FnCase[] = [];

async function buildFnCases(): Promise<void> {
  const g = W.gang;
  const u = W.users;
  // S2: นัดที่มีคิวสำรอง + ที่ว่าง (ใช้ promote โดยแอดมินเลือกเอง) · ใบของ member เป็นใบยืนยัน
  const s2 = await openSession(g, u.owner, 3, 'นัดคิว');
  const regMember2 = (await one<{ id: string }>(`select id from public.register_to_session($1, $2)`, [s2, u.member])).id;
  const waiting = (
    await one<{ id: string }>(
      `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
       values ($1, 'คิวสำรอง', 'waitlist', 20, $2) returning id`,
      [s2, u.owner],
    )
  ).id;

  // สลิป verified ที่กรอกยอดโอนจริงแล้ว (ให้ record_overpayment คำนวณได้) / สลิป submitted (ให้กรอกยอด)
  const mkVerified = async () => {
    const p = await one<{ id: string }>(
      `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 100, $3) returning id`,
      [g, u.payer, u.owner],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, u.payer]);
    return p.id;
  };
  const payOver = await mkVerified();
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payOver, u.owner]);
  await pool.query(`select public.set_payment_received_amount($1, 130, $2)`, [payOver, u.owner]);
  const paySub = await mkVerified();

  // charge ที่จ่ายแล้วแต่ถูกลดหนี้ (ให้ย้ายเข้าเครดิตได้)
  const chRet = (
    await one<{ id: string }>(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount) values ($1, 'monthly_fee', $2, '1973-01-01', 50) returning id`,
      [g, W.payerMemberRowId],
    )
  ).id;
  const pRet = await one<{ id: string }>(`select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`, [g, u.payer, [chRet], u.owner]);
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [pRet.id, u.payer]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [pRet.id, u.owner]);
  await pool.query(`select public.add_payment_adjustment($1, 'credit', -50, 'ยกเลิก', null, $2)`, [chRet, u.owner]);

  fnCases = [
    { name: 'promote_waitlist(by admin pick)', sql: `select * from public.promote_waitlist($1, null, $2, 'cid', $3)`, params: (a) => [s2, a, waiting] },
    { name: 'cancel_registration(waive penalty)', sql: `select public.cancel_registration($1, $2, 'cid', true, 'ยกเว้น')`, params: (a) => [regMember2, a] },
    { name: 'preview_cancel_registration', sql: `select public.preview_cancel_registration($1, $2)`, params: (a) => [regMember2, a] },
    { name: 'record_overpayment', sql: `select public.record_overpayment($1, null, 'ทดสอบ', $2)`, params: (a) => [payOver, a] },
    { name: 'set_payment_received_amount', sql: `select public.set_payment_received_amount($1, 120, $2)`, params: (a) => [paySub, a] },
    { name: 'credit_topup(to member)', sql: `select public.credit_topup($1, $2, 1, 'ทดสอบ', $3)`, params: (a) => [g, u.member, a] },
    { name: 'credit_topup(to self)', sql: `select public.credit_topup($1, $2, 1, 'ทดสอบ', $3)`, params: (a) => [g, a, a] },
    {
      // เติมยอดให้ payer ใน txn เดียวกันก่อน (owner ทำ) แล้วค่อยให้ actor จ่ายเงินสดคืน
      name: 'credit_cash_payout',
      sql: `select public.credit_cash_payout($1, $2, 1, 'ทดสอบ', $3)`,
      params: (a) => [g, u.extra2, a],
      pre: { sql: `select public.credit_topup($1, $2, 50, 'เตรียม', $3)`, params: [g, u.extra2, u.owner] },
    },
    { name: 'credit_return_charge', sql: `select public.credit_return_charge($1, null, 'ทดสอบ', $2)`, params: (a) => [chRet, a] },
    { name: 'transfer_gang_ownership(to member)', sql: `select public.transfer_gang_ownership($1, $2, $3, 'cid')`, params: (a) => [g, a, u.member] },
    { name: 'leave_gang', sql: `select public.leave_gang($1, $2, 'cid')`, params: (a) => [g, a] },
  ];
}

// ---------------------------------------------------------------------------
// เปรียบเทียบ golden
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await reloadPostgrestSchema();
  W = await buildWorld();
  await buildFnCases();
}, 120_000);

afterAll(async () => {
  if (UPDATE) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(observed, null, 1) + '\n', 'utf8');
  }
  await pool.end();
});

function golden(): Golden {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error('ไม่พบ role-matrix.golden.json — สร้างด้วย ROLE_MATRIX_UPDATE=1 npx vitest run tests/rls/role-matrix.test.ts');
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
}

function check<K extends keyof Golden>(section: K, value: Golden[K]) {
  observed[section] = value;
  if (!UPDATE) expect(value).toEqual(golden()[section]);
}

// ---------------------------------------------------------------------------
// 1. can()
// ---------------------------------------------------------------------------

describe('R-roles-0 — can() ทุก action × role', () => {
  it('🔴 allowedActions ของ owner/admin/member/คนนอก/แอดมินองค์กร (feature เปิดหมด และปิดหมด) ตรง golden', () => {
    const allOn = Object.fromEntries(FEATURES.map((f) => [f, true])) as GangFeatures;
    const allOff = Object.fromEntries(FEATURES.map((f) => [f, false])) as GangFeatures;
    const roles: Record<string, Pick<PermissionContext, 'role' | 'orgRole'>> = {
      owner: { role: 'owner' },
      admin: { role: 'admin' },
      member: { role: 'member' },
      outsider: { role: null },
      orgAdmin: { role: null, orgRole: 'admin' },
      orgOwner: { role: null, orgRole: 'owner' },
    };
    const can: Golden['can'] = { featuresOn: {}, featuresOff: {} };
    for (const [name, ctx] of Object.entries(roles)) {
      can.featuresOn[name] = [...allowedActions({ ...ctx, features: allOn })].sort();
      can.featuresOff[name] = [...allowedActions({ ...ctx, features: allOff })].sort();
    }
    check('can', can);

    // invariants (กัน regenerate golden แบบหลวม)
    const on = can.featuresOn;
    for (const a of on.member) expect(on.admin, `admin ⊇ member: ${a}`).toContain(a);
    for (const a of on.admin) expect(on.owner, `owner ⊇ admin: ${a}`).toContain(a);
    expect(on.outsider).toEqual([]);
    expect(on.orgAdmin).toEqual(on.admin); // แอดมินองค์กร = admin ในก๊วน (ตรงกับ is_gang_admin)
    expect(on.member).not.toContain('payment.verify');
    expect(on.member).not.toContain('credit.topup');
    expect(on.admin).not.toContain('gang.ownership.transfer');
    expect(on.owner).toContain('gang.ownership.transfer');
  });
});

// ---------------------------------------------------------------------------
// 2. RLS probe
// ---------------------------------------------------------------------------

describe('R-roles-0 — RLS probe ทุกตาราง/storage × select/insert/update/delete × identity', () => {
  it('🔴 ผลทุกช่องตรง golden · คนนอก/anon เขียนอะไรไม่ได้ · member เขียนตารางแอดมินไม่ได้', async () => {
    const out: Golden['rls'] = {};
    const list = probes();

    await Promise.all(
      IDENTITIES.map(async (id) => {
        for (const p of list) {
          for (const [kind, sql] of [['select', p.sel], ['insert', p.ins], ['update', p.upd], ['delete', p.del]] as const) {
            if (!sql) continue;
            const key = `${p.key}.${kind}`;
            out[key] ??= {} as Record<Identity, string>;
            out[key][id] = await probe(id, kind, sql);
          }
        }
      }),
    );

    // เรียง key ให้ JSON คงที่
    const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    check('rls', sorted);

    // ---- invariants ที่ golden ใหม่ก็ต้องผ่าน ----
    const writes = Object.entries(sorted).filter(([k]) => !k.endsWith('.select'));
    for (const [key, row] of writes) {
      for (const id of ['outsider', 'anon'] as const) {
        // คนนอก/anon ห้ามเขียนสำเร็จหรือ "ผ่านด่านสิทธิ์" ในตารางของก๊วนนี้ (ยกเว้น insert ของตัวเองที่ออกแบบให้ทำได้)
        const selfInsertAllowed = ['join_requests.insert'].includes(key);
        if (!selfInsertAllowed) expect(['deny'], `${key} ← ${id} = ${row[id]}`).toContain(row[id]);
      }
    }
    const adminOnlyWrites = [
      'gang_skill_levels', 'gang_pricing_plans', 'session_templates', 'coupons', 'gang_expenses', 'gang_incomes',
      'announcements', 'sessions', 'session_invite_tokens', 'games', 'gangs', 'notification_logs',
    ];
    for (const t of adminOnlyWrites) {
      for (const kind of ['insert', 'update', 'delete']) {
        const row = sorted[`${t}.${kind}`];
        if (!row) continue;
        for (const id of ['member', 'payer'] as const) {
          expect(row[id], `${t}.${kind} ← ${id} ต้องถูกปฏิเสธ`).toBe('deny');
        }
      }
    }
    // สมาชิกทั่วไปอ่านการเงินของคนอื่นไม่ได้: payer เห็นแค่ของตัวเอง, member ไม่เห็นของ payer
    expect(sorted['gang_expenses.select'].member).toBe('rows:0');
    expect(sorted['gang_incomes.select'].member).toBe('rows:0');
    expect(sorted['credit_ledger.select'].owner).not.toBe('rows:0');
    expect(sorted['credit_ledger.select'].outsider).toBe('rows:0');
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 3. ตัวช่วย RLS
// ---------------------------------------------------------------------------

describe('R-roles-0 — ตัวช่วย is_gang_admin / is_session_admin / is_payment_visible', () => {
  it('🔴 ผลต่อ identity ตรง golden (แอดมินองค์กรนับเป็นแอดมิน · เจ้าของสลิปเห็นสลิปตัวเอง)', async () => {
    const out: Golden['helpers'] = {};
    const run = async (id: Identity, sql: string) =>
      asRole(id === 'anon' ? 'anon' : 'authenticated', uidOf(id), async (c) => {
        try {
          const { rows } = await c.query<{ v: boolean | null }>(sql);
          return String(rows[0].v);
        } catch (err) {
          return `err:${(err as { code?: string }).code}`;
        }
      });
    const defs: [string, string][] = [
      ['is_gang_admin', `select public.is_gang_admin('${W.gang}') v`],
      ['is_gang_member', `select public.is_gang_member('${W.gang}') v`],
      ['is_session_admin', `select public.is_session_admin('${W.session}') v`],
      ['is_payment_visible(payer)', `select public.is_payment_visible('${W.payPayer}') v`],
      ['is_payment_visible(member)', `select public.is_payment_visible('${W.payMember}') v`],
    ];
    for (const [name, sql] of defs) {
      out[name] = {} as Record<Identity, string>;
      for (const id of IDENTITIES) out[name][id] = await run(id, sql);
    }
    check('helpers', out);

    expect(out.is_gang_admin.orgAdmin).toBe('true');
    expect(out.is_gang_admin.member).toBe('false');
    expect(out.is_gang_admin.outsider).toBe('false');
    expect(out['is_payment_visible(payer)'].payer).toBe('true');
    expect(out['is_payment_visible(member)'].payer).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 4. DB function × actor
// ---------------------------------------------------------------------------

describe('R-roles-0 — DB function ที่เช็คแอดมิน/role เอง × actor', () => {
  it('🔴 ผล allow/deny/err ต่อ actor ตรง golden (ทุก call รันใน txn แล้ว rollback)', async () => {
    const out: Golden['functions'] = {};
    for (const fc of fnCases) {
      out[fc.name] = {};
      for (const actor of ACTORS) out[fc.name][actor] = await callFn(fc.sql, fc.params(actorId(actor)), fc.pre);
    }
    check('functions', out);

    // invariants: สมาชิกทั่วไป/คนนอก/ไม่มี actor ทำฟังก์ชันของแอดมินไม่ได้
    for (const name of [
      'promote_waitlist(by admin pick)', 'cancel_registration(waive penalty)', 'record_overpayment',
      'set_payment_received_amount', 'credit_topup(to member)', 'credit_cash_payout', 'credit_return_charge',
    ]) {
      for (const a of ['member', 'payer', 'outsider', 'nobody'] as const) expect(out[name][a], `${name} ← ${a}`).toBe('deny');
      expect(out[name].owner, `${name} ← owner`).not.toBe('deny');
      expect(out[name].admin, `${name} ← admin`).not.toBe('deny');
      expect(out[name].orgAdmin, `${name} ← orgAdmin`).not.toBe('deny');
    }
    // ห้ามให้เครดิตตัวเองทุกบทบาท (B5b-3) — ต้องไม่ใช่ allow แม้เป็น owner/admin
    for (const a of ['owner', 'admin', 'orgAdmin'] as const) expect(out['credit_topup(to self)'][a], `topup self ← ${a}`).not.toBe('allow');
    expect(out['credit_cash_payout'].owner).toBe('allow');
    expect(out['transfer_gang_ownership(to member)'].admin).toBe('deny'); // admin โอนความเป็นเจ้าของไม่ได้
    expect(out['transfer_gang_ownership(to member)'].owner).toBe('allow');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 5. EXECUTE grants
// ---------------------------------------------------------------------------

const INVENTORY_FNS = [
  'cancel_registration', 'create_gang', 'credit_cash_payout', 'credit_return_charge', 'credit_topup', 'is_gang_admin',
  'is_payment_visible', 'is_session_admin', 'leave_gang', 'preview_cancel_registration', 'promote_waitlist',
  'record_overpayment', 'request_to_join_gang', 'set_payment_received_amount', 'transfer_gang_ownership',
  'actor_is_gang_admin', 'is_gang_member',
];

describe('R-roles-0 — EXECUTE grants + inventory', () => {
  it('🔴 EXECUTE ของฟังก์ชันที่เกี่ยวกับ role ตรง golden (ฟังก์ชันของแอดมินผ่าน service_role เท่านั้น)', async () => {
    const { rows } = await pool.query<{ sig: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])
        order by 1, 2`,
      [INVENTORY_FNS],
    );
    const out: Golden['grants'] = {};
    for (const r of rows) (out[r.sig] ??= {})[r.role] = r.ok;
    check('grants', out);

    // ฟังก์ชันที่รับ p_actor_id ต้องไม่เปิดให้ anon/authenticated (ปลอม actor ได้ถ้าเปิด)
    for (const [sig, g] of Object.entries(out)) {
      if (/actor|credit_|promote_waitlist|record_overpayment|set_payment_received|cancel_registration|leave_gang|transfer_gang/.test(sig)) {
        expect(g.anon, sig).toBe(false);
        expect(g.authenticated, sig).toBe(false);
        expect(g.service_role, sig).toBe(true);
      }
    }
  });

  it('🔴 inventory: policy + function ที่อ้างตัวช่วยแอดมิน/เช็ค role ตรง golden — มีตัวใหม่เพิ่มต้องเข้า matrix ก่อน', async () => {
    const { rows: pol } = await pool.query<{ k: string }>(
      `select schemaname||'.'||tablename||' | '||policyname||' | '||cmd k from pg_policies
        where schemaname in ('public','storage')
          and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'is_gang_admin|is_session_admin|is_payment_visible|actor_is_gang_admin|role'
        order by 1`,
    );
    const { rows: fns } = await pool.query<{ k: string }>(
      `select p.oid::regprocedure::text k from pg_proc p where p.pronamespace = 'public'::regnamespace
          and (p.prosrc ~ 'is_gang_admin|is_session_admin|is_payment_visible|actor_is_gang_admin'
               or p.prosrc ~ 'role *= *''owner''|role *in *\\(''owner''')
        order by 1`,
    );
    check('inventory', { policies: pol.map((r) => r.k), functions: fns.map((r) => r.k) });
  });
});
