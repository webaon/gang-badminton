'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';

import { decideJoinRequest } from '@/server/actions/discovery';

export type JoinRequestRow = {
  id: string;
  requesterName: string;
  message: string | null;
  status: string;
  createdAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ผู้ขอยกเลิก',
};

/**
 * คำขอเข้าก๊วน (ฝั่งแอดมิน) — **[WO-3.E]**
 *
 * 🔴 อนุมัติผ่าน `decide_join_request()` เท่านั้น — เป็นจุดเดียวที่สร้าง `gang_members`
 *    กดสองครั้ง/สองคนกดพร้อมกัน จะได้ `INVALID_TRANSITION` ใบเดียว ไม่ได้สมาชิกซ้ำ
 */
export function JoinRequestsPanel({
  gangId,
  requests,
}: {
  gangId: string;
  requests: JoinRequestRow[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function decide(requestId: string, decision: 'approved' | 'rejected') {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await decideJoinRequest(gangId, requestId, decision);
    if (result.success) {
      setNotice(decision === 'approved' ? 'รับเข้าก๊วนแล้ว' : 'ปฏิเสธคำขอแล้ว');
      router.refresh();
    } else {
      setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    }

    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {requests.length === 0 ? (
        <p className="text-sm">ยังไม่มีคำขอเข้าก๊วน</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((request) => (
            <li key={request.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{request.requesterName}</p>
                    {request.message ? (
                      <p className="mt-1 text-sm whitespace-pre-wrap">{request.message}</p>
                    ) : null}
                    <p className="mt-1 text-xs opacity-70">
                      {new Date(request.createdAt).toLocaleString('th-TH')}
                    </p>
                  </div>
                  <Badge label={STATUS_LABELS[request.status] ?? request.status} />
                </div>

                {request.status === 'pending' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      label="รับเข้าก๊วน"
                      isDisabled={pending}
                      onClick={() => decide(request.id, 'approved')}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      label="ปฏิเสธ"
                      isDisabled={pending}
                      onClick={() => decide(request.id, 'rejected')}
                    />
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
