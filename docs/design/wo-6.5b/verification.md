# WO-6.5b — verification handoff (not final QA approval)

## Current status

Implementation is committed at `1dfaa0911c35f35f68a8c2d532153aa0fc4bcce5`. A follow-up tightens wallet textbox locators to match the complete Thai required-field name, preserving every existing assertion. No push or deployment has been performed; independent QA acceptance remains pending.

### Latest approved re-verification after locator tightening

- Owner permission, relayed by planner, lifted shared-local test HOLD for WO-6.5b only; cards 17–19 remain excluded.
- Planner explicitly accepted the existing self-name-absent assertion instead of the proposed self-topup mutation/error-detail case. The uncommitted draft case was removed under that decision; no backend/i18n change was made.
- Default Turbopack build: PASS, exit 0 (`wo65b-approved-recheck-build.log`); no webpack fallback.
- Typecheck/lint and `git diff --check`: PASS, exit 0.
- Focused wallet: 1/1 PASS, 8.4 seconds (`wo65b-approved-wallet.log`).
- Full Playwright: 62/62 PASS, 3.2 minutes, exit 0 (`wo65b-approved-full.log`). The log also contains a WebServer `The destination stream closed early` diagnostic; all tests completed successfully.
- Build/DB lane released and planner notified immediately after completion. No further test run is scheduled by frontend.
- `wallet-locators.patch` records old-to-new changes: anchored label prefix becomes anchored full label requiring `จำเป็น`; only whitespace between label and suffix is flexible. Amount, history, ledger and self-name absence assertions are unchanged.
- Unit 625 passed/1 skipped is earlier implementation evidence, not a new unit run for this locator-only change.

### Verified before the latest contrast edit

- Default production build (Turbopack): PASS after planner-authorized `.next` deletion; another default build also passed without another deletion.
- Focused wallet + states: 16/16 PASS, 24.1 seconds.
- Full Playwright: 62/62 PASS, 3.3 minutes.
- No webpack build, mock font, font/config/package/framework change was used to obtain these results.

### Verified after the latest contrast edit

- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run test:unit`: 625 passed, 1 skipped, 40 test files passed.
- Fresh default production build (Turbopack): PASS, exit 0. No webpack fallback used.
- Focused admin-payment-review + wallet: 3/3 PASS, 19.5 seconds; includes text contrast >=4.5 for enabled wallet controls and the report-range link in light/dark modes.
- Full Playwright: 62/62 PASS, 3.3 minutes, exit 0.
- Regenerated wallet and reports 390px dark screenshots inspected: visible controls readable, no horizontal overflow.
- Independent pre-contrast static review completion record: passed=true, security_concerns=[], logic_errors=[]; non-blocking suggestion to add an explicit ledger reconciliation control. Latest contrast-only edit is covered by typecheck/lint/unit/build/browser checks and remains for final QA review.

### Remaining gates

- Planner notified that the exclusive `.next` / shared test-DB slot is released after the successful final run.
- Commit only the explicitly scoped WO-6.5b files; do not use `git add -A`, push, or deploy.
- Final QA acceptance remains pending, including review of assertion diffs and the known former-member name limitation.

## Assertion changes for QA

- `pay-flow-assertions.patch`: replaces the legacy admin-button interaction with queue → payment detail → received-amount confirmation → verification confirmation. The original verified-state assertion is preserved verbatim. Adds queue-heading and equal-received-amount assertions. Member-side assertions remain unchanged.
- `states-assertions.patch`: narrows the original report-entry date locator to the exact textbox named `วันที่`. Visibility, bounding-box existence, and right-edge bounds assertions remain unchanged. This avoids collisions with the new report-range date controls.
- New wallet test checks reason-required confirmation, zero writes before confirmation, uncertain-write recovery without replay, exactly one top-up, former-member payout with a DB assertion for the specific user ID, and signed history. Self top-up is excluded from the UI and fixture because the DB prohibits it for every role (B5b-3).
- Wallet locators account for Astryx's localized required-label suffix. The negative amount assertion is `-฿10.00`, matching the existing `baht()` formatter; it is not an unsigned or partial-text assertion.

## Known loader limitation

`listGangCredits` uses an RLS-constrained profile join and supplies `ไม่ทราบชื่อ` when a former member's profile is not visible. The former member remains present and payout works by user ID. The browser fixture selects the returned fallback label and verifies the resulting balance against the former member's exact ID. The name limitation has been reported to the planner; no backend policy/query workaround has been introduced in this UI work.

## Build investigation and interrupted test runs

The original default-build failure reported 12 font-loader errors in generated `noto_sans_thai_198afa3c.module.css`, at 8:8, 18:8, 28:8, 38:8, 48:8, 58:8, 68:8, 78:8, 88:8, 98:8, 108:8 and 118:8. Each reported an unresolved `@vercel/turbopack-next/internal/font/google/font` and `next/font/google queries have exactly one entry`. The symptom disappeared after the authorized `.next` deletion; the internal cache/root cause has not been proven.

A foreground Playwright call timed out before its per-test timeout. An owned orphan Next listener remained on port 3210 and later HTTP probes timed out. Ownership was checked using PID, command and creation time; the owned listener was stopped and port vacancy verified. A fresh-server focused suite and full suite subsequently passed. Earlier interrupted/failing runs are not described as passes or assumed flakes.

## Local evidence logs

Directory: `C:/Users/peepe/.hermes/profiles/gb-frontend/cache/scratch/`

- `wo65b-exclusive-build.log`: original default-build failure, including all 12 error locations.
- `wo65b-clean-build.log`: default build PASS after authorized cleanup.
- `wo65b-fixed-build.log`: subsequent default build PASS.
- `wo65b-fresh-focused.log`: focused 16/16 PASS before contrast edit.
- `wo65b-fresh-full.log`: full 62/62 PASS before contrast edit.

- `wo65b-contrast-build.log`: final default build PASS after contrast edit.
- `wo65b-contrast-focused.log`: final focused 3/3 PASS, including contrast checks and regenerated screenshots.
- `wo65b-contrast-full.log`: final full 62/62 PASS after contrast edit.

The final logs above, not older interrupted runs, establish verification of the submitted contrast edit.
