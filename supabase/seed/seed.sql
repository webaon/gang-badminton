-- =============================================================================
-- WO-1.5 — Seed: ก๊วนตัวอย่างหนึ่งก๊วนที่ใช้งานได้จริง
-- =============================================================================
-- DoD: **รันซ้ำได้ (idempotent)** — รันกี่รอบก็ได้สถานะเดียวกัน ไม่สร้างซ้ำ ไม่ error
--
-- วิธีทำ idempotent:
--   - แถวพื้นฐานใช้ UUID คงที่ + `on conflict do nothing`
--   - ส่วนที่ต้องเรียก DB function (ลงชื่อ/เปลี่ยนสถานะ) ห่อด้วย guard
--     เพราะเรียกซ้ำจะ raise (ALREADY_REGISTERED / INVALID_TRANSITION) ตามที่ควรเป็น
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 seed เดินตามเส้นทางเดียวกับ production ทุกขั้น
--    ไม่ยัด status ตรงๆ และไม่ insert registrations เอง แต่เรียก
--    transition_session() / register_to_session() / close_session_with_charges()
--    ⇒ ถ้าวันหนึ่ง state machine เปลี่ยนแล้ว seed พัง นั่นคือสัญญาณที่ต้องการ
--      ไม่ใช่ความรำคาญ
--
-- ⚠️ seed รันด้วยสิทธิ์ `postgres` ⇒ bypass RLS (แต่ **ไม่** bypass trigger)
--    การเปลี่ยน status จึงยังต้องผ่าน GUC ของ transition_session() เหมือนเดิม
--
-- ⚠️ ข้อมูลชุดนี้เป็นของปลอมสำหรับ dev เท่านั้น — ห้ามรันบน production
-- =============================================================================

do $seed$
declare
  -- UUID คงที่เพื่อให้รันซ้ำแล้วชนของเดิม (v7 layout: version=7, variant=8)
  k_org      constant uuid := '00000000-0000-7000-8000-00000000a001';
  k_gang     constant uuid := '00000000-0000-7000-8000-00000000b001';
  k_plan     constant uuid := '00000000-0000-7000-8000-00000000c001';
  k_upcoming constant uuid := '00000000-0000-7000-8000-00000000d001';
  k_past     constant uuid := '00000000-0000-7000-8000-00000000d002';

  v_user_ids  uuid[];
  v_names     text[] := array[
    'ต้น (หัวก๊วน)', 'แนน (แอดมิน)', 'บอส', 'ฝ้าย', 'กิ๊ฟ',
    'เอ็ม', 'ปอนด์', 'จูน', 'ตูน', 'หนึ่ง'
  ];
  v_roles     text[] := array[
    'owner', 'admin', 'member', 'member', 'member',
    'member', 'member', 'member', 'member', 'member'
  ];
  v_uid       uuid;
  v_snapshot  jsonb;
  v_charges   jsonb;
  i           integer;
