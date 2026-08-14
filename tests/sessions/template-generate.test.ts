/**
 * WO-2.5-E DoD — cron generate นัดจาก template
 *
 *   · 🔴 **idempotent** — รันซ้ำไม่ generate ซ้ำ (baseline §Verification "Job tests")
 *   · 🔴 นัดที่ generate มี **snapshot ครบเหมือนสร้างมือ** — ไม่งั้นปิดรอบไม่ได้
 *   · แก้ template มีผลเฉพาะรอบที่ยังไม่ generate
 *   · เวลาแปลงตาม `gangs.timezone` — มีเทสต์ข้าม timezone
 *   · นัดที่ generate เป็น `draft` เสมอ [D-14]
 *
 * เรียก **code path เดียวกับ route handler** (`generateAllTemplates`)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { generateAllTemplates, generateForTemplate } = await import('@/server/templates/generate');

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`tg-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วน + แผนราคา + ตารางประจำ (จันทร์/พฤหัส 19:00–21:00) */
async function gangWithTemplate(opts: { timezone?: string; days?: number[]; active?: boolean } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(`update public.gangs set timezone = $2, promptpay_id = '0812345678' where id = $1`, [
    gang.id,
    opts.timezone ?? 'Asia/Bangkok',
  ]);

  await pool.query(
    `insert into public.gang_pricing_plans (gang_id, name, type, params)
     values ($1, 'เหมาจ่าย', 'flat_rate', '{"amount_per_person": "200.00"}'::jsonb)`,
    [gang.id],
  );

  await pool.query(
    `insert into public.gang_skill_levels (gang_id, label, rank) values ($1, 'มือใหม่', 1)`,
    [gang.id],
  );

  const {
    rows: [template],
  } = await pool.query<{ id: string }>(
    `insert into public.session_templates
       (gang_id, name, recurrence, venue, court_count, max_players, allow_guests, is_active, created_by)
     values ($1, 'ซ้อมประจำ',
             jsonb_build_object('days', $2::jsonb, 'start_time', '19:00', 'end_time', '21:00'),
             'ยิมประจำ', 2, 16, true, $3, $4)
     returning id`,
    [gang.id, JSON.stringify(opts.days ?? [1, 4]), opts.active ?? true, owner],
  );

  return { owner, gangId: gang.id, templateId: template.id };
}

async function sessionsOf(templateId: string) {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    starts_at: Date;
    ends_at: Date;
    title: string;
    max_players: number;
    snapshot: Record<string, unknown>;
  }>(
    `select id, status, starts_at, ends_at, title, max_players, snapshot
       from public.sessions where template_id = $1 order by starts_at`,
    [templateId],
  );
  return rows;
}

/** 13 ส.ค. 2026 = วันพฤหัสบดี 10:00 ตามเวลาไทย */
const NOW = new Date('2026-08-13T03:00:00Z');

