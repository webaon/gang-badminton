import type { ReactNode } from 'react';

import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { buildGangMenu } from '@/domain/navigation/gang-menu';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';
import { GangShell, type ShellGang } from '@/features/shell/GangShell';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<GangRole, string> = {
  owner: 'เจ้าของก๊วน',
  admin: 'แอดมิน',
  member: 'สมาชิก',
};

type Row = {
  role: GangRole;
  gangs: { id: string; name: string; features: Partial<GangFeatures> | null };
};

/**
 * โครงหน้าของทุกหน้าใต้ `/gangs/[gangId]/*` — **[WO-6.1a]**
 *
 * อ่าน membership + role + feature flags ครั้งเดียวแล้วส่งเมนูที่ `can()` อนุญาตให้ shell (client)
 *
 * 🔴 นี่ไม่ใช่ชั้นสิทธิ์ — ทุกหน้าลูกยัง `requireUser()` + ตรวจ role ฝั่ง server เองเหมือนเดิม
 *    layout จึงไม่ redirect เอง (ไม่งั้นลิงก์ลึกที่ต้องล็อกอินจะเสีย `next` ที่ถูกต้อง) —
 *    ไม่ล็อกอิน / ไม่ใช่สมาชิก / query พัง ⇒ ปล่อยหน้าลูกตัดสินเองโดยไม่มี shell
 */
export default async function GangLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;

  const user = await currentUser();
  if (!user) return <>{children}</>;

  const supabase = await supabaseServer();

  // query เดียวกับหน้า /gangs — RLS กรองให้เห็นเฉพาะก๊วนที่เป็นสมาชิก
  const { data, error } = await supabase
    .from('gang_members')
    .select('role, gangs!inner(id, name, features)')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .is('gangs.deleted_at', null);

  if (error) {
    // ❌ ห้ามกลืน error เงียบ — แต่ shell เป็นแค่กรอบ ไม่ควรทำให้ทั้งหน้าล่ม
    console.error('[shell] อ่านรายชื่อก๊วนของผู้ใช้ไม่สำเร็จ — แสดงหน้าโดยไม่มี shell', {
      code: error.code,
    });
    return <>{children}</>;
  }

  const rows = (data ?? []) as unknown as Row[];
  const current = rows.find((r) => r.gangs.id === gangId);
  if (!current) return <>{children}</>;

  const menu = buildGangMenu({ role: current.role, features: current.gangs.features ?? {} }, gangId);
  const gangs: ShellGang[] = rows.map((r) => ({
    id: r.gangs.id,
    name: r.gangs.name,
    roleLabel: ROLE_LABELS[r.role],
  }));

  return (
    <GangShell
      gangId={gangId}
      gangName={current.gangs.name}
      tabs={menu.tabs}
      side={menu.side}
      gangs={gangs}
    >
      {children}
    </GangShell>
  );
}
