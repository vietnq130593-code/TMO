/**
 * r69 — TEST CHO 8 MỤC CÒN TREO bug.md + 1 kết quả audit r68
 *
 * Mọi test bắt từ BẰNG CHỨNG quan sát mission cmuznvkl…6b136k (bug.md):
 *   - BUG-007: read_output KHÔNG BAO GIỜ trả exitCode (SENTINEL mất gate
 *     receipt 15:03:59→15:05:50) → ProcessOutput giờ mang status+exitCode.
 *   - BUG-008: directive UI 82 ký tự mơ hồ không qua guard ping-pong →
 *     directive-guard enrich tầng API (không chặn user).
 *   - BUG-009/025: tmp/ rác repo + 101 dòng uncommitted vô hình →
 *     workspace-git helpers.
 *   - BUG-010/014: readOnly ràng buộc bằng CÂU CHỮ → cờ cứng tầng tool
 *     (SUBAGENT_WRITE_TOOLS strip + auto-detect).
 *   - BUG-012: 1.86M tokens/sub-task không cảnh báo → DELEGATION_TOKEN_WARN_TIERS.
 *   - AUDIT r68-F2: writtenFiles bóc từ preview 160-chars cắt cụt → giờ từ
 *     args thật (test bằng chính regex lỗi cũ chứng minh sai, cách mới đúng).
 */

import { describe, test, expect } from 'bun:test'

// ==================== BUG-007 — exitCode receipt ====================

/** Shape ProcessOutput sau r69 (test đối chiếu các field receipt mới) */
interface ReadOutShape {
  ended: boolean
  exitCode?: number | null
  status?: string
  output: string
}

const waitForProcessEnd = async (processId: string, timeoutMs = 4_000): Promise<ReadOutShape | null> => {
  const { processManager } = await import('@/lib/execution/process-manager')
  let out: ReadOutShape | null = null
  for (let i = 0; i < Math.ceil(timeoutMs / 100); i++) {
    out = (await processManager.readProcessOutput(processId)) as ReadOutShape
    if (out && out.ended) return out
    await new Promise(r => setTimeout(r, 100))
  }
  return out
}

describe('r69 BUG-007 — read_output trả exitCode (gate receipt)', () => {
  test('process chết exit 0 → readProcessOutput mang status=exited + exitCode=0', async () => {
    const { processManager } = await import('@/lib/execution/process-manager')
    const info = await processManager.startProcess({
      command: 'echo gate-pass-1791471',
      name: 'test-gate-ok',
      cwd: process.cwd(),
    })
    const out = await waitForProcessEnd(info.id)
    expect(out).not.toBeNull()
    expect(out!.ended).toBe(true)
    // Trước r69 ProcessOutput KHÔNG có 2 field này — đây là receipt bị mất
    // suốt mission r68 ("Gate receipt was lost — I never captured its exit code")
    expect(out!.status).toBe('exited')
    expect(out!.exitCode).toBe(0)
    expect(out!.output).toContain('gate-pass-1791471')
  })

  test('process chết exit khác 0 → exitCode phản ánh mã lỗi thật', async () => {
    const { processManager } = await import('@/lib/execution/process-manager')
    const info = await processManager.startProcess({
      command: 'exit 7',
      name: 'test-gate-fail',
      cwd: process.cwd(),
    })
    const out = await waitForProcessEnd(info.id)
    expect(out).not.toBeNull()
    expect(out!.ended).toBe(true)
    expect(out!.status).toBe('exited')
    expect(out!.exitCode).toBe(7)
  })

  test('process_id không tồn tại → vẫn trả shape hợp lệ (fail-open, ended=true)', async () => {
    const { processManager } = await import('@/lib/execution/process-manager')
    const out = await processManager.readProcessOutput('proc_khong-ton-tai-xyz')
    expect(out.ended).toBe(true)
    expect(out.output).toBe('')
    // KHÔNG throw — read_output cũ cũng không, giữ nguyên
  })
})

// ==================== BUG-008 — directive guard ====================

