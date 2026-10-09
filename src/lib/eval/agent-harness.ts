/**
 * AGENT HARNESS — harness kiểm định NĂNG LỰC AGENT THẬT (Task 43)
 * ==================================================================
 * (user audit "agent harness": trước đây eval/redteam harness chỉ đánh giá
 * đường RAG/KB — KHÔNG có harness nào chạy CHÍNH agent (Omega/Code Team...)
 * qua task suite để đo agents dùng tool đúng đủ phù hợp.)
 *
 * Thiết kế (tái dùng tối đa hạ tầng sẵn có — không phát minh lại):
 *   - Mỗi task chạy qua runSubAgentForProfile — ĐÚNG engine delegation
 *     production (mini ReAct + tool thật + plan-first + depth guard).
 *   - Chấm điểm qua trọng tài độc lập có sẵn (outcome.evaluation —
 *     evaluateDelegationOutcome gắn sẵn trong runSubAgentForProfile).
 *   - Task suite mặc định: 3 task an toàn kiểm định được bằng tool thật
 *     (ghi file + đọc lại / đếm bằng lệnh máy / todo plan lifecycle) —
 *     exercise đúng các năng lực cốt lõi: file ops, shell verify, todo_write.
 *   - Chạy BACKGROUND (fire-and-forget từ API route); kết quả cuối lưu
 *     globalThis — GET poll lấy report (mirror pattern EvalRun).
 *
 * Tiêu hao: mỗi task ~1 sub-agent run (≤5 vòng, ≤40k token) + 1 evaluator
 * call — chạy theo yêu cầu (on-demand), KHÔNG chạy định kỳ.
 */

import { db } from '@/lib/db'
import { emitAgentEvent } from '@/lib/agent-event-bus'
import {
  runSubAgentForProfile,
  POSITION_BY_NAME,
  type SubAgentProfile,
  type SubAgentOutcome,
} from '@/lib/subagent-delegate'

// ==================== TASK SUITE ====================

export interface HarnessTask {
  id: string
  /** Nhiệm vụ gửi cho agent (ngôn ngữ như user thật giao việc) */
  task: string
  /** Điều kiện hoàn thành kiểm định được — trọng tài đối chiếu evidence */
  acceptanceCriteria: string
  /** Năng lực đang đo — dùng để chẩn đoán agent thiếu gì */
  measures: string
}

/**
 * Suite mặc định — 3 năng lực cốt lõi của MỌI agent làm việc:
 * (1) file ops + verify đọc lại, (2) lệnh máy đếm chính xác (derived-number),
 * (3) todo plan lifecycle. Tất cả an toàn trong workspace (thư mục .tmo-harness).
 */
export const DEFAULT_HARNESS_TASKS: HarnessTask[] = [
  {
    id: 'file-write-verify',
    task:
      'Tạo file .tmo-harness/task-1.txt với ĐÚNG 1 dòng nội dung: HARNESS-TASK-1-OK (dùng file_write). Sau đó ĐỌC LẠI file bằng file_read và trích dẫn nội dung đọc được trong báo cáo. Thư mục .tmo-harness có thể chưa tồn tại — tạo nếu cần (shell mkdir -p hoặc file_write tự tạo).',
    acceptanceCriteria:
      'xong khi file .tmo-harness/task-1.txt tồn tại với đúng 1 dòng "HARNESS-TASK-1-OK" VÀ báo cáo có trích dẫn nội dung đọc lại từ file_read (bằng chứng tool, không phải tuyên bố).',
    measures: 'file_write + file_read verify (không tin tuyên bố — tin bằng chứng đọc lại)',
  },
  {
    id: 'machine-count',
    task:
      'Dùng lệnh shell để đếm số dòng của file package.json ở thư mục làm việc (wc -l). Báo cáo CON SỐ CHÍNH XÁC từ output lệnh (không đếm bằng mắt). Trích dẫn output lệnh trong báo cáo.',
    acceptanceCriteria:
      'xong khi báo cáo nêu đúng con số dòng của package.json TRÍCH TỪ output lệnh wc -l (evidence có output lệnh chứa con số).',
    measures: 'shell + derived-number discipline (số liệu phải từ lệnh máy)',
  },
  {
    id: 'todo-plan-lifecycle',
    task:
      'Gọi todo_write tạo 2 todo: "Khảo sát thư mục .tmo-harness" và "Báo cáo kết quả". Đánh dấu todo ĐẦU TIÊN completed sau khi khảo sát xong (file_list hoặc shell ls .tmo-harness). Báo cáo trạng thái todo cuối cùng qua todo_read.',
    acceptanceCriteria:
      'xong khi có todo_write tạo ≥2 todo VÀ todo_read cuối cho thấy todo đầu tiên completed (không phải pending) trong cùng lần chạy.',
    measures: 'todo_write/todo_read plan lifecycle (kỷ luật kế hoạch)',
  },
]

// ==================== RESULT TYPES ====================

export interface HarnessTaskResult {
  taskId: string
  measures: string
  /** Sub-agent tự kết luận + trọng tài độc lập */
  success: boolean
  endedBy: SubAgentOutcome['endedBy']
  iterations: number
  toolCalls: number
  tokensUsed: number
  /** Trọng tài độc lập: pass/gaps — null khi evaluator fail-open */
  evaluation: SubAgentOutcome['evaluation'] | null
  reportExcerpt: string
}

export interface HarnessReport {
  agent: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'done' | 'error'
  tasks: HarnessTaskResult[]
  passRate: number | null
  totalTokens: number
  totalToolCalls: number
  error?: string
}

// ==================== STATE (poll qua GET) ====================

