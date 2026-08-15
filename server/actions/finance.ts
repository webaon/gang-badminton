'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { toSatang } from '@/domain/billing/money';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/**
 * รายรับ-รายจ่ายที่แอดมินบันทึกเอง — **[WO-3.B]**
 *
 * ⚠️ ตารางนี้เป็น**ข้อมูลการเงินของก๊วน** — RLS เปิดให้เฉพาะแอดมิน (0010)
 *    ที่นี่ใช้ client ที่ผูก session ⇒ RLS เป็นด่านสุดท้ายถ้า `can()` พลาด
 *
 * ❌ ห้ามใช้ตารางนี้บันทึกยอดที่ควรเป็น `session_charges` — รายรับจากผู้เล่น
 *    ต้องผ่าน `close_session_with_charges()` เท่านั้น (ADR-001) ไม่งั้นจะนับซ้ำในรายงาน
 */

type Kind = 'expense' | 'income';

const TABLE: Record<Kind, 'gang_expenses' | 'gang_incomes'> = {
  expense: 'gang_expenses',
  income: 'gang_incomes',
};

async function assertFinanceAdmin(gangId: string): Promise<string> {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  assertCan({ role: (data?.role as GangRole | undefined) ?? null }, 'gang.finance.manage');
  return user.id;
}

export type FinanceEntryInput = {
  kind: Kind;
  category: string;
  amount: string;
  note: string | null;
  /** `YYYY-MM-DD` บนนาฬิกาของก๊วน */
  occurredOn: string;
  /** ผูกกับนัดได้ (ค่าคอร์ทของนัดนั้น) หรือไม่ผูกก็ได้ (ค่าอุปกรณ์ประจำปี) */
  sessionId?: string | null;
};

export async function addFinanceEntry(
  gangId: string,
  input: FinanceEntryInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    const userId = await assertFinanceAdmin(gangId);

    if (input.category.trim() === '') {
      throw new AppError('VALIDATION_ERROR', 'ต้องระบุหมวด');
    }

    // 🔴 เงินผ่าน `toSatang()` เพื่อบังคับรูปแบบเดียวกับที่เขียนลง numeric(12,2)
    //    ❌ ห้าม `Number()` — ค่าที่ผ่าน float มาแล้วอาจเพี้ยนตั้งแต่ต้นทาง
    let satang: number;
    try {
      satang = toSatang(input.amount);
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', (err as Error).message, { cause: err });
    }
    if (satang <= 0) throw new AppError('VALIDATION_ERROR', 'จำนวนเงินต้องมากกว่า 0');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
      throw new AppError('VALIDATION_ERROR', 'วันที่ต้องเป็นรูปแบบ YYYY-MM-DD');
    }

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from(TABLE[input.kind])
        .insert({
          gang_id: gangId,
          session_id: input.sessionId ?? null,
          category: input.category.trim(),
          amount: input.amount.trim(),
          note: input.note?.trim() || null,
          occurred_on: input.occurredOn,
          created_by: userId,
        })
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/reports`);
    return assertOne<{ id: string }>(rows);
  });
}

export async function removeFinanceEntry(
  gangId: string,
  kind: Kind,
  entryId: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    await assertFinanceAdmin(gangId);

    const supabase = await supabaseServer();

    // ⚠️ ลบจริง ไม่ใช่ soft delete — ตารางนี้ไม่มี `deleted_at` และไม่ใช่หลักฐานการจ่ายเงิน
    //    (หลักฐานการเก็บเงินอยู่ที่ `session_charges` + ledger ซึ่งลบไม่ได้)
    const rows = unwrap(
      await supabase
        .from(TABLE[kind])
        .delete()
        .eq('id', entryId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/reports`);
    return assertOne<{ id: string }>(rows);
  });
}