begin
  ---------------------------------------------------------------------------
  -- 1. ผู้ใช้ + โปรไฟล์
  ---------------------------------------------------------------------------
  v_user_ids := array[]::uuid[];

  for i in 1 .. array_length(v_names, 1) loop
    v_uid := ('00000000-0000-7000-8000-0000000f' || lpad(i::text, 4, '0'))::uuid;
    v_user_ids := v_user_ids || v_uid;

    insert into auth.users (id) values (v_uid) on conflict (id) do nothing;

    -- trigger on_auth_user_created สร้างแถวให้แล้วพร้อมชื่อ fallback
    -- ⇒ upsert เพื่อเขียนทับด้วยชื่อจริงของ seed
    insert into public.profiles (id, display_name, phone)
    values (v_uid, v_names[i], '08' || lpad(i::text, 8, '0'))
    on conflict (id) do update
      set display_name = excluded.display_name,
          phone        = excluded.phone;
  end loop;

  ---------------------------------------------------------------------------
  -- 2. องค์กร + ก๊วน
  ---------------------------------------------------------------------------
  insert into public.organizations (id, name, owner_id, created_by)
  values (k_org, 'ก๊วนแบดหลังบ้าน', v_user_ids[1], v_user_ids[1])
  on conflict (id) do nothing;

  insert into public.organization_members (org_id, user_id, role)
  values (k_org, v_user_ids[1], 'owner')
  on conflict (org_id, user_id) do nothing;

  insert into public.gangs (
    id, org_id, name, description, area, is_public, promptpay_id, timezone,
    cancellation_policy, features, created_by
  )
  values (
    k_gang, k_org, 'ก๊วนแบดวันพุธ',
    'ตีกันทุกวันพุธกับวันเสาร์ สนามในร่ม 3 คอร์ท',
    'ลาดพร้าว กรุงเทพฯ', true, '0812345678', 'Asia/Bangkok',
    -- cutoff 12 ชม. · ยกเลิกหลัง cutoff ได้แต่โดน penalty
    '{"cutoff_hours": 12, "allow_cancel_after_cutoff": true}'::jsonb,
    '{"line": false, "discovery": true, "guests": true, "coupons": false, "statistics": true}'::jsonb,
    v_user_ids[1]
  )
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------
  -- 3. ระดับฝีมือ + สมาชิก
  ---------------------------------------------------------------------------
  insert into public.gang_skill_levels (gang_id, label, rank)
  values (k_gang, 'มือใหม่', 1), (k_gang, 'มือกลาง', 2), (k_gang, 'มือหนัก', 3)
  on conflict (gang_id, rank) do nothing;

  for i in 1 .. array_length(v_user_ids, 1) loop
    insert into public.gang_members (gang_id, user_id, role, skill_level_id, is_monthly_member)
    select k_gang, v_user_ids[i], v_roles[i],
           (select id from public.gang_skill_levels
             where gang_id = k_gang and rank = 1 + (i % 3)),
           (i = 3)   -- ให้ "บอส" เป็นสมาชิกรายเดือน ไว้ทดสอบ MembershipBilling
     where not exists (
       select 1 from public.gang_members
        where gang_id = k_gang and user_id = v_user_ids[i] and deleted_at is null
     );
  end loop;

  ---------------------------------------------------------------------------
  -- 4. แผนราคา
  ---------------------------------------------------------------------------
  insert into public.gang_pricing_plans (
    id, gang_id, name, type, params, rounding_policy, monthly_member_pays_shuttle, created_by
  )
  values (
    k_plan, k_gang, 'ค่าคอร์ท + ค่าลูก (หารเท่า)', 'court_plus_shuttle',
    '{"court_fee_total": "900.00", "shuttle_price": "25.00"}'::jsonb,
    '{"mode": "ceil_baht", "surplus_to": "gang"}'::jsonb,
    true, v_user_ids[1]
  )
  on conflict (id) do nothing;

  -- 🔴 snapshot = บันทึกแช่แข็ง ต้องมีทุกอย่างที่กระทบเงิน (baseline §Snapshot rule)
  select jsonb_build_object(
           'snapshot_version', 1,
           'pricing_plan', jsonb_build_object(
             'id', p.id, 'type', p.type, 'params', p.params,
             'monthly_member_pays_shuttle', p.monthly_member_pays_shuttle
           ),
           'rounding_policy', p.rounding_policy,
           'promptpay_id', g.promptpay_id,
           'cancellation_policy', g.cancellation_policy,
           'skill_levels', coalesce(
             (select jsonb_agg(jsonb_build_object('label', sl.label, 'rank', sl.rank) order by sl.rank)
                from public.gang_skill_levels sl where sl.gang_id = k_gang),
             '[]'::jsonb
           )
         )
    into v_snapshot
    from public.gang_pricing_plans p
    join public.gangs g on g.id = p.gang_id
   where p.id = k_plan;

  ---------------------------------------------------------------------------
  -- 5. นัดที่กำลังจะถึง — เปิดรับสมัคร มีคนเต็มและมี waitlist
  ---------------------------------------------------------------------------
  if not exists (select 1 from public.sessions where id = k_upcoming) then
    insert into public.sessions (
      id, gang_id, title, venue, starts_at, ends_at,
      court_count, court_labels, max_players, allow_guests, snapshot, created_by
    )
    values (
      k_upcoming, k_gang, 'ซ้อมวันพุธ', 'สนามแบดลาดพร้าว',
      date_trunc('hour', now()) + interval '3 days' + interval '19 hours',
      date_trunc('hour', now()) + interval '3 days' + interval '22 hours',
      3, '["A", "B", "C"]'::jsonb, 8, true, v_snapshot, v_user_ids[1]
    );

    -- draft → open ผ่าน state machine ไม่ยัด status ตรง
    perform public.transition_session(k_upcoming, 'open', v_user_ids[1], 'seed');

    -- ลงชื่อครบ 10 คน ⇒ 8 confirmed + 2 waitlist (max_players = 8)
    for i in 1 .. array_length(v_user_ids, 1) loop
      perform public.register_to_session(
        k_upcoming, v_user_ids[i], null, null, null, v_user_ids[i], 'seed'
      );
    end loop;
  end if;

  ---------------------------------------------------------------------------
  -- 6. นัดที่ผ่านมาแล้ว — ปิดรอบพร้อม charges ครบ (ไว้ทดสอบรายงาน/ยอดค้างจ่าย)
  ---------------------------------------------------------------------------
  if not exists (select 1 from public.sessions where id = k_past) then
    insert into public.sessions (
      id, gang_id, title, venue, starts_at, ends_at,
      court_count, max_players, allow_guests, snapshot, created_by
    )
    values (
      k_past, k_gang, 'ซ้อมเสาร์ที่แล้ว', 'สนามแบดลาดพร้าว',
      date_trunc('hour', now()) - interval '4 days',
      date_trunc('hour', now()) - interval '4 days' + interval '3 hours',
      2, 6, true, v_snapshot, v_user_ids[1]
    );

    perform public.transition_session(k_past, 'open', v_user_ids[1], 'seed');

    -- 6 คนแรกลงชื่อและมาจริง
    for i in 1 .. 6 loop
      perform public.register_to_session(
        k_past, v_user_ids[i], null, null, null, v_user_ids[i], 'seed'
      );
      perform public.check_in_registration(
        (select id from public.session_registrations
          where session_id = k_past and user_id = v_user_ids[i]),
        v_user_ids[1], 'seed'
      );
    end loop;

    perform public.transition_session(k_past, 'in_play', v_user_ids[1], 'seed');

    -- คิดเงิน: ค่าคอร์ท 900 หาร 6 = 150 + ค่าลูก 2 ลูก/คน × 25 = 50 ⇒ 200 บาท
    -- (ของจริงคำนวณใน domain/billing ฝั่ง TS — ที่นี่ใส่ตัวเลขตรงๆ เพราะ Phase 2 ยังไม่เขียน)
    select jsonb_agg(
             jsonb_build_object(
               'registration_id', r.id,
               'amount', '200.00',
               'breakdown', jsonb_build_object('court', '150.00', 'shuttle', '50.00')
             )
           )
      into v_charges
      from public.session_registrations r
     where r.session_id = k_past and r.deleted_at is null;

    perform public.close_session_with_charges(
      k_past, v_charges, 'in_play', 'billing', v_user_ids[1], 'seed'
    );
    perform public.transition_session(k_past, 'settled', v_user_ids[1], 'seed');
  end if;

  ---------------------------------------------------------------------------
  -- 7. ประกาศ
  ---------------------------------------------------------------------------
  insert into public.announcements (gang_id, title, body, published_at, created_by)
  select k_gang, 'ย้ายสนามชั่วคราว',
         'สัปดาห์หน้าสนามประจำปิดปรับปรุง ย้ายไปสนามข้างเซเว่นครับ',
         now() - interval '1 day', v_user_ids[1]
   where not exists (
     select 1 from public.announcements
      where gang_id = k_gang and title = 'ย้ายสนามชั่วคราว'
   );

  raise notice 'seed เสร็จแล้ว: ก๊วน % · สมาชิก % คน · นัด 2 ใบ',
    'ก๊วนแบดวันพุธ', array_length(v_user_ids, 1);
end
$seed$;
