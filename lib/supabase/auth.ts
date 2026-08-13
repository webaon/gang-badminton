import 'server-only';

import { redirect } from 'next/navigation';

import { currentUser, supabaseServer } from './server';

/**
 * บังคับว่าต้องล็อกอิน — ถ้าไม่ก็เด้งไปหน้า sign-in
 *
 * 🔴 DoD ของ WO-2.2: "เข้าหน้าที่ต้องล็อกอินโดยไม่ล็อกอิน → redirect ไม่ใช่ 500"
 *    ⇒ ทุกหน้าที่ต้องการผู้ใช้ต้องเรียกตัวนี้เป็นบรรทัดแรก ห้ามอ่าน user เองแล้วลืมเช็ค
 *
 * แนบ `next` ไปด้วยเพื่อพากลับมาที่เดิมหลังล็อกอินเสร็จ
 */
export async function requireUser(returnTo?: string) {
  const user = await currentUser();

  if (!user) {
    const target = returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : '/sign-in';
    redirect(target);
  }

  return user;
}

/** โปรไฟล์ของผู้ใช้ปัจจุบัน — trigger สร้างให้ตอนสมัครแล้ว จึงต้องมีเสมอ */
export async function currentProfile() {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, phone, avatar_url')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;

  return { user, profile: data };
}
