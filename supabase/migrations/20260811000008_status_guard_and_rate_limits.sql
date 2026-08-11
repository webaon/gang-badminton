-- =============================================================================
-- WO-1.3 · 0008 — กลไก "ห้าม UPDATE status ตรง" + rate_limits
-- =============================================================================
-- Baseline: §State Machines [v3.2]
--   "RLS บล็อกระดับคอลัมน์ไม่ได้ → ใช้ BEFORE UPDATE trigger ตรวจ
--    OLD.status IS DISTINCT FROM NEW.status แล้วเช็ค GUC ที่ transition_session()
--    set ไว้เอง (set_config('app.allow_transition', ..., true) — local ต่อ transaction)
--    ไม่มี setting = raise exception; pattern เดียวกันใช้กับ payments"
--
-- ⚠️ migration นี้ต้อง apply ก่อน 0009 เพราะ transition_session() ใน 0009
--    พึ่ง GUC ตัวนี้ — แต่ trigger ต้องมีอยู่ก่อนถึงจะพิสูจน์ได้ว่าฟังก์ชันเป็น
--    "ทางเดียว" ที่เปลี่ยน status ได้จริง
--
-- Rollback: DROP TRIGGER sessions_enforce_status_transition ON public.sessions;
--           DROP TRIGGER payments_enforce_status_transition ON public.payments;
--           DROP FUNCTION public.enforce_status_transition();
--           DROP FUNCTION public.check_rate_limit(text, integer, interval);
--           DROP TABLE public.rate_limits;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- enforce_status_transition() — BEFORE UPDATE guard
-- -----------------------------------------------------------------------------
-- ค่าที่เก็บใน GUC คือ **id ของแถวที่กำลัง transition** ไม่ใช่ boolean
--
-- ทำไมไม่ใช้ 'on'/'true': GUC ตั้งแบบ local ต่อ transaction — ถ้าเป็น boolean
-- การเรียก transition_session(A) แล้วเผลอ UPDATE status ของ session B ต่อใน
-- transaction เดียวกันจะผ่านฉลุย เพราะ flag ยัง on อยู่ การผูกกับ id ทำให้
-- ใบอนุญาตครอบเฉพาะแถวที่ตั้งใจจริง (fail-closed)
--
-- ⚠️ ห้าม reset GUC หลังใช้: set_config(..., true) เป็น transaction-local อยู่แล้ว
--    Postgres คืนค่าเดิมให้ตอนจบ transaction เอง
create or replace function public.enforce_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allow text;
begin
  -- แก้คอลัมน์อื่นโดยไม่แตะ status = ผ่านตามปกติ
  if old.status is not distinct from new.status then
    return new;
  end if;

  -- current_setting(..., true) = missing_ok → คืน null ถ้าไม่เคย set
  v_allow := current_setting('app.allow_transition', true);

  if v_allow is null or v_allow <> new.id::text then
    raise exception using
      errcode = 'P0001',
      message = 'DIRECT_STATUS_UPDATE_FORBIDDEN',
      detail  = json_build_object(
        'table',       tg_table_name,
        'id',          new.id,
        'from_status', old.status,
        'to_status',   new.status
      )::text,
      hint    = 'เปลี่ยน status ผ่าน DB function เท่านั้น (transition_session / '
                || 'close_session_with_charges) — ห้าม UPDATE ตรง';
  end if;

  return new;
end;
$$;

comment on function public.enforce_status_transition() is
  '[v3.2] BEFORE UPDATE guard — status เปลี่ยนได้เฉพาะเมื่อ GUC app.allow_transition = id ของแถวนั้น';

create trigger sessions_enforce_status_transition
  before update on public.sessions
  for each row execute function public.enforce_status_transition();

create trigger payments_enforce_status_transition
  before update on public.payments
  for each row execute function public.enforce_status_transition();


-- -----------------------------------------------------------------------------
-- rate_limits — fixed-window counter
-- -----------------------------------------------------------------------------
-- unlogged: ไม่ WAL-log ⇒ write เร็วและไม่ปนเข้า replication
-- ข้อแลกเปลี่ยน: crash แล้วตารางถูก truncate = counter รีเซ็ต ซึ่งยอมรับได้
-- (ผลคือปล่อยผ่านชั่วคราว ไม่ใช่ล็อกผู้ใช้ออก) และเป็นเหตุผลที่ห้ามเอาตารางนี้
-- ไปเก็บอย่างอื่นที่หายไม่ได้
create unlogged table public.rate_limits (
  key          text        primary key,
  window_start timestamptz not null default clock_timestamp(),
  count        integer     not null default 0 check (count >= 0)
);

comment on table public.rate_limits is
  'fixed-window rate limit counter — unlogged (หายตอน crash โดยตั้งใจ: fail-open ชั่วคราวดีกว่าล็อกผู้ใช้ออก)';

-- กวาดแถวเก่าทิ้ง (pg_cron ใน WO-1.5) — ไม่มี index อื่นเพราะ query ทุกครั้งคือ PK lookup
create index rate_limits_window_start_idx on public.rate_limits (window_start);


-- -----------------------------------------------------------------------------
-- check_rate_limit(key, limit, window) → boolean
-- -----------------------------------------------------------------------------
-- true  = ยังอยู่ในโควต้า (นับครั้งนี้แล้ว)
-- false = เกินโควต้า → ผู้เรียก raise RATE_LIMITED เอง
--
-- ใช้ INSERT ... ON CONFLICT DO UPDATE เป็น upsert แบบ atomic — ไม่มีช่อง
-- check-then-act เพราะ Postgres ล็อกแถวที่ conflict ให้ระหว่าง DO UPDATE
--
-- ใช้ clock_timestamp() ไม่ใช่ now(): now() คงที่ทั้ง transaction ⇒ window
-- ที่ควรหมดอายุระหว่าง transaction ยาวจะไม่ถูกรีเซ็ต
create or replace function public.check_rate_limit(
  p_key    text,
  p_limit  integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_limit < 1 then
    raise exception using
      errcode = 'P0001',
      message = 'INTERNAL_ERROR',
      detail  = json_build_object('reason', 'check_rate_limit: p_limit must be >= 1')::text;
  end if;

  insert into public.rate_limits as rl (key, window_start, count)
  values (p_key, clock_timestamp(), 1)
  on conflict (key) do update
    set count = case
                  when rl.window_start <= clock_timestamp() - p_window then 1
                  else rl.count + 1
                end,
        window_start = case
                         when rl.window_start <= clock_timestamp() - p_window then clock_timestamp()
                         else rl.window_start
                       end
  returning rl.count into v_count;

  return v_count <= p_limit;
end;
$$;

comment on function public.check_rate_limit(text, integer, interval) is
  'fixed-window rate limit — true = ผ่าน (นับแล้ว), false = เกินโควต้า. atomic ผ่าน ON CONFLICT DO UPDATE';

-- security definer + ตารางที่ยังไม่มี RLS ⇒ ปิดไม่ให้ client เรียกตรง
-- (WO-1.4 จะเปิดให้เฉพาะ path ที่ต้องใช้จริง)
revoke execute on function public.check_rate_limit(text, integer, interval) from public;