const globalForHarness = globalThis as unknown as {
  __tmoAgentHarnessLast?: HarnessReport
}

/** Kết quả harness gần nhất (hoặc đang chạy) — GET /api/eval/agent-harness. */
export function getLastHarnessReport(): HarnessReport | null {
  return globalForHarness.__tmoAgentHarnessLast ?? null
}

// ==================== PROFILE RESOLUTION ====================

/**
 * Resolve agent bất kỳ → SubAgentProfile:
 *   - Code Team (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST) →
 *     resolveAgent(position) (DB-first + fallback hardcoded)
 *   - Agent khác trong DB (Omega/Opus/research/custom/FORGE — user directive
 *     2026-10-09: FORGE tách khỏi Code Team, resolve by-name như standalone
 *     khác) → row AgentProfile (mirror dispatch_agent của Omega)
 */
async function resolveHarnessProfile(agentName: string): Promise<SubAgentProfile> {
  const name = agentName.trim()
  if (!name) throw new Error('Thiếu tên agent')

  const position = POSITION_BY_NAME[name.toUpperCase()]
  if (position) {
    const { resolveAgent } = await import('@/lib/code-team/agent-resolver')
    const resolved = await resolveAgent(position)
    return {
      id: resolved.id,
      name: resolved.name,
      instruction: resolved.instruction,
      provider: resolved.provider,
      model: resolved.model,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      tools: resolved.tools,
    }
  }

  const profile = await db.agentProfile.findFirst({ where: { name, enabled: true } })
  if (!profile) {
    throw new Error(`Agent "${name}" không tồn tại hoặc bị vô hiệu (kiểm tra GET /api/agents)`)
  }
  let tools: string[] = []
  if (typeof profile.tools === 'string' && profile.tools.trim()) {
    try {
      const parsed = JSON.parse(profile.tools)
      if (Array.isArray(parsed)) tools = parsed.map(String)
    } catch { /* keep [] — DEFAULT_SUBAGENT_TOOLS fallback trong runner */ }
  }
  return {
    id: profile.id,
    name: profile.name,
    instruction: profile.instruction || '',
    provider: profile.provider,
    model: profile.model,
    temperature: profile.temperature ?? 0.5,
    maxTokens: profile.maxTokens ?? -1,
    tools,
  }
}

// ==================== RUNNER ====================

/**
 * Chạy harness cho 1 agent qua task suite (mặc định 3 task). Trả về report
 * đầy đủ — caller (API route) gọi fire-and-forget và poll getLastHarnessReport.
 */
export async function runAgentHarness(params: {
  agent: string
  tasks?: HarnessTask[]
  sessionId?: string | null
}): Promise<HarnessReport> {
  const { agent, sessionId = null } = params
  const tasks = (params.tasks && params.tasks.length > 0 ? params.tasks : DEFAULT_HARNESS_TASKS).slice(0, 8)

  const report: HarnessReport = {
    agent,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    tasks: [],
    passRate: null,
    totalTokens: 0,
    totalToolCalls: 0,
  }
  globalForHarness.__tmoAgentHarnessLast = report
  emitAgentEvent('run_started', {
    agentName: agent,
    sessionId,
    data: { kind: 'agent-harness', taskCount: tasks.length },
  })

  try {
    const profile = await resolveHarnessProfile(agent)
    let passed = 0

    for (const task of tasks) {
      const outcome = await runSubAgentForProfile({
        profile,
        task: task.task,
        acceptanceCriteria: task.acceptanceCriteria,
        parentAgentName: 'agent-harness',
        sessionId,
      })
      const evalPass = outcome.evaluation ? outcome.evaluation.pass : outcome.success
      if (evalPass) passed++
      report.tasks.push({
        taskId: task.id,
        measures: task.measures,
        success: evalPass,
        endedBy: outcome.endedBy,
        iterations: outcome.iterations,
        toolCalls: outcome.toolCalls,
        tokensUsed: outcome.tokensUsed,
        evaluation: outcome.evaluation ?? null,
        reportExcerpt: outcome.report.slice(0, 600),
      })
      report.totalTokens += outcome.tokensUsed
      report.totalToolCalls += outcome.toolCalls
      emitAgentEvent('tool_executed', {
        agentName: profile.name,
        sessionId,
        data: { kind: 'harness-task', taskId: task.id, pass: evalPass, toolCalls: outcome.toolCalls, tokens: outcome.tokensUsed },
      })
      console.log(
        `[AgentHarness] ${profile.name} task "${task.id}": ${evalPass ? 'PASS' : 'FAIL'} (${outcome.toolCalls} tool calls, ${outcome.tokensUsed} tokens, endedBy=${outcome.endedBy})`,
      )
    }

    report.passRate = tasks.length > 0 ? passed / tasks.length : null
    report.status = 'done'
    report.finishedAt = new Date().toISOString()
    emitAgentEvent('run_terminal', {
      agentName: profile.name,
      sessionId,
      data: { kind: 'agent-harness', passRate: report.passRate, tasks: tasks.length },
    })
    console.log(
      `[AgentHarness] HOÀN TẤT ${profile.name}: ${passed}/${tasks.length} task đạt (${Math.round((report.passRate ?? 0) * 100)}%) — ${report.totalToolCalls} tool calls, ${report.totalTokens} tokens`,
    )
    return report
  } catch (err) {
    report.status = 'error'
    report.error = err instanceof Error ? err.message : String(err)
    report.finishedAt = new Date().toISOString()
    emitAgentEvent('run_terminal', {
      agentName: agent,
      sessionId,
      data: { kind: 'agent-harness', error: report.error },
    })
    console.error(`[AgentHarness] LỖI:`, report.error)
    return report
  }
}
