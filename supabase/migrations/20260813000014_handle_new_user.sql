-- =============================================================================
-- WO-2.2 · 0014 — สร้างแถว profiles อัตโนมัติเมื่อมีผู้ใช้ใหม่
-- =============================================================================
-- 🔴 ตัดสินใจ (ยืนยันกับเจ้าของงาน 13 ส.ค. 2026): ใช้ **DB trigger** ไม่ใช่ server action
--
-- เหตุผล: `profiles.display_name` เป็น NOT NULL และแทบทุก query ในระบบ join
-- `profiles` ⇒ `auth.users` ที่ไม่มีแถว profile คู่กัน = ผู้ใช้ที่ล็อกอินได้แต่
-- ใช้งานอะไรไม่ได้เลย และมองไม่เห็นจากฝั่งแอปด้วยซ้ำ
--
-- trigger ทำงานใน transaction เดียวกับการสร้าง user ⇒ **เป็นไปไม่ได้ที่จะมี
-- orphan user** ส่วน server action มีช่องเสมอ: magic link เข้าผ่าน callback
-- ถ้าผู้ใช้ปิดแท็บกลางคันก็จะเหลือ user ที่ไม่มี profile ค้างไว้
--
-- ข้อแลกเปลี่ยนที่รับไว้: **trigger พัง = สมัครไม่ได้เลย** และ error message
-- ที่ผู้ใช้เห็นจะเป็นข้อความจาก Postgres ที่อ่านไม่รู้เรื่อง
-- ⇒ จึงต้องเขียน trigger ให้ "ล้มไม่ได้" (ดู fallback ของ display_name ด้านล่าง)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ ผลข้างเคียงกับ seed และเทสต์
--
-- seed กับ `createUser()` ในเทสต์ insert `auth.users (id)` โดย **ไม่มี email**
-- ⇒ ถ้า fallback ของ display_name จบที่ `split_part(email, '@', 1)` จะได้ null
--   แล้วชน NOT NULL ทำให้ seed/เทสต์พังทั้งชุด
-- ⇒ fallback จึงต้องจบที่ค่าคงที่เสมอ
--
-- และเพราะ trigger สร้างแถวให้แล้ว ที่ที่เคย `insert into profiles` ตามหลัง
-- ต้องเปลี่ยนเป็น upsert (`on conflict (id) do update`) ไม่งั้นชน PK
-- — แก้ให้แล้วทั้งใน `supabase/seed/seed.sql` และ `tests/helpers/db.ts`
--
-- Rollback: DROP TRIGGER on_auth_user_created ON auth.users;
--           DROP FUNCTION public.handle_new_user();
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  -- ลำดับการหาชื่อ: ที่ผู้ใช้กรอกตอนสมัคร → ส่วนหน้าของอีเมล → ค่าคงที่
  --
  -- 🔴 ต้องจบที่ค่าคงที่เสมอ ห้ามมีทางที่ผลลัพธ์เป็น null
  --    เพราะ display_name เป็น NOT NULL ⇒ null = สมัครไม่สำเร็จ
  --    (และผู้ใช้ที่สร้างจาก dashboard/seed ไม่มี email ด้วยซ้ำ)
  v_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'สมาชิกใหม่'
  );

  insert into public.profiles (id, display_name, phone)
  values (
    new.id,
    v_display_name,
    nullif(btrim(new.raw_user_meta_data ->> 'phone'), '')
  )
  -- เผื่อมีใครสร้างแถวไว้ก่อนแล้ว (เช่น seed ที่ควบคุมชื่อเอง) — อย่าล้ม
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'สร้าง public.profiles อัตโนมัติตอนมี auth.users ใหม่ — atomic กับการสมัคร จึงไม่มี orphan user';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
