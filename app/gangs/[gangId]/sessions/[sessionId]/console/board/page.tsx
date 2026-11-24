import { LiveBoard } from '@/features/sessions/LiveBoard';
import { loadConsole } from '@/server/sessions/console-loader';

export const dynamic = 'force-dynamic';

/**
 * กระดานคิวสด (hi-fi 24) — **[WO-6.4a]** อ่านอย่างเดียว สำหรับเปิดค้างบนแท็บเล็ต/ทีวีที่สนาม
 *
 * 🔴 ไม่ใช่หน้า public: ใช้ `loadConsole()` ตัวเดียวกับคอนโซล ⇒ ต้องล็อกอิน + มีสิทธิ์ `game.manage`
 *    (สมาชิกทั่วไปถูกพากลับหน้ารายละเอียดนัด) · ไม่มี realtime channel ใหม่ — `BoardSync` แค่ refresh เป็นระยะ
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const data = await loadConsole(gangId, sessionId, `/gangs/${gangId}/sessions/${sessionId}/console/board`);

  return <LiveBoard data={data} backHref={`/gangs/${gangId}/sessions/${sessionId}/console`} />;
}