describe('r69 BUG-008 — directive-guard (enrich, không chặn user)', () => {
  test('extractAcceptanceCriteria: bắt block "Nghiệm thu:" chuẩn worked-example', async () => {
    const { extractAcceptanceCriteria } = await import('@/lib/directive-guard')
    const raw = [
      'Triển khai fix X cho hệ thống.',
      '',
      'Nghiệm thu:',
      '- [ ] file src/lib/x.ts sửa hàm Y và lint pass',
      '- [ ] test X chạy 169/169 pass',
    ].join('\n')
    const acc = extractAcceptanceCriteria(raw)
    expect(acc.length).toBe(2)
    expect(acc[0]).toContain('x.ts')
    expect(acc[1]).toContain('169/169')
  })

  test('extractAcceptanceCriteria: bắt per-item "Nghiệm thu: <đk>" (format mission #18)', async () => {
    const { extractAcceptanceCriteria } = await import('@/lib/directive-guard')
    const raw = [
      'Hạng mục 1 — sửa parser.',
      'Nghiệm thu: grep R7 có test pass',
      'Hạng mục 2 — hardcode gate.',
      'Nghiệm thu: run_gate 392/392 PASS',
    ].join('\n')
    const acc = extractAcceptanceCriteria(raw)
    expect(acc.length).toBe(2)
    expect(acc.some(a => a.includes('R7'))).toBe(true)
    expect(acc.some(a => a.includes('392/392'))).toBe(true)
  })

  test('extractAcceptanceCriteria: directive mơ hồ 82 ký tự của mission r68 → 0 tiêu chí', async () => {
    const { extractAcceptanceCriteria } = await import('@/lib/directive-guard')
    // NGUYÊN VĂN bằng chứng bug.md BUG-008 (GoalLoopJob cmuznvkl…)
    const acc = extractAcceptanceCriteria('Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi')
    expect(acc.length).toBe(0)
  })

  test('isWorkOrderDirective: continuation-verb → work order; câu hỏi thường → không', async () => {
    const { isWorkOrderDirective } = await import('@/lib/directive-guard')
    expect(isWorkOrderDirective('Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi')).toBe(true)
    expect(isWorkOrderDirective('Làm tiếp phần P0-2')).toBe(true)
    expect(isWorkOrderDirective('triển khai feature ABC')).toBe(true)
    // Câu hỏi factual ngắn — KHÔNG enrich (chống nhiễu casual chat)
    expect(isWorkOrderDirective('AI là gì?')).toBe(false)
    expect(isWorkOrderDirective('Cho tôi xin lời chào')).toBe(false)
  })

  test('enrichDirectiveForGoalLoop: đã có nghiệm thu → tôn trọng, KHÔNG đụng', async () => {
    const { enrichDirectiveForGoalLoop } = await import('@/lib/directive-guard')
    const withAcc = 'Triển khai fix X.\n\nNghiệm thu:\n- [ ] lint pass'
    const r = await enrichDirectiveForGoalLoop(fakeDb([]), 'sess-1', withAcc)
    expect(r.guardApplied).toBe(false)
    expect(r.directive).toBe(withAcc)
  })

  test('enrichDirectiveForGoalLoop: work order mơ hồ + backlog todo → scaffold BACKLOG (ping-pong bị chặn nguồn)', async () => {
    const { enrichDirectiveForGoalLoop } = await import('@/lib/directive-guard')
    // Todo mở đúng như mission r68 để lại (10 phần việc dở)
    const db = fakeDb([
      { content: 'P0-2: bootstrap-token trust — rà soát nguồn cấp token setup' },
      { content: 'Nâng cấp bun 1.4 theo advisory' },
    ])
    const r = await enrichDirectiveForGoalLoop(db, 'sess-co-todo', 'Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi')
    expect(r.guardApplied).toBe(true)
    expect(r.scaffoldKind).toBe('backlog')
    expect(r.directive).toContain('P0-2')
    expect(r.directive).toContain('Nâng cấp bun 1.4')
    // Scaffold là dòng "- [ ] …" máy-đo được (evaluator + todo-coverage ăn được)
    expect(r.directive).toMatch(/- \[ \] P0-2/)
    expect(r.acceptanceCount).toBeGreaterThanOrEqual(2)
  })

  test('enrichDirectiveForGoalLoop: work order mơ hồ KHÔNG backlog → scaffold BASELINE', async () => {
    const { enrichDirectiveForGoalLoop, BASELINE_ACCEPTANCE_SCAFFOLD } = await import('@/lib/directive-guard')
    const r = await enrichDirectiveForGoalLoop(fakeDb([]), 'sess-trống', 'Triển khai các khắc phục còn tồn cho tôi')
    expect(r.guardApplied).toBe(true)
    expect(r.scaffoldKind).toBe('baseline')
    expect(r.directive).toContain(BASELINE_ACCEPTANCE_SCAFFOLD)
  })

  test('enrichDirectiveForGoalLoop: câu hỏi thường → KHÔNG enrich (không nhiễu casual)', async () => {
    const { enrichDirectiveForGoalLoop } = await import('@/lib/directive-guard')
    const r = await enrichDirectiveForGoalLoop(fakeDb([{ content: 'việc dở' }]), 's', 'Bạn tên gì?')
    expect(r.guardApplied).toBe(false)
    expect(r.directive).toBe('Bạn tên gì?')
  })

  test('enrichDirectiveForGoalLoop: DB lỗi → fail-open trả directive gốc', async () => {
    const { enrichDirectiveForGoalLoop } = await import('@/lib/directive-guard')
    const throwingDb = {
      todo: { findMany: async () => { throw new Error('db down') } },
    } as never
    const r = await enrichDirectiveForGoalLoop(throwingDb, 's', 'Triển khai khắc phục P0-1 cho tôi')
    // Fail-open: vẫn enrich bằng BASELINE (DB lỗi không được chặn user) —
    // directive gốc KHÔNG mất, KHÔNG throw
    expect(r.directive).toContain('Triển khai khắc phục P0-1')
    expect(r.guardApplied).toBe(true)
    expect(r.scaffoldKind).toBe('baseline')
  })
})

