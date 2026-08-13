'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { TextInput } from '@astryxdesign/core/TextInput';

import { DAY_LABELS, type Recurrence } from '@/domain/sessions/recurrence';
import {
  createTemplate,
  generateNow,
  setTemplateActive,
  updateTemplate,
} from '@/server/actions/templates';

export type TemplateRow = {
  id: string;
  name: string;
  venue: string | null;
  courtCount: number;
  maxPlayers: number;
  allowGuests: boolean;
  isActive: boolean;
  recurrence: Recurrence;
  /** จำนวนนัดที่ generate จากตารางนี้และยังไม่ถึงเวลา */
  upcoming: number;
};

const EMPTY: TemplateRow = {
  id: '',
  name: '',
  venue: null,
  courtCount: 2,
  maxPlayers: 16,
  allowGuests: true,
  isActive: true,
  recurrence: { days: [], startTime: '19:00', endTime: '21:00' },
  upcoming: 0,
};

/**
 * ตารางนัดประจำ — **[WO-2.5-E]**
 *
 * ⚠️ แก้ตารางมีผลกับ**รอบที่ยังไม่ถูกสร้าง**เท่านั้น — นัดที่ generate ไปแล้ว
 *    ไม่ถูกย้ายเวลาตาม (คนลงชื่อไว้แล้ว) หน้าจอเขียนบอกไว้ให้ชัด
 */
export function TemplatesPanel({
  gangId,
  templates,
}: {
  gangId: string;
  templates: TemplateRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();
    if (result.success) router.refresh();
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');

    setPending(false);
    return result.success;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;

    const input = {
      name: editing.name,
      recurrence: editing.recurrence,
      venue: editing.venue,
      courtCount: editing.courtCount,
      maxPlayers: editing.maxPlayers,
      allowGuests: editing.allowGuests,
      isActive: editing.isActive,
    };

    const ok = await run(() =>
      editing.id === ''
        ? createTemplate(gangId, input)
        : updateTemplate(gangId, editing.id, input),
    );

    if (ok) {
      setEditing(null);
      setNotice('บันทึกตารางแล้ว — รอบถัดไปจะถูกสร้างล่วงหน้า 2 สัปดาห์');
    }
  }

  function toggleDay(day: number) {
    setEditing((prev) => {
      if (!prev) return prev;
      const days = prev.recurrence.days.includes(day)
        ? prev.recurrence.days.filter((d) => d !== day)
        : [...prev.recurrence.days, day].sort((a, b) => a - b);
      return { ...prev, recurrence: { ...prev.recurrence, days } };
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {templates.length === 0 && editing === null ? (
        <p className="text-sm">
          ยังไม่มีตารางประจำ — ตั้งไว้แล้วระบบจะสร้างนัดล่วงหน้าให้ 2 สัปดาห์ทุกวัน
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {templates.map((t) => (
          <li key={t.id}>
            <Card padding={4}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm">
                    {t.recurrence.days.map((d) => DAY_LABELS[d]).join(' · ') || 'ยังไม่เลือกวัน'}{' '}
                    {t.recurrence.startTime}–{t.recurrence.endTime}
                  </p>
                  <p className="text-xs opacity-70">
                    {t.venue ? `${t.venue} · ` : ''}
                    {t.courtCount} คอร์ท · รับ {t.maxPlayers} คน · สร้างล่วงหน้าแล้ว {t.upcoming} นัด
                  </p>
                </div>
                <Badge label={t.isActive ? 'เปิดอยู่' : 'ปิดอยู่'} />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  label="แก้ไข"
                  isDisabled={pending}
                  onClick={() => setEditing(t)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  label="สร้างล่วงหน้าเลย"
                  isDisabled={pending || !t.isActive}
                  onClick={() =>
                    run(async () => {
                      const result = await generateNow(gangId, t.id);
                      if (result.success) {
                        setNotice(
                          result.data.created > 0
                            ? `สร้างนัดใหม่ ${result.data.created} นัด`
                            : 'สร้างครบแล้ว — ไม่มีรอบใหม่ที่ต้องสร้าง',
                        );
                      }
                      return result;
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  label={t.isActive ? 'ปิดตาราง' : 'เปิดตาราง'}
                  isDisabled={pending}
                  onClick={() => run(() => setTemplateActive(gangId, t.id, !t.isActive))}
                />
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <div>
          <Button variant="primary" label="เพิ่มตารางประจำ" onClick={() => setEditing(EMPTY)} />
        </div>
      ) : (
        <Card padding={4}>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
            <TextInput
              label="ชื่อตาราง"
              value={editing.name}
              onChange={(v) => setEditing({ ...editing, name: v })}
              isRequired
              description="ใช้เป็นชื่อนัดที่สร้างขึ้นมา เช่น “ซ้อมประจำสัปดาห์”"
            />

            <div>
              <p className="mb-2 text-sm font-medium">เล่นวันไหนบ้าง</p>
              <div className="flex flex-wrap gap-3">
                {DAY_LABELS.map((label, day) => (
                  <CheckboxInput
                    key={label}
                    label={label}
                    size="sm"
                    value={editing.recurrence.days.includes(day)}
                    onChange={() => toggleDay(day)}
                  />
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <TextInput
                label="เวลาเริ่ม"
                value={editing.recurrence.startTime}
                onChange={(v) =>
                  setEditing({ ...editing, recurrence: { ...editing.recurrence, startTime: v } })
                }
                placeholder="19:00"
              />
              <TextInput
                label="เวลาจบ"
                value={editing.recurrence.endTime}
                onChange={(v) =>
                  setEditing({ ...editing, recurrence: { ...editing.recurrence, endTime: v } })
                }
                placeholder="21:00"
                description="เวลาของก๊วน · จบข้ามเที่ยงคืนได้"
              />
            </div>

            <TextInput
              label="สถานที่"
              value={editing.venue ?? ''}
              onChange={(v) => setEditing({ ...editing, venue: v })}
            />

            <div className="flex gap-2">
              <TextInput
                label="จำนวนคอร์ท"
                value={String(editing.courtCount)}
                onChange={(v) => setEditing({ ...editing, courtCount: Number(v) || 0 })}
              />
              <TextInput
                label="รับกี่คน"
                value={String(editing.maxPlayers)}
                onChange={(v) => setEditing({ ...editing, maxPlayers: Number(v) || 0 })}
              />
            </div>

            <CheckboxInput
              label="ให้แขกลงชื่อได้"
              value={editing.allowGuests}
              onChange={(v) => setEditing({ ...editing, allowGuests: v })}
            />

            <div className="flex gap-2">
              <Button type="submit" variant="primary" label="บันทึก" isLoading={pending} />
              <Button label="ยกเลิก" onClick={() => setEditing(null)} />
            </div>

            <p className="text-xs opacity-70">
              แก้ตารางมีผลกับรอบที่ยังไม่ถูกสร้างเท่านั้น — นัดที่สร้างไปแล้วต้องแก้ทีละนัด
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
