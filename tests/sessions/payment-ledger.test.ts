/**
 * WO-2.5-D DoD — payment_allocations + adjustments
 *
 *   · invariant `sum(allocations) ≤ payment.amount` — ยิงชนจริง
 *   · ยอดสุทธิต่อคน = `charge − allocations + adjustments` ทุกเคส
 *   · refund ระดับ charge แล้วยอดค้างเปลี่ยนทันที
 *   · 🔴 กด "ขอ QR" ซ้ำต้องได้ **ใบเดิม** ถ้ายังไม่ verified
 *   · 🔴 E2E: 1 สลิป 2 คน (baseline ระบุเคสนี้ตรงๆ)
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
    [`pl-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดที่ปิดรอบแล้ว มี charge ของผู้เล่น n คน คนละ `amount` */
async function sessionWithCharges(n: number, amount = '200.00') {
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
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'จ่ายแทนเพื่อน', now() - interval '3 hours', now() - interval '1 hour', $2,
             '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, n + 2, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const players: { userId: string; registrationId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, u],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      u,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    players.push({ userId: u, registrationId: reg.id });
  }

  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);
  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
    [
      session.id,
      JSON.stringify(
        players.map((p) => ({
          registration_id: p.registrationId,
          amount,
          breakdown: { flat_rate: amount },
        })),
      ),
      owner,
    ],
  );

  const { rows: charges } = await pool.query<{ id: string; registration_id: string }>(
    `select id, registration_id from public.session_charges where session_id = $1`,
    [session.id],
  );

  const chargeOf = new Map(charges.map((c) => [c.registration_id, c.id]));

  return {
    owner,
    gangId: gang.id,
    sessionId: session.id,
    players: players.map((p) => ({ ...p, chargeId: chargeOf.get(p.registrationId)! })),
  };
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

async function outstanding(chargeId: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ charge_outstanding: string }>(
    `select public.charge_outstanding($1)::text`,
    [chargeId],
  );
  return row.charge_outstanding;
}

async function verify(paymentId: string, payer: string, admin: string) {
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [paymentId, payer]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [paymentId, admin]);
}

describe('WO-2.5-D DoD — 1 สลิป 2 คน (จ่ายแทนเพื่อน)', () => {
  it('🔴 E2E: จ่ายใบเดียวครอบสองคน → ทั้งคู่หนี้เป็น 0 หลัง verify', async () => {
    const { gangId, owner, players } = await sessionWithCharges(2, '200.00');
    const [a, b] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId, b.chargeId], a.userId);
    expect(payment.amount).toBe('400.00');

    // ยังไม่ verify ⇒ หนี้ยังอยู่ครบ (สลิปที่ยังไม่ยืนยันต้องไม่ล้างหนี้)
    expect(await outstanding(a.chargeId)).toBe('200.00');
    expect(await outstanding(b.chargeId)).toBe('200.00');

    await verify(payment.id, a.userId, owner);

    expect(await outstanding(a.chargeId)).toBe('0.00');
    expect(await outstanding(b.chargeId)).toBe('0.00');

    const { rows: allocations } = await pool.query<{ session_charge_id: string; amount: string }>(
      `select session_charge_id, amount from public.payment_allocations where payment_id = $1`,
      [payment.id],
    );
    expect(allocations).toHaveLength(2);
    expect(allocations.every((x) => x.amount === '200.00')).toBe(true);
  });

  it('คนที่ถูกจ่ายแทนแล้ว ไม่ถูกนับซ้ำในใบถัดไป', async () => {
    const { gangId, owner, players } = await sessionWithCharges(2);
    const [a, b] = players;

    const first = await createPayment(gangId, a.userId, [a.chargeId, b.chargeId], a.userId);
    await verify(first.id, a.userId, owner);

    // b พยายามจ่ายเองทีหลัง — ไม่มียอดค้างแล้ว
    await expect(createPayment(gangId, b.userId, [b.chargeId], b.userId)).rejects.toThrow(
      /VALIDATION_ERROR/,
    );
  });
});

