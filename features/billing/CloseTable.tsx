"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import { baht, reasonView } from "@/domain/sessions/close-view";

export type CloseRow = {
  id: string;
  name: string;
  isMonthlyMember: boolean;
  /** รหัสเหตุผลจาก server (`chargeReason()`) — แปลที่นี่ครั้งเดียว */
  reason: string;
  /** แยกยอด [WO-B12]: court + shuttle + penalty + rounding = amount (string จาก server) */
  court: string;
  shuttle: string;
  penalty: string;
  rounding: string;
  /** ยอดรวมต่อคน (string จาก server — ไม่แปลงเป็นตัวเลข) */
  amount: string;
} & Record<string, unknown>;

export type CloseColumns = {
  shuttle: boolean;
  penalty: boolean;
  rounding: boolean;
};

type MoneyKey = "court" | "shuttle" | "penalty" | "rounding";

const MONEY_LABEL: Record<MoneyKey, string> = {
  court: "ค่าคอร์ท",
  shuttle: "ค่าลูก",
  penalty: "ค่าปรับ",
  rounding: "ปัดเศษ",
};

function visibleMoneyKeys(columns: CloseColumns): MoneyKey[] {
  return [
    "court",
    ...(columns.shuttle ? (["shuttle"] as const) : []),
    ...(columns.penalty ? (["penalty"] as const) : []),
    ...(columns.rounding ? (["rounding"] as const) : []),
  ];
}

/**
 * รายการยอดต่อคนก่อนปิดรอบ (hi-fi 28) — **[WO-6.4b + B12 + 6.4b.1]**
 *
 * 🔴 แสดงค่าที่ `previewSessionCharges()` ส่งมาเท่านั้น (ไม่คิดเงิน ไม่รวมยอดเอง)
 *
 * รูปแบบตามขนาดจอ (CSS สลับ ไม่ใช้ JS วัดจอ จึงไม่มี hydration mismatch):
 *   · < 768px: การ์ดต่อคน — ชื่อ + **ยอดเด่นขวามือ** อยู่บรรทัดเดียวกัน เหตุผลกับยอดแยกใต้ชื่อ ไม่ต้องเลื่อนข้าง
 *   · ≥ 768px: ตาราง — คอลัมน์ **ยอดอยู่ถัดชื่อ** ก่อนเหตุผล/ยอดแยก เพื่อให้ชื่อกับยอดเห็นพร้อมกันเสมอ
 *     แม้คอลัมน์แยกยอดจะยาวจนตารางเลื่อนแนวนอน
 * คอลัมน์/ส่วนแยกยอด (ลูก/ปรับ/ปัดเศษ) โผล่เฉพาะเมื่อนัดนี้มีค่าไม่เป็นศูนย์ (`columns`)
 * เป็น client component เพราะ `renderCell` เป็น function (ส่งจาก server ไม่ได้)
 */
export function CloseTable({
  rows,
  columns,
}: {
  rows: CloseRow[];
  columns: CloseColumns;
}) {
  const keys = visibleMoneyKeys(columns);

  const money = (key: MoneyKey) => ({
    key,
    header: MONEY_LABEL[key],
    width: pixel(96),
    align: "end" as const,
    renderCell: (row: CloseRow) => (
      <Text hasTabularNumbers>{baht(row[key])}</Text>
    ),
  });

  return (
    <>
      {/* มือถือ: การ์ดต่อคน */}
      <VStack gap={2} className="md:hidden" aria-label="การ์ดยอดต่อคน">
        {rows.map((row) => {
          const view = reasonView(row.reason);
          return (
            <Card key={row.id} padding={3}>
              <VStack gap={2}>
                <HStack justify="between" align="center" gap={3}>
                  <HStack
                    gap={2}
                    align="center"
                    wrap="wrap"
                    className="min-w-0 flex-1"
                  >
                    <Text weight="semibold">{row.name}</Text>
                    {row.isMonthlyMember ? (
                      <Badge variant="info" label="รายเดือน" />
                    ) : null}
                  </HStack>
                  <Heading level={3}>{baht(row.amount)}</Heading>
                </HStack>
                <HStack gap={2} align="center" wrap="wrap">
                  <Badge variant={view.tone} label={view.label} />
                </HStack>
                <Text type="supporting" size="xsm">
                  {keys
                    .map((k) => `${MONEY_LABEL[k]} ${baht(row[k])}`)
                    .join(" · ")}
                </Text>
              </VStack>
            </Card>
          );
        })}
      </VStack>

      {/* ≥768px: ตาราง (ยอดถัดชื่อ) */}
      <VStack className="hidden md:flex">
        <Card padding={0}>
          <Table
            data={rows}
            idKey="id"
            density="compact"
            columns={[
              {
                key: "name",
                header: "ผู้เล่น",
                width: proportional(1),
                renderCell: (row) => (
                  <HStack gap={2} align="center" wrap="wrap">
                    <Text weight="semibold">{row.name}</Text>
                    {row.isMonthlyMember ? (
                      <Badge variant="info" label="รายเดือน" />
                    ) : null}
                  </HStack>
                ),
              },
              {
                key: "amount",
                header: "ยอด",
                width: pixel(112),
                align: "end",
                renderCell: (row) => (
                  <Text weight="semibold" hasTabularNumbers>
                    {baht(row.amount)}
                  </Text>
                ),
              },
              {
                key: "reason",
                header: "เหตุผล",
                width: pixel(168),
                renderCell: (row) => {
                  const view = reasonView(row.reason);
                  return <Badge variant={view.tone} label={view.label} />;
                },
              },
              ...keys.map(money),
            ]}
          />
        </Card>
      </VStack>
    </>
  );
}
