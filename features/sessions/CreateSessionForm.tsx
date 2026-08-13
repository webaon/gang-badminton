'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Switch } from '@astryxdesign/core/Switch';
import { TextInput } from '@astryxdesign/core/TextInput';

import { createSession } from '@/server/actions/sessions';

/**
 * ⚠️ เวลาที่กรอกคือ **เวลาของก๊วน** ไม่ใช่เวลาของเครื่องผู้ใช้
 *    server แปลงเป็น instant จริงด้วย `gangs.timezone` (domain/time/timezone.ts)
 *    ⇒ ห้ามแปลงเป็น ISO ที่ฝั่ง client เพราะจะได้ timezone ของเบราว์เซอร์
 */
export function CreateSessionForm({ gangId, timezone }: { gangId: string; timezone: string }) {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [courtCount, setCourtCount] = useState('2');
  const [maxPlayers, setMaxPlayers] = useState('8');
  const [allowGuests, setAllowGuests] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await createSession(gangId, {
      title,
      venue: venue || null,
      startsAtLocal,
      endsAtLocal,
      courtCount: Number(courtCount),
      maxPlayers: Number(maxPlayers),
      allowGuests,
    });

    if (result.success) {
      setTitle('');
      setStartsAtLocal('');
      setEndsAtLocal('');
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput label="ชื่อนัด" value={title} onChange={setTitle} isRequired />
        <TextInput label="สนาม" value={venue} onChange={setVenue} isOptional />
      </FormLayout>

      {/* Astryx ยังไม่มี date-time input ⇒ ใช้ native ห่อด้วย label ตาม fallback rule §1 */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>เริ่ม ({timezone})</span>
          <input
            type="datetime-local"
            required
            value={startsAtLocal}
            onChange={(e) => setStartsAtLocal(e.target.value)}
            className="rounded-lg border p-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>จบ ({timezone})</span>
          <input
            type="datetime-local"
            required
            value={endsAtLocal}
            onChange={(e) => setEndsAtLocal(e.target.value)}
            className="rounded-lg border p-2"
          />
        </label>
      </div>

      <div className="mt-3">
        <FormLayout direction="horizontal">
          <TextInput label="จำนวนคอร์ท" value={courtCount} onChange={setCourtCount} />
          <TextInput label="รับสูงสุด (คน)" value={maxPlayers} onChange={setMaxPlayers} />
        </FormLayout>
      </div>

      <div className="mt-3">
        <Switch label="ให้ guest ลงชื่อได้" value={allowGuests} onChange={setAllowGuests} />
      </div>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button type="submit" variant="primary" label="สร้างนัด (ยังไม่เปิดรับ)" isLoading={pending} />
      </div>
    </form>
  );
}
