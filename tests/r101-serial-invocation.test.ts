/**
 * ROUND-101 TESTS — R14 TUẦN TỰ HÓA AGENT INVOCATION (user directive bản 3)
 * ============================================================================
 *
 * User directive (ghi đè bản 2 2026-10-29b "3 đồng thời"): "agents khi gọi
 * agent khác tham gia xử lý tác vụ thì mỗi lượt chỉ gọi thêm 1, lần lượt
 * agent này xử lý xong mới tới agent khác để khỏi vấn đề lỗi; nếu gọi team
 * thì lần lượt từng thành viên".
 *
 * Đo lường:
 *   A. Pool config (BEHAVIORAL): getSubAgentSlotPoolInfo() — mặc định 1 tuần tự
 *      (env unset → default=1; env set hợp lệ → env floor; env xấu → default).
 *      Pool idle lúc module load: busySlots=0, waiting=0.
 *   B. Source-contract pins — 4 call-site TUẦN TỰ (grep vùng hàm, không tin
 *      comment ngoài hàm):
 *      B1 subagent-delegate.ts: default `: 1` + boot log "Phanh hiệu dụng
 *         (R14)" + export getSubAgentSlotPoolInfo + runSubAgentForProfile
 *         vẫn acquire/release qua slot pool (điểm đi qua duy nhất).
 *      B2 omega-orchestrator.ts dispatchAgentsParallel: KHÔNG Promise.all/
 *         allSettled trong thân hàm; có for-await tuần tự + log trung thực
 *         "TUẦN TỰ" (xóa log "chạy song song — slot pool điều tiết tối đa 3").
 *      B3 research-team/g1/sub-agents.ts dispatchPlan: KHÔNG allSettled;
 *         có for-await từng SA + log "SA dispatch tuần tự".
 *      B4 research-team/king/engine.ts blind scorers: KHÔNG Promise.all;
 *         2 callLLMForAgent tuần tự (r1 await xong mới r2).
 *   C. Truthful docs: tool description dispatch_agents_parallel (tool-executor)
 *      + goal-loop hint/log không còn mô tả "đồng thời/3 cùng lúc" sai sự thật.
 *   D. .env.example: SUBAGENT_MAX_CONCURRENT=1 có mục + chú thích kill-switch.
 *
 * Nguyên tắc test:
 * - A import module thật (đi qua db-isolation preload của gate); B-D thuần
 *   readFileSync theo precedent tc-07/r97 (pin wiring khi race/LLM không
 *   behavioral-test được — bài học BUG2-210).
 * - Kỳ vọng DẪN NGUỒN ĐƯỢC: mỗi expect kèm nguồn (directive R14 / dòng code).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSubAgentSlotPoolInfo } from '@/lib/subagent-delegate'

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

/** Trích toàn bộ hàm (signature + body) bằng brace-counting — an toàn với
 *  template literal `${...}` (cặp {}) và chuỗi chứa cặp {} cân bằng.
 *  Phân biệt body-open với return-type `Promise<{...}>` qua ký tự ngay trước `{`. */
function extractFn(src: string, fnName: string, prefix = 'export async function'): string {
  const start = src.indexOf(`${prefix} ${fnName}`)
  if (start < 0) throw new Error(`function ${fnName} not found`)
  // sigEnd = '):' kết thúc params (trong `}): Promise<...>`)
  const sigEnd = src.indexOf('):', start)
  if (sigEnd < 0) throw new Error(`signature end not found for ${fnName}`)
  const firstBrace = src.indexOf('{', sigEnd)
  if (firstBrace < 0) throw new Error(`no brace after signature for ${fnName}`)
  let bodyOpen: number
  if (src[firstBrace - 1] === '<') {
    // `{` này mở return-type object `Promise<{...}>` — đếm tới đóng, body-open là `{` kế tiếp
    let depth = 0
    let rtClose = -1
    for (let i = firstBrace; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { rtClose = i; break }
      }
    }
    if (rtClose < 0) throw new Error(`return type not closed for ${fnName}`)
    bodyOpen = src.indexOf('{', rtClose + 1)
    if (bodyOpen < 0) throw new Error(`body open not found for ${fnName}`)
  } else {
    bodyOpen = firstBrace
  }
  // brace-count thân hàm tới depth 0
  let depth = 0
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 2)
    }
  }
  throw new Error(`function ${fnName} body not closed`)
}

