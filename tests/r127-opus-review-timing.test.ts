/**
 * R127 TESTS — OPUS REVIEW TIMING + THỨ TỰ ƯU TIÊN CHỈ ĐẠO
 * (user directive 2026-10-20: "khi agent đang xử lý tác vụ, nếu bật Opus
 * Review thì chỉ khi agent thực hiện xong tác vụ Opus mới tiến hành review
 * và ban hành chỉ thị công việc tiếp theo — ưu tiên đầu tiên của Opus là xử
 * lý các nợ kỹ thuật phát sinh, sau đó mới tiếp tục chỉ thị các phần việc để
 * hoàn thành yêu cầu ban đầu. Không review khi agent chưa hoàn thành tác vụ").
 *
 * Phạm vi regression (pattern r123/r124/r125/r126: nhóm A source-scan + nhóm
 * B logic-order):
 *   A1. agent-run-tracker.ts — hasActiveAgentTaskRun: loại trừ run review của
 *       chính Opus (agentName='Opus' / runId 'opus_rev_*') — nếu không, review
 *       của Opus tự chặn sweep/hook của chính nó với lý do sai.
 *   A2. pipeline.ts — isAgentTaskRunning: 2 nguồn tín hiệu (GoalLoopJob
 *       queued/running durable + tracker in-process) + KHÔNG xét
 *       AgentRunRecord DB 'running' (fire-and-forget close đua với hook →
 *       chặn oan review chính đáng).
 *   A3. pipeline.ts — passesAutoGate: BUSY-GUARD đứng SAU kill switch, TRƯỚC
 *       dedupe và TRƯỚC mọi tín hiệu A/B/C/D (sweep reconciliation không được
 *       review xuyên qua tác vụ đang chạy).
 *   A4. review route — manual cũng bị chặn (409 'agent-task-running' kèm
 *       note) + đứng TRƯỚC mutex opus-review-running và KHÔNG giữ lock.
 *   A5. smolab-module.tsx — UI phân biệt 2 loại 409 (agent-task-running ≠
 *       opus-review-running) với message đúng ý user.
 *   A6. opus-agent.ts — OPUS_INSTRUCTION có khối THỨ TỰ ƯU TIÊN CHỈ ĐẠO
 *       (nợ kỹ thuật TRƯỚC → yêu cầu gốc SAU) + nguyên tắc chỉ review run
 *       ĐÃ KẾT THÚC ở §III.
 *   A7. dossier.ts — §6b DebtLedger (nợ hạ tầng của phiên, open/in_progress)
 *       được build vào dossier để Opus THẤY nợ phát sinh mà giao xử lý trước.
 *   B.  Logic-order thuần (string indexOf trên source thật — không DB):
 *       thứ tự các mốc trong gate, trong khối ưu tiên directive, và trong
 *       render directive message.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(p, 'utf8')

// ==================== A1. TRACKER — hasActiveAgentTaskRun ====================

describe('R127 A1 · agent-run-tracker.ts — hasActiveAgentTaskRun loại trừ run của chính Opus', () => {
  const src = read('src/lib/agent-run-tracker.ts')

  test('A1.1: export hasActiveAgentTaskRun — nguồn in-process cho BUSY-GUARD', () => {
    expect(src).toMatch(/export function hasActiveAgentTaskRun\(/)
  })

  test('A1.2: chỉ tính run status=running VÀ KHÔNG phải run của Opus (agentName + runId prefix)', () => {
    const idx = src.indexOf('export function hasActiveAgentTaskRun')
    expect(idx).toBeGreaterThan(0)
    const body = src.slice(idx, idx + 1400)
    expect(body).toMatch(/r\.status === 'running'/)
    expect(body).toMatch(/r\.agentName !== 'Opus'/)
    expect(body).toMatch(/startsWith\('opus_rev_'\)/)
  })

  test('A1.3: fail-open — lỗi registry trả false (không chặn review bằng registry hỏng)', () => {
    const idx = src.indexOf('export function hasActiveAgentTaskRun')
    const body = src.slice(idx, idx + 1400)
    // catch cuối hàm trả false — không được trả true (busy) khi registry lỗi
    expect(body).toMatch(/\} catch \{\s*\n\s*return false\s*\n\s*\}/)
  })
})

// ==================== A2. PIPELINE — isAgentTaskRunning ====================

describe('R127 A2 · pipeline.ts — isAgentTaskRunning (2 nguồn tín hiệu an toàn cho hook)', () => {
  const src = read('src/lib/opus/pipeline.ts')

  test('A2.1: export isAgentTaskRunning + interface AgentTaskBusyState', () => {
    expect(src).toMatch(/export async function isAgentTaskRunning\(/)
    expect(src).toMatch(/export interface AgentTaskBusyState/)
  })

  test('A2.2: nguồn (1) durable — GoalLoopJob status queued/running', () => {
    const idx = src.indexOf('export async function isAgentTaskRunning')
    const body = src.slice(idx, idx + 1200)
    expect(body).toMatch(/db\.goalLoopJob\.findFirst/)
    expect(body).toMatch(/status: \{ in: \['queued', 'running'\] \}/)
  })

  test('A2.3: nguồn (2) in-process — gọi hasActiveAgentTaskRun (đã import tĩnh)', () => {
    const idx = src.indexOf('export async function isAgentTaskRunning')
    const body = src.slice(idx, idx + 1200)
    expect(body).toMatch(/hasActiveAgentTaskRun\(sessionId\)/)
    expect(src).toMatch(/import \{ hasActiveAgentTaskRun \} from '@\/lib\/agent-run-tracker'/)
  })

  test('A2.4: KHÔNG xét AgentRunRecord DB status running (chống chặn oan — fire-and-forget close đua hook)', () => {
    const idxFn = src.indexOf('export async function isAgentTaskRunning')
    // JSDoc thiết kế nằm TRƯỚC dòng export — bao cả khối doc (lý do bỏ nguồn DB)
    const docStart = src.lastIndexOf('/**', idxFn)
    const body = src.slice(docStart, src.indexOf('async function passesAutoGate'))
    expect(body).not.toMatch(/agentRunRecord\.findFirst/)
    // ghi chú thiết kế phải nói rõ lý do bỏ qua nguồn này (chống regress nhầm)
    expect(body).toContain('KHÔNG xét AgentRunRecord DB')
  })
})

// ==================== A3. GATE — BUSY-GUARD ordering ====================

describe('R127 A3 · pipeline.ts — passesAutoGate: BUSY-GUARD chặn MỌI tín hiệu khi agent đang chạy', () => {
  const src = read('src/lib/opus/pipeline.ts')

  test('A3.1: gate gọi isAgentTaskRunning và skip với reason nói rõ chỉ review SAU khi hoàn thành', () => {
    const gateIdx = src.indexOf('async function passesAutoGate')
    const gateBody = src.slice(gateIdx, gateIdx + 12000)
    expect(gateBody).toMatch(/const busy = await isAgentTaskRunning\(sessionId\)/)
    expect(gateBody).toMatch(/Opus chỉ review SAU khi agent hoàn thành tác vụ/)
  })

  test('A3.2: BUSY-GUARD đứng SAU kill switch (mode + kill vẫn là 2 check đầu)', () => {
    const gateIdx = src.indexOf('async function passesAutoGate')
    const gateBody = src.slice(gateIdx, gateIdx + 12000)
    const idxKill = gateBody.indexOf('if (await isKilled())')
    const idxBusy = gateBody.indexOf('const busy = await isAgentTaskRunning')
    expect(idxKill).toBeGreaterThan(0)
    expect(idxBusy).toBeGreaterThan(idxKill)
  })

  test('A3.3: BUSY-GUARD đứng TRƯỚC dedupe 45s (skip busy không tiêu tốn cửa sổ dedupe)', () => {
    const gateIdx = src.indexOf('async function passesAutoGate')
    const gateBody = src.slice(gateIdx, gateIdx + 12000)
    const idxBusy = gateBody.indexOf('const busy = await isAgentTaskRunning')
    const idxDedupe = gateBody.indexOf('AUTO_REVIEW_DEDUPE_MS) {')
    expect(idxDedupe).toBeGreaterThan(0)
    expect(idxBusy).toBeGreaterThan(0)
    expect(idxBusy).toBeLessThan(idxDedupe)
  })

  test('A3.4: BUSY-GUARD đứng TRƯỚC tín hiệu A (assistant message mới) — sweep không review xuyên tác vụ đang chạy', () => {
    const gateIdx = src.indexOf('async function passesAutoGate')
    const gateBody = src.slice(gateIdx, gateIdx + 16000)
    const idxBusy = gateBody.indexOf('const busy = await isAgentTaskRunning')
    const idxSignalA = gateBody.indexOf('TÍN HIỆU A')
    expect(idxSignalA).toBeGreaterThan(0)
    expect(idxBusy).toBeLessThan(idxSignalA)
  })
})

// ==================== A4. ROUTE MANUAL — 409 agent-task-running ====================

describe('R127 A4 · review route — manual review cũng chặn khi agent đang chạy', () => {
  const src = read('src/app/api/opus/review/route.ts')

  test('A4.1: import + gọi isAgentTaskRunning TRƯỚC mutex markReviewRunning (không giữ lock khi từ chối)', () => {
    expect(src).toMatch(/isAgentTaskRunning,?\s*\} from '@\/lib\/opus\/pipeline'/)
    const idxBusy = src.indexOf('const busy = await isAgentTaskRunning(sessionId)')
    const idxMutex = src.indexOf('if (!markReviewRunning(sessionId))')
    expect(idxBusy).toBeGreaterThan(0)
    expect(idxMutex).toBeGreaterThan(idxBusy)
  })

  test('A4.2: trả 409 với error=agent-task-running + note giải thích đúng ý user', () => {
    const idxBusy = src.indexOf("error: 'agent-task-running'")
    expect(idxBusy).toBeGreaterThan(0)
    const slice = src.slice(idxBusy - 200, idxBusy + 500)
    expect(slice).toMatch(/status: 409/)
    expect(slice).toMatch(/Opus chỉ review sau khi agent hoàn thành tác vụ/)
  })
})

// ==================== A5. UI — phân biệt 2 loại 409 ====================

describe('R127 A5 · smolab-module.tsx — toast đúng loại 409', () => {
  const src = read('src/components/smolab/smolab-module.tsx')

  test('A5.1: handleOpusReview parse body 409 và nhánh agent-task-running riêng', () => {
    expect(src).toMatch(/errData\?\.error === 'agent-task-running'/)
  })

  test('A5.2: nhánh agent-task-running giữ lại message cũ cho opus-review-running', () => {
    const idx = src.indexOf("errData?.error === 'agent-task-running'")
    const slice = src.slice(idx, idx + 1600)
    expect(slice).toMatch(/Agent đang xử lý tác vụ/)
    expect(slice).toMatch(/chỉ review sau khi agent hoàn thành tác vụ/)
    expect(slice).toMatch(/Opus đang review — chờ chút/)
  })
})

// ==================== A6. INSTRUCTION — ưu tiên chỉ đạo ====================

describe('R127 A6 · opus-agent.ts — OPUS_INSTRUCTION: nợ trước, yêu cầu gốc sau', () => {
  const src = read('src/lib/opus/opus-agent.ts')

  test('A6.1: khối THỨ TỰ ƯU TIÊN BAN HÀNH CHỈ ĐẠO tồn tại trong §V (sau 5 động từ)', () => {
    const idxVerbs = src.indexOf('━━━ V. GIAO THỨC 5 ĐỘNG TỪ')
    const idxPrio = src.indexOf('THỨ TỰ ƯU TIÊN BAN HÀNH CHỈ ĐẠO')
    const idxFormat = src.indexOf('━━━ VI. FORMAT CHỈ ĐẠO')
    expect(idxVerbs).toBeGreaterThan(0)
    expect(idxPrio).toBeGreaterThan(idxVerbs)
    expect(idxPrio).toBeLessThan(idxFormat)
  })

  test('A6.2: trong khối ưu tiên — NỢ KỸ THUẬT PHÁT SINH TRƯỚC > HOÀN THÀNH YÊU CẦU GỐC', () => {
    const idxPrio = src.indexOf('THỨ TỰ ƯU TIÊN BAN HÀNH CHỈ ĐẠO')
    const block = src.slice(idxPrio, idxPrio + 1200)
    const idxDebt = block.indexOf('NỢ KỸ THUẬT PHÁT SINH TRƯỚC')
    const idxOrigin = block.indexOf('HOÀN THÀNH YÊU CẦU GỐC')
    expect(idxDebt).toBeGreaterThan(0)
    expect(idxOrigin).toBeGreaterThan(idxDebt)
    // directive còn nợ blocking/major chưa giao → CHƯA hợp lệ (ràng buộc cứng)
    expect(block).toMatch(/CHƯA hợp lệ/)
  })

  test('A6.3: §III có nguyên tắc thời điểm — chỉ review run ĐÃ KẾT THÚC, không phán quyết nửa vời', () => {
    const idx3 = src.indexOf('━━━ III. GIAO THỨC REVIEW')
    const idx4 = src.indexOf('━━━ IV. 5 TRỤC ĐÁNH GIÁ')
    const section = src.slice(idx3, idx4)
    expect(section).toMatch(/chỉ review run ĐÃ KẾT THÚC/)
    expect(section).toMatch(/không bao giờ review giữa chừng/)
    expect(section).toMatch(/ESCALATE hỏi lại thay vì phán quyết nửa vời/)
  })
})

// ==================== A7. DOSSIER — §6b DebtLedger ====================

describe('R127 A7 · dossier.ts — §6b nợ hạ tầng DebtLedger trong dossier', () => {
  const src = read('src/lib/opus/dossier.ts')

  test('A7.1: sectionDebtLedger query theo originSessionId + status open/in_progress, cap 10', () => {
    const idx = src.indexOf('async function sectionDebtLedger')
    expect(idx).toBeGreaterThan(0)
    const body = src.slice(idx, idx + 1600)
    expect(body).toMatch(/db\.debtLedger\.findMany/)
    expect(body).toMatch(/originSessionId: sessionId/)
    expect(body).toMatch(/status: \{ in: \['open', 'in_progress'\] \}/)
    expect(body).toMatch(/take: 10/)
  })

  test('A7.2: buildOpusDossier nối §6b vào SAU §6 (chỉ khi có nợ — null bỏ qua)', () => {
    expect(src).toMatch(/s6b\] = await Promise\.all/)
    expect(src).toMatch(/if \(s6b\) sections\.push\(s6b\)/)
  })

  test('A7.3: fail-open — query lỗi trả null (không làm hỏng dossier)', () => {
    const idx = src.indexOf('async function sectionDebtLedger')
    const body = src.slice(idx, idx + 1600)
    expect(body).toMatch(/\} catch \{\s*\n\s*return null/)
  })
})

// ==================== B. LOGIC-ORDER THUẦN (không DB) ====================

describe('R127 B · logic-order — vòng auto loop đúng trình tự user yêu cầu', () => {
  const pipeline = read('src/lib/opus/pipeline.ts')

  test('B1: hook-completion an toàn — markCompleted chạy TRƯỚC hook maybeAutoOpusReview trong worker', () => {
    const worker = read('src/lib/goal-loop-worker.ts')
    // mark completed (updateMany status completed) phải nằm trước hook opus
    const idxMark = worker.indexOf("data: {\n            status: 'completed',")
    const idxHook = worker.indexOf('void maybeAutoOpusReview(job.sessionId, {')
    expect(idxMark).toBeGreaterThan(0)
    expect(idxHook).toBeGreaterThan(idxMark)
  })

  test('B2: fail-path an toàn — markFailed đóng tracker (endAgentRun) TRƯỚC hook opus', () => {
    const worker = read('src/lib/goal-loop-worker.ts')
    const idxMarkFailed = worker.indexOf('private async markFailed(')
    const failBody = worker.slice(idxMarkFailed, idxMarkFailed + 8000)
    const idxEndRun = failBody.indexOf('endAgentRun(')
    const idxHook = failBody.indexOf('maybeAutoOpusReview')
    expect(idxEndRun).toBeGreaterThan(0)
    expect(idxHook).toBeGreaterThan(idxEndRun)
  })

  test('B3: gate skip có modeAuto=true — busy KHÔNG bị coi như "session manual" (sweep vẫn xét lại tick sau)', () => {
    const idx = pipeline.indexOf('agent đang xử lý tác vụ (${busy.detail})')
    expect(idx).toBeGreaterThan(0)
    const slice = pipeline.slice(idx, idx + 400)
    expect(slice).toMatch(/modeAuto: true/)
  })
})
