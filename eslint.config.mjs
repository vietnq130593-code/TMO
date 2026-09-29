import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  // .next-qa = distDir cô lập của quality gate (scripts/quality-gate.mjs) —
  // build FAIL giữa chừng (vd OOM exit 137) có thể để lại chunks sinh lỗi lint
  // ở lần gate sau; ignore vĩnh viễn.
  // .next-audit-wp = work-product cache tsc của chuỗi audit (sinh .d.ts routes
  // generated — 183 lỗi no-empty-object-type khi `bun run lint` trần quét phải);
  // .next-audit-gate = distDir của run-gate.sh (cùng tính chất .next-qa).
  // Fix sau sự cố 2026-09-30: `bun run lint` (không có --ignore-pattern như
  // gate) fail 183 lỗi từ file generated — 2 dòng dưới đưa lint trần về sạch.
  ignores: ["node_modules/**", ".next/**", ".next-qa/**", ".next-audit-wp/**", ".next-audit-gate/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "public/**"]
}];

export default eslintConfig;
