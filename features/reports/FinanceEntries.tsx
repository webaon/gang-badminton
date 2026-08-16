'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { TextInput } from '@astryxdesign/core/TextInput';

import { addFinanceEntry, removeFinanceEntry } from '@/server/actions/finance';

export type FinanceEntryRow = {
  id: string;
  kind: 'expense' | 'income';
  category: string;
  amount: string;
  note: string | null;
  occurredOn: string;
  sessionTitle: string | null;
};

/**
 * รายรับ-รายจ่ายที่บันทึกเอง — **[WO-3.B]**
 *
 * ⚠️ ที่นี่ไว้บันทึก "เงินนอกบิล" เท่านั้น (ค่าคอร์ทที่จ่ายให้สนาม ค่าลูกที่ซื้อมา
 *    เงินสปอนเซอร์) — **ยอดที่เก็บจากผู้เล่นมาจาก `session_charges` อัตโนมัติ**
 *    ถ้ามาบันทึกซ้ำที่นี่ รายงานจะนับสองรอบ
 */
export function FinanceEntries({
  gangId,
  entries,
  today,
}: {
  gangId: string;
  entries: FinanceEntryRow[];
  /** วันนี้ตามนาฬิกาของก๊วน */
  today: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [occurredOn, setOccurredOn] = useState(today);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);

    const result = await fn();
    if (result.success) router.refresh();
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');

    setPending(false);
    return result.success;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    const ok = await run(() =>
      addFinanceEntry(gangId, { kind, category, amount, note: note || null, occurredOn }),
    );

    if (ok) {
      setCategory('');
      setAmount('');
      setNote('');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner status="error" title={error} /> : null}

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <RadioList
          label="ประเภท"
          orientation="horizontal"
          size="sm"
          value={kind}
          onChange={(v) => setKind(v as 'expense' | 'income')}
        >
          <RadioListItem label="รายจ่าย" value="expense" description="ค่าคอร์ท ค่าลูก ค่าน้ำ" />
          <RadioListItem label="รายรับอื่น" value="income" description="สปอนเซอร์ ขายของ" />
        </RadioList>

        <div className="flex gap-2">
          <div className="flex-1">
            <TextInput
              label="หมวด"
              value={category}
              onChange={setCategory}
              placeholder={kind === 'expense' ? 'ค่าคอร์ท' : 'สปอนเซอร์'}
              isRequired
            />
          </div>
          <div className="w-32">
            <TextInput label="จำนวนเงิน" value={amount} onChange={setAmount} isRequired />
          </div>
          <div className="w-40">
            <TextInput label="วันที่" value={occurredOn} onChange={setOccurredOn} />
          </div>
        </div>

        <TextInput label="บันทึกช่วยจำ" value={note} onChange={setNote} />

        <div>
          <Button type="submit" variant="primary" label="บันทึก" isLoading={pending} />
        </div>
      </form>

      {entries.length === 0 ? (
        <p className="text-sm">ยังไม่มีรายการในช่วงนี้</p>
      ) : (
        <ul className="divide-y">
          {entries.map((e) => (
            <li key={`${e.kind}-${e.id}`} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {e.category}
                  {e.sessionTitle ? ` · ${e.sessionTitle}` : ''}
                </p>
                <p className="text-xs opacity-70">
                  {e.occurredOn}
                  {e.note ? ` · ${e.note}` : ''}
                </p>
              </div>
              <span className={e.kind === 'expense' ? 'font-medium' : 'font-medium'}>
                {e.kind === 'expense' ? '−' : '+'}
                {e.amount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                label="ลบ"
                isDisabled={pending}
                onClick={() => run(() => removeFinanceEntry(gangId, e.kind, e.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
