'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';

import { cancelJoinRequest, requestToJoin, type GangSearchResult } from '@/server/actions/discovery';

export type MyJoinRequest = {
  id: string;
  gangName: string;
  status: string;
  createdAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'รอแอดมินอนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ถูกปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
};

/**
 * ค้นหาก๊วน + ขอเข้าก๊วน — **[WO-3.E]**
 *
 * ⚠️ ปุ่ม "ขอเข้าก๊วน" ซ่อนตาม `viewerStatus` เพื่อความสะดวกเท่านั้น
 *    ด่านจริงคือ `request_to_join_gang()` ที่ตรวจซ้ำว่าเป็นสมาชิกอยู่แล้วหรือยัง
 *    (ก๊วนที่ไม่ public / ปิด discovery ไม่โผล่มาถึงตรงนี้ตั้งแต่ต้นอยู่แล้ว)
 */
export function DiscoverPanel({
  query,
  results,
  myRequests,
  isSignedIn,
}: {
  query: string;
  results: GangSearchResult[];
  myRequests: MyJoinRequest[];
  isSignedIn: boolean;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(query);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<{ gangId: string; text: string } | null>(null);

  function onSearch(event: FormEvent) {
    event.preventDefault();
    const q = term.trim();
    router.push(q === '' ? '/discover' : `/discover?q=${encodeURIComponent(q)}`);
  }

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

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSearch} noValidate className="flex items-end gap-2">
        <div className="grow">
          <TextInput
            label="ค้นหาก๊วน"
            value={term}
            onChange={setTerm}
            placeholder="ชื่อก๊วน หรือพื้นที่ เช่น บางแค"
          />
        </div>
        <Button type="submit" variant="primary" label="ค้นหา" isLoading={pending} />
      </form>

      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {results.length === 0 ? (
        <p className="text-sm">
          {query === '' ? 'ยังไม่มีก๊วนที่เปิดให้ค้นหา' : `ไม่พบก๊วนที่ตรงกับ “${query}”`}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {results.map((gang) => (
            <li key={gang.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{gang.name}</p>
                    {gang.area ? <p className="text-sm">{gang.area}</p> : null}
                    {gang.description ? (
                      <p className="mt-1 text-sm whitespace-pre-wrap">{gang.description}</p>
                    ) : null}
                  </div>
                  <Badge label={`${gang.memberCount} คน`} />
                </div>

                <div className="mt-3">
                  {gang.viewerStatus === 'member' ? (
                    <p className="text-sm">คุณอยู่ในก๊วนนี้แล้ว</p>
                  ) : gang.viewerStatus === 'pending' ? (
                    <p className="text-sm">ส่งคำขอไปแล้ว — รอแอดมินอนุมัติ</p>
                  ) : !isSignedIn ? (
                    <p className="text-sm">เข้าสู่ระบบก่อนจึงจะขอเข้าก๊วนได้</p>
                  ) : message?.gangId === gang.id ? (
                    <div className="flex flex-col gap-2">
                      <TextInput
                        label="ข้อความถึงแอดมิน (ไม่ใส่ก็ได้)"
                        value={message.text}
                        onChange={(text) => setMessage({ gangId: gang.id, text })}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          label="ส่งคำขอ"
                          isDisabled={pending}
                          onClick={() =>
                            run(async () => {
                              const result = await requestToJoin(gang.id, message.text);
                              if (result.success) {
                                setMessage(null);
                                setNotice('ส่งคำขอแล้ว — รอแอดมินอนุมัติ');
                              }
                              return result;
                            })
                          }
                        />
                        <Button size="sm" label="ยกเลิก" onClick={() => setMessage(null)} />
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      label="ขอเข้าก๊วน"
                      isDisabled={pending}
                      onClick={() => setMessage({ gangId: gang.id, text: '' })}
                    />
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {myRequests.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">คำขอของฉัน</h2>
          <ul className="flex flex-col gap-2">
            {myRequests.map((request) => (
              <li key={request.id}>
                <Card padding={4}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{request.gangName}</p>
                      <p className="text-sm">
                        {STATUS_LABELS[request.status] ?? request.status} ·{' '}
                        {new Date(request.createdAt).toLocaleDateString('th-TH')}
                      </p>
                    </div>
                    {request.status === 'pending' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        label="ยกเลิกคำขอ"
                        isDisabled={pending}
                        onClick={() => run(() => cancelJoinRequest(request.id))}
                      />
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
