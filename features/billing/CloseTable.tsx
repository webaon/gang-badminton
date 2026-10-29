"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";

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

/**
 * ตารางยอดต่อคนก่อนปิดรอบ (hi-fi 28) — **[WO-6.4b + B12]**
 *
 * 🔴 แสดงค่าที่ `previewSessionCharges()` ส่งมาเท่านั้น (ไม่คิดเงิน ไม่รวมยอดเอง)
 * คอลัมน์แยกยอด (ลูก/ปรับ/ปัดเศษ) โผล่เฉพาะเมื่อมีค่าไม่ใช่ศูนย์ในนัดนี้ (`columns`) — `Table` เลื่อนแนวนอนเองในกรอบ
 * ไม่ดันหน้าให้กว้างเกิน · เป็น client component เพราะ `renderCell` เป็น function (ส่งจาก server ไม่ได้)
 */
export function CloseTable({
  rows,
  columns,
}: {
  rows: CloseRow[];
  columns: CloseColumns;
}) {
  const money = (
    key: "court" | "shuttle" | "penalty" | "rounding",
    header: string,
  ) => ({
    key,
    header,
    width: pixel(96),
    align: "end" as const,
    renderCell: (row: CloseRow) => (
      <Text hasTabularNumbers>{baht(row[key])}</Text>
    ),
  });

  return (
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
          key: "reason",
          header: "เหตุผล",
          width: pixel(168),
          renderCell: (row) => {
            const view = reasonView(row.reason);
            return <Badge variant={view.tone} label={view.label} />;
          },
        },
        money("court", "ค่าคอร์ท"),
        ...(columns.shuttle ? [money("shuttle", "ค่าลูก")] : []),
        ...(columns.penalty ? [money("penalty", "ค่าปรับ")] : []),
        ...(columns.rounding ? [money("rounding", "ปัดเศษ")] : []),
        {
          key: "amount",
          header: "ยอด",
          width: pixel(104),
          align: "end",
          renderCell: (row) => (
            <Text weight="semibold" hasTabularNumbers>
              {baht(row.amount)}
            </Text>
          ),
        },
      ]}
    />
  );
}
