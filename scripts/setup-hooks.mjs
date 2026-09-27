#!/usr/bin/env bun
/**
 * TMO QUALITY GATE — cài git hooks cho repo hiện tại.
 *
 * Git không track được .git/hooks → hooks sống trong repo ở scripts/hooks/
 * và được kích hoạt qua `git config core.hooksPath scripts/hooks`. Script này
 * idempotent — chạy bao nhiêu lần cũng được.
 *
 * Usage: bun scripts/setup-hooks.mjs   (hoặc `bun run setup` — đã ghép vào setup)
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')

try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'pipe' })
} catch {
  console.error('❌ [setup-hooks] Không phải git repo — bỏ qua.')
  process.exit(1)
}

// Đảm bảo hook file có exec bit (trên Windows git vẫn chạy qua sh, nhưng
// set cho đầy đủ trên POSIX + để git lưu exec bit trong index)
for (const hook of ['pre-push', 'pre-merge-commit']) {
  const p = path.join(ROOT, 'scripts', 'hooks', hook)
  if (fs.existsSync(p)) {
    try { fs.chmodSync(p, 0o755) } catch { /* Windows chmod — bỏ qua */ }
  } else {
    console.error(`❌ [setup-hooks] Thiếu ${p}`)
    process.exit(1)
  }
}

execSync('git config core.hooksPath scripts/hooks', { cwd: ROOT })
console.log('✅ [setup-hooks] Git hooks ĐÃ BẬT (core.hooksPath=scripts/hooks):')
console.log('   • pre-push          — chặn push nếu quality gate FAIL')
console.log('   • pre-merge-commit  — chặn merge nếu quality gate FAIL')
console.log('')
console.log('   Gate gồm: type_check (tsc) → lint (eslint) → imports (boundary + circular) → tests (bun test, DB cô lập) → build thử (distDir riêng).')
console.log('   Máy yếu / đang chạy dev server: tạo file .quality-gate.local với dòng skipBuild=true')
console.log('   (GitHub Actions vẫn chạy full gate trên mọi push nên không có gì lọt kiểm duyệt).')

process.exit(0)