describe('R101 · A. Pool config (behavioral)', () => {
  test('A1 — mặc định 1 TUẦN TỰ (env unset → default=1; env hợp lệ → floor env)', () => {
    const info = getSubAgentSlotPoolInfo()
    const envRaw = Number(process.env.SUBAGENT_MAX_CONCURRENT)
    const envSet = Number.isFinite(envRaw) && envRaw >= 1
    // Hợp đồng R14: default=1 khi env không set/xấu (nguồn: subagent-delegate.ts
    // `: 1`); env set hợp lệ → floor(env) (kill-switch quay lại bản 2).
    expect(info.maxConcurrent).toBe(envSet ? Math.floor(envRaw) : 1)
    expect(info.source).toBe(envSet ? 'env' : 'default')
  })

  test('A2 — pool idle lúc test chạy: busySlots=0, waiting=0', () => {
    const info = getSubAgentSlotPoolInfo()
    expect(info.busySlots).toBe(0)
    expect(info.waiting).toBe(0)
  })

  test('A3 — gọi 2 lần liên tiếp cho cùng giá trị (thuần read, no side-effect)', () => {
    const a = getSubAgentSlotPoolInfo()
    const b = getSubAgentSlotPoolInfo()
    expect(a).toEqual(b)
  })
})

describe('R101 · B. Source-contract — 4 call-site TUẦN TỰ', () => {
  test('B1 — subagent-delegate.ts: default=1 + boot log + export + acquire/release', () => {
    const src = readSrc('src/lib/subagent-delegate.ts')
    // default 1 (dòng quyết định — không phải comment)
    expect(src).toContain('? Math.floor(rawSubagentMaxConcurrent)\n  : 1')
    // boot log phanh (R12 lesson: mọi phanh phải có boot log đối chiếu được)
    expect(src).toContain('[SubAgentSlot] Phanh hiệu dụng (R14): maxConcurrent=')
    expect(src).toContain('TUẦN TỰ, mỗi lượt 1 sub-agent, hoàn tất mới tới kế tiếp')
    // observability export
    expect(src).toContain('export function getSubAgentSlotPoolInfo')
    // điểm đi qua duy nhất: runSubAgentForProfile acquire → finally release
    const runFn = extractFn(src, 'runSubAgentForProfile')
    expect(runFn).toContain('await acquireSubAgentSlot(profileName, parentName)')
    expect(runFn).toContain('finally')
    expect(runFn).toContain('releaseSubAgentSlot(slot)')
  })

  test('B2 — omega-orchestrator.ts dispatchAgentsParallel: for-await tuần tự, KHÔNG Promise.all*', () => {
    const src = readSrc('src/lib/omega-orchestrator.ts')
    const fn = extractFn(src, 'dispatchAgentsParallel')
    expect(fn).not.toContain('Promise.allSettled')
    expect(fn).not.toContain('Promise.all(')
    expect(fn).toContain('for (const [fanIdx, t] of valid.entries())')
    expect(fn).toContain('FAN-OUT tuần tự ${fanIdx + 1}/${valid.length}')
    // log trung thực — xóa mô tả "chạy song song" của bản 2
    expect(fn).toContain('TUẦN TỰ: mỗi lượt 1 sub-agent, hoàn tất (kết quả + evaluation) mới tới kế tiếp')
    expect(src).not.toContain('sub-agent chạy song song — slot pool điều tiết tối đa 3')
    // fail-open từng dispatch giữ nguyên (lỗi 1 agent không sập batch)
    expect(fn).toContain('KHÔNG sập batch')
  })

  test('B3 — g1/sub-agents.ts dispatchPlan: for-await từng SA, KHÔNG allSettled', () => {
    const src = readSrc('src/lib/research-team/g1/sub-agents.ts')
    const fn = extractFn(src, 'dispatchPlan')
    expect(fn).not.toContain('Promise.allSettled')
    expect(fn).not.toContain('Promise.all(')
    expect(fn).toContain('for (const [saIdx, sa] of plan.tasks.entries())')
    expect(fn).toContain('SA dispatch tuần tự ${saIdx + 1}/${plan.tasks.length}')
    // fail-open: SA lỗi → FAILED, SA sau vẫn chạy
    expect(fn).toContain("status: 'FAILED' as SubAgentStatus")
    // doc §4 đổi mặc định (thuần doc-fidelity)
    expect(src).toContain('TUẦN TỰ mặc định, user directive R14')
  })

  test('B4 — king/engine.ts blind scorers: 2 judge tuần tự, KHÔNG Promise.all (extractFn — pin mạnh hơn region heuristic)', () => {
    const src = readSrc('src/lib/research-team/king/engine.ts')
    // FB-SERIAL-R1-08: extractFn thay region heuristic (region trượt nếu
    // BLIND_SCORE_SYSTEM_PROMPT được dùng thêm chỗ khác).
    const region = extractFn(src, 'llmScoreHypothesisBlind', 'async function')
    expect(region).not.toContain('await Promise.all([')
    expect(region).toContain('const r1 = await callLLMForAgent')
    expect(region).toContain('const r2 = await callLLMForAgent')
    // r1 đứng TRƯỚC r2 trong source (tuần tự — thứ tự vị trí)
    expect(region.indexOf('const r1 = await callLLMForAgent')).toBeGreaterThanOrEqual(0)
    expect(region.indexOf('const r2 = await callLLMForAgent')).toBeGreaterThan(
      region.indexOf('const r1 = await callLLMForAgent'),
    )
  })

  test('B5 — FB-SERIAL-R1-01 (P2): nested-delegation chặn bằng ALS re-entrancy', () => {
    const sd = readSrc('src/lib/subagent-delegate.ts')
    // export + ALS + fail-open outcome trong runSubAgentForProfile
    expect(sd).toContain('export function isInsideSubAgentRun(): boolean')
    expect(sd).toContain('const subAgentRunALS = new AsyncLocalStorage')
    expect(sd).toContain('NESTED_DELEGATION_BLOCKED (R14): context hiện đang giữ slot pool sub-agent')
    // wrap holding quanh inner run
    const runFn = extractFn(sd, 'runSubAgentForProfile')
    expect(runFn).toContain('if (isInsideSubAgentRun())')
    expect(runFn).toContain('subAgentRunALS.run({ holding: true }, () =>')
    // guard tool-executor escalate bổ sung ALS (không chỉ delegationRunId)
    const te = readSrc('src/lib/code-team/tool-executor.ts')
    const gi = te.indexOf('let calledFromSubAgent = Boolean(context?.delegationRunId)')
    expect(gi).toBeGreaterThanOrEqual(0)
    const guardRegion = te.slice(gi - 400, gi + 700)
    expect(guardRegion).toContain("const { isInsideSubAgentRun } = await import('@/lib/subagent-delegate')")
    expect(guardRegion).toContain('if (isInsideSubAgentRun()) calledFromSubAgent = true')
  })

  test('B6 — FB-SERIAL-R1-02/03 + JD strings + sivil comments: hết prompt sống nói "song song"', () => {
    // R1-02: standalone OMEGA instruction
    const sa = readSrc('src/lib/standalone-agents.ts')
    expect(sa).not.toContain('chạy song song tối đa 3 sub-agent')
    expect(sa).toContain('chạy TUẦN TỰ: mỗi lượt 1 sub-agent hoàn tất mới tới kế tiếp — user directive R14')
    // R1-03: SIVIL identity prompt
    const ag = readSrc('src/lib/research-team/agents.ts')
    expect(ag).not.toContain('EXPLORE SONG SONG')
    expect(ag).toContain('EXPLORE THEO LƯỢT — TUẦN TỰ, mỗi lượt 1 sub-agent')
    // JD strings (R1-08a) — 3 nguồn
    expect(ag).toContain('dispatch THEO LƯỢT, mỗi lượt 1 sub-agent (R14, tuần tự)')
    const ct = readSrc('src/lib/research-team/constants.ts')
    expect(ct).not.toContain('explore song song')
    expect(ct).toContain('theo lượt — tuần tự, mỗi lượt 1 sub-agent')
    const sv = readSrc('src/lib/research-team/g1/sivil.ts')
    expect(sv).toContain('theo lượt — tuần tự (R14)')
    expect(sv).not.toContain('(parallel waves)')
    expect(sv).toContain('R14: tuần tự, mỗi lượt 1 SA')
  })

  test('B7 — FB-SERIAL-R1-04/07: comment khối tool + S1 citation trung thực', () => {
    const te = readSrc('src/lib/code-team/tool-executor.ts')
    // R1-04: comment khối — region mở rộng bao cả comment (từ trước name 260 ký tự)
    const i = te.indexOf("name: 'dispatch_agents_parallel'")
    const region = te.slice(Math.max(0, i - 260), i + 1500)
    expect(region).toContain('Dispatch NHIỀU sub-agent TUẦN TỰ (mỗi lượt 1 — user directive R14)')
    expect(region).not.toContain('Dispatch NHIỀU sub-agent ĐỒNG THỜI')
    // R1-07: S1 spec citation trung thực trong dispatchPlan
    const su = readSrc('src/lib/research-team/g1/sub-agents.ts')
    expect(su).toContain('CHƯA triển khai; fail-open tiếp tục (xem FB-SERIAL-R1-07)')
    // R1-06: TB-03 note R14
    const tb = readSrc('docs/blueprints/TB-03-g1-engine-sivil-beli.md')
    expect(tb).toContain('NOTE R14 (2026-10-15')
    expect(tb).toContain('tạm ngưng')
  })

  test('B9 — FB-SERIAL-R2-01/02/03/04 (vòng R2): hết văn-bản-sống "song song" sai sự thật (quét TOÀN FILE, không chỉ vùng fix)', () => {
    // R2-01 (P3): protocol delegation dạy đúng cơ chế pool 1-slot
    const gl = readSrc('src/lib/agent-goal-loop.ts')
    expect(gl).not.toContain('hệ thống tự chạy SONG SONG')
    expect(gl).toContain('hệ thống tự XẾP HÀNG TUẦN TỰ (pool 1-slot')
    // R2-02: thought 📤/📥
    expect(gl).not.toContain('PHÂN CÔNG SONG SONG')
    expect(gl).not.toContain('KẾT QUẢ PHÂN CÔNG SONG SONG')
    expect(gl).toContain('PHÂN CÔNG THEO LƯỢT (tuần tự — pool 1-slot R14)')
    // R2-03: comment block thực thi tool + tool list standalone + workspace-git
    const te = readSrc('src/lib/code-team/tool-executor.ts')
    expect(te).not.toContain('Dispatch nhiều sub-agent SONG SONG')
    const sa = readSrc('src/lib/standalone-agents.ts')
    expect(sa).not.toContain('dispatch 2-4 sub-agent\n      // SONG SONG')
    expect(sa).not.toContain('SONG SONG + hợp nhất')
    const wg = readSrc('src/lib/workspace-git.ts')
    expect(wg).toContain('Từ R14 sub-agent chạy tuần tự (pool 1-slot)')
    // R2-04: code-team prompt tool-calls
    const cp = readSrc('src/lib/code-team/prompts.ts')
    expect(cp).not.toContain('Tool calls có thể song song')
    expect(cp).toContain('thực thi LẦN LƯỢT theo thứ tự (R14 — tuần tự)')
  })

  test('B8 — FB-SERIAL-R1-08b: dispatchPlanInBatches tuần tự-gián-tiếp + goal-loop evidence', () => {
    const su = readSrc('src/lib/research-team/g1/sub-agents.ts')
    const batchFn = extractFn(su, 'dispatchPlanInBatches', 'async function')
    // batch tuần tự: mỗi batch gọi await dispatchPlan (bên trong giờ tuần tự) —
    // không Promise.all map (nếu ai đổi thành Promise.all → quay lại song song
    // không tiếng động — pin này bắt được)
    expect(batchFn).not.toContain('Promise.all')
    expect(batchFn).toContain('await dispatchPlan(batchPlan)')
    // goal-loop evidence text (C2 thiếu pin positive)
    const gl = readSrc('src/lib/agent-goal-loop.ts')
    expect(gl).toContain('đã chạy TUẦN TỰ qua hàng đợi pool 1-slot (mỗi lượt 1 sub-agent hoàn tất mới tới kế tiếp — user directive R14)')
  })
})

