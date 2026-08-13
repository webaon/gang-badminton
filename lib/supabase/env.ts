/**
 * อ่าน env ของ Supabase ฝั่งที่เปิดเผยได้
 *
 * แยกไฟล์เพราะทั้ง browser client และ server client ใช้ร่วมกัน และอยากให้
 * "ลืมตั้ง env" ดังตั้งแต่จุดเดียว พร้อมบอกชื่อตัวแปรที่ขาด
 *
 * ⚠️ ต้องอ้าง `process.env.NEXT_PUBLIC_*` แบบเต็มสตริง ห้ามใช้ตัวแปรมาประกอบชื่อ
 *    — Next.js แทนค่าตอน build ด้วยการ **แทนที่ข้อความตรงๆ** ถ้าเขียนแบบ dynamic
 *    ค่าจะกลายเป็น undefined ในฝั่ง browser โดยไม่มี error
 */
export type PublicSupabaseEnv = {
  url: string;
  anonKey: string;
};

export function publicSupabaseEnv(): PublicSupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing = [
    !url && 'NEXT_PUBLIC_SUPABASE_URL',
    !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`ตั้งค่า ${missing.join(' และ ')} ก่อน (ดู .env.example)`);
  }

  return { url: url as string, anonKey: anonKey as string };
}
