import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * 🔴 `domain/` ต้องเป็น pure TypeScript (baseline §Folder Structure · CLAUDE.md §3)
 *
 * เหตุผล: `domain/billing` + `domain/matching` ต้อง unit test ได้เต็มโดยไม่ต้อง
 * mock framework — ถ้าเผลอ import `next`/`react`/`@supabase/*` เข้าไป ชั้นนี้จะ
 * ผูกกับ runtime ทันทีและเทสต์จะเริ่มต้องการ environment
 *
 * baseline §Verification เรียกข้อนี้ว่า "Domain layer test" และบังคับให้มี lint rule ตรวจ
 */
const domainForbiddenImports = [
  { group: ["next", "next/*"], message: "domain/ ห้าม import next — ย้าย logic ที่ต้องใช้ framework ไป server/ หรือ features/" },
  { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "domain/ ห้าม import react — ชั้นนี้ต้องเป็น pure logic" },
  { group: ["@supabase/*"], message: "domain/ ห้ามแตะ Supabase — รับข้อมูลเป็น argument แทน แล้วให้ชั้นนอกไปอ่าน DB" },
  { group: ["server-only", "client-only"], message: "domain/ ต้องรันได้ทั้งสองฝั่ง จึงห้ามผูกกับฝั่งใดฝั่งหนึ่ง" },
  { group: ["@/lib/*", "@/server/*", "@/app/*", "@/features/*", "@/components/*"], message: "domain/ ห้ามพึ่งชั้นนอก — ทิศทางการพึ่งพาต้องเป็น ชั้นนอก → domain เท่านั้น" },
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["domain/**/*.ts", "domain/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: domainForbiddenImports },
      ],
    },
  },
];

export default eslintConfig;
