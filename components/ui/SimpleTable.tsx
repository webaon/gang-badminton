'use client';

import { Table, pixel, proportional } from '@astryxdesign/core/Table';

export type SimpleTableColumn = {
  key: string;
  header: string;
  /** กว้างคงที่ (px) — ไม่ใส่ = ยืดตามสัดส่วน 1 */
  widthPx?: number;
  align?: 'start' | 'end';
};

export type SimpleTableRow = { id: string } & Record<string, string>;

/**
 * ตารางข้อความล้วน สำหรับ server component — **[HF-2 / WO-6.4b]**
 *
 * 🔴 ที่มา: Astryx `Table` ต้องการ `idKey` / `width` ที่เป็น **function / object ที่มี function**
 *    server component ส่ง function ข้ามเข้า client component ไม่ได้ ⇒ หน้าพังตอน render
 *    wrapper นี้เป็น client component รับแต่ข้อมูลธรรมดา (string/number) แล้วสร้าง `width` + `idKey` เอง
 *
 * ❌ ห้ามเพิ่ม prop ชนิด function (renderCell/onClick/idKey เป็นฟังก์ชัน) ที่นี่ — ถ้าต้องการ cell พิเศษ
 *    ให้ทำ client component เฉพาะกิจ (ดู `features/billing/CloseTable.tsx`)
 * ✅ `id` ต้องไม่ซ้ำในตาราง (ใช้ id ของแถวจริง ไม่ใช่ชื่อ — ชื่อซ้ำได้)
 */
export function SimpleTable({ rows, columns }: { rows: SimpleTableRow[]; columns: SimpleTableColumn[] }) {
  return (
    <Table
      data={rows}
      idKey="id"
      density="compact"
      columns={columns.map((c) => ({
        key: c.key,
        header: c.header,
        width: c.widthPx ? pixel(c.widthPx) : proportional(1),
        align: c.align,
      }))}
    />
  );
}
