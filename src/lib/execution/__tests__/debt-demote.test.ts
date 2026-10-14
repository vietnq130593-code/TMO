// ============================================
// R12 — Unit test INFRA-DEBT DEMOTION (src/lib/execution/debt-demote.ts)
// Fix P1-2 lượt quan sát 5: nợ infra không giao cho agent trả trong debt cycle.
// ============================================

import { describe, expect, test } from 'bun:test'
import { INFRA_DEBT_DEMOTE_ENABLED, INFRA_SIDE_ISSUE_PATTERNS, isInfraSideIssue, splitSideIssuesByInfra } from '../debt-demote'

/** Các side issue THẬT đã gặp trong vận hành (R8/R11 + dev.log) — loại infra. */
const REAL_INFRA_ISSUES = [
  'Access denied: path escapes workspace root (file_read /home/z/tmo-app/src)',
  "HTTP 410 ModelDeprecated: model 'exo-free' đã bị khai tử (zen)",
  'resolveCwd is not defined — shell tool chết ×16',
  'Socket timeout (the database failed to respond to a query within the configured timeout) lúc saveChatMessages',
  'FreeTierError: Zen chặn free-tier theo project config (403)',
  'Watchdog MemWatchdog self-exit: MemAvailable 364MB < 450MB',
  'rate limit exceeded sau 12 attempts xoay key (429)',
  'harness lỗi khi phát tool call native (space-bunny-free HTTP)',
  'lỗi hạ tầng bên thứ 3 — vendor LLM provider chết toàn chuỗi',
  'spawn ENOENT: không spawn được process worker',
  'EACCES: permission denied khi ghi db/custom.db',
  'database is locked — SQLITE_BUSY contention lúc run-close',
]

/** Side issue agent TỰ gây ra (R11 rule 9 'continue' đúng nghĩa) — KHÔNG phải infra. */
const REAL_AGENT_ISSUES = [
  'lint fail ở file src/lib/x.ts run đã đụng (2 warning)',
  'type_check lỗi trong file đã sửa — chạy lại kiểm định',
  '3 tests failed sau thay đổi logic trong module mới',
  'MODULE_NOT_FOUND: import sai đường dẫn trong file run vừa tạo',
  'config hành vi hỏng do run đổi default — cần khôi phục',
]

describe('INFRA-DEBT DEMOTION — debt-demote.ts (R12)', () => {
  test('INFRA_DEBT_DEMOTE_ENABLED bật mặc định (env không set → on)', () => {
    expect(INFRA_DEBT_DEMOTE_ENABLED).toBe(true)
  })

  test('mọi pattern đều là RegExp hợp lệ và test được chuỗi rỗng không crash', () => {
    for (const re of INFRA_SIDE_ISSUE_PATTERNS) {
      expect(re instanceof RegExp).toBe(true)
      expect(() => re.test('')).not.toThrow()
    }
  })

  for (const issue of REAL_INFRA_ISSUES) {
    test(`INFRA: ${issue.slice(0, 60)}...`, () => {
      expect(isInfraSideIssue(issue)).toBe(true)
    })
  }

  for (const issue of REAL_AGENT_ISSUES) {
    test(`AGENT (không khớp): ${issue.slice(0, 60)}...`, () => {
      expect(isInfraSideIssue(issue)).toBe(false)
    })
  }

  test('splitSideIssuesByInfra tách đúng 2 loại giữ thứ tự', () => {
    const mixed = [...REAL_INFRA_ISSUES.slice(0, 3), ...REAL_AGENT_ISSUES.slice(0, 2)]
    const split = splitSideIssuesByInfra(mixed)
    expect(split.demoteEnabled).toBe(true)
    expect(split.infra).toHaveLength(3)
    expect(split.agent).toHaveLength(2)
    expect(split.infra).toEqual(REAL_INFRA_ISSUES.slice(0, 3))
    expect(split.agent).toEqual(REAL_AGENT_ISSUES.slice(0, 2))
    // không mất issue nào
    expect([...split.agent, ...split.infra].sort()).toEqual([...mixed].sort())
  })

  test('splitSideIssuesByInfra với mảng rỗng + chuỗi không phải string', () => {
    const split = splitSideIssuesByInfra([])
    expect(split.agent).toEqual([])
    expect(split.infra).toEqual([])
    expect(isInfraSideIssue('' as string)).toBe(false)
  })
})

describe('INFRA-DEBT DEMOTION — kill-switch GOAL_LOOP_INFRA_DEBT_DEMOTE=0 (R12)', () => {
  test('env=0 → mọi issue trả về là agent (hành vi cũ trước R12)', async () => {
    // Module đọc env 1 lần lúc load — chạy subprocess riêng với env=0 để không
    // ô nhiễm module đã nạp trong process test này.
    const proc = Bun.spawnSync(['bun', '-e', `
      const { splitSideIssuesByInfra } = require('./src/lib/execution/debt-demote.ts')
      const split = splitSideIssuesByInfra(['Access denied: path escapes workspace root', 'lint fail ở file đã sửa'])
      console.log(JSON.stringify({ agent: split.agent.length, infra: split.infra.length, enabled: split.demoteEnabled }))
    `], {
      cwd: import.meta.dir + '/../../../../',
      env: { ...process.env, GOAL_LOOP_INFRA_DEBT_DEMOTE: '0' },
    })
    expect(proc.exitCode).toBe(0)
    const out = JSON.parse(proc.stdout.toString().trim().split('\n').pop() || '{}')
    // kill-switch off: 'Access denied' (vốn là infra) giờ cũng về agent — đúng hành vi cũ
    expect(out).toEqual({ agent: 2, infra: 0, enabled: false })
  })
})
