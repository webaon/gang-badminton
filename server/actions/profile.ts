'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

export type ProfileInput = {
  displayName: string;
  phone: string | null;
};

/**
 * แก้โปรไฟล์ของตัวเอง
 *
 * 🔴 ไม่ต้องส่ง userId เข้ามา — อ่านจาก session เสมอ
 *    ถ้ารับ id จาก client จะกลายเป็นช่องให้แก้โปรไฟล์คนอื่น (policy จะกันไว้อีกชั้น
 *    แต่ห้ามพึ่งชั้นเดียว และห้ามเปิดหน้าต่างให้ลองด้วยซ้ำ)
 *
 * 🔴 `.select()` ต่อท้าย update เสมอ แล้วส่งผ่าน `assertOne()`
 *    ไม่งั้น RLS ที่กรองแถวทิ้งจะทำให้ action ตอบ success ทั้งที่ไม่มีอะไรเปลี่ยน
 */
export async function updateOwnProfile(input: ProfileInput): Promise<ApiResponse<{ id: string }>> {
  const cid = correlationIdFrom(await headers());

  return runAction(cid, async () => {
    const user = await requireUser();

    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'ชื่อที่ใช้แสดงห้ามว่าง');
    }
    if (displayName.length > 80) {
      throw new AppError('VALIDATION_ERROR', 'ชื่อที่ใช้แสดงยาวเกินไป');
    }

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('profiles')
        .update({
          display_name: displayName,
          phone: input.phone?.trim() || null,
        })
        .eq('id', user.id)
        .select('id'),
    );

    const row = assertOne<{ id: string }>(rows);

    revalidatePath('/profile');
    return { id: row.id };
  });
}
