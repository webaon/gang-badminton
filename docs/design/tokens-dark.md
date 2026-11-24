# Dark tokens — BadGame theme (WO-6.0)

> Tokens v4 (`design/hifi/tokens.css`) มีแต่ชุด light — เจ้าของงานตัดสินให้คง `mode="system"`
> (phase6-redesign-plan §3.1 · C3) ⇒ ชุด dark ด้านล่าง**ออกแบบเพิ่มเอง**ตามกติกาตั้งต้นใน plan §6
> ปรับได้ถ้าเจ้าของงานดู screenshot (`docs/design/wo-6.0/`) แล้วไม่ชอบ — แก้ที่ `theme/src/badgame.ts`
> แล้วรัน `npm run theme:build`

**Source of truth**: `theme/src/badgame.ts` → build เป็น `theme/badgame.{css,js,d.ts}` (commit ผลลัพธ์)
**เทสต์ที่คุมตารางนี้**: `tests/design/theme-tokens.test.ts` (คำนวณ contrast จาก `theme/badgame.css` จริง ทุกครั้งที่รัน)

## 1. ชุดสี light ↔ dark

ทุก token สีเป็นคู่ `light-dark(light, dark)` — Astryx สลับตาม `color-scheme` ของ OS

| บทบาท | Astryx token | light (v4) | dark |
|---|---|---|---|
| พื้นหน้า | `--color-background-body` | `#FCFCFC` surface | `#061525` navy-950 |
| การ์ด / input | `--color-background-card` | `#FFFFFF` card | `#0A1E33` navy-900 |
| พื้นยก (dialog, popover, muted) | `--color-background-surface` · `-popover` · `-muted` | `#FFFFFF` · `#FFFFFF` · `#F0F0F0` | `#0F2944` navy-800 |
| เส้น | `--color-border` | `#E3E3E3` divider | `#173554` navy-700 |
| เส้นเน้น (input) | `--color-border-emphasized` | `#DCDCDC` border-input | `#2A4A6B` |
| ข้อความหลัก | `--color-text-primary` | `#0D0D0D` | `#F2F5F9` |
| ข้อความรอง | `--color-text-secondary` | `#6B6B6B` text-muted | `#AFC0D6` |
| primary (ปุ่ม/จุดสี) | `--color-accent` | `#0169CC` | `#3B8AD6` primary-400 |
| ข้อความ/ไอคอน accent (ลิงก์) | `--color-text-accent` · `-icon-accent` | `#0169CC` | `#80B2E3` primary-300 ¹ |
| ตัวหนังสือบนปุ่ม primary | `--color-on-accent` | `#FFFFFF` | `#061525` ² |
| success | `--color-success` | `#14935F` | `#3FBF86` |
| warning / waitlist (orange) | `--color-warning` | `#E8850A` accent-500 | `#F99A2E` accent-400 |
| error | `--color-error` | `#D93A3F` | `#F0686C` |
| ข้อความสถานะบนพื้นอ่อน | `--color-text-{green,orange,red,blue,gray}` | `#0D6B45` · `#9C5404` · `#A82A2E` · `#0154A3` · `#3D3D3D` (v4 *-ink) | `#7FE0B0` · `#FDB668` · `#FFA3A6` · `#B9D5F2` · `#C9D5E4` |
| พื้นอ่อนของ chip/banner | `--color-background-{green,orange,red,blue,gray}` | `#E7F5EE` · `#FFF6EB` · `#FCECEC` · `#EAF2FB` · `#F0F0F0` | `#0B3A2B` · `#3A2410` · `#3D1A1E` · `#0F2F52` · `#173554` |

¹ plan §6 กำหนด primary-400 เป็น accent ของ dark — ใช้กับ**พื้นปุ่ม**ได้ แต่เมื่อเป็น**ตัวหนังสือบนพื้นยก navy-800**
ได้ 4.08:1 (ไม่ผ่าน 4.5 — ค่าจากเทสต์) จึงแยก `--color-text-accent` ไปใช้ primary-300 `#80B2E3` (6.61:1)
² ขาว (`#FFFFFF`) บน `#3B8AD6` ได้ 3.63:1 (ไม่ผ่าน 4.5 — ค่าจากเทสต์) ⇒ dark ใช้ตัวหนังสือสีเข้ม `#061525` (5.07:1)

**สถานะ "รอ/waitlist" = orange เท่านั้น** — v4 ไม่มีสีเหลือง ⇒ `*-yellow` ของ Astryx (ใช้โดย banner/badge warning)
ถูกชี้ไปค่าเดียวกับ `*-orange`

