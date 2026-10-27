import Link from 'next/link';

import { AuthCard } from '@/features/auth/AuthCard';
import { SignInForm } from '@/features/auth/SignInForm';
import { signInErrorText } from '@/features/auth/sign-in-errors';
import { isLinePlatformLoginEnabled } from '@/lib/line/platform-login';
import { safeNext } from '@/lib/url/safe-next';

export const metadata = { title: 'เข้าสู่ระบบ · Gang Badminton' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <AuthCard title="เข้าสู่ระบบ">
      {/* 🔴 `next` มาจาก query string — ผ่าน safeNext() ก่อนถึง client (กัน open redirect ผ่าน router.replace)
          🔴 `error` ผ่าน signInErrorText() = ข้อความตายตัวตาม code ที่รู้จัก ไม่ echo ค่าที่ส่งมา [WO-B1.a]
          ปุ่ม LINE ขึ้นเมื่อ LINE_PLATFORM_LOGIN_ENABLED=true เท่านั้น (ADR-013) */}
      <SignInForm
        next={next ? safeNext(next) : undefined}
        initialError={signInErrorText(error) ?? undefined}
        lineEnabled={isLinePlatformLoginEnabled()}
      />
      <p className="mt-4 text-sm">
        ยังไม่มีบัญชี?{' '}
        <Link href="/sign-up" className="underline">
          สมัครสมาชิก
        </Link>
      </p>
    </AuthCard>
  );
}
