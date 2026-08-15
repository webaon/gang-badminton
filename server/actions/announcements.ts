'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { announcementImagePath, BUCKETS, tenantKeyOf } from '@/lib/storage/paths';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/**
 * ประกาศของก๊วน — **[WO-3.D]**
 *
 * 🔴 ร่าง (`published_at is null`) สมาชิกทั่วไป **มองไม่เห็น** — บังคับที่ RLS (0032)
 *    ที่นี่ใช้ client ที่ผูก session ⇒ RLS เป็นด่านจริง ไม่ใช่กรองเองใน TS
 *
 * 🔴 publish ผ่าน `publish_announcement()` เท่านั้น — ❌ ห้าม UPDATE `published_at` ตรง
 *    เพราะจุดนั้นคือที่ที่ต้องเข้าคิวแจ้งเตือนแบบ idempotent ไปพร้อมกัน
 */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function assertAnnouncementAdmin(gangId: string): Promise<string> {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  assertCan({ role: (data?.role as GangRole | undefined) ?? null }, 'announcement.manage');
  return user.id;
}

export type AnnouncementInput = {
  title: string;
  body: string;
  /** path ของรูปที่อัปแล้ว — ต้องเป็น path ที่ `prepareAnnouncementImage()` ออกให้ */
  imagePaths?: string[];
};

function assertContent(input: AnnouncementInput): void {
  if (input.title.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุหัวข้อ');
  if (input.body.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุเนื้อหา');
}

/**
 * 🔴 [D-15] ตรวจว่า path ที่ client ส่งกลับมาอยู่ใต้ก๊วนที่ถูกต้องจริง
 *    (client อาจส่ง path ของก๊วนอื่นมาแทนที่ path ที่ server ออกให้)
 */
function assertImagePaths(gangId: string, paths: string[]): void {
  for (const path of paths) {
    if (tenantKeyOf(path) !== gangId) {
      throw new AppError('VALIDATION_ERROR', 'ตำแหน่งไฟล์ไม่ถูกต้อง');
    }
  }
}

export async function createAnnouncement(
  gangId: string,
  input: AnnouncementInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const userId = await assertAnnouncementAdmin(gangId);
    assertContent(input);

    const images = input.imagePaths ?? [];
    assertImagePaths(gangId, images);

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('announcements')
        .insert({
          gang_id: gangId,
          title: input.title.trim(),
          body: input.body.trim(),
          image_urls: images,
          // 🔴 สร้างเป็น "ร่าง" เสมอ — ประกาศจริงต้องกดอีกครั้ง (จุดที่ยิงแจ้งเตือน)
          published_at: null,
          created_by: userId,
        })
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/announcements`);
    return assertOne<{ id: string }>(rows);
  });
}

export async function updateAnnouncement(
  gangId: string,
  announcementId: string,
  input: AnnouncementInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const userId = await assertAnnouncementAdmin(gangId);
    assertContent(input);

    const images = input.imagePaths ?? [];
    assertImagePaths(gangId, images);

    const supabase = await supabaseServer();

    // ⚠️ ไม่แตะ `published_at` — แก้เนื้อหาไม่ได้แปลว่าประกาศใหม่
    const rows = unwrap(
      await supabase
        .from('announcements')
        .update({
          title: input.title.trim(),
          body: input.body.trim(),
          image_urls: images,
          updated_by: userId,
        })
        .eq('id', announcementId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/announcements`);
    return assertOne<{ id: string }>(rows);
  });
}

/**
 * ประกาศออกไปจริง — เข้าคิวแจ้งเตือนให้สมาชิกทุกคน
 *
 * 🔴 กดซ้ำได้ไม่จำกัด: `dedupe_key = announcement:<id>:<user>` กันส่งซ้ำที่ระดับ DB
 */
export async function publishAnnouncement(
  gangId: string,
  announcementId: string,
): Promise<ApiResponse<{ id: string; publishedAt: string | null }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const userId = await assertAnnouncementAdmin(gangId);

    const { data, error } = await supabaseAdmin().rpc('publish_announcement', {
      p_announcement_id: announcementId,
      p_actor_id: userId,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const row = data as { id: string; published_at: string | null; gang_id: string };
    if (row.gang_id !== gangId) throw new AppError('NOT_FOUND', 'ไม่พบประกาศนี้ในก๊วนนี้');

    revalidatePath(`/gangs/${gangId}/announcements`);
    return { id: row.id, publishedAt: row.published_at };
  });
}

/**
 * ลบประกาศ — **ลบรูปที่แนบไปด้วย**
 *
 * 🔴 DoD: "ลบประกาศแล้วรูปที่แนบไม่ค้างเป็นขยะที่เข้าถึงได้"
 *    ⇒ ลบไฟล์ก่อน แล้วค่อยลบแถว — ถ้าลบแถวก่อนแล้วลบไฟล์พลาด จะไม่มีใครรู้ว่ามีไฟล์ค้าง
 */
export async function deleteAnnouncement(
  gangId: string,
  announcementId: string,
): Promise<ApiResponse<{ id: string; removedImages: number }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertAnnouncementAdmin(gangId);

    const supabase = await supabaseServer();

    const { data: existing } = await supabase
      .from('announcements')
      .select('id, image_urls')
      .eq('id', announcementId)
      .eq('gang_id', gangId)
      .maybeSingle();

    if (!existing) throw new AppError('NOT_FOUND', 'ไม่พบประกาศนี้');

    const images = (existing.image_urls ?? []) as string[];

    if (images.length > 0) {
      const { error } = await supabaseAdmin().storage.from(BUCKETS.announcementImages).remove(images);
      // ❌ ห้ามกลืนเงียบ — ถ้าลบไฟล์ไม่ได้ต้องรู้ ไม่ใช่ลบแถวทิ้งแล้วปล่อยไฟล์ลอย
      if (error) throw error;
    }

    const rows = unwrap(
      await supabase
        .from('announcements')
        .delete()
        .eq('id', announcementId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/announcements`);
    return { id: assertOne<{ id: string }>(rows).id, removedImages: images.length };
  });
}

/**
 * ขอ path สำหรับอัปรูป — **[D-15] server เป็นคนประกอบ path**
 *
 * ❌ ห้ามให้ client ตั้ง path เอง เพราะสิทธิ์ของ storage ตรวจจาก path
 */
export async function prepareAnnouncementImage(
  gangId: string,
  fileName: string,
): Promise<ApiResponse<{ bucket: string; path: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertAnnouncementAdmin(gangId);

    return {
      bucket: BUCKETS.announcementImages,
      path: announcementImagePath(gangId, fileName),
    };
  });
}