**ปรับจาก neutral theme (component override ใน theme)**: Badge = chip ของ v4 (พื้นอ่อน + ตัวหนังสือ *-ink)
· Button destructive = `danger-ink` บน `danger-soft` · StatusDot ใช้ค่าเต็มของ token สถานะ ·
radius: ปุ่ม pill / card 16 / input 6 · เงาเป็นเส้นขอบ (dark = เส้นขาวโปร่ง)

## 2. ข้อควรรู้ — ค่า spec v4 ที่ไม่ใช่ "สีข้อความ"

`--color-success` (`#14935F`) · `--color-warning` (`#E8850A`) · `--color-error` (`#D93A3F`) เป็นค่าตาม spec v4
ใช้เป็น**พื้น/จุดสี/ไอคอน**ได้ แต่**ห้ามเอาไปเป็นสีตัวหนังสือบนพื้นขาว**:
`#E8850A` บนขาวได้ 2.70:1 · `#14935F` ได้ 3.91:1 · `#D93A3F` ได้ 4.54:1 (ผ่านเฉยๆ) — ทุกตัวเลขมาจากเทสต์
ข้อความสถานะให้ใช้ `--color-text-green/orange/red` (v4 *-ink) ซึ่งผ่านทุกคู่ — ดูตารางด้านล่าง
(Astryx บางจุด เช่นข้อความ status ของ TextInput อ้าง `--color-warning` เป็นสีตัวหนังสือ — ถ้าเจอใน WO หน้าจอให้แจ้ง)

### คู่ที่ไม่ผ่านโดยตั้งใจ — ห้ามใช้เป็นตัวหนังสือ (ล็อกค่าไว้ใน `KNOWN_FAILS` ของเทสต์)

