#!/usr/bin/env bash
#
# Ignored Build Step ของ Vercel — "production ขึ้นได้เฉพาะตอน CI เขียว"
#
# 🔴 กติกา exit code ของ Vercel **กลับหัวจากปกติ**:
#      exit 0 = ยกเลิก build (ข้าม)
#      exit 1 = build ต่อ
#
# เส้นทางที่ตั้งใจให้เป็น:
#   push เข้า main → Vercel เริ่ม build ทันที → สคริปต์นี้เห็นว่า full.yml ยังไม่จบ → ข้าม
#   full.yml เขียว  → deploy job ยิง deploy hook → Vercel build อีกรอบ → เห็น success → ขึ้นจริง
#   full.yml แดง    → ไม่มีใครยิง hook → production ไม่ขยับ (ของเดิมยังอยู่)
#
# ⚠️ preview ไม่ถูกกั้น — จุดประสงค์ของ preview คือเอาไว้เปิดดูก่อน merge
#    (โค้ดที่เทสต์ไม่ผ่านก็ควรเปิดดูได้ ไม่งั้นดูไม่ออกว่าพังตรงไหน)
#
# ⚠️ repo เป็น public ⇒ เรียก GitHub API โดยไม่ต้องมี token (เพดาน 60 req/ชม./IP)
#    ถ้าเรียกไม่สำเร็จจริงๆ เลือก **build ต่อ** ไม่ใช่ข้าม — เพราะ production ที่เงียบ
#    ไม่ยอมขึ้นโดยไม่บอกสาเหตุ เป็นอาการที่แย่กว่าการ deploy commit ที่เทสต์แดงเป็นครั้งคราว
#    (gate นี้มีไว้กันความพลาด ไม่ได้มีไว้กันคนตั้งใจ)

set -uo pipefail

REPO='webaon/gang-badminton'
WORKFLOW='.github/workflows/full.yml'

log() { echo "[ignore-build] $*"; }

if [ "${VERCEL_ENV:-}" != 'production' ]; then
  log "env=${VERCEL_ENV:-?} (ไม่ใช่ production) → build"
  exit 1
fi

SHA="${VERCEL_GIT_COMMIT_SHA:-}"
if [ -z "$SHA" ]; then
  log 'ไม่รู้ commit sha → build (ไม่ปิดกั้นแบบเดาไม่ได้)'
  exit 1
fi

API="https://api.github.com/repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100"

for attempt in 1 2 3; do
  BODY=$(curl -sS --max-time 20 -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null)

  RESULT=$(printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const runs = JSON.parse(s).workflow_runs;
        if (!Array.isArray(runs)) return console.log("unavailable");
        const run = runs
          .filter((r) => r.path === process.argv[1])
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        console.log(run ? `${run.status}:${run.conclusion}` : "none");
      } catch {
        console.log("unavailable");
      }
    });
  ' "$WORKFLOW")

  [ "$RESULT" != 'unavailable' ] && break
  log "เรียก GitHub API ไม่สำเร็จ (ครั้งที่ ${attempt})"
  sleep 3
done

case "$RESULT" in
  completed:success)
    log "CI เขียวสำหรับ ${SHA:0:7} → build"
    exit 1
    ;;
  unavailable)
    log 'อ่านผล CI ไม่ได้เลย → build (fail-open ตามเหตุผลหัวไฟล์)'
    exit 1
    ;;
  none)
    log "ยังไม่มี run ของ full.yml สำหรับ ${SHA:0:7} → ข้าม (รอ deploy hook)"
    exit 0
    ;;
  *)
    log "CI ยังไม่ผ่าน (${RESULT}) → ข้าม"
    exit 0
    ;;
esac
