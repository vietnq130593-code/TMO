#!/usr/bin/env bun
/**
 * TMO SETUP — cài Playwright chromium browser binary (Task 42).
 *
 * Tại sao cần script này:
 *   - `bun install` chỉ kéo PACKAGE playwright (thư viện điều khiển browser),
 *     KHÔNG kèm browser BINARY (~114MB) — binary nằm ngoài npm package theo
 *     thiết kế của Playwright (tải về ~/.cache/ms-playwright hoặc
 *     %USERPROFILE%\AppData\Local\ms-playwright trên Windows).
 *   - Tool `browser_screenshot` của agents (Playwright headless chromium —
 *     verify UI sau khi code) sẽ fail "Executable doesn't exist" nếu thiếu
 *     binary. Trên Windows sau `git pull` + `bun install` + `bun run setup`,
 *     đây là bước DUY NHẤT còn thiếu để browser tool chạy được.
 *
 * Best-effort — KHÔNG BAO GIỜ làm fail toàn bộ `bun run setup`:
 *   - Mạng chậm / offline → in cảnh báo + hướng dẫn chạy tay, vẫn exit 0.
 *   - Đã cài rồi → Playwright tự nhận (chạy rất nhanh, gần như no-op).
 *
 * Usage:
 *   bun scripts/setup-playwright.mjs    (hoặc `bun run setup` — đã ghép cuối setup)
 *   bun run setup:playwright            (script riêng trong package.json)
 */

import { spawnSync } from 'node:child_process'

const TIMEOUT_MS = 10 * 60_000 // 10 phút — lần đầu tải ~114MB, mạng chậm cần dư địa

console.log('🌐 [setup-playwright] Cài Playwright chromium (browser binary cho tool browser_screenshot)...')

// `bunx playwright install chromium` — bunx tự resolve playwright từ
// node_modules của repo (đã có trong dependencies). shell:true cho Windows
// (bunx là .cmd shim) — pattern giống runStage của quality-gate.mjs.
const result = spawnSync('bunx', ['playwright', 'install', 'chromium'], {
  shell: true,
  stdio: 'inherit',
  timeout: TIMEOUT_MS,
})

if (result.status === 0) {
  console.log('✅ [setup-playwright] Chromium ĐÃ SẴN SÀNG — tool browser_screenshot của agents chạy được.')
  process.exit(0)
}

const reason =
  result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT' || result.status === null
    ? `TIMEOUT sau ${TIMEOUT_MS / 60_000} phút (mạng chậm?)`
    : `exit code ${result.status}`

console.warn('')
console.warn(`⚠️  [setup-playwright] Cài chromium KHÔNG thành công (${reason}) — KHÔNG chặn setup.`)
console.warn('    Tool browser_screenshot của agents sẽ báo "Executable doesn\'t exist" đến khi cài được.')
console.warn('    Chạy tay bất cứ lúc nào (không cần mở lại setup):')
console.warn('        bunx playwright install chromium')
console.warn('    Mọi bước khác của TMO KHÔNG phụ thuộc bước này — bỏ qua an toàn.')
process.exit(0) // best-effort: luôn exit 0 để không làm hỏng `bun run setup`
