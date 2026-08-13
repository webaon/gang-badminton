'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { supabaseBrowser } from '@/lib/supabase/client';
import {
  POLL_INTERVAL_MS,
  REALTIME_GRACE_MS,
  syncMode,
  type RealtimeState,
} from '@/lib/sync/fallback';

/**
 * ทำให้กระดานคิวอัปเดตสด
 *
 * 🔴 realtime เป็น "ของแถม" — ถ้าต่อไม่ติดต้องตกไป polling เองภายใน 5 วินาที
 *    ตรรกะการตัดสินใจอยู่ใน `lib/sync/fallback.ts` ซึ่งมี unit test คุม
 *    (คอมโพเนนต์นี้แค่เอาผลไปใช้ ไม่มี logic ตัดสินใจของตัวเอง)
 *
 * ⚠️ ไม่เก็บ state ของ roster เอง — แค่สั่ง `router.refresh()` ให้ server component
 *    ดึงข้อมูลใหม่ ⇒ ไม่มีทางที่หน้าจอกับฐานข้อมูลจะเห็นไม่ตรงกันจากการ merge ผิด
 */
export function RosterSync({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<RealtimeState>('connecting');
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const supabase = supabaseBrowser();

    const channel = supabase
      .channel(`roster:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'session_registrations',
          filter: `session_id=eq.${sessionId}`,
        },
        () => router.refresh(),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setState('subscribed');
        else if (status === 'CHANNEL_ERROR') setState('error');
        else if (status === 'CLOSED') setState('closed');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, router]);

  // ประเมินซ้ำเมื่อหมดช่วงผ่อนผัน เผื่อ realtime ต่อไม่ติดโดยไม่ส่ง error กลับมา
  useEffect(() => {
    if (state !== 'connecting') return;
    const timer = setTimeout(() => setState((s) => (s === 'connecting' ? 'error' : s)), REALTIME_GRACE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const mode = syncMode(state, Date.now() - startedAt.current);

  useEffect(() => {
    if (mode !== 'polling') return;
    const timer = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [mode, router]);

  return (
    <p className="text-xs opacity-70">
      {mode === 'realtime' ? 'อัปเดตอัตโนมัติ' : 'อัปเดตทุก 10 วินาที'}
    </p>
  );
}
