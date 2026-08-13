-- =============================================================================
-- WO-2.10 · 0023 — สร้าง notification เข้าคิว + บันทึกผลส่ง
-- =============================================================================
-- baseline §โมดูล ข้อ 6: "กระดิ่ง: เปิดรอบใหม่, คิวถึง, เตือนจ่าย, ประกาศ"
-- ("คิวถึง" มีอยู่แล้วใน `promote_waitlist()` ตั้งแต่ WO-1.3)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 ทำไมไม่แก้ `transition_session()` / `close_session_with_charges()` ให้ยิงเอง
--
-- สองฟังก์ชันนั้น apply บน cloud ไปแล้ว การแก้ต้อง `CREATE OR REPLACE` ทั้งก้อน
-- ⇒ ต้องคัดลอก body เดิมมาทั้งหมด ซึ่งเสี่ยงพิมพ์ตกโดยไม่มีใครรู้ (ฟังก์ชันพวกนั้น
--   ถือ lock และคุมเงิน — ความเสี่ยงไม่คุ้มกับการประหยัดหนึ่ง call)
--
-- ⇒ แยกเป็นฟังก์ชันต่างหากแล้วให้ server action เรียกต่อหลัง transition สำเร็จ
--
-- ⚠️ ข้อแลกเปลี่ยน: เรียก `transition_session()` ตรงจาก SQL (เช่น seed) จะไม่มี
--    notification — ยอมรับได้เพราะ seed ไม่ควรส่งแจ้งเตือนอยู่แล้ว
--
-- Rollback: DROP FUNCTION public.enqueue_session_notification(uuid, text, text, text);
--           DROP FUNCTION public.mark_notification_sent(uuid, boolean, text);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- enqueue_session_notification(...)
-- -----------------------------------------------------------------------------
-- `p_audience`:
--   `gang_members` — สมาชิกก๊วนทุกคน (เปิดรับสมัครนัดใหม่)
--   `charged`      — คนที่มียอดต้องจ่ายในนัดนี้ (เตือนจ่าย)
--
-- ⚠️ guest ไม่มี `user_id` ⇒ ไม่ได้รับ in-app notification (ไม่มีบัญชีให้ส่งถึง)
--    baseline ออกแบบให้ guest ติดตามผ่านลิงก์ที่ได้ตอนลงชื่อแทน
create or replace function public.enqueue_session_notification(
  p_session_id     uuid,
  p_event_type     text,
  p_audience       text default 'gang_members',
  p_correlation_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gang_id uuid;
  v_title   text;
  v_count   integer;
begin
  select s.gang_id, s.title into v_gang_id, v_title
    from public.sessions s
   where s.id = p_session_id and s.deleted_at is null;

  if v_gang_id is null then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session', 'id', p_session_id)::text;
  end if;

  if p_audience not in ('gang_members', 'charged') then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'audience', 'value', p_audience)::text;
  end if;

  with recipients as (
    select gm.user_id
      from public.gang_members gm
     where p_audience = 'gang_members'
       and gm.gang_id = v_gang_id
       and gm.deleted_at is null

    union

    select r.user_id
      from public.session_charges sc
      join public.session_registrations r on r.id = sc.registration_id
     where p_audience = 'charged'
       and sc.session_id = p_session_id
       and sc.type = 'session'
       and sc.amount > 0
       and r.user_id is not null
  ),
  inserted as (
    insert into public.notifications
      (gang_id, recipient_id, channel, event_type, payload)
    select v_gang_id, rc.user_id, 'in_app', p_event_type,
           jsonb_build_object(
             'correlation_id', p_correlation_id,
             'session_id',     p_session_id,
             'session_title',  v_title
           )
      from recipients rc
     where rc.user_id is not null
    returning 1
  )
  select count(*)::integer into v_count from inserted;

  return v_count;
end;
$$;

comment on function public.enqueue_session_notification(uuid, text, text, text) is
  'สร้าง in-app notification เข้าคิว — worker เป็นคนส่ง (claim_notifications)';


-- -----------------------------------------------------------------------------
-- mark_notification_sent(...) — worker บันทึกผลส่ง
-- -----------------------------------------------------------------------------
-- 🔴 baseline §Notification worker: "ส่งไม่สำเร็จ = retry แบบ exponential backoff
--    ผ่าน next_retry_at (5 นาที → 15 นาที → 1 ชม.) เกิน 3 ครั้ง = failed ถาวร"
--
-- ใช้ตารางเวลาเดียวกับ `sweep_stuck_notifications()` (migration 0012) เพื่อไม่ให้
-- แถวที่ worker ตอบว่าล้มเหลว กับแถวที่ worker ตายกลางทาง มี backoff คนละแบบ
create or replace function public.mark_notification_sent(
  p_notification_id uuid,
  p_success         boolean,
  p_error           text default null
)
returns public.notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notifications;
begin
  select * into v_row from public.notifications where id = p_notification_id for update;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'notification', 'id', p_notification_id)::text;
  end if;

  if p_success then
    update public.notifications
       set status = 'sent', sent_at = now(), last_error = null
     where id = p_notification_id
    returning * into v_row;
  else
    update public.notifications
       set status = case when attempt >= 3 then 'failed' else 'pending' end,
           next_retry_at = case attempt
                             when 1 then now() + interval '5 minutes'
                             when 2 then now() + interval '15 minutes'
                             else        now() + interval '1 hour'
                           end,
           claimed_at = null,
           last_error = coalesce(p_error, 'ส่งไม่สำเร็จโดยไม่ระบุสาเหตุ')
     where id = p_notification_id
    returning * into v_row;
  end if;

  -- บันทึกผลส่งจริงทุกครั้ง — ใช้นับโควต้า LINE ต่อก๊วนต่อเดือนใน Phase 4
  insert into public.notification_logs
    (notification_id, gang_id, channel, success, error_message)
  values
    (p_notification_id, v_row.gang_id, v_row.channel, p_success, p_error);

  return v_row;
end;
$$;

comment on function public.mark_notification_sent(uuid, boolean, text) is
  'worker บันทึกผลส่ง + backoff ตาม baseline (5น/15น/1ชม · เกิน 3 ครั้ง = failed)';


revoke execute on function public.enqueue_session_notification(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.mark_notification_sent(uuid, boolean, text)          from public, anon, authenticated;

grant execute on function public.enqueue_session_notification(uuid, text, text, text)  to service_role;
grant execute on function public.mark_notification_sent(uuid, boolean, text)           to service_role;
