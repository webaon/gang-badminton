-- =============================================================================
-- WO-2.3 · 0015 — สร้างก๊วนแบบ atomic + default cancellation policy ตาม ADR-002
-- =============================================================================
-- 🔴 ทำไมต้องเป็น DB function [D-17]
--
-- baseline §โมดูล ข้อ 2: "สร้างก๊วน (auto-create org)" ⇒ หนึ่งการกระทำของผู้ใช้
-- ต้องสร้าง 4 แถวข้ามตาราง: organizations · organization_members · gangs · gang_members
--
-- supabase-js ทำ multi-statement transaction ไม่ได้ ⇒ ถ้าแยกเป็น 4 request
-- แล้วพังกลางทางจะเหลือขยะที่กู้ยาก เช่น org ที่ไม่มีก๊วน หรือก๊วนที่ไม่มีเจ้าของ
-- (ก๊วนที่ไม่มีใครเป็น owner = ไม่มีใครแก้ได้เลย เพราะ policy ต้องการ is_gang_admin)
--
-- ⇒ รวมเป็นฟังก์ชันเดียวที่ทำทั้งหมดใน transaction เดียว
--
-- ⚠️ **ไม่ใช้ auth.uid()** แต่รับ `p_owner_id` เข้ามา
--    เพราะฟังก์ชันนี้ grant ให้ `service_role` เท่านั้น (กติกาจาก WO-1.4)
--    ⇒ ถูกเรียกจาก server action ที่ตรวจ session แล้ว และส่ง id ที่ยืนยันแล้วเข้ามา
--    server action **ห้ามรับ owner id จาก client** เด็ดขาด
--
-- Rollback: DROP FUNCTION public.create_gang(uuid, text, text, text, text, text);
--           ALTER TABLE public.gangs ALTER COLUMN cancellation_policy SET DEFAULT '{}'::jsonb;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- default ของ cancellation_policy — ADR-002
-- -----------------------------------------------------------------------------
-- เดิม default เป็น '{}' ซึ่ง `fromJson()` จะตีความเป็น penalty_type = 'none'
-- ⇒ ก๊วนที่ถูกสร้างด้วยเส้นทางอื่น (import, งานภายใน) จะกลายเป็นก๊วนที่ไม่เก็บ
--   penalty เลยโดยไม่มีใครตั้งใจ — ตั้ง default ให้ตรงกับที่ ADR เลือกไว้
alter table public.gangs
  alter column cancellation_policy
  set default '{"cutoff_hours": 12, "allow_cancel_after_cutoff": true, "penalty_type": "full_share"}'::jsonb;

comment on column public.gangs.cancellation_policy is
  'ADR-002 schema: { cutoff_hours, allow_cancel_after_cutoff, penalty_type, penalty_value? } — snapshot ลง session ตอนสร้างนัด ห้ามอ่านค่านี้ตอนคิดเงิน';


-- -----------------------------------------------------------------------------
-- create_gang(...)
-- -----------------------------------------------------------------------------
create or replace function public.create_gang(
  p_owner_id       uuid,
  p_name           text,
  p_org_name       text default null,
  p_area           text default null,
  p_timezone       text default 'Asia/Bangkok',
  p_correlation_id text default null
)
returns public.gangs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  public.organizations;
  v_gang public.gangs;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'name', 'reason', 'ต้องระบุชื่อก๊วน')::text;
  end if;

  if not exists (select 1 from public.profiles where id = p_owner_id) then
    -- ผู้ใช้ต้องมีโปรไฟล์ก่อน (trigger สร้างให้ตอนสมัครแล้ว) — ถ้าไม่มีแปลว่า
    -- มีคนส่ง id มั่วเข้ามา ซึ่งต้องดังตั้งแต่ตรงนี้
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'profile', 'id', p_owner_id)::text;
  end if;

  -- 1) องค์กร — ชื่อเดียวกับก๊วนถ้าไม่ได้ระบุ (ผู้ใช้ส่วนใหญ่มีก๊วนเดียว
  --    และไม่ควรต้องเข้าใจแนวคิด "องค์กร" ตั้งแต่วันแรก)
  insert into public.organizations (name, owner_id, created_by)
  values (btrim(coalesce(nullif(p_org_name, ''), v_name)), p_owner_id, p_owner_id)
  returning * into v_org;

  insert into public.organization_members (org_id, user_id, role, created_by)
  values (v_org.id, p_owner_id, 'owner', p_owner_id);

  -- 2) ก๊วน — cancellation_policy/features ใช้ default ของคอลัมน์ (ADR-002)
  insert into public.gangs (org_id, name, area, timezone, created_by)
  values (v_org.id, v_name, nullif(btrim(coalesce(p_area, '')), ''), p_timezone, p_owner_id)
  returning * into v_gang;

  -- 3) ผู้สร้างเป็น owner ของก๊วนด้วย
  --    ถ้าลืมขั้นนี้ ก๊วนจะไม่มีใครแก้ได้เลยเพราะทุก policy ต้องการ is_gang_admin()
  insert into public.gang_members (gang_id, user_id, role, created_by)
  values (v_gang.id, p_owner_id, 'owner', p_owner_id);

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang.id, 'gang.created', 'gang', v_gang.id, p_owner_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'org_id',         v_org.id,
       'name',           v_name
     ));

  return v_gang;
end;
$$;

comment on function public.create_gang(uuid, text, text, text, text, text) is
  '[D-17] สร้าง org + org_member + gang + gang_member ใน transaction เดียว — กันก๊วนที่ไม่มีเจ้าของ';

-- กติกาเดียวกับ WO-1.4: DB function เรียกได้จาก server เท่านั้น
revoke execute on function public.create_gang(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_gang(uuid, text, text, text, text, text)
  to service_role;
