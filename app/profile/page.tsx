import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';

import { currentProfile } from '@/lib/supabase/auth';
import { ProfileForm } from '@/features/profile/ProfileForm';
import { signOut } from '@/server/actions/auth';

export const metadata = { title: 'โปรไฟล์ · Gang Badminton' };

/**
 * 🔴 หน้านี้อ่าน session ของผู้ใช้ ⇒ **ห้าม prerender เด็ดขาด**
 *
 * ถ้าปล่อยให้ Next พยายาม static build จะพังตั้งแต่ตอน build (อ่าน env ไม่ได้)
 * และถ้าบังเอิญ build ผ่าน ผลลัพธ์จะแย่กว่ามาก: หน้าโปรไฟล์ของผู้ใช้คนหนึ่ง
 * ถูก cache ไว้เสิร์ฟให้ทุกคน
 *
 * ⇒ ทุกหน้าที่เรียก `requireUser()` / `currentProfile()` ต้องมีบรรทัดนี้
 */
export const dynamic = 'force-dynamic';

/**
 * หน้าโปรไฟล์ — route บางๆ ตาม CLAUDE.md §3
 *
 * `currentProfile()` เรียก `requireUser()` ข้างใน ⇒ ยังไม่ล็อกอินจะถูก redirect
 * ไปหน้า sign-in ไม่ใช่ throw 500 (DoD ของ WO-2.2)
 */
export default async function ProfilePage() {
  const { user, profile } = await currentProfile();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <Card padding={6}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">โปรไฟล์ของฉัน</h1>
          <form action={signOut}>
            <Button type="submit" variant="ghost" label="ออกจากระบบ" />
          </form>
        </div>

        <ProfileForm
          initialDisplayName={profile?.display_name ?? ''}
          initialPhone={profile?.phone ?? null}
          email={user.email ?? ''}
        />
      </Card>
    </main>
  );
}
