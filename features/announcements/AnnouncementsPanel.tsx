'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';

import {
  createAnnouncement,
  deleteAnnouncement,
  publishAnnouncement,
  updateAnnouncement,
} from '@/server/actions/announcements';

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  publishedAt: string | null;
  imageCount: number;
};

/**
 * ประกาศของก๊วน — **[WO-3.D]**
 *
 * 🔴 สร้างแล้วเป็น **ร่าง** เสมอ · สมาชิกทั่วไปยังไม่เห็น (RLS 0032)
 *    ต้องกด "ประกาศ" อีกครั้ง ซึ่งเป็นจุดที่แจ้งเตือนถูกยิง
 *
 * ⚠️ กด "ประกาศ" ซ้ำได้ — `dedupe_key` กันส่งซ้ำที่ระดับฐานข้อมูล
 */
export function AnnouncementsPanel({
  gangId,
  announcements,
  canManage,
}: {
  gangId: string;
  announcements: AnnouncementRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string } | null>(
    null,
  );
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

    const input = { title: editing.title, body: editing.body };
    const ok = await run(() =>
      editing.id === null
        ? createAnnouncement(gangId, input)
        : updateAnnouncement(gangId, editing.id, input),
    );

    if (ok) {
      setEditing(null);
      setNotice('บันทึกเป็นร่างแล้ว — กด “ประกาศ” เพื่อแจ้งสมาชิก');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {announcements.length === 0 ? (
        <p className="text-sm">ยังไม่มีประกาศ</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {announcements.map((a) => (
            <li key={a.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{a.title}</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap">{a.body}</p>
                    {a.imageCount > 0 ? (
                      <p className="mt-1 text-xs opacity-70">แนบรูป {a.imageCount} รูป</p>
                    ) : null}
                  </div>
                  <Badge
                    label={
                      a.publishedAt
                        ? `ประกาศแล้ว ${new Date(a.publishedAt).toLocaleDateString('th-TH')}`
                        : 'ร่าง'
                    }
                  />
                </div>

                {canManage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      label="แก้ไข"
                      isDisabled={pending}
                      onClick={() => setEditing({ id: a.id, title: a.title, body: a.body })}
                    />
                    {a.publishedAt === null ? (
                      <Button
                        size="sm"
                        variant="primary"
                        label="ประกาศ"
                        isDisabled={pending}
                        onClick={() =>
                          run(async () => {
                            const result = await publishAnnouncement(gangId, a.id);
                            if (result.success) setNotice('ประกาศแล้ว — แจ้งเตือนสมาชิกเรียบร้อย');
                            return result;
                          })
                        }
                      />
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      label="ลบ"
                      isDisabled={pending}
                      onClick={() => run(() => deleteAnnouncement(gangId, a.id))}
                    />
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        editing === null ? (
          <div>
            <Button
              variant="primary"
              label="เขียนประกาศใหม่"
              onClick={() => setEditing({ id: null, title: '', body: '' })}
            />
          </div>
        ) : (
          <Card padding={4}>
            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
              <TextInput
                label="หัวข้อ"
                value={editing.title}
                onChange={(title) => setEditing({ ...editing, title })}
                isRequired
              />
              <TextInput
                label="เนื้อหา"
                value={editing.body}
                onChange={(body) => setEditing({ ...editing, body })}
                isRequired
              />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" label="บันทึกร่าง" isLoading={pending} />
                <Button label="ยกเลิก" onClick={() => setEditing(null)} />
              </div>
              <p className="text-xs opacity-70">
                บันทึกแล้วยังไม่แจ้งสมาชิก — ต้องกด “ประกาศ” อีกครั้ง
              </p>
            </form>
          </Card>
        )
      ) : null}
    </div>
  );
}
