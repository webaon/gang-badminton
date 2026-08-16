import Link from 'next/link';

import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { searchGangs } from '@/server/actions/discovery';
import { DiscoverPanel, type MyJoinRequest } from '@/features/discovery/DiscoverPanel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'ค้นหาก๊วน · Gang Badminton' };

/**
 * ค้นหาก๊วน — **[WO-3.E]**
 *
 * 🔴 ผลค้นหามาจาก `search_public_gangs()` ที่เดียว ซึ่งกรอง `is_public` +
 *    `features.discovery` ในตัวมันเอง ⇒ หน้านี้ไม่มีเงื่อนไขกรองของตัวเอง
 *    (ถ้ากรองในหน้าจอ วันหนึ่งมีหน้าอื่นเรียกฟังก์ชันแล้วลืมกรอง ก๊วนส่วนตัวจะหลุด)
 *
 * เปิดได้โดยไม่ต้องล็อกอิน — คนใหม่ต้องเห็นก่อนว่ามีก๊วนอะไรบ้างถึงจะอยากสมัคร
 */
export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const result = await searchGangs(query);
  const results = result.success ? result.data : [];

  const user = await currentUser();
  let myRequests: MyJoinRequest[] = [];

  if (user) {
    const supabase = await supabaseServer();

    // RLS ของ `join_requests` ให้เห็นเฉพาะแถวของตัวเอง (หรือของก๊วนที่ตัวเองเป็นแอดมิน)
    // ⇒ กรอง `user_id` ซ้ำที่นี่เพื่อไม่ให้คำขอของก๊วนที่ตัวเองดูแลปนเข้ามาในลิสต์นี้
    const { data } = await supabase
      .from('join_requests')
      .select('id, status, created_at, gangs (name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    type Row = {
      id: string;
      status: string;
      created_at: string;
      gangs: { name: string } | { name: string }[] | null;
    };

    myRequests = ((data ?? []) as Row[]).map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      gangName: (Array.isArray(row.gangs) ? row.gangs[0]?.name : row.gangs?.name) ?? 'ก๊วน',
    }));
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">ค้นหาก๊วน</h1>
        <Link href={user ? '/gangs' : '/sign-in'} className="underline">
          {user ? 'ก๊วนของฉัน' : 'เข้าสู่ระบบ'}
        </Link>
      </div>

      {result.success ? null : (
        <p className="mb-3 text-sm">ค้นหาไม่สำเร็จ — {result.error.message}</p>
      )}

      <DiscoverPanel
        query={query}
        results={results}
        myRequests={myRequests}
        isSignedIn={user !== null}
      />
    </main>
  );
}