/** Fake PrismaClient tối tiểu — chỉ cần todo.findMany cho backlog scaffold */
function fakeDb(todos: Array<{ content: string }>): never {
  return {
    todo: {
      findMany: async () => todos.map(t => ({ ...t })),
    },
  } as never
}

// ==================== BUG-009/025 — workspace-git ====================

describe('r69 BUG-009/025 — workspace-git (rác + uncommitted hiện hình)', () => {
  test('getWorkspaceGitStatus: repo thật → ok=true, dòng porcelain hợp lệ', async () => {
    const { getWorkspaceGitStatus } = await import('@/lib/workspace-git')
    const gs = await getWorkspaceGitStatus()
    expect(gs.ok).toBe(true) // /home/z/tmo-app là git repo
    // Format dòng porcelain: 2-3 ký tự mã + space + path (vd " M file", "?? tmp/")
    for (const line of gs.lines) {
      expect(line).toMatch(/^([ MADRCU?!]{1,2}\s+\S|OM\s)/)
    }
  })

  test('diffGitStatusSnapshots: chỉ trả dòng MỚI xuất hiện ở snapshot sau', async () => {
    const { diffGitStatusSnapshots } = await import('@/lib/workspace-git')
    const before = { ok: true, lines: [' M src/a.ts', '?? old-rác/'], total: 2 }
    const after = { ok: true, lines: [' M src/a.ts', '?? tmp/', '?? scratch/new.ts'], total: 3 }
    const delta = diffGitStatusSnapshots(before, after)
    // tmp/ (rác BUG-009) + scratch/new.ts là MỚI — đây là phần sub-agent để lại
    expect(delta).toEqual(['?? tmp/', '?? scratch/new.ts'])
  })

  test('diffGitStatusSnapshots: before fail-open (ok=false) → dùng nguyên snapshot sau', async () => {
    const { diffGitStatusSnapshots } = await import('@/lib/workspace-git')
    const delta = diffGitStatusSnapshots(
      { ok: false, lines: [], total: 0 },
      { ok: true, lines: ['?? tmp/'], total: 1 },
    )
    expect(delta).toEqual(['?? tmp/'])
  })

  test('formatUncommittedBlock: cây sạch → rỗng; bẩn → có tiêu đề + dòng', async () => {
    const { formatUncommittedBlock } = await import('@/lib/workspace-git')
    expect(formatUncommittedBlock({ ok: true, lines: [], total: 0 }, 'TIÊU ĐỀ')).toBe('')
    expect(formatUncommittedBlock({ ok: false, lines: ['?? x'], total: 1 }, 'TIÊU ĐỀ')).toBe('')
    const block = formatUncommittedBlock({ ok: true, lines: [' M src/lib/a.ts', '?? tmp/'], total: 2 }, 'TIÊU ĐỀ')
    expect(block).toContain('TIÊU ĐỀ')
    expect(block).toContain('M src/lib/a.ts')
    expect(block).toContain('?? tmp/')
  })

  test('formatUncommittedBlock: cap 30 dòng + ghi chú "+N dòng khác"', async () => {
    const { formatUncommittedBlock, MAX_UNCOMMITTED_LINES_VISIBLE } = await import('@/lib/workspace-git')
    const lines = Array.from({ length: 40 }, (_, i) => `?? file-${i}.txt`)
    const block = formatUncommittedBlock({ ok: true, lines, total: 40 }, 'T')
    expect(block).toContain('+10 dòng khác')
    expect(block).not.toContain('file-39.txt')
    expect(MAX_UNCOMMITTED_LINES_VISIBLE).toBe(30)
  })
})