| โหมด | คู่ | อัตราส่วน | ระดับ | กติกา |
|---|---|---|---|---|
| light | orange `#E8850A` เป็นตัวหนังสือบนการ์ดขาว | 2.70 | ต่ำกว่า 3:1 | ❌ ห้าม — orange ใช้เป็น**พื้น**ของ chip/ปุ่ม (ตัวหนังสือสีเข้ม) หรือจุดสถานะเท่านั้น |
| light | **ตัวหนังสือขาวบนปุ่ม orange** (#30 ปุ่มจ่ายเงิน) | 2.70 | ต่ำกว่า 3:1 | ❌ **ไม่ผ่าน** — ใช้ `--color-on-warning` (`#0D0D0D`, 7.21:1) แทน หรือแจ้ง planner ถ้า design ต้องการตัวขาว (ค่า orange ล็อกใน v4 ห้ามแก้เอง) |
| dark | primary-400 `#3B8AD6` เป็นตัวหนังสือบน navy-800 | 4.08 | 3:1 (ข้อความใหญ่/UI) | ❌ ข้อความปกติ — ใช้ `--color-text-accent` |
| dark | ตัวหนังสือขาวบนปุ่ม primary-400 | 3.63 | 3:1 (ข้อความใหญ่/UI) | ❌ — ใช้ `--color-on-accent` (`#061525`) |
| dark | ตัวหนังสือขาวบนปุ่ม orange accent-400 `#F99A2E` | 2.17 | ต่ำกว่า 3:1 | ❌ — ใช้ `--color-on-warning` |

## 3. ตาราง contrast ที่วัดจริง

สูตร WCAG 2.x relative luminance · ค่าอ่านจาก `theme/badgame.css` ที่ build แล้ว · สร้างด้วย
`CONTRAST_OUT=<path> npx vitest run tests/design`

### ข้อความ (เกณฑ์ ≥ 4.5:1)

| ตัวหนังสือ/ไอคอน | พื้น | ใช้กับ | light (fg / bg) | อัตราส่วน | dark (fg / bg) | อัตราส่วน |
|---|---|---|---|---|---|---|
| `--color-text-primary` | `--color-background-body` | ข้อความหลัก | #0D0D0D / #FCFCFC | 18.94 | #F2F5F9 / #061525 | 16.82 |
| `--color-text-secondary` | `--color-background-body` | ข้อความรอง (v4 text-muted) | #6B6B6B / #FCFCFC | 5.19 | #AFC0D6 / #061525 | 9.93 |
| `--color-text-accent` | `--color-background-body` | ลิงก์/ข้อความ accent | #0169CC / #FCFCFC | 5.26 | #80B2E3 / #061525 | 8.23 |
| `--color-text-primary` | `--color-background-card` | ข้อความหลัก | #0D0D0D / #FFFFFF | 19.44 | #F2F5F9 / #0A1E33 | 15.41 |
| `--color-text-secondary` | `--color-background-card` | ข้อความรอง (v4 text-muted) | #6B6B6B / #FFFFFF | 5.33 | #AFC0D6 / #0A1E33 | 9.09 |
| `--color-text-accent` | `--color-background-card` | ลิงก์/ข้อความ accent | #0169CC / #FFFFFF | 5.39 | #80B2E3 / #0A1E33 | 7.54 |
| `--color-text-primary` | `--color-background-surface` | ข้อความหลัก | #0D0D0D / #FFFFFF | 19.44 | #F2F5F9 / #0F2944 | 13.52 |
| `--color-text-secondary` | `--color-background-surface` | ข้อความรอง (v4 text-muted) | #6B6B6B / #FFFFFF | 5.33 | #AFC0D6 / #0F2944 | 7.98 |
| `--color-text-accent` | `--color-background-surface` | ลิงก์/ข้อความ accent | #0169CC / #FFFFFF | 5.39 | #80B2E3 / #0F2944 | 6.61 |
| `--color-text-primary` | `--color-background-popover` | ข้อความหลัก | #0D0D0D / #FFFFFF | 19.44 | #F2F5F9 / #0F2944 | 13.52 |
| `--color-text-secondary` | `--color-background-popover` | ข้อความรอง (v4 text-muted) | #6B6B6B / #FFFFFF | 5.33 | #AFC0D6 / #0F2944 | 7.98 |
| `--color-text-accent` | `--color-background-popover` | ลิงก์/ข้อความ accent | #0169CC / #FFFFFF | 5.39 | #80B2E3 / #0F2944 | 6.61 |
| `--color-text-primary` | `--color-background-muted` | ข้อความหลัก | #0D0D0D / #F0F0F0 | 17.05 | #F2F5F9 / #0F2944 | 13.52 |
| `--color-text-secondary` | `--color-background-muted` | ข้อความรอง (v4 text-muted) | #6B6B6B / #F0F0F0 | 4.68 | #AFC0D6 / #0F2944 | 7.98 |
| `--color-text-accent` | `--color-background-muted` | ลิงก์/ข้อความ accent | #0169CC / #F0F0F0 | 4.73 | #80B2E3 / #0F2944 | 6.61 |
| `--color-on-accent` | `--color-accent` | ตัวหนังสือบนปุ่ม primary | #FFFFFF / #0169CC | 5.39 | #061525 / #3B8AD6 | 5.07 |
| `--color-text-primary` | `--color-accent-muted` | ข้อความบนพื้น primary-tint | #0D0D0D / #EAF2FB | 17.21 | #F2F5F9 / #0F2F52 | 12.40 |
| `--color-on-success` | `--color-success` | บนพื้นสี success | #0D0D0D / #14935F | 4.97 | #061525 / #3FBF86 | 7.89 |
| `--color-on-warning` | `--color-warning` | บนพื้นสี warning (orange) | #0D0D0D / #E8850A | 7.21 | #061525 / #F99A2E | 8.49 |
| `--color-on-error` | `--color-error` | บนพื้นสี error | #FFFFFF / #D93A3F | 4.54 | #061525 / #F0686C | 6.04 |
| `--color-text-green` | `--color-background-green` | chip success | #0D6B45 / #E7F5EE | 5.83 | #7FE0B0 / #0B3A2B | 7.97 |
| `--color-text-green` | `--color-background-card` | ข้อความ success บนการ์ด | #0D6B45 / #FFFFFF | 6.55 | #7FE0B0 / #0A1E33 | 10.58 |
| `--color-text-orange` | `--color-background-orange` | chip warning/waitlist | #9C5404 / #FFF6EB | 5.33 | #FDB668 / #3A2410 | 8.38 |
| `--color-text-orange` | `--color-background-card` | ข้อความ warning/waitlist บนการ์ด | #9C5404 / #FFFFFF | 5.70 | #FDB668 / #0A1E33 | 9.68 |
| `--color-text-yellow` | `--color-background-yellow` | chip warning (alias ของ orange) | #9C5404 / #FFF6EB | 5.33 | #FDB668 / #3A2410 | 8.38 |
| `--color-text-yellow` | `--color-background-card` | ข้อความ warning (alias ของ orange) บนการ์ด | #9C5404 / #FFFFFF | 5.70 | #FDB668 / #0A1E33 | 9.68 |
| `--color-text-red` | `--color-background-red` | chip error | #A82A2E / #FCECEC | 6.04 | #FFA3A6 / #3D1A1E | 8.09 |
| `--color-text-red` | `--color-background-card` | ข้อความ error บนการ์ด | #A82A2E / #FFFFFF | 6.92 | #FFA3A6 / #0A1E33 | 8.86 |
| `--color-text-blue` | `--color-background-blue` | chip info | #0154A3 / #EAF2FB | 6.64 | #B9D5F2 / #0F2F52 | 8.95 |
| `--color-text-blue` | `--color-background-card` | ข้อความ info บนการ์ด | #0154A3 / #FFFFFF | 7.50 | #B9D5F2 / #0A1E33 | 11.12 |
| `--color-text-gray` | `--color-background-gray` | chip neutral | #3D3D3D / #F0F0F0 | 9.53 | #C9D5E4 / #173554 | 8.44 |
| `--color-text-gray` | `--color-background-card` | ข้อความ neutral บนการ์ด | #3D3D3D / #FFFFFF | 10.86 | #C9D5E4 / #0A1E33 | 11.33 |
| `--color-text-red` | `--color-error-muted` | ปุ่ม destructive | #A82A2E / #FCECEC | 6.04 | #FFA3A6 / #3D1A1E | 8.09 |

### ไอคอน (เกณฑ์ ≥ 3:1)

| ตัวหนังสือ/ไอคอน | พื้น | ใช้กับ | light (fg / bg) | อัตราส่วน | dark (fg / bg) | อัตราส่วน |
|---|---|---|---|---|---|---|
| `--color-icon-primary` | `--color-background-card` | ไอคอนหลัก | #0D0D0D / #FFFFFF | 19.44 | #F2F5F9 / #0A1E33 | 15.41 |
| `--color-icon-secondary` | `--color-background-card` | ไอคอนรอง | #6B6B6B / #FFFFFF | 5.33 | #AFC0D6 / #0A1E33 | 9.09 |
| `--color-icon-accent` | `--color-background-card` | ไอคอน accent | #0169CC / #FFFFFF | 5.39 | #80B2E3 / #0A1E33 | 7.54 |
| `--color-icon-green` | `--color-background-card` | ไอคอน success | #14935F / #FFFFFF | 3.91 | #3FBF86 / #0A1E33 | 7.23 |
| `--color-icon-orange` | `--color-background-card` | ไอคอน waitlist | #C46C05 / #FFFFFF | 3.82 | #F99A2E / #0A1E33 | 7.77 |
| `--color-icon-red` | `--color-background-card` | ไอคอน error | #D93A3F / #FFFFFF | 4.54 | #F0686C / #0A1E33 | 5.54 |
| `--color-icon-blue` | `--color-background-card` | ไอคอน info | #0169CC / #FFFFFF | 5.39 | #3B8AD6 / #0A1E33 | 4.65 |

## 4. primary โหมดมืด — ตัดสินแล้ว (ใช้แบบผสม)

ตัวเลขทั้งหมดมาจาก `tests/design/theme-tokens.test.ts` (ตัวหนังสือขาวบนปุ่มไม่ผ่านทั้งสองเฉด: 400 = 3.63 · 300 = 2.24)

| | (ก) primary-400 `#3B8AD6` | (ข) primary-300 `#80B2E3` |
|---|---|---|
| ตัวหนังสือ navy-950 `#061525` บนปุ่ม | 5.07 ✅ | 8.23 ✅ |
| ลิงก์บนพื้นหน้า navy-950 | 5.07 ✅ | 8.23 ✅ |
| ลิงก์บนการ์ด navy-900 | 4.65 ✅ | 7.54 ✅ |
| ลิงก์บนพื้นยก navy-800 | **4.08 ❌** | 6.61 ✅ |

**ที่ใช้อยู่ตอนนี้ (ผสม) — ✅ ตัดสินแล้วโดย planner**: พื้นปุ่ม = (ก) primary-400 + ตัวหนังสือ navy-950 · ลิงก์/ไอคอน accent (`--color-text-accent`) = (ข) primary-300
เหตุผล: ผ่าน 4.5:1 ทุกคู่ (รวมลิงก์บนพื้นยก navy-800) และปุ่มยังใกล้ primary แท้ `#0169CC` ⇒ ห้ามเปลี่ยนเป็น (ก)ล้วน/(ข)ล้วนโดยไม่ผ่านการตัดสินใหม่
(ลิงก์สว่างกว่าพื้นปุ่มหนึ่งขั้น — ตั้งใจ)
