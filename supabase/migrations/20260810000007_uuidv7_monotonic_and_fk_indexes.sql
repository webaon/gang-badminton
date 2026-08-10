-- =============================================================================
-- WO-1.2 · 0007 — แก้ uuid_generate_v7() ให้ monotonic + index FK ที่เหลือ
-- =============================================================================
-- migration ใหม่ (ไม่แก้ 0001) ตามกติกา §Engineering Practices:
--   "ห้ามแก้ migration ที่รันใน production แล้ว — แก้ = migration ใหม่เสมอ"
--
-- Rollback: CREATE OR REPLACE ฟังก์ชันกลับเป็นเวอร์ชัน 0001 + DROP INDEX ที่เพิ่มด้านล่าง
--           (ปลอดภัย: ไม่มีการเปลี่ยนโครงตารางหรือข้อมูล)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ปัญหาที่พบตอน verify WO-1.2
-- -----------------------------------------------------------------------------
-- เวอร์ชันใน 0001 ใส่ timestamp ระดับ millisecond แล้วปล่อย rand_a (12 bits) เป็น
-- random → UUID ที่เกิดภายใน millisecond เดียวกันเรียงลำดับมั่ว
-- ผลตรวจจริง: generate 500 ตัวติดกัน (ใช้เวลา < 1 ms) → monotonic FAIL
--
-- ⇒ เสียเหตุผลทั้งหมดที่เลือก v7 แทน v4 (baseline [v3.1]: "เรียงตามเวลา ลด
--   index fragmentation") เพราะ insert ที่มาพร้อมกันจะกระจายทั่ว B-tree เหมือน v4
--
-- แก้ตาม RFC 9562 §6.2 "Method 3 — Replace Leftmost Random Bits with Increased
-- Clock Precision": เอาเศษ sub-millisecond (ไมโครวินาที) มาเข้ารหัสใน rand_a
-- ได้ความละเอียดราว 1/4096 ms ≈ 244 ns ซึ่งละเอียดกว่าอัตราการ insert จริงมาก
create or replace function public.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
set search_path = ''
as $$
declare
  v_bytes  bytea;
  v_us     bigint;   -- เวลาเป็นไมโครวินาทีตั้งแต่ epoch
  v_ts_ms  bigint;   -- ส่วน millisecond (48 bits แรก)
  v_rand_a integer;  -- 12 bits: เศษ sub-ms → ทำให้เรียงลำดับได้ในระดับ µs
begin
  v_bytes := extensions.gen_random_bytes(16);

  v_us     := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
  v_ts_ms  := v_us / 1000;
  -- เศษไมโครวินาทีภายใน ms ปัจจุบัน (0..999) → สเกลเป็น 12 bits (0..4095)
  v_rand_a := (((v_us % 1000) * 4096) / 1000)::integer;

  -- bytes 0-5 = unix_ts_ms (48 bits, big-endian)
  v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >>  8) & 255)::int);
  v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);

  -- byte 6: 4 bits บน = version (7), 4 bits ล่าง = rand_a บน
  v_bytes := set_byte(v_bytes, 6, (112 | ((v_rand_a >> 8) & 15)));
  -- byte 7: rand_a ล่าง 8 bits
  v_bytes := set_byte(v_bytes, 7, (v_rand_a & 255));

  -- byte 8: 2 bits บน = variant (0b10), 6 bits ล่าง = random เดิม (rand_b)
  v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));

  return encode(v_bytes, 'hex')::uuid;
end;
$$;

comment on function public.uuid_generate_v7() is
  'UUIDv7 (RFC 9562) พร้อม Method 3 sub-millisecond precision — เรียงตามเวลาได้ระดับไมโครวินาที. ห้ามใช้สร้าง secret token (ฝัง timestamp ⇒ เดาได้)';


