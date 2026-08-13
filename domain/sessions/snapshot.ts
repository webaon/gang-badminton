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
  flatRateToJson,
  roundingToJson,
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

export type SessionSnapshot = {
  snapshot_version: number;
  pricing_plan: {
    id: string | null;
    name: string;
    type: PricingType;
    params: Record<string, string>;
  };
  rounding_policy: { mode: string; surplus_to: string };
  promptpay_id: string | null;
  cancellation_policy: CancellationPolicyJson;
  skill_levels: Array<{ label: string; rank: number }>;
};

export type BuildSnapshotInput = {
  pricingPlan: {
    id: string | null;
    name: string;
    type: PricingType;
    /** MVP-0 มีแค่ flat_rate (ADR-002) */
    flatRate: FlatRateParams;
  };
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
export function buildSnapshot(input: BuildSnapshotInput): SessionSnapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    pricing_plan: {
      id: input.pricingPlan.id,
      name: input.pricingPlan.name,
      type: input.pricingPlan.type,
      params: flatRateToJson(input.pricingPlan.flatRate),
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
