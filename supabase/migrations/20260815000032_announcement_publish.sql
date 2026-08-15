-- =============================================================================
-- WO-3.D · 0032 — ประกาศ: ร่างต้องไม่หลุดถึงสมาชิก + แจ้งเตือนตอน publish
-- =============================================================================
-- 🔴 policy เดิม (0010) ให้สมาชิกอ่าน **ทุกแถว** ของก๊วน รวม**ร่างที่ยังไม่ประกาศ**
--    ⇒ แอดมินร่างประกาศเรื่องขึ้นราคาไว้ สมาชิกเห็นทันทีตั้งแต่ยังไม่ตั้งใจให้เห็น
--    (`published_at` มีอยู่ในตารางตั้งแต่ 0005 แต่ยังไม่มีใครใช้เป็นเงื่อนไข)
--
-- 🔴 publish = จุดที่ "ประกาศมีผล" ⇒ ต้องเป็น DB function ที่ตั้ง `published_at`
--    + เข้าคิวแจ้งเตือน **แบบ atomic** และ **idempotent**
--    ⇒ กด publish ซ้ำ / แก้แล้ว publish ใหม่ ต้องไม่ส่งซ้ำ (dedupe_key ของ WO-2.5-G)
--
-- Rollback: DROP FUNCTION public.publish_announcement(uuid, uuid, text);
--           DROP POLICY announcements_select_member ON public.announcements;
--           CREATE POLICY announcements_select_member ON public.announcements
--             FOR SELECT TO authenticated USING ((SELECT public.is_gang_member(gang_id)));
-- =============================================================================

drop policy if exists announcements_select_member on public.announcements;

create policy announcements_select_member on public.announcements
  for select to authenticated
  using (
    (select public.is_gang_member(gang_id))
    and (
      -- ประกาศแล้วเท่านั้นที่สมาชิกทั่วไปเห็น
      published_at is not null
      -- แอดมินเห็นร่างของตัวเองด้วย (policy `announcements_write_admin` ครอบ for all อยู่แล้ว
      -- แต่เขียนซ้ำตรงนี้เพื่อให้ SELECT ของแอดมินไม่ต้องพึ่ง policy อีกใบ)
      or (select public.is_gang_admin(gang_id))
    )
  );


-- -----------------------------------------------------------------------------
-- publish_announcement(...) — ประกาศ + เข้าคิวแจ้งเตือนในทีเดียว
-- -----------------------------------------------------------------------------
-- ⚠️ ❌ ห้าม insert `notifications` ตรง — ต้องผ่าน `enqueue_notifications()`
--    ที่มี `dedupe_key` (WO-2.5-G) ไม่งั้นกด publish ซ้ำแล้วสมาชิกโดนยิงซ้ำ
create or replace function public.publish_announcement(
  p_announcement_id uuid,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.announcements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     public.announcements;
  v_queued  integer;
begin
  select * into v_row from public.announcements where id = p_announcement_id;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'announcement', 'id', p_announcement_id)::text;
  end if;

  if btrim(coalesce(v_row.title, '')) = '' or btrim(coalesce(v_row.body, '')) = '' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ประกาศต้องมีหัวข้อและเนื้อหา')::text;
  end if;

  -- ประกาศไปแล้วไม่ต้องเลื่อนเวลาใหม่ — เวลาที่ประกาศครั้งแรกคือความจริงที่ต้องคงไว้
  if v_row.published_at is null then
    update public.announcements
       set published_at = now(), updated_by = p_actor_id
     where id = p_announcement_id
    returning * into v_row;
  end if;

  -- เข้าคิวให้สมาชิกทุกคนของก๊วน — dedupe ต่อ (ประกาศ, ผู้รับ)
  -- ⇒ กด publish ซ้ำ หรือแก้เนื้อหาแล้ว publish ใหม่ จะไม่มีใครได้รับซ้ำ
  select public.enqueue_notifications(
    coalesce(
      (select jsonb_agg(jsonb_build_object(
                'gang_id',      v_row.gang_id,
                'recipient_id', m.user_id,
                'event_type',   'announcement.published',
                'payload',      jsonb_build_object(
                                  'correlation_id',  p_correlation_id,
                                  'announcement_id', v_row.id,
                                  'title',           v_row.title
                                ),
                'dedupe_key',   'announcement:' || v_row.id || ':' || m.user_id
              ))
         from public.gang_members m
        where m.gang_id = v_row.gang_id
          and m.deleted_at is null),
      '[]'::jsonb
    )
  ) into v_queued;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_row.gang_id, 'announcement.published', 'gang', v_row.gang_id, p_actor_id,
     jsonb_build_object(
       'correlation_id',  p_correlation_id,
       'announcement_id', v_row.id,
       'notified',        v_queued
     ));

  return v_row;
end;
$$;

comment on function public.publish_announcement(uuid, uuid, text) is
  '[WO-3.D] ประกาศ + เข้าคิวแจ้งเตือน (idempotent ผ่าน dedupe_key ของ WO-2.5-G)';

revoke execute on function public.publish_announcement(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.publish_announcement(uuid, uuid, text) to service_role;
