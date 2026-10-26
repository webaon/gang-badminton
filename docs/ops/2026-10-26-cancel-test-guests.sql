-- ยกเลิก guest ทดสอบชื่อ "Ford" 3 แถว ในนัดแรกของก๊วนเรนนี่ (production)
-- รันใน Supabase Dashboard → SQL Editor ของโปรเจกต์ emmzeriekkjryhucvctx
-- ใช้ cancel_registration() (ทางเดียวที่ถูกต้อง) — ไม่ DELETE ตรง ⇒ มี event log ครบ และคิว waitlist เลื่อนเอง
-- ยกเลิกก่อน cutoff = ไม่มี penalty

-- ขั้น 1: ดูก่อน — ต้องได้ 3 แถว ชื่อ 'Ford' / 'Ford ' และเป็นนัด "พิชิตแมทเรทนี่"
select r.id, '"' || r.guest_name || '"' as guest_name, r.status, r.created_at, s.title, s.status as session_status
  from public.session_registrations r
  join public.sessions s on s.id = r.session_id
 where s.gang_id = '01a01fa3-9f0d-7608-8488-422674632e30'
   and r.user_id is null
   and trim(r.guest_name) = 'Ford'
   and r.status in ('confirmed', 'waitlist')
   and r.deleted_at is null
 order by r.created_at;

-- ขั้น 2: ยกเลิก — ถ้าจำนวนไม่ใช่ 3 จะ rollback ทั้งหมด
do $$
declare
  v_ids   uuid[];
  v_id    uuid;
  v_owner uuid;
begin
  select array_agg(r.id order by r.created_at) into v_ids
    from public.session_registrations r
    join public.sessions s on s.id = r.session_id
   where s.gang_id = '01a01fa3-9f0d-7608-8488-422674632e30'
     and r.user_id is null
     and trim(r.guest_name) = 'Ford'
     and r.status in ('confirmed', 'waitlist')
     and r.deleted_at is null;

  if coalesce(array_length(v_ids, 1), 0) <> 3 then
    raise exception 'คาดว่า 3 แถว แต่เจอ % — ไม่ทำอะไร', coalesce(array_length(v_ids, 1), 0);
  end if;

  select gm.user_id into v_owner
    from public.gang_members gm
   where gm.gang_id = '01a01fa3-9f0d-7608-8488-422674632e30'
     and gm.role = 'owner' and gm.deleted_at is null
   limit 1;

  foreach v_id in array v_ids loop
    perform public.cancel_registration(v_id, v_owner, 'ops:cancel-test-guests-2026-10-26');
  end loop;
end $$;

-- ขั้น 3: ตรวจผล — ต้องเหลือแค่ owner ลงชื่ออยู่ 1 คน
select r.status, coalesce(r.guest_name, '(สมาชิก)') as who, count(*)
  from public.session_registrations r
  join public.sessions s on s.id = r.session_id
 where s.gang_id = '01a01fa3-9f0d-7608-8488-422674632e30'
   and r.deleted_at is null
 group by 1, 2 order by 1;
