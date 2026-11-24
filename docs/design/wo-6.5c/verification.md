# WO-6.5c dashboard UI — owner verification

## Fresh focused verification after planner's slot extension

Planner extended the slot for the current-member identity fix and a populated dashboard fixture, then requested a fresh build plus focused members/dashboard checks before returning the slot. Planner later confirmed the original full run had no overlapping build; no full rerun is needed (see timing clarification below).

- `currentUserId` now comes from the existing authenticated user in the members loader and is passed to MembersPanel; no new query or permission change.
- Member loader/source tests reproduced the omission (three failing assertions), then passed: 34/34 including permission-context coverage. Typecheck and lint passed.
- Full unit at this point: 717 passed, 1 skipped, 2 failed in backend's uncommitted `tests/domain/leave-gang-error.test.ts` at 131/140 (unknown/empty reason). Those files were not modified by frontend; this is not an all-unit-green claim.
- Fresh default Turbopack build with required env: exit 0, log `wo65c-populated-build.log`.
- Initial focused run: 2 passed, 1 failed due to an incorrect fixture query for `session_charges.user_id`. The helper was corrected to join `session_registrations` via `registration_id`; no application change or weakened assertion.
- Focused rerun: **3/3 passed in 24.2s**, log `wo65c-populated-focused-r2.log`, traces `.playwright/wo65c-populated-r2/`. Includes empty dashboard/outsider case, populated dashboard, and settings/members with the current member's exact name plus `(คุณ)` and only one self label.
- Populated fixture is implemented in `e2e-browser/dashboard-fixture.ts`; it creates an isolated gang, real registrations, charges through the close UI, submitted/verified payments via DB functions, credit, expense, join request and activity. No manual DB patch or mocked dashboard response was used.
- Browser assertions cover all 12 widget headings, 3 members, outstanding ฿150.00, one pending slip, net cash ฿130.00, credit ฿25.00, one pending join request, one unclosed session, next session with two seated players, nonempty activity and cash-flow table ฿150.00 in / ฿20.00 out.
- Four populated screenshots visually inspected: `populated/h10-populated-{390,1280}-{light,dark}.png`. No measured contrast claim. New images complement the empty-state captures below.
- Slot returned immediately after focused rerun completed. No full-suite rerun on this identity-fix snapshot; independent QA acceptance remains pending. Theme freshness issue is assigned to BACKLOG by planner and was not modified.

## Planner clarification: original full-suite evidence remains valid

Planner subsequently corrected the delayed overlap warning: backend's build at `f4aefc3` finished before frontend received the slot at 12:58. Frontend then built again, and no other agent wrote `.next` during its browser run. The earlier potential-contamination qualification is therefore withdrawn on the planner's explicit timing clarification; the observed **64/64 full-suite pass at f4aefc3 remains valid**. No full-suite rerun was requested.

The later identity fix and populated fixture were separately verified by a fresh build and focused members/dashboard 3/3, as recorded above. The original full-suite pass does not claim full-suite coverage of that later identity-fix snapshot.

Runtime performed 2026-11-14 with planner-granted DB/.next ownership. Both requested followups are complete in separate commits: identity fix `37636b875f109cd333185ef62aa8d034b1e29ba8`; populated fixture/spec `2966e57d5d255e0cc8cc80b67ceaac6d0c0f43d6`. Slot returned after the focused run. No push or deploy.

## Snapshot

- UI checkpoint: `7253437a902218abe4e07c3581f4b9ddc41ec700`.
- Actual tested HEAD: `f4aefc382c3eafc437662016aa1a19f2e0696b89` (backend test-only followup after the planner's announced `c159bd3`).
- Tracked tree was clean before and during execution. No application source or assertions changed during verification.
- Default `npm run build`: Next.js 16.3.1 Turbopack, exit 0. Required public and server Supabase env populated in memory from the existing Playwright config; values not printed. No cache cleanup or webpack fallback.
- Landing route remains static/ISR 1h; dashboard is dynamic.

## Real results

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:unit` | 716 passed, 1 skipped; 46 files |
| Dashboard render/source + gang-menu + permission-context coverage | 70/70; 4 files |
| `git diff --check` | exit 0 |
| `npm run build` with required env | exit 0 |
| Focused `dashboard.spec.ts` | 1/1; 7.1s suite, 4.1s test |
| Full Playwright, Chrome channel | 64/64; 3.9m, exit 0 |
| `npm run astryx -- doctor` | 6 passed, 0 warnings/failures, 2 info |
| Theme generated-output `--check` | **FAIL**: CSS/JS/d.ts/variants.d.ts reported stale; not regenerated |

Theme check command: `npm run astryx -- theme build theme/src/badgame.ts --out theme/badgame.css --check`. This matches the existing theme build script with the check flag. Cause not established; theme files are outside this dashboard change and were not modified. Reported to planner; do not treat all gates as green.

The full suite logged `The destination stream closed early`, digest `1286201938`, during console-flow, which nevertheless passed. No causal explanation inferred and no failed browser tests in this run.

## Browser scope and images

Focused test exercises actual sign-up/create-gang, sidebar navigation to `/dashboard`, real dashboard loader/table rendering, zero-session average as em dash, hiding null next-session card, outsider HTTP 404, no horizontal overflow at 390/1280 in both OS color schemes, and watched owner-page CSP/pageerror/hydration assertions.

Four local screenshots, visually inspected:

- `h10-390-light.png`
- `h10-390-dark.png`
- `h10-1280-light.png`
- `h10-1280-dark.png`

These show a newly created gang, genuine zeros and creation activity. They are not populated-state evidence for all 12 widgets. No obvious horizontal clipping observed. Mobile fixed navigation appears partway down the full-page capture because its position is relative to the viewport; no claim that this is a document-positioned bar. Pixel review is not measured contrast or tap-target acceptance.

SSR tests cover null guards, genuine zero display, nonzero average, next-session link/Bangkok time and high-precision amount strings. Browser role-matrix/minimal custom permissions, populated next-session, translated loader failure injection and measured contrast/tap bounds were not newly exercised by this UI spec. Backend role-matrix acceptance remains separate evidence; independent QA acceptance is pending.

## Approved scope deviations

- Six-month cash flow uses Astryx-backed SimpleTable, not a chart. No UI parsing/arithmetic of money. A future chart requires server-computed ratios.
- Next session shows only available title/time/seated/waitlist/guest/court-count fields; no invented capacity, court names or second next session.
- Generic greeting; no user-name query or unsupported revenue comparison.
- Nonfinancial attendance average may divide totalSeated by sessionCount, one decimal; zero denominator shows em dash.
- Menu retains its existing finance permission gate; authoritative page/loader checks remain server-side. A null widget is hidden, never converted to a zero card.

## Local evidence handles

Log directory: `C:/Users/peepe/.hermes/profiles/gb-frontend/cache/scratch/`

- `wo65c-slot-unit.log`
- `wo65c-slot-build.log`
- `wo65c-slot-focused.log`
- `wo65c-slot-full.log`

Focused trace directory: `.playwright/wo65c-focused/`.
Full output directory: `.playwright/wo65c-full/` (trace retained only on failure).
Screenshots: `G:/TON-Workspace/Ton-App/BadGame/gang-badminton/docs/design/wo-6.5c/`.

This report is owner execution evidence, not QA PASS or permission to deploy.
