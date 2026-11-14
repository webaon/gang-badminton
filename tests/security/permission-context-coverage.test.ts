/**
 * R-roles-3 — inventory AND wiring-verification of every tenant-authorization
 * call site that uses `can()`/`assertCan()`. Started as a Task 1 drift
 * detector (classification only); since Phase 2 (Task 4-6) it ALSO asserts
 * every non-exempt tenant+delegable site's FILE actually calls
 * `loadGangPermissionContext(` — i.e. "every tenant site passes through
 * context", not just "is inventoried". This is still not a style rule:
 * it does not prescribe import spelling or match comments — it finds every
 * real `assertCan(`/`can({` call in app/ and server/ by brace-matching the
 * call expression, then cross-checks it against a hand-reviewed manifest.
 *
 * RED here means one of two things, and the message says which:
 *   - a new call site exists that the manifest doesn't know about yet, or
 *   - a manifest entry's call site moved/disappeared (line shifted, refactor).
 * Either way: update MANIFEST in the same change that touches the guard site.
 *
 * Classification (plan docs/plans/r-roles-3-server-permission-context.md Task 1):
 *   tenant  — authorization is scoped to one gang (roleInGang / inline membership read)
 *   self    — the action only concerns the caller's own resource (no delegation possible)
 *   org     — not currently used server-side: grep confirms no server action passes
 *             `orgRole` into `can()`/`assertCan()` today. Org-admin elevation only
 *             happens through RLS (`is_gang_admin()`); this is a pre-existing gap,
 *             out of scope for this WO, recorded here so it is not silently assumed.
 *   public  — reserved; no current call site needs public classification (every
 *             assertCan/can call site requires an authenticated actor already).
 *   ui      — Server Component page gating (redirect-only). Explicitly OUT of
 *             Phase 2 scope ("ห้าม UI"); loader wiring here is a separate, future WO.
 *
 * `delegable` says whether Phase 2 must eventually pass `extra` at this site:
 *   true     — the action (or every candidate of a dynamic action) is in
 *              DELEGABLE_ACTIONS; a scheduler/treasurer/custom bundle could pass here today.
 *   false    — never-delegable or self-only; passing `extra` here is a no-op by design.
 *   'mixed'  — a dynamic (ternary/parameter) action whose candidates include BOTH a
 *              delegable and a non-delegable action. The loader is still useful here
 *              because the delegable branch needs it; the non-delegable branch doesn't.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ACTIONS } from '@/domain/permissions/types';
import { DELEGABLE_ACTIONS, NEVER_DELEGABLE_ACTIONS } from '@/domain/permissions/delegable';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);
const DELEGABLE_SET: ReadonlySet<string> = new Set(DELEGABLE_ACTIONS);
const NEVER_SET: ReadonlySet<string> = new Set(NEVER_DELEGABLE_ACTIONS);

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** ตัดคอมเมนต์ก่อน scan — เอกสาร (`// ...`, `/* ... *\/`) พูดถึง "can()"/"assertCan()" บ่อย
 *  ในตัวอย่าง แต่ไม่ใช่ call จริง. Naive strip (ไม่รองรับ // ภายใน string literal) พอสำหรับ
 *  source TypeScript จริงของโปรเจกต์นี้ที่ไม่มี URL/regex แบบนั้นในบรรทัดที่มี can(/assertCan(. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

/** ไฟล์ .ts/.tsx ใต้ app/ และ server/ — ที่เดียวที่กฎ CLAUDE.md ถือว่าเป็นด่านความปลอดภัยจริง (server) หรือ UI gate (app) */
function sourceFiles(): string[] {
  const dirs = ['app', 'server'];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = join(dir, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(rel.replace(/\\/g, '/'));
    }
  };
  dirs.forEach(walk);
  return found;
}

type FoundCall = { file: string; line: number; fn: 'assertCan' | 'can'; text: string };

