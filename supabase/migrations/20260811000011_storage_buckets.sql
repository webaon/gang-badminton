-- =============================================================================
-- WO-1.4 · 0011 — Storage buckets + policies
-- =============================================================================
-- Baseline §Storage Buckets:
--   payment-slips        private — เจ้าของ + แอดมินก๊วน
--   avatars              public read, เจ้าของเขียน
--   gang-assets          public read, แอดมินก๊วนเขียน
--   announcement-images  สมาชิกอ่าน, แอดมินเขียน
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 [D-15] ข้อตกลงเรื่อง path — policy ทั้งไฟล์นี้พึ่งมันทั้งหมด
--
--   payment-slips/<gang_id>/<payment_id>/<file>
--   avatars/<user_id>/<file>
--   gang-assets/<gang_id>/<file>
--   announcement-images/<gang_id>/<file>
--
-- `storage.foldername(name)[1]` = โฟลเดอร์แรก ⇒ ใช้เป็น tenant key ในการตรวจสิทธิ์
-- baseline ไม่ได้กำหนด path ไว้ แต่ RLS ของ storage ตรวจได้จากชื่อไฟล์เท่านั้น
-- (ไม่มีคอลัมน์ gang_id ใน storage.objects) ⇒ **อัปโหลดผิด path = สิทธิ์ผิดทันที**
-- ฝั่ง server action ต้องประกอบ path เอง ห้ามให้ client ส่ง path มาดิบๆ
--
-- ⚠️ `avatars` / `gang-assets` เป็น bucket public: ใครมี URL ก็เปิดดูได้โดยไม่ต้อง
--    ผ่าน RLS เลย (storage API เสิร์ฟ public bucket ตรง) ⇒ **ห้ามเอาของที่เป็น
--    ความลับไปวางในสองอันนี้เด็ดขาด** สลิปโอนเงินต้องอยู่ payment-slips เท่านั้น
--
-- Rollback: DROP POLICY ... ON storage.objects (ทุกตัวในไฟล์นี้);
--           DELETE FROM storage.buckets WHERE id IN
--             ('payment-slips','avatars','gang-assets','announcement-images');
--           (ลบ bucket ได้เฉพาะตอนไม่มีไฟล์ค้าง)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- buckets
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- สลิปโอนเงิน — ความลับ ห้าม public
  ('payment-slips', 'payment-slips', false, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),

  ('avatars', 'avatars', true, 2097152,
   array['image/jpeg', 'image/png', 'image/webp']),

  ('gang-assets', 'gang-assets', true, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']),

  -- baseline บอก "สมาชิกอ่าน" ⇒ ไม่ public
  ('announcement-images', 'announcement-images', false, 5242880,
   array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;


-- =============================================================================
-- payment-slips — private
-- =============================================================================
-- อ่าน: คนอัปโหลดเอง หรือแอดมินของก๊วนตาม path[1]
create policy payment_slips_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
    )
  );

-- เขียน: สมาชิกก๊วนนั้นอัปสลิปของตัวเองได้
create policy payment_slips_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-slips'
    and owner = (select auth.uid())
    and (select public.is_gang_member((storage.foldername(name))[1]::uuid))
  );

-- แก้/ลบ: เจ้าของสลิป หรือแอดมิน (เช่นลบสลิปที่อัปผิด)
create policy payment_slips_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
    )
  );

create policy payment_slips_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
    )
  );


-- =============================================================================
-- avatars — public read, เจ้าของเขียน
-- =============================================================================
create policy avatars_select_public on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );


-- =============================================================================
-- gang-assets — public read, แอดมินก๊วนเขียน
-- =============================================================================
create policy gang_assets_select_public on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'gang-assets');

create policy gang_assets_write_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'gang-assets'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );

create policy gang_assets_update_admin on storage.objects
  for update to authenticated
  using (
    bucket_id = 'gang-assets'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );

create policy gang_assets_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'gang-assets'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );


-- =============================================================================
-- announcement-images — สมาชิกอ่าน, แอดมินเขียน
-- =============================================================================
create policy announcement_images_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'announcement-images'
    and (select public.is_gang_member((storage.foldername(name))[1]::uuid))
  );

create policy announcement_images_insert_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'announcement-images'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );

create policy announcement_images_update_admin on storage.objects
  for update to authenticated
  using (
    bucket_id = 'announcement-images'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );

create policy announcement_images_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'announcement-images'
    and (select public.is_gang_admin((storage.foldername(name))[1]::uuid))
  );
