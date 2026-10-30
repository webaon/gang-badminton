import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import {
  baht,
  hasShuttleSplit,
  isZeroAmount,
} from "@/domain/sessions/close-view";
import { CloseTable, type CloseRow } from "@/features/billing/CloseTable";
import type { BillingPreview } from "@/server/actions/billing";

function Kpi({
  label,
  value,
  hint,
  highlight = false,
}: {
  label: string;
  value: string;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <Card padding={4} variant={highlight ? "blue" : "default"}>
      <VStack gap={1}>
        <Text type="supporting" size="sm">
          {label}
        </Text>
        <Heading level={2}>{value}</Heading>
        {hint ? (
          <Text type="supporting" size="xsm">
            {hint}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}

/**
 * สรุปยอดก่อนปิดรอบ (hi-fi 28) — **[WO-6.4b + B12]** server component
 *
 * 🔴 ไม่คำนวณเงินที่นี่: ทุกค่ามาจาก `BillingPreview` (map จาก `calculateSessionCharges()` ตัวเดียวกับตอนปิดรอบจริง)
 *    ที่เห็นคือ string ที่ server ส่งมา จัดรูปอย่างเดียว · หมวดที่เป็นศูนย์ทั้งนัดไม่โชว์ (KPI/คอลัมน์) ให้จอไม่รก
 */
export function CloseSummary({ preview }: { preview: BillingPreview }) {
  const {
    rows,
    total,
    chargedCount,
    checkedInCount,
    pricingType,
    shuttlesUsedTotal,
    roundingSurplus,
    courtCostTotal,
    shuttleCostTotal,
    penaltyTotal,
    roundingTotal,
    absorbedCostTotal,
  } = preview;

  const showShuttle =
    hasShuttleSplit(pricingType) || !isZeroAmount(shuttleCostTotal);
  const showPenalty = !isZeroAmount(penaltyTotal);
  const showRounding = !isZeroAmount(roundingTotal);
  const showAbsorbed = !isZeroAmount(absorbedCostTotal);

  const tableRows: CloseRow[] = rows.map((r) => ({
    id: r.registrationId,
    name: r.displayName,
    isMonthlyMember: r.isMonthlyMember,
    reason: r.reason,
    court: r.breakdown.court,
    shuttle: r.breakdown.shuttle,
    penalty: r.breakdown.penalty,
    rounding: r.breakdown.rounding,
    amount: r.amount,
  }));

  return (
    <VStack gap={4}>
      <Grid columns={{ minWidth: 150, repeat: "fit" }} gap={3}>
        <Kpi label="เก็บรวม" value={baht(total)} highlight />
        <Kpi label="ถูกเก็บเงิน" value={`${chargedCount} คน`} />
        <Kpi label="เช็คอินแล้ว" value={`${checkedInCount} คน`} />
        <Kpi label="ค่าคอร์ท" value={baht(courtCostTotal)} />
        {showShuttle ? (
          <Kpi
            label="ค่าลูก"
            value={baht(shuttleCostTotal)}
            hint={`ใช้ ${shuttlesUsedTotal ?? "0"} ลูก`}
          />
        ) : null}
        {showPenalty ? (
          <Kpi label="ค่าปรับ" value={baht(penaltyTotal)} />
        ) : null}
        {showRounding ? (
          <Kpi
            label="เศษจากการปัด"
            value={baht(roundingSurplus)}
            hint={
              roundingSurplus.startsWith("-")
                ? "ติดลบ = ก๊วนรับส่วนต่างเอง"
                : "เป็นรายรับของก๊วน"
            }
          />
        ) : null}
      </Grid>

      {showAbsorbed ? (
        <Banner
          status="info"
          title="มีต้นทุนที่ไม่มีใครหาร"
          description={`${baht(absorbedCostTotal)} — ก๊วนรับส่วนนี้เอง (เช่นทุกคนที่เล่นเป็นสมาชิกรายเดือน)`}
        />
      ) : null}

      <HStack justify="between" align="center" gap={2} wrap="wrap">
        <Heading level={2}>ยอดต่อคน</Heading>
        <Badge variant="info" label={`ในรายการ ${rows.length} คน`} />
      </HStack>

      <CloseTable
        rows={tableRows}
        columns={{
          shuttle: showShuttle,
          penalty: showPenalty,
          rounding: showRounding,
        }}
      />
    </VStack>
  );
}
