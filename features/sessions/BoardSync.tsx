'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import { POLL_INTERVAL_MS } from '@/lib/sync/fallback';

/**
 * ทำให้กระดานคิวสดอัปเดตเอง — **[WO-6.4a · hi-fi 24]**
 *
 * 🔴 ไม่เปิด realtime channel ใหม่ (ไม่มี `supabase.channel`) — แค่สั่ง `router.refresh()` ทุก
 *    `POLL_INTERVAL_MS` (ค่าเดียวกับ fallback ของคอนโซล) ให้ server component อ่านข้อมูลใหม่ด้วย
 *    loader เดียวกับคอนโซล ⇒ ผ่าน RLS/สิทธิ์เดิมทุกครั้ง · ไม่เก็บ state ของคิวเอง (หน้าจอ = ฐานข้อมูลเสมอ)
 *
 * เหตุที่ไม่ใช้ `RosterSync`: มันฟังเฉพาะตาราง `session_registrations` — จบเกม/จัดคู่ใหม่จากเครื่องอื่น
 * (ตาราง `games`) จะไม่ทำให้จอที่สนามขยับ · กระดานนี้เปิดค้างทั้งวัน จึง poll ตรงๆ แทน
 * หยุดพักเมื่อแท็บถูกซ่อน (ไม่ยิง request ตอนไม่มีคนดู) แล้วรีเฟรชทันทีที่กลับมาเห็น
 */
export function BoardSync() {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router]);

  return (
    <HStack gap={2} align="center">
      <StatusDot variant="success" label="กระดานสด" isPulsing />
      <Text type="supporting" size="sm">
        อัปเดตทุก {POLL_INTERVAL_MS / 1000} วินาที
      </Text>
    </HStack>
  );
}
