import Link from 'next/link';

import { AuthCard } from '@/features/auth/AuthCard';
import { SignUpForm } from '@/features/auth/SignUpForm';

export const metadata = { title: 'สมัครสมาชิก · Gang Badminton' };

export default function SignUpPage() {
  return (
    <AuthCard title="สมัครสมาชิก">
      <SignUpForm />
      <p className="mt-4 text-sm">
        มีบัญชีอยู่แล้ว?{' '}
        <Link href="/sign-in" className="underline">
          เข้าสู่ระบบ
        </Link>
      </p>
    </AuthCard>
  );
}
