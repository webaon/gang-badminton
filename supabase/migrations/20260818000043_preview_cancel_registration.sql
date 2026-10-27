-- =============================================================================
-- 20260818000043 — WO-B11.1: preview ผลการยกเลิก (read-only) ให้หน้าจอ 6.2
-- =============================================================================
-- ปัญหา: UI คำนวณ grace เองไม่ได้ — TS `fromJson()` ให้ default 3 ชม. กับ snapshot เก่าที่ DB ถือเป็น 0
--        ⇒ หน้าจอจะบอกผู้ใช้ว่า "ยกเลิกฟรี" ทั้งที่จริงโดนปรับ
--
-- แก้โดย "แยกส่วนตัดสิน" ออกมาเป็น helper ตัวเดียว `cancel_decision()` แล้วให้ทั้ง
--   - cancel_registration()          (ทำจริง)
--   - preview_cancel_registration()  (ดูเฉยๆ STABLE ไม่เขียนอะไร)
-- เรียกตัวเดียวกัน ⇒ ไม่มีตรรกะซ้ำสองที่ ผลที่เห็นกับผลที่เกิดจริงจึงตรงกันโดยโครงสร้าง
--
-- 🔴 cancel_registration(): พฤติกรรมเดิมทุกอย่าง (signature เดิม · event payload เดิม · error เดิม)
--    ย้ายเฉพาะส่วนคำนวณ cutoff/grace/waiver/late/blocked ไปไว้ใน helper
-- 🔴 preview ไม่คืนจำนวนเงิน — คืนแค่ประเภท/เวลา (เงินคำนวณใน domain/billing ตอนปิดรอบ · ADR-001)
-- 🔴 อ่าน policy จาก sessions.snapshot เท่านั้น · ไม่มีคีย์ promoted_grace_hours = 0
--
-- ROLLBACK:
--   DROP FUNCTION public.preview_cancel_registration(uuid, uuid);
--   -- re-apply cancel_registration() จาก 20260818000041 แล้ว
--   DROP FUNCTION public.cancel_decision(public.session_registrations, public.sessions, boolean, timestamptz);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cancel_decision(reg, session, waive, now) — ตัวตัดสินตัวเดียว (internal)
-- -----------------------------------------------------------------------------
-- STABLE · ไม่ lock · ไม่เขียน · ผู้เรียกต้อง lock ก่อนเองถ้าต้องการความสดระดับ transaction
-- ไม่ผูกกับ role ใดเลย (revoke ทั้งหมด) — เรียกได้เฉพาะจาก SECURITY DEFINER ที่เป็นเจ้าของเดียวกัน
create or replace function public.cancel_decision(
  p_reg    public.session_registrations,
  p_session public.sessions,
  p_waive  boolean,
  p_now    timestamptz default now()
)
returns table (
  policy             jsonb,
  cutoff_at          timestamptz,
  would_be_late      boolean,
  grace_until        timestamptz,
  in_grace           boolean,
  waiver             text,
  is_late            boolean,
  allow_after_cutoff boolean,
  blocked            boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy        jsonb;
  v_cutoff_hours  numeric;
  v_cutoff_at     timestamptz;
  v_grace_hours   numeric;
  v_grace_until   timestamptz;
  v_in_grace      boolean := false;
  v_would_be_late boolean;
  v_waiver        text;
  v_is_late       boolean;
  v_allow         boolean;
begin
  -- 🔴 อ่าน policy จาก snapshot เท่านั้น ห้ามอ่านค่าปัจจุบันจาก gangs
  v_policy       := coalesce(p_session.snapshot -> 'cancellation_policy', '{}'::jsonb);
  v_cutoff_hours := coalesce((v_policy ->> 'cutoff_hours')::numeric, 0);
  v_cutoff_at    := p_session.starts_at - (v_cutoff_hours * interval '1 hour');
  -- คนที่รออยู่ใน waitlist ยังไม่ได้ที่ ⇒ ไม่มี penalty ไม่ว่ายกเลิกตอนไหน
  v_would_be_late := (p_reg.status = 'confirmed') and (p_now > v_cutoff_at);

  -- [ADR-011] grace หลังถูกเลื่อนคิว — นัดเก่าไม่มีคีย์ = 0 = ไม่มี grace
  v_grace_hours := coalesce((v_policy ->> 'promoted_grace_hours')::numeric, 0);
  if p_reg.status = 'confirmed' and p_reg.promoted_at is not null and v_grace_hours > 0 then
    v_grace_until := least(
      p_reg.promoted_at + (v_grace_hours * interval '1 hour'),
      p_session.starts_at
    );
    v_in_grace := p_now <= v_grace_until;
  end if;

  -- แอดมินยกเว้น > grace (ถ้าเข้าทั้งคู่ ให้บันทึกว่าแอดมินตัดสินใจ)
  -- grace บันทึกเฉพาะตอนที่ "มิฉะนั้นจะนับเป็นยกเลิกช้า" เพื่อไม่ให้ข้อมูลรก
  v_waiver := case
                when coalesce(p_waive, false) then 'admin'
                when v_in_grace and v_would_be_late then 'promoted_grace'
                else null
              end;

  v_is_late := v_would_be_late and v_waiver is null;
  v_allow   := coalesce((v_policy ->> 'allow_cancel_after_cutoff')::boolean, true);

  return query select
    v_policy,
    v_cutoff_at,
    v_would_be_late,
    v_grace_until,
    v_in_grace,
    v_waiver,
    v_is_late,
    v_allow,
    (v_is_late and not v_allow);
end;
$$;

comment on function public.cancel_decision(public.session_registrations, public.sessions, boolean, timestamptz) is
  '[WO-B11.1] ตัวตัดสินผลการยกเลิกตัวเดียว (cutoff/grace/waiver/late/blocked) — cancel_registration() และ preview_cancel_registration() เรียกตัวนี้เท่านั้น ห้ามเขียนตรรกะซ้ำ';

revoke execute on function public.cancel_decision(public.session_registrations, public.sessions, boolean, timestamptz)
  from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- cancel_registration — พฤติกรรมเดิมของ 0041 ทุกอย่าง · เปลี่ยนแค่เรียก cancel_decision()
-- -----------------------------------------------------------------------------
create or replace function public.cancel_registration(
  p_registration_id         uuid,
  p_actor_id                uuid    default null,
  p_correlation_id          text    default null,
  p_waive_penalty           boolean default false,
  p_reason                  text    default null,
  p_promote_registration_id uuid    default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg           public.session_registrations;
  v_session       public.sessions;
  v_session_id    uuid;
  v_d             record;
  v_reason        text := nullif(btrim(coalesce(p_reason, '')), '');
  v_was_status    text;
begin
  -- อ่าน session_id ก่อนโดยไม่ล็อก เพื่อจะได้ล็อกตามลำดับ session → registration
  -- (ลำดับเดียวกันทุกฟังก์ชัน = ไม่มี deadlock ไขว้)
  select session_id into v_session_id
    from public.session_registrations
   where id = p_registration_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  select * into v_session
    from public.sessions
   where id = v_session_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session')::text;
  end if;

  select * into v_reg
    from public.session_registrations
   where id = p_registration_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  v_was_status := v_reg.status;

  -- อนุญาตเฉพาะ confirmed → cancelled และ waitlist → cancelled
  if v_was_status not in ('confirmed', 'waitlist') then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_was_status,
        'to_status',       'cancelled'
      )::text;
  end if;

  -- "เปลี่ยนคน": ยกเลิก A แล้วเลื่อน B ใน transaction เดียว — ถ้าปล่อยให้ promote ตามคิวเอง หัวคิวจะได้ที่ก่อน
  -- B ที่แอดมินเลือกจะไม่ได้ที่ (SESSION_FULL) ⇒ ต้องส่งเป้าหมายเข้ามาตรงนี้ · ยังเป็นการเลื่อนผ่าน
  -- promote_waitlist() ตัวเดียว (ตรวจสิทธิ์แอดมิน/ที่ว่าง/สถานะของ B ในนั้น — พังตรงไหน ยกเลิก A ถูก rollback ด้วย)
  if p_promote_registration_id is not null and v_was_status <> 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field',  'promote_registration_id',
        'reason', 'เลือกคนเลื่อนได้เฉพาะตอนยกเลิกคนที่ถือที่อยู่'
      )::text;
  end if;

  -- ขอยกเว้นค่าปรับ: ต้องเป็นแอดมินจริง (ตรวจใน DB) และต้องบอกเหตุผล
  if coalesce(p_waive_penalty, false) then
    if not public.actor_is_gang_admin(v_session.gang_id, p_actor_id) then
      raise exception using
        errcode = 'P0001',
        message = 'FORBIDDEN',
        detail  = json_build_object('reason', 'เฉพาะแอดมินที่ยกเว้นค่าปรับได้')::text;
    end if;

    if v_reason is null then
      raise exception using
        errcode = 'P0001',
        message = 'VALIDATION_ERROR',
        detail  = json_build_object('field', 'reason', 'reason', 'ต้องระบุเหตุผลที่ไม่คิดค่าปรับ')::text;
    end if;
  end if;

  -- 🔴 ตรรกะตัดสินอยู่ที่ cancel_decision() ที่เดียว (ใช้ร่วมกับ preview)
  select * into v_d
    from public.cancel_decision(v_reg, v_session, coalesce(p_waive_penalty, false));

  if v_d.blocked then
    raise exception using
      errcode = 'P0001',
      message = 'CANCEL_CUTOFF_PASSED',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'cutoff_at',       v_d.cutoff_at,
        'starts_at',       v_session.starts_at
      )::text;
  end if;

  update public.session_registrations
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancel_waiver = v_d.waiver,
         updated_by    = coalesce(p_actor_id, updated_by)
   where id = p_registration_id
  returning * into v_reg;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, v_session.id, 'registration.cancelled', 'registration',
     p_registration_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_status',    v_was_status,
       -- [D-9] บันทึกข้อเท็จจริงให้ domain/billing คิดเงินตอนปิดรอบ
       --       is_late_cancel = "ถูกคิดเป็นยกเลิกช้าจริง" (หลังหักการยกเว้นแล้ว)
       'is_late_cancel', v_d.is_late,
       'cutoff_at',      v_d.cutoff_at,
       'cancelled_at',   v_reg.cancelled_at,
       'policy',         v_d.policy,
       -- [ADR-011]
       'would_be_late_cancel', v_d.would_be_late,
       'penalty_waived_by',    v_d.waiver,
       'promoted_at',          v_reg.promoted_at,
       'grace_until',          v_d.grace_until
     ));

  if coalesce(p_waive_penalty, false) then
    -- เหตุผลเป็นข้อความอิสระของแอดมิน ⇒ เก็บใน audit.* (admin-only) ไม่ใส่ใน event ที่สมาชิกอ่านได้
    insert into public.event_logs
      (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (v_session.gang_id, v_session.id, 'audit.registration_penalty_waived', 'registration',
       p_registration_id, p_actor_id,
       jsonb_build_object(
         'correlation_id',      p_correlation_id,
         'reason',              v_reason,
         'would_be_late_cancel', v_d.would_be_late
       ));
  end if;

  -- ที่ว่างเพิ่งเกิดขึ้นเฉพาะตอนที่คนยกเลิกเคยถือที่อยู่
  if v_was_status = 'confirmed' then
    if p_promote_registration_id is not null then
      perform public.promote_waitlist(
        v_session.id, null, p_actor_id, p_correlation_id, p_promote_registration_id
      );
    else
      perform public.promote_waitlist(v_session.id, null, p_actor_id, p_correlation_id);
    end if;
  end if;

  return v_reg;
end;
$$;

comment on function public.cancel_registration(uuid, uuid, text, boolean, text, uuid) is
  '[D-9][ADR-011] cancelled + บันทึก is_late_cancel (หลังหัก grace/ยกเว้น) + cancel_waiver ลงแถว (ไม่ insert charges — ADR-001) + promote ในตัว · ตรรกะตัดสินอยู่ใน cancel_decision() (ใช้ร่วมกับ preview)';


-- -----------------------------------------------------------------------------
-- preview_cancel_registration(registration_id, actor_id) — read-only
-- -----------------------------------------------------------------------------
-- คืน jsonb:
--   outcome     free_in_grace | free_before_cutoff | penalty | blocked
--   free_until  ยกเลิกฟรีได้ถึงเมื่อไหร่ (null = ไม่มีเส้นตาย เช่นคนอยู่ waitlist · หรือ penalty/blocked)
--   penalty_type  เฉพาะ outcome = penalty (จาก snapshot) · ไม่คืนจำนวนเงิน
--   reason      รหัสสั้นให้ UI เลือกข้อความ: waitlist | before_cutoff | promoted_grace | late_cancel | cutoff_passed
--
-- ไม่ lock ไม่เขียน — เป็นภาพ ณ ตอนที่ถาม ผลจริงตัดสินใหม่ใต้ lock ตอน cancel
-- สิทธิ์: actor ต้องเป็นเจ้าของใบลงชื่อ หรือแอดมินของก๊วน (เหมือน can() ของ cancel.self / cancel.other)
-- ไม่คิดกรณีแอดมินกด "ไม่คิดค่าปรับ" (เป็นตัวเลือกที่แอดมินเลือกเอง ไม่ใช่ผลตามนโยบาย)
create or replace function public.preview_cancel_registration(
  p_registration_id uuid,
  p_actor_id        uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reg     public.session_registrations;
  v_session public.sessions;
  v_d       record;
  v_outcome text;
  v_reason  text;
  v_free_until timestamptz;
  v_penalty text;
begin
  select * into v_reg
    from public.session_registrations
   where id = p_registration_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  select * into v_session
    from public.sessions
   where id = v_reg.session_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session')::text;
  end if;

  if p_actor_id is null
     or not (
       v_reg.user_id = p_actor_id
       or public.actor_is_gang_admin(v_session.gang_id, p_actor_id)
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'ดูผลการยกเลิกได้เฉพาะเจ้าของใบลงชื่อหรือแอดมิน')::text;
  end if;

  -- สถานะเดียวกับที่ cancel_registration() รับ — ที่เหลือไม่มีอะไรให้ยกเลิก
  if v_reg.status not in ('confirmed', 'waitlist') then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_reg.status,
        'to_status',       'cancelled'
      )::text;
  end if;

  select * into v_d from public.cancel_decision(v_reg, v_session, false);

  if v_d.blocked then
    v_outcome := 'blocked';
    v_reason  := 'cutoff_passed';
  elsif v_d.waiver = 'promoted_grace' then
    v_outcome    := 'free_in_grace';
    v_reason     := 'promoted_grace';
    v_free_until := v_d.grace_until;
  elsif v_d.is_late then
    v_outcome := 'penalty';
    v_reason  := 'late_cancel';
    v_penalty := v_d.policy ->> 'penalty_type';
  else
    v_outcome := 'free_before_cutoff';
    if v_reg.status = 'waitlist' then
      v_reason := 'waitlist';
    else
      v_reason     := 'before_cutoff';
      -- ถ้ายังอยู่ใน grace ต่อจาก cutoff ก็ฟรีไปถึงสิ้นสุด grace (ตามจริงที่ cancel จะตัดสิน)
      v_free_until := greatest(v_d.cutoff_at, coalesce(v_d.grace_until, v_d.cutoff_at));
    end if;
  end if;

  return jsonb_build_object(
    'outcome',      v_outcome,
    'free_until',   v_free_until,
    'penalty_type', v_penalty,
    'reason',       v_reason
  );
end;
$$;

comment on function public.preview_cancel_registration(uuid, uuid) is
  '[WO-B11.1] read-only: ผลถ้ายกเลิกตอนนี้ (free_in_grace/free_before_cutoff/penalty/blocked + free_until) — เรียก cancel_decision() ตัวเดียวกับ cancel_registration() · ไม่คืนจำนวนเงิน';

revoke execute on function public.preview_cancel_registration(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.preview_cancel_registration(uuid, uuid) to service_role;