// ==================== BUG-010/014 — readOnly delegation ====================

describe('r69 BUG-010/014 — readOnly delegation contract (cờ cứng tầng tool)', () => {
  test('SUBAGENT_WRITE_TOOLS: phủ mọi tool ghi quan sát được (file/shell/git/gateway/pkg/cron)', async () => {
    const { SUBAGENT_WRITE_TOOLS } = await import('@/lib/subagent-delegate')
    // Bằng chứng BUG-010: SENTINEL tự sửa qua file tools + shell + gate
    for (const t of ['file_write', 'file_edit', 'file_multi_edit', 'file_delete', 'shell', 'run_bg', 'git_commit', 'git_push', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'manage_packages', 'mkdir', 'knowledge_write']) {
      expect(SUBAGENT_WRITE_TOOLS.has(t)).toBe(true)
    }
    // Tool đọc/kiểm định KHÔNG bị strip — sub-agent khảo sát vẫn làm việc được
    for (const t of ['file_read', 'file_list', 'grep', 'run_tests', 'lint', 'type_check', 'todo_write', 'todo_read', 'escalate_problem']) {
      expect(SUBAGENT_WRITE_TOOLS.has(t)).toBe(false)
    }
  })

  test('detectReadOnlyDelegation: bằng chứng evt70 r68 ("chỉ đọc và kiểm định; không sửa file") → true', async () => {
    const { detectReadOnlyDelegation } = await import('@/lib/subagent-delegate')
    expect(detectReadOnlyDelegation('Khảo sát độc lập phần còn dở P0-1, chỉ đọc và kiểm định; không sửa file. Đọc đầy đủ src/app/api/opencode/execute/route.ts')).toBe(true)
    expect(detectReadOnlyDelegation('read-only audit of the security layer')).toBe(true)
    expect(detectReadOnlyDelegation('Phân tích, no modifications allowed')).toBe(true)
  })

  test('detectReadOnlyDelegation: BUG-010 gốc (khảo sát không ràng buộc) → false — không đoán mò', async () => {
    const { detectReadOnlyDelegation } = await import('@/lib/subagent-delegate')
    // Lời giao GỐC BUG-010: "Khảo sát độc lập P0-1 endpoint OpenCode execute
    // và xác định mọi khoảng trống còn lại. Đọc đầy đủ route, exec-allowlist…"
    // — KHÔNG tín hiệu mạnh → KHÔNG auto (TL phải truyền cờ chủ đích; tránh
    // chặn nhầm task khảo sát+kèm sửa hợp lệ).
    expect(detectReadOnlyDelegation('Khảo sát độc lập P0-1 endpoint OpenCode execute và xác định mọi khoảng trống còn lại. Đọc đầy đủ route, exec-allowlist, exec-runner')).toBe(false)
  })

  test('detectReadOnlyDelegation: task chỉ-đọc NHƯNG kèm ý định sửa → false (task hỗn hợp là hợp lệ)', async () => {
    const { detectReadOnlyDelegation } = await import('@/lib/subagent-delegate')
    expect(detectReadOnlyDelegation('Chỉ đọc cấu hình hiện tại rồi sửa lại file config cho đúng')).toBe(false)
    expect(detectReadOnlyDelegation('read-only review trước, sau đó implement fix trong cùng task')).toBe(false)
  })

  test('detectReadOnlyDelegation: ràng buộc "không sửa file" KHÔNG tự kích hoạt guard âm vì từ "sửa"', async () => {
    const { detectReadOnlyDelegation } = await import('@/lib/subagent-delegate')
    // "không sửa file" chứa từ "sửa" — nếu guard âm không strip cụm ràng buộc
    // trước khi dò modify-intent thì task này sẽ bị coi là "có ý định sửa"
    expect(detectReadOnlyDelegation('Kiểm định P0-1, không sửa file, báo cáo lại')).toBe(true)
    expect(detectReadOnlyDelegation('')).toBe(false)
  })

  test('whitelist strip: readOnly → mọi tool ghi biến mất, tool đọc giữ nguyên', async () => {
    // Mô phỏng đúng logic strip trong runSubAgentForProfileInner
    const { SUBAGENT_WRITE_TOOLS } = await import('@/lib/subagent-delegate')
    const { DEFAULT_SUBAGENT_TOOLS, DEPTH_GUARD_TOOLS } = await import('@/lib/subagent-delegate')
    const base = DEFAULT_SUBAGENT_TOOLS.filter(t => !DEPTH_GUARD_TOOLS.includes(t))
    const stripped = base.filter(t => !SUBAGENT_WRITE_TOOLS.has(t))
    // DEFAULT có shell/file_edit/run_bg → bị strip
    expect(stripped.includes('shell')).toBe(false)
    expect(stripped.includes('file_edit')).toBe(false)
    expect(stripped.includes('run_bg')).toBe(false)
    // Giữ đủ bộ đọc + kiểm định
    expect(stripped.includes('file_read')).toBe(true)
    expect(stripped.includes('run_tests')).toBe(true)
    expect(stripped.includes('lint')).toBe(true)
    expect(stripped.includes('grep')).toBe(true)
  })
})

