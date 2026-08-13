import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { fromJson as recurrenceFromJson, occurrencesBetween } from '@/domain/sessions/recurrence';
import { utcToZonedWallClock, zonedTimeToUtc } from '@/domain/time/timezone';
import { buildSessionSnapshot } from '@/server/sessions/snapshot';

/**
 * สร้างนัดล่วงหน้าจาก template — **[WO-2.5-E]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 idempotent: กันซ้ำด้วย unique index `sessions_template_slot_key`
 *    `(template_id, starts_at)` ที่ระดับฐานข้อมูล ⇒ cron กับปุ่มของแอดมิน
 *    ยิงพร้อมกันก็ไม่ได้นัดซ้ำ (❌ ห้าม check-then-act ใน TS — CLAUDE.md §2.1)
 *
 * 🔴 นัดที่ generate ต้อง**เหมือนสร้างมือทุกอย่าง**: snapshot ครบ + `status = 'draft'`
 *    ⇒ ใช้ `buildSessionSnapshot()` ตัวเดียวกับ `createSession()`
 *
 * ⚠️ แก้ template แล้ว**ไม่ย้อนไปแก้นัดที่ generate ไปแล้ว** — ฟังก์ชันนี้ไม่ UPDATE
 *    แถวเดิมเลย มีแต่ INSERT ของช่วงเวลาที่ยังไม่มี
 */

/** baseline: generate ล่วงหน้า 2 สัปดาห์ */
export const HORIZON_DAYS = 14;

export type GenerateOutcome = {
  templateId: string;
  created: number;
  skipped: number;
};

type TemplateRow = {
  id: string;
  gang_id: string;
  name: string;
  recurrence: unknown;
  venue: string | null;
  court_count: number;
  court_labels: unknown;
  max_players: number;
  pricing_plan_id: string | null;
  allow_guests: boolean;
  gangs: { timezone: string; deleted_at: string | null } | null;
};

/** โค้ด error ของ Postgres ตอนชน unique index */
const UNIQUE_VIOLATION = '23505';

async function generateFor(
  template: TemplateRow,
  correlationId: string,
  now: Date,
  actorId: string | null,
): Promise<GenerateOutcome> {
  const admin = supabaseAdmin();
  const timezone = template.gangs?.timezone ?? 'Asia/Bangkok';

  const { snapshot } = await buildSessionSnapshot(admin, template.gang_id, template.pricing_plan_id);

  // วันนี้ตามนาฬิกาของก๊วน — ก๊วนคนละโซนต้องได้ชุดวันคนละชุด
  const today = utcToZonedWallClock(now, timezone).slice(0, 10);
  const occurrences = occurrencesBetween(recurrenceFromJson(template.recurrence), today, HORIZON_DAYS);

  let created = 0;
  let skipped = 0;

  for (const occurrence of occurrences) {
    let startsAt: Date;
    let endsAt: Date;

    try {
      startsAt = zonedTimeToUtc(occurrence.startLocal, timezone);
      endsAt = zonedTimeToUtc(occurrence.endLocal, timezone);
    } catch (error) {
      // เวลาที่ไม่มีอยู่จริงในโซนนั้น (วันเปลี่ยน DST) — ข้ามรอบนั้นไป ไม่ใช่พังทั้งงาน
      console.warn('[templates] ข้ามรอบที่แปลงเวลาไม่ได้', {
        correlationId,
        templateId: template.id,
        startLocal: occurrence.startLocal,
        message: (error as Error).message,
      });
      skipped += 1;
      continue;
    }

    // ไม่สร้างย้อนหลัง — รอบของวันนี้ที่เลยเวลาไปแล้วไม่มีประโยชน์
    if (startsAt.getTime() <= now.getTime()) {
      skipped += 1;
      continue;
    }

    const { error } = await admin.from('sessions').insert({
      gang_id: template.gang_id,
      template_id: template.id,
      title: template.name,
      venue: template.venue,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      court_count: template.court_count,
      court_labels: template.court_labels ?? [],
      max_players: template.max_players,
      allow_guests: template.allow_guests,
      // 🔴 draft เสมอ [D-14] — เปิดรับสมัครต้องผ่าน transition_session()
      status: 'draft',
      snapshot,
      created_by: actorId,
    });

    if (!error) {
      created += 1;
      continue;
    }

    // ชน unique index = มีนัดของช่วงเวลานี้อยู่แล้ว (หรือแอดมินลบทิ้งไปแล้ว) ⇒ ข้าม
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      skipped += 1;
      continue;
    }

    throw error;
  }

  return { templateId: template.id, created, skipped };
}

const TEMPLATE_COLUMNS =
  'id, gang_id, name, recurrence, venue, court_count, court_labels, max_players, pricing_plan_id, allow_guests, gangs!inner(timezone, deleted_at)';

/** generate ของ template ใบเดียว — ใช้จากปุ่มของแอดมิน */
export async function generateForTemplate(opts: {
  templateId: string;
  correlationId: string;
  actorId: string;
  now?: Date;
}): Promise<GenerateOutcome | null> {
  const { data } = await supabaseAdmin()
    .from('session_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', opts.templateId)
    .eq('is_active', true)
    .maybeSingle();

  const template = data as unknown as TemplateRow | null;
  if (!template || template.gangs?.deleted_at) return null;

  return generateFor(template, opts.correlationId, opts.now ?? new Date(), opts.actorId);
}

/**
 * generate ของทุก template ที่เปิดอยู่ — งานของ cron
 *
 * ⚠️ template ใบหนึ่งพังต้องไม่ทำให้ใบที่เหลือไม่ถูก generate ⇒ จับ error ต่อใบ
 *    แต่ห้ามกลืนเงียบ (CLAUDE.md §5) — log พร้อม correlation id และรายงานจำนวนที่พลาด
 */
export async function generateAllTemplates(
  correlationId: string,
  now: Date = new Date(),
): Promise<{ templates: number; created: number; skipped: number; failed: number }> {
  const { data, error } = await supabaseAdmin()
    .from('session_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('is_active', true);

  if (error) throw error;

  const templates = (data as unknown as TemplateRow[]).filter((t) => !t.gangs?.deleted_at);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const template of templates) {
    try {
      const outcome = await generateFor(template, correlationId, now, null);
      created += outcome.created;
      skipped += outcome.skipped;
    } catch (error) {
      failed += 1;
      console.error('[templates] generate ไม่สำเร็จ', {
        correlationId,
        templateId: template.id,
        message: (error as { message?: string }).message,
      });
    }
  }

  return { templates: templates.length, created, skipped, failed };
}
