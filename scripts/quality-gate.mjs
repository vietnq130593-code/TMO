#!/usr/bin/env bun
/**
 * TMO QUALITY GATE — cổng kiểm soát chất lượng trước khi push/merge.
 *
 * Mọi stage phải PASS thì gate mới cho qua (exit 0). Bất kỳ stage nào FAIL
 * → exit 1 → git hook chặn push/merge, GitHub Actions đánh dấu commit đỏ.
 *
 * Stages (chạy tuần tự):
 *   1. type_check  — bunx tsc --noEmit          (TypeScript strict)
 *   2. lint        — bun run lint               (ESLint toàn repo)
 *   3. imports     — bun scripts/check-imports.mjs (Task 42 — import
 *                    boundary src↔mini-services + circular import tĩnh)
 *   4. tests       — bun test trên DB TEST CÔ LẬP              (không đụng db/custom.db!)
 *                    (fresh schema qua `prisma db push` vào file SQLite riêng,
 *                     rồi chạy bun test với DATABASE_URL ghi đè)
 *   5. build       — bunx next build với distDir riêng (.next-qa)
 *                    (build THỬ — không đụng .next của dev server đang chạy)
 *
 * Usage:
 *   bun scripts/quality-gate.mjs                  # full gate (5 stage)
 *   bun scripts/quality-gate.mjs --skip-build     # bỏ stage build
 *   bun scripts/quality-gate.mjs --quick          # chỉ type_check + lint
 *   bun scripts/quality-gate.mjs --stage=tests    # chạy stage cụ thể (comma-separated)
 *   node scripts/quality-gate.mjs                 # chạy bằng node cũng OK (chỉ dùng API chuẩn)
 *
 * Env:
 *   TMO_GATE_SKIP_BUILD=1       — tương tự --skip-build
 *   TMO_BUILD_DIST_DIR=<dir>    — distDir của build thử (mặc định .next-qa)
 *
 * Local override file `.quality-gate.local` (gitignored, mỗi máy tự cấu hình):
 *   skipBuild=true              — máy yếu / dev server đang chạy → bỏ build thử
 *                                 (GitHub Actions vẫn chạy full gate nên push
 *                                  không bao giờ lọt mà không qua build)
 *
 * Git hooks (scripts/hooks/) và GitHub Actions (.github/workflows/quality-gate.yml)
 * đều gọi script này → 1 nguồn sự thật duy nhất.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const GATE = '\x1b[35m[TMO QUALITY GATE]\x1b[0m'
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// Parse args + local override file
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const hasFlag = (f) => args.includes(f)
const stageArg = args.find((a) => a.startsWith('--stage='))
const stageFilter = stageArg ? stageArg.slice(8).split(',').map((s) => s.trim()) : null

const skipBuildFlag = hasFlag('--skip-build') || process.env.TMO_GATE_SKIP_BUILD === '1'
const quickFlag = hasFlag('--quick')

// .quality-gate.local — per-machine override (gitignored)
const localConfigPath = path.join(ROOT, '.quality-gate.local')
const localConfig = {}
if (fs.existsSync(localConfigPath)) {
  for (const line of fs.readFileSync(localConfigPath, 'utf-8').split('\n')) {
    const m = line.trim().match(/^([a-zA-Z]+)\s*=\s*(.+)$/)
    if (m) localConfig[m[1]] = m[2].trim()
  }
}
const skipBuild = skipBuildFlag || localConfig.skipBuild === 'true'

// ---------------------------------------------------------------------------
// Runner helper
// ---------------------------------------------------------------------------
function runStage(name, { cmd, args: cmdArgs, env = {}, timeoutMs = 15 * 60_000 }) {
  const started = Date.now()
  console.log(`\n${GATE} ${BOLD(name)} — chạy: ${cmd} ${cmdArgs.join(' ')}`)

  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    shell: true, // Windows: bunx/tsc là .cmd shim — cần shell
    stdio: 'inherit',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  })

  const durationMs = Date.now() - started
  const secs = (durationMs / 1000).toFixed(1)

  if (result.status === 0) {
    console.log(`${GATE} ${GREEN(`✔ PASS ${name}`)} (${secs}s)`)
    return { name, status: 'PASS', durationMs }
  }
  if (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT' || result.status === null) {
    console.log(`${GATE} ${RED(`✘ FAIL ${name}`)} — TIMEOUT sau ${secs}s`)
    return { name, status: 'FAIL', durationMs, reason: 'timeout' }
  }
  console.log(`${GATE} ${RED(`✘ FAIL ${name}`)} (exit ${result.status}, ${secs}s)`)
  return { name, status: 'FAIL', durationMs, reason: `exit ${result.status}` }
}

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------
const TEST_DB = path.join(ROOT, 'db', '.quality-gate-test.db')
const TEST_DB_URL = `file:${TEST_DB}`
const BUILD_DIST_DIR = process.env.TMO_BUILD_DIST_DIR || '.next-qa'
// r60 (C6 — chặn leak jsonl TEST-* vào agent-runs/ THẬT, lặp lại >=4 lần ở các
// phiên 58-59: test units gọi startAgentRun/endAgentRun ghi trail jsonl vào
// RUN_TRAILS_DIR (mặc định <repo>/agent-runs). Env TMO_AGENT_RUNS_DIR (được
// agent-run-tracker + instrumentation-node tôn trọng) trỏ sang thư mục tạm
// duy nhất theo pid — dọn sạch trong finally cùng DB test.
const TEST_RUNS_DIR = `/tmp/tmo-gate-agent-runs-${process.pid}`

function rmQuiet(p) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(p + suffix, { force: true }) } catch { /* ignore */ }
  }
}