/** หา call ของ `assertCan(` หรือ `can({` ด้วยการนับวงเล็บจริง (เหมือน consoleCalls ของ rate-limit.test.ts) — กัน false negative จาก call หลายบรรทัด */
function findCalls(source: string, file: string): FoundCall[] {
  const calls: FoundCall[] = [];
  // \b กันไม่ให้ match identifier อื่นที่ลงท้ายด้วย "can" (เช่น scan) — assertCan/can ถูก import
  // จาก '@/domain/permissions/can' เท่านั้นในโค้ดนี้ ไม่ต้องบังคับว่า arg แรกเป็น object literal
  // เพราะมี helper เช่น financeReader ที่ส่ง `ctx` เป็นตัวแปรแทน `{ role }` ตรงๆ
  const pattern = /\b(assertCan|can)\(/g;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    const openParenIndex = source.indexOf('(', m.index);
    let depth = 1;
    let i = openParenIndex + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    const text = source.slice(m.index, i);
    const line = source.slice(0, m.index).split('\n').length;
    calls.push({ file, line, fn: m[1] as 'assertCan' | 'can', text });
  }
  return calls;
}

type Category = 'tenant' | 'self' | 'org' | 'public' | 'ui';
type ManifestEntry = {
  file: string;
  line: number;
  fn: 'assertCan' | 'can';
  category: Category;
  actionKind: 'literal' | 'dynamicSet';
  actions: readonly string[];
  delegable: boolean | 'mixed';
  /** ตั้งใจไม่ส่ง extra ของ loader แม้ action เป็น delegable ทั่วไป — เหตุผลอ้างอิงคำตัดสินของ planner (เช่น 'Q2ก') */
  exempt?: string;
  /** cosmetic page-gate ที่ยกไปทำใน WO ฝั่ง frontend แยก (ไม่ใช่ permanent exemption แบบ exempt) — ระบุ WO ที่จะรับช่วง */
  deferred?: string;
  note?: string;
};

/**
 * 🔴 แหล่งเดียวของ inventory ปัจจุบัน — re-grep ใหม่ทุกครั้งที่แตะ guard site
 * (ตามคำสั่ง planner: ห้ามใช้เลขเก่าจากแผน/ADR) แทนที่ตารางนี้เมื่อโค้ดเปลี่ยน
 * ไม่ใช่แก้เทสต์ให้ผ่านโดยไม่ดูว่าของจริงคืออะไร
 */