describe('R101 · C. Truthful docs — tool description + goal-loop hint/log', () => {
  test('C1 — dispatch_agents_parallel description: TUẦN TỰ, hết "chạy ĐỒNG THỜI"', () => {
    const src = readSrc('src/lib/code-team/tool-executor.ts')
    const i = src.indexOf("name: 'dispatch_agents_parallel'")
    const region = src.slice(i, i + 1600)
    expect(region).toContain('TUẦN TỰ: mỗi lượt 1 sub-agent chạy xong (kết quả + evaluation) mới tới kế tiếp')
    expect(region).not.toContain('chạy ĐỒNG THỜI')
    expect(region).not.toContain('tối đa 3 sub-agent')
    // giải thích tương thích tên: "parallel" là tên call-site, hành vi tuần tự
    expect(region).toContain('Tên giữ "parallel" cho tương thích call-site')
  })

  test('C2 — goal-loop: hint + log + evidence hết mô tả 3-đồng-thời, có TUẦN TỰ R14', () => {
    const src = readSrc('src/lib/agent-goal-loop.ts')
    // hint directive (DELEGATE hint cho LLM)
    expect(src).toContain('chạy TUẦN TỰ: mỗi lượt 1 sub-agent hoàn tất mới tới kế tiếp (user directive R14')
    expect(src).not.toContain('chạy song song tối đa 3 sub-agent cùng lúc')
    // log + thought + evidence
    expect(src).toContain('hàng đợi FIFO pool 1-slot, thực thi TUẦN TỰ')
    expect(src).not.toContain('launch đồng thời, slot pool điều tiết tối đa 3 sub-agent')
    expect(src).not.toContain('delegation đã chạy song song (slot pool điều tiết ≤3')
  })

  test('C3 — .env.example có SUBAGENT_MAX_CONCURRENT=1 + chú thích kill-switch', () => {
    const env = readSrc('.env.example')
    expect(env).toContain('SUBAGENT_MAX_CONCURRENT=1')
    expect(env).toContain('Kill-switch: đặt 3 để quay lại chế độ song song của bản 2')
  })
})
