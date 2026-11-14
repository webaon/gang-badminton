# WO-6.5c dashboard UI — owner verification

Runtime performed 2026-11-14 after planner explicitly granted exclusive DB/.next use. Slot returned immediately after the full suite completed. No push or deploy.

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
