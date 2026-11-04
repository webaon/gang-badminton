/**
 * R-roles-3 Task 1 — frozen inventory of every tenant-authorization call site
 * that uses `can()`/`assertCan()`, BEFORE the server-only permission-context
 * loader is wired in (Phase 2). This is a drift detector, not a style rule:
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
  note?: string;
};

/**
 * 🔴 แหล่งเดียวของ inventory ปัจจุบัน — re-grep ใหม่ทุกครั้งที่แตะ guard site
 * (ตามคำสั่ง planner: ห้ามใช้เลขเก่าจากแผน/ADR) แทนที่ตารางนี้เมื่อโค้ดเปลี่ยน
 * ไม่ใช่แก้เทสต์ให้ผ่านโดยไม่ดูว่าของจริงคืออะไร
 */
const MANIFEST: readonly ManifestEntry[] = [
  // ---- server/actions/credit.ts ----
  { file: 'server/actions/credit.ts', line: 111, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['credit.read.self'], delegable: false },
  { file: 'server/actions/credit.ts', line: 126, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['credit.read.self', 'credit.read.other'], delegable: 'mixed', note: 'ternary user.id===userId' },
  { file: 'server/actions/credit.ts', line: 212, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['credit.overpayment.record'], delegable: true },
  { file: 'server/actions/credit.ts', line: 260, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/credit.ts', line: 301, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['credit.topup', 'credit.payout.record'], delegable: true, note: 'creditMovement(action) shared by topUpCredit/payOutCredit' },
  { file: 'server/actions/credit.ts', line: 363, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['credit.return_charge'], delegable: true },

  // ---- server/payments/admin-read.ts (financeReader shared helper — 5 callers pass different actions) ----
  { file: 'server/payments/admin-read.ts', line: 27, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['gang.finance.view', 'credit.read.other', 'payment.verify'], delegable: true, note: 'financeReader(gangId, action=gang.finance.view); callers: finance-report.ts:44, payment-admin.ts:132/199 (default), credit.ts:144 (credit.read.other), payment-admin.ts:64 (payment.verify), payment-list.ts:47 (payment.verify)' },

  // ---- server/actions/billing.ts ----
  { file: 'server/actions/billing.ts', line: 229, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },
  { file: 'server/actions/billing.ts', line: 361, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },

  // ---- server/actions/announcements.ts ----
  { file: 'server/actions/announcements.ts', line: 41, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['announcement.manage'], delegable: true },

  // ---- server/actions/finance.ts ----
  { file: 'server/actions/finance.ts', line: 43, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.finance.manage'], delegable: true },

  // ---- server/actions/game-console.ts (scheduler preset's core surface) ----
  { file: 'server/actions/game-console.ts', line: 84, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 114, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.no_show'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 145, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 189, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 293, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 346, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 390, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true },
  { file: 'server/actions/game-console.ts', line: 427, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true, note: 'guarded by `if (!isMine)` — self check-in bypasses this' },
  { file: 'server/actions/game-console.ts', line: 476, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },

  // ---- server/actions/gang-config.ts (shared assertGangAdmin helper — never-delegable actions only) ----
  { file: 'server/actions/gang-config.ts', line: 44, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['gang.skill.manage', 'gang.pricing.manage'], delegable: false, note: 'assertGangAdmin(gangId, action); callers: :60/:95 gang.skill.manage, :137 gang.pricing.manage' },

  // ---- server/actions/gangs.ts ----
  { file: 'server/actions/gangs.ts', line: 111, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.update'], delegable: false, note: 'NEVER_DELEGABLE (gang.update)' },

  // ---- server/actions/line.ts ----
  { file: 'server/actions/line.ts', line: 47, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.line.manage'], delegable: false, note: 'NEVER_DELEGABLE (gang.line.manage)' },
  { file: 'server/actions/line.ts', line: 408, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['line.link.self'], delegable: false },

  // ---- server/actions/members.ts ----
  { file: 'server/actions/members.ts', line: 47, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 76, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 149, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['gang.leave.self'], delegable: false },
  { file: 'server/actions/members.ts', line: 197, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.ownership.transfer'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/members.ts', line: 227, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },

  // ---- server/actions/membership.ts ----
  { file: 'server/actions/membership.ts', line: 58, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.pricing.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/membership.ts', line: 110, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false, note: 'NEVER_DELEGABLE' },
  { file: 'server/actions/membership.ts', line: 149, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['billing.close'], delegable: true },

  // ---- server/actions/payments.ts ----
  { file: 'server/actions/payments.ts', line: 62, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },
  { file: 'server/actions/payments.ts', line: 196, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/payments.ts', line: 279, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },
  { file: 'server/actions/payments.ts', line: 282, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'guarded by `if (payer !== user.id)` — paying for self bypasses this' },
  { file: 'server/actions/payments.ts', line: 327, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['payment.verify'], delegable: true },
  { file: 'server/actions/payments.ts', line: 479, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['payment.submit.self'], delegable: false },

  // ---- server/actions/registrations.ts ----
  { file: 'server/actions/registrations.ts', line: 58, fn: 'assertCan', category: 'self', actionKind: 'literal', actions: ['registration.create.self'], delegable: false },
  { file: 'server/actions/registrations.ts', line: 85, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.create.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 144, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['registration.cancel.self', 'registration.cancel.other'], delegable: 'mixed', note: 'ternary isSelf' },
  { file: 'server/actions/registrations.ts', line: 149, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.cancel.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 158, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.promote.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 220, fn: 'assertCan', category: 'tenant', actionKind: 'dynamicSet', actions: ['registration.cancel.self', 'registration.cancel.other'], delegable: 'mixed', note: 'ternary reg.user_id===user.id' },
  { file: 'server/actions/registrations.ts', line: 275, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['registration.promote.other'], delegable: true },
  { file: 'server/actions/registrations.ts', line: 314, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.invite.manage'], delegable: true, note: 'feature-gated on features.guests' },

  // ---- server/actions/reports.ts ----
  { file: 'server/actions/reports.ts', line: 44, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.update'], delegable: false, note: 'NEVER_DELEGABLE (gang.update) — recomputeGangStatistics gates on gang.update, not statistics.view.all; pre-existing, not changed by this WO' },

  // ---- server/actions/sessions.ts ----
  { file: 'server/actions/sessions.ts', line: 65, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true },
  { file: 'server/actions/sessions.ts', line: 146, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.transition'], delegable: true },
  { file: 'server/actions/sessions.ts', line: 211, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true },

  // ---- server/actions/templates.ts — BLOCKING decision pending (ADR-015/R-roles-3 plan §Task5):
  //      planner decided these four should become a new nondelegable session.template.manage;
  //      current code still literally checks session.create/update, so a naive loader wire-up
  //      would wrongly let the scheduler preset manage recurring templates (Q2ก violation).
  //      DO NOT pass extra at these four sites in Phase 2 until that action/migration lands.
  { file: 'server/actions/templates.ts', line: 78, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true, note: 'BLOCKED for Phase 2: pending session.template.manage decision' },
  { file: 'server/actions/templates.ts', line: 114, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true, note: 'BLOCKED for Phase 2: pending session.template.manage decision' },
  { file: 'server/actions/templates.ts', line: 156, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.update'], delegable: true, note: 'BLOCKED for Phase 2: pending session.template.manage decision' },
  { file: 'server/actions/templates.ts', line: 187, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['session.create'], delegable: true, note: 'BLOCKED for Phase 2: pending session.template.manage decision' },

  // ---- server/actions/discovery.ts ----
  { file: 'server/actions/discovery.ts', line: 160, fn: 'assertCan', category: 'tenant', actionKind: 'literal', actions: ['gang.join_request.manage'], delegable: false, note: 'NEVER_DELEGABLE; feature-gated on features.discovery' },

  // ---- server/sessions/console-loader.ts — shared loader behind console/page.tsx + console/board/page.tsx ----
  { file: 'server/sessions/console-loader.ts', line: 68, fn: 'can', category: 'tenant', actionKind: 'literal', actions: ['game.manage'], delegable: true, note: 'real gate: denies loading admin.rpc(session_console_queue) service-role data, not cosmetic' },
  { file: 'server/sessions/console-loader.ts', line: 147, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['billing.close'], delegable: true, note: 'cosmetic canClose flag only — real enforcement is membership.ts:149 on the /close route per the file\'s own comment' },

  // ---- server/actions/payment-admin.ts — can() used as read-only eligibility hints on an
  //      already financeReader()-gated response (same pattern as console-loader.ts:147);
  //      NOT a security gate on its own — enforcement is financeReader's assertCan at
  //      admin-read.ts:27, DB still rejects on the real write call regardless of this hint. ----
  { file: 'server/actions/payment-admin.ts', line: 102, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (setReceivedAmount); real gate is financeReader at line64' },
  { file: 'server/actions/payment-admin.ts', line: 103, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (verify)' },
  { file: 'server/actions/payment-admin.ts', line: 104, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['payment.verify'], delegable: true, note: 'eligibility hint (reject)' },
  { file: 'server/actions/payment-admin.ts', line: 105, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['credit.overpayment.record'], delegable: true, note: 'eligibility hint (recordOverpayment)' },
  { file: 'server/actions/payment-admin.ts', line: 213, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['credit.return_charge'], delegable: true, note: 'eligibility hint (canReturn) — comment says "no client-side money ceiling", DB still caps it' },

  // ---- app/ pages — UI gate only (redirect-on-deny). OUT of Phase-2 loader scope ("ห้าม UI"). ----
  { file: 'app/gangs/[gangId]/join-requests/page.tsx', line: 47, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.join_request.manage'], delegable: false },
  { file: 'app/gangs/[gangId]/announcements/page.tsx', line: 48, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['announcement.view'], delegable: false },
  { file: 'app/gangs/[gangId]/announcements/page.tsx', line: 81, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['announcement.manage'], delegable: true, note: 'extra not passed yet; scheduler-visible "manage" UI is future UI work, not this WO' },
  { file: 'app/gangs/[gangId]/templates/page.tsx', line: 41, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['session.create'], delegable: true, note: 'same pending session.template.manage decision as server/actions/templates.ts' },
  { file: 'app/gangs/[gangId]/members/page.tsx', line: 64, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.member.manage'], delegable: false },
  { file: 'app/gangs/[gangId]/settings/page.tsx', line: 58, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.update'], delegable: false },
  { file: 'app/gangs/[gangId]/liff/page.tsx', line: 57, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['line.link.self'], delegable: false },
  { file: 'app/gangs/[gangId]/stats/page.tsx', line: 50, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['statistics.view'], delegable: false, note: 'self-view, not statistics.view.all' },
  { file: 'app/gangs/[gangId]/stats/page.tsx', line: 102, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true },
  { file: 'app/gangs/[gangId]/membership/page.tsx', line: 57, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['gang.finance.view'], delegable: true },
  { file: 'app/gangs/[gangId]/membership/page.tsx', line: 148, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['billing.close'], delegable: true },
  { file: 'app/gangs/[gangId]/sessions/[sessionId]/scan/page.tsx', line: 61, fn: 'can', category: 'ui', actionKind: 'literal', actions: ['registration.checkin'], delegable: true },
];

function byKey(e: { file: string; line: number }): string {
  return `${e.file}:${e.line}`;
}

describe('R-roles-3 Task 1 — guard-site inventory drift detector (no DB)', () => {
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
    }).toEqual({ tenant: 49, self: 7, org: 0, public: 0, ui: 18, total: 74 });
  });

  it('Phase-2 scope: tenant-category sites needing the loader (delegable true/mixed, excluding the templates.ts block)', () => {
    const needsLoader = MANIFEST.filter(
      (e) => e.category === 'tenant' && e.delegable !== false && !e.note?.includes('BLOCKED for Phase 2'),
    );
    expect(needsLoader.length).toBe(34);
  });
});
