/**
 * `sessions.snapshot` — บันทึกแช่แข็งทุกอย่างที่กระทบเงิน ณ ตอนสร้างนัด
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 baseline §Snapshot rule (blocker):
 *    "ตอนคิดเงินอ่านจาก snapshot เสมอ ห้ามอ่านค่าปัจจุบันจาก gangs / gang_pricing_plans"
 *
 * เหตุผล: ก๊วนขึ้นราคาเดือนหน้า นัดที่จัดไปแล้วเมื่อเดือนก่อนต้องยังคิดราคาเดิม
 * ถ้าอ่านค่าปัจจุบัน ยอดของนัดเก่าจะเปลี่ยนย้อนหลังทุกครั้งที่แก้ราคา
 * ⇒ รายงานย้อนหลังเชื่อถือไม่ได้ และคนที่จ่ายไปแล้วจะกลายเป็นค้างจ่าย
 *
 * ⚠️ snapshot เป็น **ก้อนเดียว** — ห้ามแตกเป็นคอลัมน์ (baseline §Snapshot rule)
 *    ไม่มี query pattern ที่ต้อง index เข้าไปข้างใน
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */
import type { CancellationPolicyJson } from '../policies/cancellation';
import { toJson as cancellationToJson, type CancellationPolicy } from '../policies/cancellation';
import {
  courtPlusShuttleToJson,
  flatRateToJson,
  roundingToJson,
  type CourtPlusShuttleParams,
  type FlatRateParams,
  type PricingType,
  type RoundingPolicy,
} from '../policies/pricing';

/**
 * ขึ้นเลขนี้เมื่อ **รูปร่าง** ของ snapshot เปลี่ยน
 *
 * billing อ่านตาม version ได้ ⇒ นัดเก่ายังคิดเงินถูกต้องหลัง schema เปลี่ยน
 * (baseline [v3.1] กำหนดให้มีคีย์นี้ตั้งแต่แรกด้วยเหตุผลนี้)
 */
export const SNAPSHOT_VERSION = 1;

/**
 * ⚠️ **[WO-2.5-B]** เพิ่ม `pricing_plan.monthly_member_pays_shuttle` แบบ **additive**
 *    ⇒ ไม่ขึ้น `SNAPSHOT_VERSION` (แนวเดียวกับ ADR-004)
 *    snapshot เก่าที่ไม่มีคีย์นี้อ่านเป็น `true` = ค่า default ของคอลัมน์ใน schema
 *    ⇒ นัดเก่าคิดเงินได้ผลเท่าเดิมเป๊ะ เพราะ `flat_rate` ไม่ได้ใช้คีย์นี้อยู่แล้ว
 */

export type SessionSnapshot = {
  snapshot_version: number;
  pricing_plan: {
    id: string | null;
    name: string;
    type: PricingType;
    /** คีย์ต่างกันตาม type — `flat_rate` ใช้ `amount_per_person`,
     *  `court_plus_shuttle` ใช้ `court_fee_total` + `shuttle_price` */
    params: Record<string, string>;
    /** ค่าลูกของสมาชิกรายเดือน: true = คิดตามจริง · false = รวมในค่ารายเดือนแล้ว */
    monthly_member_pays_shuttle: boolean;
  };
  rounding_policy: { mode: string; surplus_to: string };
  promptpay_id: string | null;
  cancellation_policy: CancellationPolicyJson;
  skill_levels: Array<{ label: string; rank: number }>;
};

/** พารามิเตอร์ราคาแยกตาม type — union บังคับให้ส่งชุดที่ตรงกับ type เท่านั้น */
export type SnapshotPricingPlan = { id: string | null; name: string } & (
  | { type: 'flat_rate'; flatRate: FlatRateParams }
  | { type: 'court_plus_shuttle'; courtPlusShuttle: CourtPlusShuttleParams }
  | { type: 'monthly'; monthly: Record<string, never> }
);

export type BuildSnapshotInput = {
  pricingPlan: SnapshotPricingPlan;
  /** ค่าจาก `gang_pricing_plans.monthly_member_pays_shuttle` */
  monthlyMemberPaysShuttle?: boolean;
  roundingPolicy: RoundingPolicy;
  promptpayId: string | null;
  cancellationPolicy: CancellationPolicy;
  skillLevels: Array<{ label: string; rank: number }>;
};

/**
 * ประกอบ snapshot ให้ครบตาม baseline
 *
 * รายการที่ baseline บังคับ: pricing plan เต็มก้อน · rounding policy · PromptPay ID ·
 * ราคาคอร์ท/ลูก (อยู่ใน `pricing_plan.params`) · cancellation policy · skill scale ·
 * `snapshot_version`
 */
function pricingParamsToJson(plan: SnapshotPricingPlan): Record<string, string> {
  switch (plan.type) {
    case 'flat_rate':
      return flatRateToJson(plan.flatRate);
    case 'court_plus_shuttle':
      return courtPlusShuttleToJson(plan.courtPlusShuttle);
    case 'monthly':
      // ยังไม่ implement (WO-2.5-C) — แต่ห้ามแช่แข็ง params เปล่าเงียบๆ
      throw new Error('ยังสร้าง snapshot ของแผนราคาแบบรายเดือนไม่ได้ (WO-2.5-C)');
  }
}

export function buildSnapshot(input: BuildSnapshotInput): SessionSnapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    pricing_plan: {
      id: input.pricingPlan.id,
      name: input.pricingPlan.name,
      type: input.pricingPlan.type,
      params: pricingParamsToJson(input.pricingPlan),
      monthly_member_pays_shuttle: input.monthlyMemberPaysShuttle ?? true,
    },
    rounding_policy: roundingToJson(input.roundingPolicy),
    promptpay_id: input.promptpayId,
    cancellation_policy: cancellationToJson(input.cancellationPolicy),
    // เรียงตาม rank ให้ผลลัพธ์คงที่ — snapshot ที่ต่างกันแค่ลำดับ array อ่านยากเวลา diff
    skill_levels: [...input.skillLevels].sort((a, b) => a.rank - b.rank),
  };
}

/** ตรวจว่า snapshot ที่อ่านมาใช้การได้ — ใช้ตอน billing เพื่อ fail เร็วแทนที่จะคิดเงินผิด */
export function assertUsableSnapshot(snapshot: unknown): asserts snapshot is SessionSnapshot {
  const s = snapshot as Partial<SessionSnapshot> | null;

  if (!s || typeof s !== 'object') {
    throw new Error('snapshot ว่างหรือไม่ใช่ object — คิดเงินไม่ได้');
  }
  if (typeof s.snapshot_version !== 'number') {
    throw new Error('snapshot ไม่มี snapshot_version — ไม่รู้ว่าต้องอ่านด้วย schema ไหน');
  }
  if (s.snapshot_version > SNAPSHOT_VERSION) {
    // นัดที่สร้างด้วยโค้ดใหม่กว่า — เกิดได้ตอน rollback deploy
    throw new Error(
      `snapshot version ${s.snapshot_version} ใหม่กว่าที่โค้ดนี้รู้จัก (${SNAPSHOT_VERSION})`,
    );
  }
  if (!s.pricing_plan) {
    throw new Error('snapshot ไม่มี pricing_plan — คิดเงินไม่ได้');
  }
}