-- -----------------------------------------------------------------------------
-- Index สำหรับ FK คอลัมน์ audit ที่เหลือ
-- -----------------------------------------------------------------------------
-- baseline §Database Schema สั่งไว้ตรงตัวว่า "ทุก FK มี index"
-- ตอน audit พบว่า FK ที่ยังขาด index คือคอลัมน์ audit ล้วน (created_by /
-- updated_by / deleted_by) — FK ที่ใช้ query จริงมีครบแล้วตั้งแต่ 0002-0006
--
-- 📌 ทำตาม baseline ตามตัวอักษร เหตุผล:
--    - FK เหล่านี้ชี้ไปที่ profiles โดยไม่มี ON DELETE action ⇒ ถ้าไม่มี index
--      การลบ profile หนึ่งแถวต้อง seq scan ทุกตารางเหล่านี้
--    - ต้นทุนต่ำที่ขนาดข้อมูลของแอปนี้ และย้อนกลับได้ด้วย migration เดียว
--    - ถ้าภายหลังวัดแล้วพบว่ากระทบ write throughput จริง ค่อยลบ (จดใน BACKLOG.md)
create index organizations_created_by_idx          on public.organizations (created_by);
create index organizations_updated_by_idx          on public.organizations (updated_by);
create index organization_members_created_by_idx   on public.organization_members (created_by);
create index organization_members_updated_by_idx   on public.organization_members (updated_by);
create index gangs_created_by_idx                  on public.gangs (created_by);
create index gangs_updated_by_idx                  on public.gangs (updated_by);
create index gangs_deleted_by_idx                  on public.gangs (deleted_by);
create index gang_members_created_by_idx           on public.gang_members (created_by);
create index gang_members_updated_by_idx           on public.gang_members (updated_by);
create index gang_members_deleted_by_idx           on public.gang_members (deleted_by);
create index gang_pricing_plans_created_by_idx     on public.gang_pricing_plans (created_by);
create index gang_pricing_plans_updated_by_idx     on public.gang_pricing_plans (updated_by);
create index session_templates_created_by_idx      on public.session_templates (created_by);
create index session_templates_updated_by_idx      on public.session_templates (updated_by);
create index sessions_created_by_idx               on public.sessions (created_by);
create index sessions_updated_by_idx               on public.sessions (updated_by);
create index sessions_deleted_by_idx               on public.sessions (deleted_by);
create index session_invite_tokens_created_by_idx  on public.session_invite_tokens (created_by);
create index session_registrations_created_by_idx  on public.session_registrations (created_by);
create index session_registrations_updated_by_idx  on public.session_registrations (updated_by);
create index session_registrations_deleted_by_idx  on public.session_registrations (deleted_by);
create index games_created_by_idx                  on public.games (created_by);
create index games_updated_by_idx                  on public.games (updated_by);
create index session_charges_created_by_idx        on public.session_charges (created_by);
create index session_charges_updated_by_idx        on public.session_charges (updated_by);
create index payments_created_by_idx               on public.payments (created_by);
create index payments_updated_by_idx               on public.payments (updated_by);
create index payments_deleted_by_idx               on public.payments (deleted_by);
create index payment_allocations_created_by_idx    on public.payment_allocations (created_by);
create index payment_adjustments_created_by_idx    on public.payment_adjustments (created_by);
create index coupons_created_by_idx                on public.coupons (created_by);
create index coupons_updated_by_idx                on public.coupons (updated_by);
create index gang_expenses_created_by_idx          on public.gang_expenses (created_by);
create index gang_expenses_updated_by_idx          on public.gang_expenses (updated_by);
create index gang_incomes_created_by_idx           on public.gang_incomes (created_by);
create index gang_incomes_updated_by_idx           on public.gang_incomes (updated_by);
create index announcements_created_by_idx          on public.announcements (created_by);
create index announcements_updated_by_idx          on public.announcements (updated_by);
create index gang_line_configs_created_by_idx      on public.gang_line_configs (created_by);
create index gang_line_configs_updated_by_idx      on public.gang_line_configs (updated_by);
