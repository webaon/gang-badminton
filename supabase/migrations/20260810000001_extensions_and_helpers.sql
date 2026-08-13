-- =============================================================================
-- WO-1.2 · 0001 — Extensions + helper functions
-- =============================================================================
-- Baseline: §Database Schema
--   "[v3.1] PK ทุกตารางเป็น UUIDv7 (สร้างฟังก์ชัน uuid_generate_v7() ใน migration แรก
--    ใช้เป็น default แทน gen_random_uuid()) — เรียงตามเวลา ลด index fragmentation เทียบ v4"
--
-- Rollback: DROP FUNCTION public.uuid_generate_v7(); DROP EXTENSION pg_trgm, pgcrypto;
--           (ทำได้เฉพาะตอนยังไม่มีตารางที่ใช้ default นี้)
-- =============================================================================

-- pgcrypto: gen_random_bytes() สำหรับ secret token (baseline §Database Schema [v3.2])
--           และ digest() สำหรับ SHA-256 hash
create extension if not exists pgcrypto with schema extensions;

-- pg_trgm: ค้นหาชื่อก๊วน/พื้นที่ (baseline §โมดูล ข้อ 9 — ไทยตัดคำด้วย FTS ไม่ได้)
create extension if not exists pg_trgm with schema extensions;


-- -----------------------------------------------------------------------------
-- uuid_generate_v7() — UUID version 7 (RFC 9562)
-- -----------------------------------------------------------------------------
-- Postgres 17 ยังไม่มี uuidv7() ในตัว (มาใน PG18) จึง implement เอง
--
-- Layout (128 bits):
--   bits 0-47   unix_ts_ms  — เวลาเป็น millisecond ตั้งแต่ epoch (เรียงตามเวลาได้)
--   bits 48-51  version     — 0b0111 (7)
--   bits 52-63  rand_a      — random 12 bits
--   bits 64-65  variant     — 0b10 (RFC 4122)
--   bits 66-127 rand_b      — random 62 bits
--
-- ทำไมต้อง v7: PK เรียงตามเวลา → insert ลงท้าย B-tree เสมอ ลด page split /
-- index fragmentation เทียบกับ v4 ที่กระจายสุ่มทั้ง index
--
-- ⚠️ ห้ามใช้ฟังก์ชันนี้สร้าง secret token — v7 ฝัง timestamp ⇒ เดาได้
--    secret ต้องใช้ gen_random_bytes(32) แล้วเก็บเฉพาะ hash (baseline [v3.2])
create or replace function public.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_ts_ms bigint;
begin
  -- 16 bytes สุ่มก่อน แล้วค่อยเขียนทับ 6 bytes แรกด้วย timestamp + set version/variant
  v_bytes := extensions.gen_random_bytes(16);
  v_ts_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  -- bytes 0-5 = unix_ts_ms (48 bits, big-endian)
  v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >>  8) & 255)::int);
  v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);

  -- byte 6: 4 bits บน = version (7), 4 bits ล่าง = random เดิม
  v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));

  -- byte 8: 2 bits บน = variant (0b10), 6 bits ล่าง = random เดิม
  v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));

  return encode(v_bytes, 'hex')::uuid;
end;
$$;

comment on function public.uuid_generate_v7() is
  'UUIDv7 (RFC 9562) — PK default ทุกตาราง เรียงตามเวลาเพื่อลด index fragmentation. ห้ามใช้สร้าง secret token.';


-- -----------------------------------------------------------------------------
-- set_updated_at() — trigger function มาตรฐาน
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger — อัปเดต updated_at อัตโนมัติ';