describe('WO-2.5-D DoD — ไม่ออกใบจ่ายซ้ำ', () => {
  it('🔴 กดขอ QR ซ้ำขณะยังไม่ verified → ได้ใบเดิม', async () => {
    const { gangId, players } = await sessionWithCharges(1);
    const [a] = players;

    const first = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    const second = await createPayment(gangId, a.userId, [a.chargeId], a.userId);

    expect(second.id).toBe(first.id);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.payments where gang_id = $1`,
      [gangId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('ใบที่ถูกปฏิเสธยังถือว่าใช้ได้ — อัปสลิปใหม่ในใบเดิม ไม่ใช่ออกใบใหม่', async () => {
    const { gangId, owner, players } = await sessionWithCharges(1);
    const [a] = players;

    const first = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [first.id, a.userId]);
    await pool.query(`select public.transition_payment($1, 'rejected', $2, $3)`, [
      first.id,
      owner,
      'สลิปอ่านไม่ออก',
    ]);

    const again = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    expect(again.id).toBe(first.id);
  });

  it('ชุด charge ต่างกัน → เป็นคนละใบ (ไม่ใช่เหมารวมมั่ว)', async () => {
    const { gangId, players } = await sessionWithCharges(2);
    const [a, b] = players;

    const own = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    const both = await createPayment(gangId, a.userId, [a.chargeId, b.chargeId], a.userId);

    expect(both.id).not.toBe(own.id);
    expect(both.amount).toBe('400.00');
  });
});

describe('WO-2.5-D DoD — invariant sum(allocations) ≤ payment.amount', () => {
  it('🔴 ยัด allocation เกินยอดสลิป → ALLOCATION_EXCEEDS_PAYMENT', async () => {
    const { gangId, players } = await sessionWithCharges(2);
    const [a, b] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId], a.userId);

    await expect(
      pool.query(
        `insert into public.payment_allocations (payment_id, session_charge_id, amount)
         values ($1, $2, '200.00')`,
        [payment.id, b.chargeId],
      ),
    ).rejects.toThrow(/ALLOCATION_EXCEEDS_PAYMENT/);
  });

  it('allocate เท่ากับยอดสลิปพอดี → ผ่าน (≤ ไม่ใช่ <)', async () => {
    const { gangId, players } = await sessionWithCharges(2);
    const [a, b] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId, b.chargeId], a.userId);

    const { rows } = await pool.query<{ sum: string }>(
      `select coalesce(sum(amount), 0)::text as sum from public.payment_allocations
        where payment_id = $1`,
      [payment.id],
    );
    expect(rows[0].sum).toBe(payment.amount);
  });
});

describe('WO-2.5-D DoD — adjustments (refund / correction / credit)', () => {
  it('🔴 refund หลัง verify แล้ว ยอดค้างสะท้อนทันที', async () => {
    const { gangId, owner, players } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    await verify(payment.id, a.userId, owner);
    expect(await outstanding(a.chargeId)).toBe('0.00');

    await pool.query(
      `select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`,
      [a.chargeId, '-50.00', 'มาไม่ครบเวลา คืนบางส่วน', payment.id, owner],
    );

    // คืนไป 50 ⇒ ยอดค้างติดลบ 50 = ก๊วนเป็นหนี้ผู้เล่นอยู่ 50
    expect(await outstanding(a.chargeId)).toBe('-50.00');
  });

  it('correction เพิ่มหนี้ได้ (ยอดบวก)', async () => {
    const { players, owner } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    await pool.query(`select public.add_payment_adjustment($1, 'correction', $2, $3, null, $4)`, [
      a.chargeId,
      '30.00',
      'ลืมคิดค่าลูกเพิ่ม',
      owner,
    ]);

    expect(await outstanding(a.chargeId)).toBe('230.00');
  });

  it('🔴 refund/credit ที่เป็นยอดบวก → ถูกปฏิเสธ (ตั้งใจคืนแต่หนี้เพิ่ม)', async () => {
    const { players, owner } = await sessionWithCharges(1);
    const [a] = players;

    for (const type of ['refund', 'credit']) {
      await expect(
        pool.query(`select public.add_payment_adjustment($1, $2, $3, $4, null, $5)`, [
          a.chargeId,
          type,
          '50.00',
          'พิมพ์ผิด',
          owner,
        ]),
        type,
      ).rejects.toThrow(/VALIDATION_ERROR/);
    }
  });

  it('🔴 คืนเงินเกินกว่าที่เก็บมาจริงไม่ได้', async () => {
    const { gangId, owner, players } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    await verify(payment.id, a.userId, owner);

    await pool.query(`select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`, [
      a.chargeId,
      '-150.00',
      'คืนบางส่วน',
      payment.id,
      owner,
    ]);

    await expect(
      pool.query(`select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`, [
        a.chargeId,
        '-100.00',
        'คืนอีก',
        payment.id,
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('ไม่ระบุเหตุผล → ถูกปฏิเสธ (เดือนหน้าจะไม่มีใครรู้ว่าทำไมยอดไม่ตรง)', async () => {
    const { players, owner } = await sessionWithCharges(1);
    const [a] = players;

    await expect(
      pool.query(`select public.add_payment_adjustment($1, 'correction', $2, $3, null, $4)`, [
        a.chargeId,
        '10.00',
        '   ',
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('บันทึก event พร้อมยอดค้างหลังปรับ', async () => {
    const { players, owner } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      a.chargeId,
      '-20.00',
      'ส่วนลดสมาชิกใหม่',
      owner,
    ]);

    const {
      rows: [event],
    } = await pool.query<{ payload: { type: string; outstanding_after: string } }>(
      `select payload from public.event_logs
        where aggregate_id = $1 and event_type = 'payment.adjusted'`,
      [a.chargeId],
    );

    expect(event.payload.type).toBe('credit');
    expect(Number(event.payload.outstanding_after)).toBe(180);
  });
});

describe('WO-2.5-D DoD — ห้ามแก้ยอดที่จ่ายแล้ว', () => {
  it('🔴 UPDATE session_charges.amount ของหนี้ที่ verify แล้ว → PAYMENT_ALREADY_VERIFIED', async () => {
    const { gangId, owner, players } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    const payment = await createPayment(gangId, a.userId, [a.chargeId], a.userId);
    await verify(payment.id, a.userId, owner);

    await expect(
      pool.query(`update public.session_charges set amount = '10.00' where id = $1`, [a.chargeId]),
    ).rejects.toThrow(/PAYMENT_ALREADY_VERIFIED/);

    // ยอดเดิมต้องอยู่ครบ
    const {
      rows: [row],
    } = await pool.query<{ amount: string }>(
      `select amount from public.session_charges where id = $1`,
      [a.chargeId],
    );
    expect(row.amount).toBe('200.00');
  });

  it('หนี้ที่ยังไม่ถูกจ่าย แก้ยอดได้ (ยังไม่มีใครยึดตัวเลขนี้)', async () => {
    const { players } = await sessionWithCharges(1, '200.00');
    const [a] = players;

    await pool.query(`update public.session_charges set amount = '150.00' where id = $1`, [
      a.chargeId,
    ]);
    expect(await outstanding(a.chargeId)).toBe('150.00');
  });
});
