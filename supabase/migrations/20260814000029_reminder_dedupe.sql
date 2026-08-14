-- =============================================================================
-- WO-2.5-G · 0029 — คิวเตือน: กันส่งซ้ำด้วย dedupe key
-- =============================================================================
-- DoD: "ไม่ส่งซ้ำ — เตือนนัดเดิม/ยอดเดิมสองครั้งไม่ได้ (idempotent key)"
--
-- 🔴 กันที่ระดับฐานข้อมูล ไม่ใช่เช็คในโค้ด
--    cron รันทุกชั่วโมงและอาจซ้อนกันเอง (รอบก่อนยังไม่จบ) ⇒ check-then-act ใน TS
--    จะผ่านทั้งคู่แล้วยัดแจ้งเตือนซ้ำใส่คนใช้งาน (CLAUDE.md §2.1)
--
-- ⚠️ คีย์ตั้งใจให้ "หนึ่งครั้งต่อชีวิต" ของแต่ละเรื่อง:
--      session_reminder:<session_id>:<user_id>
--      payment_due:<charge_id>:<user_id>
--    ถ้าวันหนึ่งอยากเตือนซ้ำเป็นรอบๆ ให้ใส่ช่วงเวลาลงไปในคีย์ (เช่น ...:2026-W34)
--    ❌ ห้ามถอด unique index ออกเพื่อให้เตือนซ้ำได้
--
-- Rollback: DROP FUNCTION public.enqueue_notifications(jsonb);
--           DROP INDEX public.notifications_dedupe_key;
--           ALTER TABLE public.notifications DROP COLUMN dedupe_key;
-- =============================================================================

alter table public.notifications
  add column if not exists dedupe_key text;

comment on column public.notifications.dedupe_key is
  '[WO-2.5-G] กันเตือนซ้ำ — null = ข้อความที่ไม่ต้องกันซ้ำ (เช่น payment.due ตอนปิดรอบ)';

create unique index if not exists notifications_dedupe_key
  on public.notifications (dedupe_key)
  where dedupe_key is not null;


-- -----------------------------------------------------------------------------
-- enqueue_notifications(rows) — เข้าคิวทีละชุด ข้ามอันที่เคยส่งแล้ว
-- -----------------------------------------------------------------------------
-- คืนจำนวนแถวที่ **สร้างใหม่จริง** (ที่ชนคีย์เดิมไม่นับ)
--
-- ❌ ห้ามสร้าง worker ใหม่ — แถวที่ insert ที่นี่ถูกส่งโดย `claim_notifications()`
--    + `dispatchNotifications()` เดิมทุกประการ (baseline §Notification worker)
create or replace function public.enqueue_notifications(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'rows', 'reason', 'ต้องเป็น array')::text;
  end if;

  with input as (
    select *
      from jsonb_to_recordset(p_rows)
        as r(gang_id uuid, recipient_id uuid, event_type text, payload jsonb, dedupe_key text)
  ),
  inserted as (
    insert into public.notifications
      (gang_id, recipient_id, channel, event_type, payload, dedupe_key)
    select i.gang_id, i.recipient_id, 'in_app', i.event_type,
           coalesce(i.payload, '{}'::jsonb), i.dedupe_key
      from input i
     where i.gang_id is not null
       and i.recipient_id is not null
       and i.event_type is not null
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;

  return v_created;
end;
$$;

revoke execute on function public.enqueue_notifications(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_notifications(jsonb) to service_role;