const MANIFEST: readonly ManifestEntry[] = [
  // ---- server/actions/credit.ts ----
  { file: 'server/actions/credit.ts', line: 98, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['credit.read.self'], delegable: false },
  { file: 'server/actions/credit.ts', line: 113, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['credit.read.self', 'credit.read.other'], delegable: 'mixed', note: 'ternary user.id===userId' },
  { file: 'server/actions/credit.ts', line: 199, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['credit.overpayment.record'], delegable: true },
  { file: 'server/actions/credit.ts', line: 247, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/credit.ts', line: 288, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['credit.topup', 'credit.payout.record'], delegable: true, note: 'creditMovement(action) shared by topUpCredit/payOutCredit' },
  { file: 'server/actions/credit.ts', line: 350, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['credit.return_charge'], delegable: true },

  // ---- server/payments/admin-read.ts (financeReader shared helper — 5 callers pass different actions) ----
  { file: 'server/payments/admin-read.ts', line: 24, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['gang.finance.view', 'credit.read.other', 'payment.verify'], delegable: true, note: 'financeReader(gangId, action=gang.finance.view); callers: finance-report.ts:44, payment-admin.ts:132/199 (default), credit.ts:144 (credit.read.other), payment-admin.ts:64 (payment.verify), payment-list.ts:47 (payment.verify)' },

  // ---- server/actions/billing.ts ----
  { file: 'server/actions/billing.ts', line: 219, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },
  { file: 'server/actions/billing.ts', line: 342, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },

  // ---- server/actions/dashboard.ts (WO-6.5c H10 admin dashboard aggregate loader — can()→null, not assertCan; read-only widget data, no mutation) ----
  { file: 'server/actions/dashboard.ts', line: 109, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true, note: 'unclosedSessionsCount widget — null if missing' },
  { file: 'server/actions/dashboard.ts', line: 114, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['gang.join_request.manage'], delegable: false, note: 'joinRequestsPending widget — NEVER_DELEGABLE' },
  { file: 'server/actions/dashboard.ts', line: 130, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'pendingSlips widget (G2) — combined with :131 via &&; split onto its own line on purpose so this file:line key does not collide with the other half of the gate' },
  { file: 'server/actions/dashboard.ts', line: 131, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true, note: 'pendingSlips widget (G2), other half of the :130 && gate — payment-list.ts (adminPaymentList) reads session_charges which also needs finance.view' },
  { file: 'server/actions/dashboard.ts', line: 185, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true, note: 'timeline G3 canSeeFinance — payment.*/audit.credit_* events in buildTimeline(); combined with :186 via loadRecentActivity() 2 args, split onto its own line for the same reason as :130/:131' },
  { file: 'server/actions/dashboard.ts', line: 186, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'timeline G3 canSeeOtherAdminOnly — every other adminOnly event type (line.*/gang.join_*/audit.role_* etc); NEVER_DELEGABLE chosen deliberately (is_gang_admin()-equivalent, not role===), reported to planner' },

  // ---- server/actions/announcements.ts ----
  { file: 'server/actions/announcements.ts', line: 31, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['announcement.manage'], delegable: true },

  // ---- server/actions/finance.ts ----
  { file: 'server/actions/finance.ts', line: 33, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.finance.manage'], delegable: true },

  // ---- server/actions/game-console.ts (scheduler preset's core surface) ----
  { file: 'server/actions/game-console.ts', line: 78, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 108, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.no_show'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 139, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 183, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 287, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 340, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 384, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 421, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true, note: 'guarded by `if (!isMine)` — self check-in bypasses this' },
  { file: 'server/actions/game-console.ts', line: 470, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },

  // ---- server/actions/gang-config.ts (shared assertGangAdmin helper — never-delegable actions only) ----
  { file: 'server/actions/gang-config.ts', line: 44, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['gang.skill.manage', 'gang.pricing.manage'], delegable: false, note: 'assertGangAdmin(gangId, action); callers: :60/:95 gang.skill.manage, :137 gang.pricing.manage' },

  // ---- server/actions/gangs.ts ----
  { file: 'server/actions/gangs.ts', line: 111, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.update'], delegable: false, note: 'NEVER_DELEGABLE (gang.update)' },

  // ---- server/actions/line.ts ----
  { file: 'server/actions/line.ts', line: 47, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.line.manage'], delegable: false, note: 'NEVER_DELEGABLE (gang.line.manage)' },
  { file: 'server/actions/line.ts', line: 408, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['line.link.self'], delegable: false },

  // ---- server/actions/members.ts ----
  { file: 'server/actions/members.ts', line: 49, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 78, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 153, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['gang.leave.self'], delegable: false },
  { file: 'server/actions/members.ts', line: 212, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.ownership.transfer'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 242, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },

  // ---- server/actions/membership.ts ----
  { file: 'server/actions/membership.ts', line: 59, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.pricing.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/membership.ts', line: 111, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/membership.ts', line: 150, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },

  // ---- server/actions/payments.ts ----
  { file: 'server/actions/payments.ts', line: 50, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },
  { file: 'server/actions/payments.ts', line: 184, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/payments.ts', line: 228, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'slipSignedUrl(): OR-ed with isOwner — was a hardcoded [\'owner\',\'admin\'].includes(role) bypass of can(), fixed per planner decision 3 (treasurer with delegated payment.verify can now see slips too)' },
  { file: 'server/actions/payments.ts', line: 269, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },
  { file: 'server/actions/payments.ts', line: 272, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'guarded by `if (payer !== user.id)` — paying for self bypasses this' },
  { file: 'server/actions/payments.ts', line: 317, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/payments.ts', line: 469, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },

  // ---- server/actions/registrations.ts ----
  { file: 'server/actions/registrations.ts', line: 49, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['registration.create.self'], delegable: false },
  { file: 'server/actions/registrations.ts', line: 76, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.create.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 127, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['registration.cancel.self', 'registration.cancel.other'], delegable: 'mixed', note: 'ternary isSelf' },
  { file: 'server/actions/registrations.ts', line: 132, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.cancel.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 141, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.promote.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 195, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['registration.cancel.self', 'registration.cancel.other'], delegable: 'mixed', note: 'ternary reg.user_id===user.id' },
  { file: 'server/actions/registrations.ts', line: 242, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.promote.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 278, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.invite.manage'], delegable: true, note: 'feature-gated on features.guests' },

  // ---- server/actions/reports.ts ----
  { file: 'server/actions/reports.ts', line: 44, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.update'], delegable: false, note: 'NEVER_DELEGABLE (gang.update) — recomputeGangStatistics gates on gang.update, not statistics.view.all; pre-existing, not changed by this WO' },

  // ---- server/actions/sessions.ts ----
  { file: 'server/actions/sessions.ts', line: 52, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true },
  { file: 'server/actions/sessions.ts', line: 133, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.transition'], delegable: true },
  { file: 'server/actions/sessions.ts', line: 198, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true },

  // ---- server/actions/templates.ts — ตั้งใจไม่ delegate ตามคำตัดสิน Q2ก ของ planner (ADR-015):
  //      scheduler preset จัดการได้แค่นัดเดี่ยว ไม่ใช่ "นัดประจำ/เทมเพลต" — แม้ session.create/update
  //      จะเป็น delegable action โดยทั่วไป ที่นี่ต้องค้างอยู่ที่ role ฐานเดิมเท่านั้น (ห้ามส่ง extra)
  //      จนกว่า action ใหม่ session.template.manage (ไม่ delegable) จะถูก migrate เข้ามาแทน — ดู BACKLOG/R-roles-4
  { file: 'server/actions/templates.ts', line: 78, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true, exempt: 'Q2ก', note: 'intentionally not delegated — ค้างที่ role ฐาน, ยังไม่มี session.template.manage' },
  { file: 'server/actions/templates.ts', line: 114, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true, exempt: 'Q2ก', note: 'intentionally not delegated — ค้างที่ role ฐาน, ยังไม่มี session.template.manage' },
  { file: 'server/actions/templates.ts', line: 156, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true, exempt: 'Q2ก', note: 'intentionally not delegated — ค้างที่ role ฐาน, ยังไม่มี session.template.manage' },
  { file: 'server/actions/templates.ts', line: 187, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true, exempt: 'Q2ก', note: 'intentionally not delegated — ค้างที่ role ฐาน, ยังไม่มี session.template.manage' },

  // ---- server/actions/discovery.ts ----
  { file: 'server/actions/discovery.ts', line: 160, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.join_request.manage'], delegable: false, note: 'NEVER_DELEGABLE; feature-gated on features.discovery' },

  // ---- server/sessions/console-loader.ts — shared loader behind console/page.tsx + console/board/page.tsx ----
  { file: 'server/sessions/console-loader.ts', line: 60, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true, note: 'real gate: denies loading admin.rpc(session_console_queue) service-role data, not cosmetic' },
  { file: 'server/sessions/console-loader.ts', line: 139, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['billing.close'], delegable: true, note: 'cosmetic canClose flag only — real enforcement is membership.ts:150 on the /close route per the file\'s own comment' },

  // ---- server/actions/payment-admin.ts — can() used as read-only eligibility hints on an
  //      already financeReader()-gated response (same pattern as console-loader.ts:147);
  //      NOT a security gate on its own — enforcement is financeReader's assertCan at
  //      admin-read.ts:27, DB still rejects on the real write call regardless of this hint. ----
  { file: 'server/actions/payment-admin.ts', line: 102, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (setReceivedAmount); real gate is financeReader at line64' },
  { file: 'server/actions/payment-admin.ts', line: 103, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (verify)' },
  { file: 'server/actions/payment-admin.ts', line: 104, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (reject)' },
  { file: 'server/actions/payment-admin.ts', line: 105, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['credit.overpayment.record'], delegable: true, note: 'eligibility hint (recordOverpayment)' },
  { file: 'server/actions/payment-admin.ts', line: 213, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['credit.return_charge'], delegable: true, note: 'eligibility hint (canReturn) — comment says "no client-side money ceiling", DB still caps it' },

  // ---- app/ pages — UI gate only (redirect-on-deny). OUT of Phase-2 loader scope ("ห้าม UI").
  //      planner decision (frontend conflict with 6.6a): defer all 11 non-templates sites to a
  //      future frontend WO (6.6a/6.6b/R-roles-4 UI) — NOT a permanent exemption like templates.ts'
  //      Q2ก, just "not in THIS WO". docs will track the BACKLOG item (commit e902771). ----
  { file: 'app/gangs/[gangId]/join-requests/page.tsx', line: 47, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.join_request.manage'], delegable: false, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/announcements/page.tsx', line: 48, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['announcement.view'], delegable: false, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/announcements/page.tsx', line: 81, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['announcement.manage'], delegable: true, deferred: 'frontend-page-gate', note: 'extra not passed yet; scheduler-visible "manage" UI is future UI work, not this WO' },
  { file: 'app/gangs/[gangId]/templates/page.tsx', line: 41, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['session.create'], delegable: true, exempt: 'Q2ก', note: 'same intentional non-delegation as server/actions/templates.ts' },
  { file: 'server/gangs/members-loader.ts', line: 20, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'WO-6.6a page gate moved to server-only loader and wired to permission context' },
  { file: 'server/gangs/settings-loader.ts', line: 24, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.update'], delegable: false, note: 'WO-6.6a page gate moved to server-only loader and wired to permission context' },
  { file: 'app/gangs/[gangId]/liff/page.tsx', line: 57, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['line.link.self'], delegable: false, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/stats/page.tsx', line: 50, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['statistics.view'], delegable: false, deferred: 'frontend-page-gate', note: 'self-view, not statistics.view.all' },
  { file: 'app/gangs/[gangId]/stats/page.tsx', line: 102, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/membership/page.tsx', line: 57, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/membership/page.tsx', line: 148, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['billing.close'], delegable: true, deferred: 'frontend-page-gate' },
  { file: 'app/gangs/[gangId]/sessions/[sessionId]/scan/page.tsx', line: 61, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['registration.checkin'], delegable: true, deferred: 'frontend-page-gate' },
];

function byKey(e: { file: string; line: number }): string {
  return `${e.file}:${e.line}`;
}

describe('R-roles-3 — guard-site inventory + Phase-2 wiring verification (no DB)', () => {
  const files = sourceFiles();
  const actual: FoundCall[] = files.flatMap((f) => findCalls(stripComments(read(f)), f));
  const actualByKey = new Map(actual.map((c) => [byKey(c), c]));
  const manifestByKey = new Map(MANIFEST.map((e) => [byKey(e), e]));

  it('🔴 every real assertCan()/can() call site in app/+server/ is in MANIFEST at its exact line', () => {
    const unknown = actual.filter((c) => !manifestByKey.has(byKey(c)));
    expect(
      unknown.map((c) => `${byKey(c)} [${c.fn}] ${c.text.slice(0, 80).replace(/\s+/g, ' ')}…`),
      'พบ call site ใหม่ที่ไม่มีใน MANIFEST — เพิ่มแถวใหม่ในไฟล์นี้พร้อม category/delegable ก่อน',
    ).toEqual([]);
  });

  it('🔴 every MANIFEST entry still points at a real assertCan()/can() call at that exact line', () => {
    const stale = MANIFEST.filter((e) => !actualByKey.has(byKey(e)));
    expect(
      stale.map((e) => byKey(e)),
      'MANIFEST มี entry ที่ไม่มี call จริงที่บรรทัดนั้นแล้ว (ย้าย/ลบ/รีแฟคเตอร์) — re-grep แล้วแก้เลขให้ตรง',
    ).toEqual([]);
  });

  it('🔴 every MANIFEST entry matches the real fn (assertCan vs can) at that line', () => {
    const mismatched = MANIFEST.filter((e) => actualByKey.get(byKey(e))?.fn !== e.fn);
    expect(mismatched.map((e) => byKey(e))).toEqual([]);
  });

  it('literal actions in MANIFEST are real members of ACTIONS (catches typos without hitting DB)', () => {
    for (const e of MANIFEST) {
      for (const a of e.actions) {
        expect(ACTION_SET.has(a), `${byKey(e)} action "${a}"`).toBe(true);
      }
    }
  });

  it('delegable=true/mixed entries actually have a delegable candidate; delegable=false entries have none', () => {
    for (const e of MANIFEST) {
      const anyDelegable = e.actions.some((a) => DELEGABLE_SET.has(a));
      const allDelegable = e.actions.every((a) => DELEGABLE_SET.has(a));
      if (e.delegable === false) {
        expect(anyDelegable, `${byKey(e)} marked delegable:false but has a delegable action`).toBe(false);
      } else if (e.delegable === true) {
        expect(allDelegable, `${byKey(e)} marked delegable:true but not every action is delegable`).toBe(true);
      } else {
        expect(anyDelegable && !allDelegable, `${byKey(e)} marked mixed but isn't actually mixed`).toBe(true);
      }
    }
  });

  it('never-delegable actions used here are still exactly NEVER_DELEGABLE_ACTIONS (escalation list didn\'t silently shrink)', () => {
    const usedNonDelegable = new Set(
      MANIFEST.flatMap((e) => e.actions).filter((a) => !DELEGABLE_SET.has(a) && a !== 'payment.submit.self'
        && a !== 'credit.read.self' && a !== 'registration.create.self' && a !== 'registration.cancel.self'
        && a !== 'gang.leave.self' && a !== 'line.link.self' && a !== 'statistics.view' && a !== 'announcement.view'),
    );
    for (const a of usedNonDelegable) expect(NEVER_SET.has(a), a).toBe(true);
  });

  it('no server/app call site passes orgRole today (pre-existing gap — not fixed by this WO, just tracked)', () => {
    const orgRoleSites = actual.filter((c) => /orgRole/.test(c.text));
    expect(orgRoleSites.map((c) => byKey(c))).toEqual([]);
  });

  it('category counts summary (informational — change expected numbers when the manifest changes on purpose)', () => {
    const byCategory = (cat: Category) => MANIFEST.filter((e) => e.category === cat).length;
    expect({
      tenant: byCategory('tenant'),
      self: byCategory('self'),
      org: byCategory('org'),
      public: byCategory('public'),
      ui: byCategory('ui'),
      total: MANIFEST.length,
    }).toEqual({ tenant: 56, self: 7, org: 0, public: 0, ui: 18, total: 81 });
  });

  it('Phase-2 scope: tenant-category sites needing the loader (delegable true/mixed, excluding Q2ก-exempt templates.ts)', () => {
    const needsLoader = MANIFEST.filter(
      (e) => e.category === 'tenant' && e.delegable !== false && !e.exempt,
    );
    expect(needsLoader.length).toBe(39);
  });

  it('🔴 every tenant site needing the loader is ACTUALLY wired — not just classified (Phase 2 done, not just inventoried)', () => {
    const needsLoader = MANIFEST.filter(
      (e) => e.category === 'tenant' && e.delegable !== false && !e.exempt,
    );
    const filesNeedingWiring = Array.from(new Set(needsLoader.map((e) => e.file)));
    const unwired = filesNeedingWiring.filter((f) => !read(f).includes('loadGangPermissionContext('));
    expect(
      unwired,
      'ไฟล์เหล่านี้มี tenant site ที่ควรส่ง extra จาก loader แล้ว แต่ source ไม่มี loadGangPermissionContext( เลย — ยังไม่ wire จริง',
    ).toEqual([]);
  });

  it('templates.ts (Q2ก-exempt) is intentionally NOT wired to the loader — must stay on plain role only', () => {
    const exempt = MANIFEST.filter((e) => e.exempt === 'Q2ก' && e.category === 'tenant');
    expect(exempt.map((e) => e.file)).toEqual(['server/actions/templates.ts', 'server/actions/templates.ts', 'server/actions/templates.ts', 'server/actions/templates.ts']);
    // ถ้าวันหนึ่งมีคนไปเพิ่ม loadGangPermissionContext( ใน templates.ts โดยไม่ได้ตั้งใจแก้ exempt นี้ด้วย
    // (เช่น refactor ปนกับไฟล์ที่ wire แล้ว) นี่คือสัญญาณให้ตรวจว่า extra รั่วไปให้ scheduler หรือยัง (Q2ก)
    expect(
      read('server/actions/templates.ts').includes('loadGangPermissionContext('),
      'templates.ts เริ่มมี loadGangPermissionContext( แล้ว — ตรวจด่วนว่า assertCan ที่ :78/114/156/187 ยังไม่ส่ง extra ให้ scheduler (ละเมิด Q2ก ถ้าส่ง)',
    ).toBe(false);
  });

  it('remaining app page-gate sites are deferred; WO-6.6a members/settings moved to wired loaders', () => {
    const deferred = MANIFEST.filter((e) => e.deferred === 'frontend-page-gate');
    expect(deferred.length).toBe(9);
    for (const file of ['server/gangs/members-loader.ts', 'server/gangs/settings-loader.ts']) {
      expect(MANIFEST.some(e => e.file === file && !e.deferred)).toBe(true);
      expect(stripComments(read(file))).toContain('loadGangPermissionContext(gangId, user.id)');
      expect(stripComments(read(file))).toMatch(/can\(ctx,/);
    }
    for (const e of deferred) expect(e.file.startsWith('app/'), e.file).toBe(true);
    // templates.ts page คนละเหตุผล (Q2ก ถาวร) — ต้องไม่ถูกแตะโดย flag ชั่วคราวนี้
    expect(deferred.some((e) => e.file.includes('templates/page.tsx'))).toBe(false);
  });
});