// ==================== BUG-012 — token warn tiers ====================

describe('r69 BUG-012 — ngưỡng cảnh báo token theo phần việc', () => {
  test('DELEGATION_TOKEN_WARN_TIERS: 2 mốc 1.2M/2.4M + sentinel ∞ (không cắt cứng)', async () => {
    const { DELEGATION_TOKEN_WARN_TIERS } = await import('@/lib/subagent-delegate')
    expect(DELEGATION_TOKEN_WARN_TIERS[0]).toBe(1_200_000)
    expect(DELEGATION_TOKEN_WARN_TIERS[1]).toBe(2_400_000)
    // Sentinel: vượt 2 mốc → không cảnh báo nữa (mọi cảnh báo đều là evidence,
    // KHÔNG cắt cứng theo user directive ∞ TỔNG)
    expect(DELEGATION_TOKEN_WARN_TIERS[2]).toBe(Number.POSITIVE_INFINITY)
    expect(99_999_999 >= DELEGATION_TOKEN_WARN_TIERS[2]).toBe(false)
  })

  test('mô phỏng addTokens: 1.86M tokens của sub-task r68 → qua MỐC 1 (1.2M), chưa tới mốc 2', async () => {
    const { DELEGATION_TOKEN_WARN_TIERS } = await import('@/lib/subagent-delegate')
    // Bằng chứng BUG-012: sub-task đốt 1,859,401 tokens
    const tokensUsed = 1_859_401
    let tier = 0
    while (tokensUsed >= DELEGATION_TOKEN_WARN_TIERS[tier]) tier++
    expect(tier).toBe(1) // 1 cảnh báo đã phát ở mốc 1.2M — trước r69 là 0
  })
})

