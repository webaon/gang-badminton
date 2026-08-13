/**
 * DoD ข้อ 4 — [ADR-001] "เรียก close_session_with_charges ด้วย expected_status
 *              ที่ล้าสมัย → ได้ INVALID_TRANSITION และ **ไม่มี charges เกิดขึ้นเลย**"
 *
 * ประเด็นคือ atomicity: ถ้าเขียนโดย insert charges ก่อนแล้วค่อยเช็ค status
 * เคสนี้จะทิ้ง charges ค้างไว้ในตารางทั้งที่ transition ล้มเหลว = เงินผี
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  createFixture,
  createUser,
  addGangMember,
  registrationsOf,
  runConcurrently,
  reloadPostgrestSchema,
} from '../helpers/db';

async function chargesOf(sessionId: string) {
  const { rows } = await pool.query<{ id: string; registration_id: string; amount: string }>(
    `select id, registration_id, amount from public.session_charges
      where session_id = $1 and type = 'session'`,
    [sessionId],
  );
  return rows;
}

async function statusOf(sessionId: string): Promise<string> {
  const {
    rows: [s],
  } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
    sessionId,
  ]);
  return s.status;
}

/** สร้างนัดที่มีผู้เล่น 3 คน confirmed แล้วดัน status ไปถึงที่ต้องการ */
async function openSessionWithPlayers(maxPlayers = 4) {
  const owner = await createUser(`owner-${Math.random()}`);
  const fx = await createFixture({ ownerId: owner, maxPlayers });

  const regIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const u = await createUser(`player-${Math.random()}`);
    await addGangMember(fx.gangId, u);
    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
  }
  const rows = await registrationsOf(fx.sessionId);
  regIds.push(...rows.map((r) => r.id));

  return { ...fx, ownerId: owner, regIds };
}

function chargePayload(regIds: string[], amount = '150.00') {
  return regIds.map((id) => ({
    registration_id: id,
    amount,
    breakdown: { court: '100.00', shuttle: '50.00' },
  }));
}

describe('DoD 4 — close_session_with_charges เป็น atomic ตาม ADR-001', () => {
  beforeAll(async () => {
    await reloadPostgrestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('4a. expected_status ล้าสมัย → INVALID_TRANSITION และไม่มี charges เกิดขึ้นเลย', async () => {
    const fx = await openSessionWithPlayers();

    // สถานะจริงเดินหน้าไปแล้ว (มีคนอื่นกดเริ่มเล่นระหว่างที่ server action คำนวณเงินอยู่)
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);
    expect(await statusOf(fx.sessionId)).toBe('in_play');

    // server action ถือค่าเก่า 'open' มา
    await expect(
      pool.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
        fx.sessionId,
        JSON.stringify(chargePayload(fx.regIds)),
        'open',
      ]),
    ).rejects.toThrow(/INVALID_TRANSITION/);

    // 🔴 หัวใจของ DoD ข้อนี้
    expect(await chargesOf(fx.sessionId)).toHaveLength(0);
    expect(await statusOf(fx.sessionId)).toBe('in_play'); // status ต้องไม่ขยับด้วย
  });

  it('4b. expected_status ถูกต้อง → charges + transition สำเร็จพร้อมกัน', async () => {
    const fx = await openSessionWithPlayers();
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);

    await pool.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
      fx.sessionId,
      JSON.stringify(chargePayload(fx.regIds)),
      'in_play',
    ]);

    const charges = await chargesOf(fx.sessionId);
    expect(charges).toHaveLength(3);
    expect(charges.every((c) => c.amount === '150.00')).toBe(true);
    expect(await statusOf(fx.sessionId)).toBe('billing');

    const { rows: events } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from public.event_logs
        where session_id = $1 and event_type = 'session.closed_with_charges'`,
      [fx.sessionId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.charge_count).toBe(3);
  });

  it('4c. เรียกซ้ำ → CHARGES_ALREADY_COMMITTED (charges ไม่เพิ่ม)', async () => {
    const fx = await openSessionWithPlayers();
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);
    await pool.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
      fx.sessionId,
      JSON.stringify(chargePayload(fx.regIds)),
      'in_play',
    ]);

    await expect(
      pool.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
        fx.sessionId,
        JSON.stringify(chargePayload(fx.regIds)),
        'billing',
      ]),
    ).rejects.toThrow(/CHARGES_ALREADY_COMMITTED/);

    expect(await chargesOf(fx.sessionId)).toHaveLength(3);
  });

  it('4d. เรียกพร้อมกัน 2 request → สำเร็จใบเดียว อีกใบถูกปฏิเสธ charges ไม่ซ้ำ', async () => {
    const fx = await openSessionWithPlayers();
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);
    const payload = JSON.stringify(chargePayload(fx.regIds));

    const results = await runConcurrently(2, (client) =>
      client.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
        fx.sessionId,
        payload,
        'in_play',
      ]),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // ใบที่แพ้ต้องแพ้ด้วยเหตุผลที่ถูกต้อง (status ขยับไปแล้ว หรือ charges ลงไปแล้ว)
    const reason = String((failed[0] as PromiseRejectedResult).reason);
    expect(reason).toMatch(/INVALID_TRANSITION|CHARGES_ALREADY_COMMITTED/);

    expect(await chargesOf(fx.sessionId)).toHaveLength(3);
    expect(await statusOf(fx.sessionId)).toBe('billing');
  });

  it('4e. [D-7] ยกเลิกกลางคัน in_play → cancelled คิดเงินบางส่วนได้ด้วยฟังก์ชันเดียวกัน', async () => {
    const fx = await openSessionWithPlayers();
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);

    await pool.query('select public.close_session_with_charges($1, $2::jsonb, $3, $4)', [
      fx.sessionId,
      JSON.stringify(chargePayload(fx.regIds, '40.00')),
      'in_play',
      'cancelled',
    ]);

    expect(await statusOf(fx.sessionId)).toBe('cancelled');
    const charges = await chargesOf(fx.sessionId);
    expect(charges).toHaveLength(3);
    expect(charges.every((c) => c.amount === '40.00')).toBe(true);
  });

  it('4f. charge ที่อ้าง registration ของนัดอื่น → VALIDATION_ERROR และไม่มี charges', async () => {
    const fx = await openSessionWithPlayers();
    const other = await openSessionWithPlayers();
    await pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);

    await expect(
      pool.query('select public.close_session_with_charges($1, $2::jsonb, $3)', [
        fx.sessionId,
        JSON.stringify(chargePayload([fx.regIds[0], other.regIds[0]])),
        'in_play',
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);

    expect(await chargesOf(fx.sessionId)).toHaveLength(0);
  });

  it('4g. transition นอก state machine → INVALID_TRANSITION', async () => {
    const fx = await openSessionWithPlayers();
    // open → settled ไม่มีในเส้นที่อนุญาต
    await expect(
      pool.query('select public.transition_session($1, $2)', [fx.sessionId, 'settled']),
    ).rejects.toThrow(/INVALID_TRANSITION/);
    expect(await statusOf(fx.sessionId)).toBe('open');
  });
});