const stages = [
  {
    name: 'type_check',
    desc: 'TypeScript strict check (tsc --noEmit)',
    run: () => runStage('type_check', {
      cmd: 'bunx', args: ['tsc', '--noEmit'],
      timeoutMs: 10 * 60_000,
    }),
  },
  {
    name: 'lint',
    desc: 'ESLint toàn repo',
    run: () => runStage('lint', {
      cmd: 'bun', args: ['run', 'lint'],
      timeoutMs: 10 * 60_000,
    }),
  },
  {
    name: 'imports',
    desc: 'Import boundary (src ↔ mini-services) + circular import tĩnh (Task 42 — cross-import gate)',
    run: () => runStage('imports', {
      cmd: 'bun', args: ['scripts/check-imports.mjs'],
      timeoutMs: 2 * 60_000,
    }),
  },
  {
    name: 'tests',
    desc: `bun test trên DB test cô lập (${path.basename(TEST_DB)})`,
    run: () => {
      // Fresh test DB mỗi lần chạy → kết quả xác định được, không đụng DB thật.
      // QUAN TRỌNG: DATABASE_URL ghi đè TRƯỚC khi prisma/bun test chạy — nếu không,
      // bun tự nạp .env (trỏ DB khác) và test sẽ fail 25/169 hoặc tệ hơn là
      // ghi đám rác vào DB thật của app.
      rmQuiet(TEST_DB)
      const push = runStage('tests:prepare-db', {
        cmd: 'bunx',
        args: ['prisma', 'db', 'push', '--skip-generate'],
        env: { DATABASE_URL: TEST_DB_URL },
        timeoutMs: 5 * 60_000,
      })
      if (push.status !== 'PASS') {
        return { name: 'tests', status: 'FAIL', durationMs: push.durationMs, reason: 'prisma db push (test DB) thất bại' }
      }
      try {
        return runStage('tests', {
          cmd: 'bun', args: ['test'],
          // r60 (C6): TMO_AGENT_RUNS_DIR → jsonl TEST-* ghi sang /tmp tạm,
          // KHÔNG rơi vào agent-runs/ thật của repo (watcher mission lọc
          // TEST-* nhưng rác vẫn xâm nhập đĩa + hậu kiểm phải dọn tay).
          env: { DATABASE_URL: TEST_DB_URL, TMO_AGENT_RUNS_DIR: TEST_RUNS_DIR },
          timeoutMs: 10 * 60_000,
        })
      } finally {
        rmQuiet(TEST_DB) // dọn DB test sau khi chạy xong
        try { fs.rmSync(TEST_RUNS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  },
  {
    name: 'build',
    desc: `Build thử (next build → ${BUILD_DIST_DIR}, không đụng .next của dev server)`,
    skip: skipBuild,
    skipReason: skipBuildFlag || process.env.TMO_GATE_SKIP_BUILD === '1'
      ? 'bỏ qua theo --skip-build / TMO_GATE_SKIP_BUILD=1'
      : 'bỏ qua theo .quality-gate.local (skipBuild=true)',
    run: () => {
      try {
        return runStage('build', {
          cmd: 'bunx', args: ['next', 'build'],
          env: { TMO_BUILD_DIST_DIR: BUILD_DIST_DIR, NEXT_TELEMETRY_DISABLED: '1' },
          timeoutMs: 25 * 60_000,
        })
      } finally {
        // Build thử dùng xong là bỏ — không để phình repo (đã gitignore sẵn)
        rmQuiet(path.join(ROOT, BUILD_DIST_DIR))
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Chọn stage theo filter
// ---------------------------------------------------------------------------
let selected = stages
if (quickFlag) {
  selected = stages.filter((s) => s.name === 'type_check' || s.name === 'lint')
} else if (stageFilter) {
  const unknown = stageFilter.filter((n) => !stages.some((s) => s.name === n))
  if (unknown.length > 0) {
    console.error(`${GATE} ${RED(`Stage không hợp lệ: ${unknown.join(', ')}`)} — hợp lệ: ${stages.map((s) => s.name).join(', ')}`)
    process.exit(2)
  }
  selected = stages.filter((s) => stageFilter.includes(s.name))
}

// ---------------------------------------------------------------------------
// Chạy gate
// ---------------------------------------------------------------------------
console.log(`${GATE} ${BOLD('Bắt đầu — TMO Quality Gate')}`)
console.log(`${GATE} Repo: ${ROOT}`)
console.log(`${GATE} Stages: ${selected.map((s) => (s.skip ? `${s.name} (SKIP)` : s.name)).join(' → ')}`)

const t0 = Date.now()
const results = []
for (const stage of selected) {
  if (stage.skip) {
    console.log(`\n${GATE} ${YELLOW(`⊘ SKIP ${stage.name}`)} — ${stage.skipReason}`)
    results.push({ name: stage.name, status: 'SKIP', durationMs: 0 })
    continue
  }
  results.push(stage.run())
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totalSecs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n${GATE} ${BOLD('────────────────────────────────────────────')}`)
for (const r of results) {
  const icon = r.status === 'PASS' ? GREEN('✔ PASS') : r.status === 'SKIP' ? YELLOW('⊘ SKIP') : RED('✘ FAIL')
  const secs = r.durationMs ? `(${(r.durationMs / 1000).toFixed(1)}s)` : ''
  console.log(`${GATE} ${icon} ${r.name.padEnd(12)} ${secs} ${r.reason ? RED(`— ${r.reason}`) : ''}`)
}
console.log(`${GATE} ${BOLD('────────────────────────────────────────────')}`)

const failed = results.filter((r) => r.status === 'FAIL')
if (failed.length > 0) {
  console.log(`${GATE} ${RED(BOLD(`CHẶN: ${failed.length}/${results.length} stage FAIL — không được push/merge.`))}`)
  console.log(`${GATE} ${RED('Sửa lỗi rồi chạy lại, hoặc dùng --no-verify nếu THẬT SỰ chắc chắn (không khuyến khích).')}`)
  process.exit(1)
}

console.log(`${GATE} ${GREEN(BOLD(`PASS toàn bộ (${totalSecs}s) — được phép push/merge.`))}`)
process.exit(0)