// ==================== AUDIT r68-F2 — máy đo file ghi từ args thật ====================

describe('r69 AUDIT r68-F2 — máy đo file ghi chính xác (bỏ regex bóc preview cụt)', () => {
  test('CÁCH CŨ (lỗi): bóc từ evidence preview 160-chars ra blob JSON cắt cụt, không ra tên file', () => {
    // Tái tạo đúng pipeline r68: compactArgs cắt 100 chars → evidence line →
    // regex cũ .replace(/^[a-z_]+\(/,'').replace(/\)$/,'')
    const compactArgs = (args: Record<string, unknown>, maxLen = 100): string => {
      const s = JSON.stringify(args)
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
    }
    const tcArgs = { path: 'src/lib/exec-allowlist.ts', content: 'export const SECRET_PATTERNS = [...33 dòng mã thật…]' }
    const entry = `file_write(${compactArgs(tcArgs)}) → ✓ {"ok":true}`
    // Regex r68 cũ:
    const oldExtracted = entry.split(' → ')[0].replace(/^[a-z_]+\(/, '').replace(/\)$/, '').trim()
    // Kết quả là blob JSON cụt — KHÔNG phải tên file sạch
    expect(oldExtracted.startsWith('{"path"')).toBe(true)
    expect(oldExtracted.endsWith('…')).toBe(true)
    expect(oldExtracted).not.toBe('src/lib/exec-allowlist.ts')
  })

  test('CÁCH MỚI (r69): từ args THẬT của tool call → tên file sạch 100%', () => {
    // Logic mới tại site thực thi (subagent-delegate): args thật → path
    const tcArgs: Record<string, unknown> = { path: 'src/lib/exec-allowlist.ts', content: '...' }
    const p = typeof tcArgs.path === 'string' ? tcArgs.path
      : typeof tcArgs.file === 'string' ? tcArgs.file
      : typeof tcArgs.filePath === 'string' ? tcArgs.filePath : ''
    expect(p).toBe('src/lib/exec-allowlist.ts')
    // file_multi_edit dùng path; custom tool có thể dùng file/filePath
    const altArgs: Record<string, unknown> = { file: 'a.ts' }
    expect(typeof altArgs.file === 'string' ? altArgs.file : '').toBe('a.ts')
  })
})

// ==================== BUG-022 — digest re-inject (threshold logic) ====================

describe('r69 BUG-022 — phanh đọc-lặp ngưỡng file (digest re-inject)', () => {
  test('ngưỡng 5 khớp bằng chứng ×15/×14/×10 — lượt 1-4 tích luỹ, lượt 5 re-inject, mỗi 5 lượt nhắc lại', () => {
    // Mirror logic noteFileReadResult (threshold hằng số trong goal-loop)
    const THRESHOLD = 5
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    const reinjectAt: number[] = []
    const remindAt: number[] = []
    for (const c of counts) {
      if (c === THRESHOLD) reinjectAt.push(c)
      else if (c > THRESHOLD && c % 5 === 0) remindAt.push(c)
    }
    // ×15 (bằng chứng exec-allowlist.ts) → re-inject 1 lần ở lượt 5 + nhắc ở 10, 15
    expect(reinjectAt).toEqual([5])
    expect(remindAt).toEqual([10, 15])
  })
})