describe('WO-2.5-E DoD — generate ล่วงหน้า 2 สัปดาห์', () => {
  it('สร้างนัดตามวันในตาราง เป็น draft เสมอ', async () => {
    const { templateId } = await gangWithTemplate();

    // ⚠️ ยืนยันเฉพาะ template ของเทสต์นี้ — `generateAllTemplates()` เดินทุกใบในฐานข้อมูล
    //    รวมของเทสต์อื่นที่จงใจให้พัง ⇒ assert `failed` รวมจะไม่เสถียรเมื่อรันซ้ำ
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const sessions = await sessionsOf(templateId);
    // จันทร์/พฤหัสในช่วง 14 วันจาก 13 ส.ค. = 13(ผ่านเวลาแล้วไหม?), 17, 20, 24
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions.every((s) => s.status === 'draft')).toBe(true);
    expect(sessions.every((s) => s.title === 'ซ้อมประจำ')).toBe(true);
    expect(sessions.every((s) => s.max_players === 16)).toBe(true);
  });

  it('🔴 snapshot ครบเหมือนสร้างมือ — ไม่งั้นปิดรอบไม่ได้', async () => {
    const { templateId } = await gangWithTemplate();
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const [session] = await sessionsOf(templateId);

    for (const key of [
      'snapshot_version',
      'pricing_plan',
      'rounding_policy',
      'promptpay_id',
      'cancellation_policy',
      'skill_levels',
    ]) {
      expect(session.snapshot, `ขาดคีย์ ${key}`).toHaveProperty(key);
    }

    const plan = session.snapshot.pricing_plan as { type: string; params: { amount_per_person: string } };
    expect(plan.type).toBe('flat_rate');
    expect(plan.params.amount_per_person).toBe('200.00');
    expect(session.snapshot.promptpay_id).toBe('0812345678');
  });

  it('🔴 รันซ้ำไม่ได้นัดซ้ำ (idempotent)', async () => {
    const { templateId } = await gangWithTemplate();

    const first = await generateAllTemplates(crypto.randomUUID(), NOW);
    const countAfterFirst = (await sessionsOf(templateId)).length;
    expect(first.created).toBeGreaterThan(0);

    await generateAllTemplates(crypto.randomUUID(), NOW);
    expect((await sessionsOf(templateId)).length).toBe(countAfterFirst);
  });

  it('🔴 unique index กันซ้ำที่ระดับฐานข้อมูล — INSERT ตรงก็ยังชน', async () => {
    const { gangId, templateId } = await gangWithTemplate();
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const [session] = await sessionsOf(templateId);

    await expect(
      pool.query(
        `insert into public.sessions
           (gang_id, template_id, title, starts_at, ends_at, max_players, snapshot)
         values ($1, $2, 'ซ้ำ', $3, $4, 4, '{}'::jsonb)`,
        [gangId, templateId, session.starts_at.toISOString(), session.ends_at.toISOString()],
      ),
    ).rejects.toThrow(/sessions_template_slot_key/);
  });

  it('ตารางที่ปิดอยู่ ไม่ถูก generate', async () => {
    const { templateId } = await gangWithTemplate({ active: false });

    await generateAllTemplates(crypto.randomUUID(), NOW);
    expect(await sessionsOf(templateId)).toHaveLength(0);
  });

  it('🔴 นัดที่แอดมินลบทิ้ง ต้องไม่ถูกสร้างกลับมา', async () => {
    const { templateId, owner } = await gangWithTemplate();
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const [session] = await sessionsOf(templateId);
    await pool.query(
      `update public.sessions set deleted_at = now(), deleted_by = $2 where id = $1`,
      [session.id, owner],
    );

    await generateAllTemplates(crypto.randomUUID(), NOW);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.sessions
        where template_id = $1 and starts_at = $2 and deleted_at is null`,
      [templateId, session.starts_at.toISOString()],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

describe('WO-2.5-E DoD — timezone', () => {
  it('🔴 ก๊วนไทยกับก๊วน UTC ตารางเดียวกัน ได้ instant ต่างกัน 7 ชั่วโมง', async () => {
    const th = await gangWithTemplate({ timezone: 'Asia/Bangkok', days: [4] });
    const utc = await gangWithTemplate({ timezone: 'UTC', days: [4] });

    await generateAllTemplates(crypto.randomUUID(), NOW);

    const [thSession] = await sessionsOf(th.templateId);
    const [utcSession] = await sessionsOf(utc.templateId);

    // วันเดียวกัน เวลาบนนาฬิกาเท่ากัน (19:00) แต่เป็นคนละ instant
    expect(thSession.starts_at.toISOString()).toBe('2026-08-13T12:00:00.000Z');
    expect(utcSession.starts_at.toISOString()).toBe('2026-08-13T19:00:00.000Z');
    expect(utcSession.starts_at.getTime() - thSession.starts_at.getTime()).toBe(7 * 60 * 60 * 1000);
  });

  it('ไม่สร้างรอบที่เลยเวลาไปแล้วของวันนี้', async () => {
    const { templateId } = await gangWithTemplate({ days: [4] });

    // 4 ทุ่มครึ่งไทยของวันพฤหัส — รอบ 19:00 ของวันนี้ผ่านไปแล้ว
    await generateAllTemplates(crypto.randomUUID(), new Date('2026-08-13T15:30:00Z'));

    const sessions = await sessionsOf(templateId);
    expect(sessions.every((s) => s.starts_at.getTime() > Date.parse('2026-08-13T15:30:00Z'))).toBe(
      true,
    );
  });
});

describe('WO-2.5-E DoD — แก้ template มีผลเฉพาะรอบที่ยังไม่สร้าง', () => {
  it('🔴 แก้เวลาในตาราง → นัดที่สร้างไปแล้วไม่ขยับ · รอบใหม่ใช้เวลาใหม่', async () => {
    const { templateId } = await gangWithTemplate({ days: [4] });
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const before = await sessionsOf(templateId);
    const firstStart = before[0].starts_at.toISOString();

    await pool.query(
      `update public.session_templates
          set recurrence = jsonb_build_object('days', '[4]'::jsonb,
                                              'start_time', '20:00', 'end_time', '22:00')
        where id = $1`,
      [templateId],
    );

    await generateAllTemplates(crypto.randomUUID(), NOW);

    const after = await sessionsOf(templateId);

    // นัดเดิมยังเวลาเดิม
    expect(after.find((s) => s.id === before[0].id)!.starts_at.toISOString()).toBe(firstStart);
    // มีรอบเวลาใหม่เพิ่มเข้ามา (คนละ slot ⇒ ไม่ชน unique index)
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((s) => s.starts_at.toISOString().endsWith('13:00:00.000Z'))).toBe(true);
  });

  it('แก้จำนวนคน → นัดเดิมคงเดิม', async () => {
    const { templateId } = await gangWithTemplate({ days: [4] });
    await generateAllTemplates(crypto.randomUUID(), NOW);

    await pool.query(`update public.session_templates set max_players = 8 where id = $1`, [
      templateId,
    ]);
    await generateAllTemplates(crypto.randomUUID(), NOW);

    const sessions = await sessionsOf(templateId);
    expect(sessions.every((s) => s.max_players === 16)).toBe(true);
  });
});

describe('WO-2.5-E — generate ทีละใบ (ปุ่มของแอดมิน)', () => {
  it('คืนจำนวนที่สร้าง · กดซ้ำได้ 0 ใหม่', async () => {
    const { templateId, owner } = await gangWithTemplate({ days: [4] });

    const first = await generateForTemplate({
      templateId,
      correlationId: crypto.randomUUID(),
      actorId: owner,
      now: NOW,
    });
    expect(first!.created).toBeGreaterThan(0);

    const second = await generateForTemplate({
      templateId,
      correlationId: crypto.randomUUID(),
      actorId: owner,
      now: NOW,
    });
    expect(second!.created).toBe(0);
  });

  it('ตารางที่ปิดอยู่ → คืน null (ให้ action แปลงเป็น NOT_FOUND)', async () => {
    const { templateId, owner } = await gangWithTemplate({ active: false });

    const outcome = await generateForTemplate({
      templateId,
      correlationId: crypto.randomUUID(),
      actorId: owner,
      now: NOW,
    });
    expect(outcome).toBeNull();
  });

  it('ก๊วนที่ยังไม่ตั้งแผนราคา → พังทั้งใบ ไม่ใช่สร้างนัดที่ปิดรอบไม่ได้', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน-${crypto.randomUUID()}`,
    ]);
    const {
      rows: [template],
    } = await pool.query<{ id: string }>(
      `insert into public.session_templates
         (gang_id, name, recurrence, court_count, max_players, created_by)
       values ($1, 'ไม่มีราคา',
               jsonb_build_object('days', '[4]'::jsonb, 'start_time', '19:00', 'end_time', '21:00'),
               1, 8, $2)
       returning id`,
      [gang.id, owner],
    );

    await expect(
      generateForTemplate({
        templateId: template.id,
        correlationId: crypto.randomUUID(),
        actorId: owner,
        now: NOW,
      }),
    ).rejects.toThrow(/แผนราคา/);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.sessions where template_id = $1`,
      [template.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
