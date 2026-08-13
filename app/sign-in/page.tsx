import Link from 'next/link';

import { AuthCard } from '@/features/auth/AuthCard';
import { SignInForm } from '@/features/auth/SignInForm';

export const metadata = { title: 'เข้าสู่ระบบ · Gang Badminton' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <AuthCard title="เข้าสู่ระบบ">
      <SignInForm next={next} />
      <p className="mt-4 text-sm">
        ยังไม่มีบัญชี?{' '}
        <Link href="/sign-up" className="underline">
          สมัครสมาชิก
        </Link>
      </p>
    </AuthCard>
  );
}
