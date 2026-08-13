/**
 * WO-2.9 DoD — Payments
 *
 *   · `transition_payment()` บังคับ state machine ตาม baseline
 *   · เปลี่ยน status ตรงยัง raise `DIRECT_STATUS_UPDATE_FORBIDDEN`
 *   · verify แล้วแก้ไม่ได้อีก (`PAYMENT_ALREADY_VERIFIED`)
 *   · ยอดคำนวณจากฐานข้อมูล ไม่เชื่อ client
 *   · non-member เปิดดูสลิปไม่ได้ (ต่อยอด RLS 3)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, visibleCount } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`pay-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วน + นัดที่ปิดรอบแล้ว มี charges ของผู้เล่นหนึ่งคน */
async function sessionWithCharges(amount = '200.00') {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const player = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gang.id, player],
  );

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'จ่ายเงิน', now() - interval '3 hours', now() - interval '1 hour', 4,
             '{"snapshot_version":1,"promptpay_id":"0812345678"}'::jsonb, $2)
     returning id`,
    [gang.id, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const {
    rows: [reg],
  } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
    session.id,
    player,
  ]);
  await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
    [
      session.id,
      JSON.stringify([{ registration_id: reg.id, amount, breakdown: { flat_rate: amount } }]),
      owner,
    ],
  );

  const {
    rows: [charge],
  } = await pool.query<{ id: string }>(
    `select id from public.session_charges where session_id = $1`,
    [session.id],
  );

  return { owner, gangId: gang.id, sessionId: session.id, player, chargeId: charge.id };
}

async function createPayment(gangId: string, payer: string, chargeIds: string[], actor: string) {
  const {
    rows: [payment],
  } = await pool.query<{ id: string; amount: string; status: string }>(
    `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
    [gangId, payer, chargeIds, actor],
  );
  return payment;
}

describe('WO-2.9 — ออกใบจ่าย', () => {
  it('ยอดคำนวณจากฐานข้อมูล ไม่เชื่อ client', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges('250.00');
    const payment = await createPayment(gangId, player, [chargeId], owner);

    expect(payment.amount).toBe('250.00');
    expect(payment.status).toBe('pending');
  });

  it('🔴 charge ของก๊วนอื่น → CHARGE_NOT_FOUND (กันดึงยอดข้ามก๊วน)', async () => {
    const a = await sessionWithCharges();
    const b = await sessionWithCharges();

    await expect(
      pool.query(`select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`, [
        a.gangId,
        a.player,
        [b.chargeId],
        a.owner,
      ]),
    ).rejects.toThrow(/CHARGE_NOT_FOUND/);
  });

  it('ยอดรวม 0 → ไม่ออกใบจ่าย', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges('0.00');
    await expect(createPayment(gangId, player, [chargeId], owner)).rejects.toThrow(
      /VALIDATION_ERROR/,
    );
  });
});

describe('WO-2.9 DoD — state machine ของ payment', () => {
  it('pending → submitted → verified', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    const {
      rows: [submitted],
    } = await pool.query<{ status: string; submitted_at: Date }>(
      `select * from public.transition_payment($1, 'submitted', $2)`,
      [payment.id, player],
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.submitted_at).not.toBeNull();

    const {
      rows: [verified],
    } = await pool.query<{ status: string; verified_by: string }>(
      `select * from public.transition_payment($1, 'verified', $2)`,
      [payment.id, owner],
    );
    expect(verified.status).toBe('verified');
    expect(verified.verified_by).toBe(owner);
  });

  it('submitted → rejected → submitted (อัปสลิปใหม่ได้)', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [payment.id, player]);

    const {
      rows: [rejected],
    } = await pool.query<{ status: string; reject_reason: string }>(
      `select * from public.transition_payment($1, 'rejected', $2, $3)`,
      [payment.id, owner, 'สลิปอ่านไม่ออก'],
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.reject_reason).toBe('สลิปอ่านไม่ออก');

    const {
      rows: [again],
    } = await pool.query<{ status: string }>(
      `select * from public.transition_payment($1, 'submitted', $2)`,
      [payment.id, player],
    );
    expect(again.status).toBe('submitted');
  });

  it('🔴 verify แล้วแก้ไม่ได้อีก → PAYMENT_ALREADY_VERIFIED', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [payment.id, player]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]);

    for (const to of ['rejected', 'submitted', 'pending']) {
      await expect(
        pool.query(`select public.transition_payment($1, $2, $3)`, [payment.id, to, owner]),
        to,
      ).rejects.toThrow(/PAYMENT_ALREADY_VERIFIED/);
    }
  });

  it('ข้ามขั้น (pending → verified) ไม่ได้', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    await expect(
      pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('🔴 UPDATE status ตรงๆ ยังถูกบล็อก (trigger จาก WO-1.3 ยังทำงาน)', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    await expect(
      pool.query(`update public.payments set status = 'verified' where id = $1`, [payment.id]),
    ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);

    // แอดมินที่ล็อกอินอยู่ก็ทำไม่ได้
    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`update public.payments set status = 'verified' where id = $1`, [payment.id]),
      ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);
    });
  });

  it('บันทึก event ทุกครั้งที่เปลี่ยนสถานะ', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [payment.id, player]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]);

    const { rows } = await pool.query(
      `select 1 from public.event_logs
        where aggregate_id = $1 and event_type = 'payment.transitioned'`,
      [payment.id],
    );
    expect(rows).toHaveLength(2);
  });
});

describe('WO-2.9 — สลิปใน storage (ต่อยอด RLS 3)', () => {
  it('🔴 non-member เปิดดูสลิปไม่ได้ · เจ้าของกับแอดมินได้', async () => {
    const { gangId, player, owner } = await sessionWithCharges();
    const outsider = await newUser();

    const slipPath = `${gangId}/${crypto.randomUUID()}/slip.jpg`;
    await pool.query(
      `insert into storage.objects (bucket_id, name, owner, owner_id)
       values ('payment-slips', $1, $2::uuid, $3::text)`,
      [slipPath, player, player],
    );

    const seenBy = (uid: string) =>
      visibleCount(
        uid,
        `select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1`,
        [slipPath],
      );

    expect(await seenBy(player)).toBe(1);
    expect(await seenBy(owner)).toBe(1);
    expect(await seenBy(outsider)).toBe(0);
  });
});

describe('WO-2.9 — สิทธิ์อ่าน payments', () => {
  it('ผู้จ่ายเห็นของตัวเอง · แอดมินเห็นทั้งก๊วน · คนอื่นไม่เห็น', async () => {
    const { gangId, player, chargeId, owner } = await sessionWithCharges();
    const payment = await createPayment(gangId, player, [chargeId], owner);

    const other = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gangId, other],
    );

    const sql = 'select 1 from public.payments where id = $1';
    expect(await visibleCount(player, sql, [payment.id])).toBe(1);
    expect(await visibleCount(owner, sql, [payment.id])).toBe(1);
    // สมาชิกคนอื่นในก๊วนเดียวกันก็ไม่ควรเห็นยอดหนี้ของเพื่อน
    expect(await visibleCount(other, sql, [payment.id])).toBe(0);
  });
});
