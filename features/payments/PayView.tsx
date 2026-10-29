import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { CreateMyPaymentButton } from '@/features/payments/CreateMyPaymentButton';
import { PayQr } from '@/features/payments/PayQr';
import { PaySlipForm } from '@/features/payments/PaySlipForm';
import { PayStatusSteps } from '@/features/payments/PayStatusSteps';

const STATUS_LABELS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'error' }> = {
  pending: { label: 'รอโอน', tone: 'neutral' },
  submitted: { label: 'รอแอดมินยืนยัน', tone: 'info' },
  verified: { label: 'ยืนยันแล้ว', tone: 'success' },
  rejected: { label: 'ถูกปฏิเสธ', tone: 'error' },
};

export type PayViewProps = {
  gangId: string;
  gangName: string;
  sessionId: string;
  sessionTitle: string;
  /** มี charge ของฉันในนัดนี้หรือไม่ */
  hasCharges: boolean;
  /** ข้อความเงินที่จัดรูปแล้วจาก server (เช่น "฿148.00") — view นี้ไม่คำนวณ/ไม่แปลงตัวเลข */
  outstandingText: string;
  allocatedText: string | null;
  /** "ก๊วนต้องคืนให้ ..." — null = ไม่มี */
  refundText: string | null;
  /** เครดิตคงเหลือของสมาชิก (รอ WO-B5a) — null = ซ่อนบล็อก */
  creditBalanceText?: string | null;
  payment: { id: string; amountText: string; status: string; rejectReason: string | null } | null;
  qr: string | null;
  promptPayId: string | null;
};

/**
 * หน้าจ่ายเงินรายนัดของสมาชิก (hi-fi 30/31 + K30/K31) — **[WO-6.3]** server component แสดงผลล้วน
 *
 * 🔴 ไม่มีการคิดเงิน: ทุกข้อความเงินมาจาก server เป็น string สำเร็จรูป
 * ข้อมูลทั้งหมดมาจาก page (ตอนนี้) / loader ของ WO-R3 (เมื่อลง) — view เปลี่ยนแหล่งข้อมูลได้โดยไม่แก้ไฟล์นี้
 */
export function PayView(props: PayViewProps) {
  const { gangId, sessionId, sessionTitle, hasCharges, payment } = props;
  const backHref = `/gangs/${gangId}/sessions/${sessionId}`;

  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-md p-4">
      <VStack gap={1}>
        <HStack justify="between" align="center" gap={2} wrap="wrap">
          <Heading level={1}>จ่ายเงิน</Heading>
          <Button size="sm" variant="ghost" label="กลับไปที่นัด" href={backHref} />
        </HStack>
        <Text type="supporting">{sessionTitle}</Text>
      </VStack>

      {!hasCharges ? (
        <StatePanel
          fullPage={false}
          headingLevel={2}
          title="ยังไม่มียอดที่ต้องจ่ายในนัดนี้"
          description="ยอดจะขึ้นหลังแอดมินปิดรอบของนัดนี้"
          actions={[{ label: 'กลับไปที่นัด', href: backHref }]}
        />
      ) : (
        <>
          <Card padding={4}>
            <VStack gap={1}>
              <Text type="supporting" size="sm">
                ยอดค้างในนัดนี้
              </Text>
              <Heading level={2}>{props.outstandingText}</Heading>
              {props.allocatedText ? (
                <Text type="supporting" size="sm">
                  จ่ายมาแล้ว {props.allocatedText}
                </Text>
              ) : null}
              {props.refundText ? (
                <Text type="supporting" size="sm">
                  {props.refundText}
                </Text>
              ) : null}
              {props.creditBalanceText ? (
                <Text type="supporting" size="sm">
                  เครดิตคงเหลือ {props.creditBalanceText}
                </Text>
              ) : null}
            </VStack>
          </Card>

          {!payment ? (
            <CreateMyPaymentButton sessionId={sessionId} />
          ) : (
            <>
              <HStack gap={2} align="center" wrap="wrap">
                <Badge
                  variant={STATUS_LABELS[payment.status]?.tone ?? 'neutral'}
                  label={STATUS_LABELS[payment.status]?.label ?? 'ไม่ทราบสถานะ'}
                />
                <Text>{payment.amountText}</Text>
              </HStack>

              {payment.status === 'rejected' ? (
                <Banner
                  status="error"
                  title="สลิปถูกปฏิเสธ"
                  description={payment.rejectReason ?? 'แอดมินไม่ได้ระบุเหตุผล — อัปสลิปใหม่ได้ด้านล่าง'}
                />
              ) : null}

              {payment.status !== 'verified' && props.qr && props.promptPayId ? (
                <PayQr
                  qr={props.qr}
                  amountText={payment.amountText}
                  promptPayId={props.promptPayId}
                  gangName={props.gangName}
                />
              ) : null}

              {payment.status !== 'verified' && !props.qr ? (
                <StatePanel
                  fullPage={false}
                  headingLevel={2}
                  tone="warning"
                  title="ยังสร้าง QR ไม่ได้"
                  description="ก๊วนยังไม่ได้ตั้งพร้อมเพย์ หรือเลขพร้อมเพย์ใช้ไม่ได้ — ติดต่อแอดมินเพื่อโอน แล้วอัปสลิปได้ด้านล่าง"
                  actions={[{ label: 'ลองใหม่', href: `/gangs/${gangId}/sessions/${sessionId}/pay`, variant: 'secondary' }]}
                />
              ) : null}

              <PayStatusSteps status={payment.status} />
              <PaySlipForm paymentId={payment.id} status={payment.status} />
            </>
          )}
        </>
      )}
    </VStack>
  );
}
