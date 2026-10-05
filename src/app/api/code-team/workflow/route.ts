/**
 * Code Team — Workflow SSE API Endpoint
 *
 * POST /api/code-team/workflow
 *
 * Accepts a workflow request and returns SSE (Server-Sent Events) stream
 * with real-time workflow events from the Code Team.
 *
 * Request body:
 *   - messages: Array<{ role: string; content: string }> — Chat history
 *   - sessionId: string — Session ID for tracking
 *   - userRequest: string — The user's current request (e.g., "triển khai feature login")
 *   - routing?: RoutingDecision — Pre-computed routing from TL Assessment (Phase 2: Smart TL Bridge)
 *     If provided, TL analyze step is skipped and pipeline starts immediately.
 *   - continueOnDisconnect?: boolean — Whether workflow continues in backend after client disconnects (default: true)
 *
 * Query parameters:
 *   - continueOnDisconnect=true (default) — Workflow continues running in background after client disconnects
 *   - continueOnDisconnect=false — Workflow aborts when client disconnects (old behavior)
 *
 * SSE Events emitted:
 *   - workflow_start: { sessionId }
 *   - agent_start: { agent, position, step, avatar, description }
 *   - agent_chunk: { agent, position, content, iteration } — ROUND-42: persist
 *     thought snapshot vào DB (metadata.teamThought) để panel hiển thị "nghĩ
 *     gì" của TỪNG AGENT sau reload (trước đây thoughts chỉ sống trong SSE —
 *     reload mất trắng).
 *   - agent_complete: { agent, position, step, content, duration }
 *   - tool_call: { agent, position, tool, detail }
 *   - tool_result: { agent, position, tool, result, detail, duration } —
 *     ROUND-42: persist (metadata.toolResult) để panel giữ ✓/✗ + duration +
 *     preview sau reload.
 *   - checkpoint: { after, step, decision?, reasoning?, agent, position } —
 *     ROUND-42: mang tên TL (agent) + persist structured metadata.checkpoint.
 *   - workflow_done: { totalDuration, sessionId, status }
 *   - omega_escalation: { advisory, reason, tokensUsed, agent?, position? } — AUTO-ESCALATE → Omega
 *   - error: { agent?, message }
 *   - heartbeat: { timestamp } — sent every 15s to keep connection alive
 */

import { NextRequest } from 'next/server'
import { runWorkflow } from '@/lib/code-team/workflow-engine'
import { db } from '@/lib/db'
// SESSION TOMBSTONE (fix review 2026-09-08 — HIGH): workflow chạy trong session
// đã bị user xóa → KHÔNG persist (chống hồi sinh phiên + chatMessage mồ côi).
import { isSessionDeleted, isSessionDeletedDeep } from '@/lib/session-tombstone'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min timeout for long workflows

/**
 * USER REQUEST 2026-09-01 (session persistence): persist team workflow events
 * vào ChatMessage DB ngay khi emit — trước đây team messages CHỈ tồn tại trong
 * state React của client đang mở SSE stream → user rời session/module mất
 * hết nội dung. Giờ mọi event quan trọng được lưu DB (best-effort, không chặn
 * stream) → mở lại session bất kỳ lúc nào đều thấy full cuộc trao đổi.
 */
function persistTeamEvent(sessionId: string, event: Record<string, unknown>) {
  const type = event.type as string
  try {
    // Tombstone guard — session đã xóa thì event KHÔNG được ghi lại (mồ côi)
    if (isSessionDeleted(sessionId)) return
    const agentName = (event.agent as string) || undefined
    const agentPosition = (event.position as string) || undefined
    // ROUND-43 fix B1: seq đơn điệu (stamp bởi emit wrapper của POST) — persist
    // vào metadata để frontend khôi phục THỨ TỰ EMIT giữa đám INSERT fire-and-forget
    // chạy đua nhau ở SQLite (không đảm bảo commit theo thứ tự).
    const teamSeq = typeof event.seq === 'number' ? event.seq : undefined
    const seqMeta = teamSeq != null ? { teamSeq } : {}
    let row: { role: string; content: string; metadata?: Record<string, unknown> } | null = null

    if (type === 'agent_complete') {
      const content = (event.content as string) || ''
      if (content.trim()) {
        row = {
          role: 'assistant',
          content,
          metadata: { isTeamMessage: true, agentName, agentPosition, durationMs: event.duration, ...seqMeta },
        }
      }
    } else if (type === 'agent_chunk') {
      // ROUND-42 (user: "không thấy rõ agent nào đang nghĩ gì"): persist thought
      // snapshot MỖI VÒNG ReAct (content đã REPLACE mỗi vòng ở client — không
      // snapshot là mất). Slice 2000 ký tự — đủ hiển thị line-clamp-6 + expand,
      // giữ row nhẹ (workflow dài 25 vòng/agent vẫn chỉ ~50KB/agent).
      const content = (event.content as string) || ''
      const iteration = typeof event.iteration === 'number' ? event.iteration : undefined
      if (content.trim()) {
        row = {
          role: 'assistant',
          content: content.slice(0, 2000),
          metadata: {
            isTeamMessage: true,
            agentName,
            agentPosition,
            teamThought: true,
            ...(iteration != null ? { iteration } : {}),
            ...seqMeta,
          },
        }
      }
    } else if (type === 'agent_start') {
      // TEAM PROCESS PANEL (2026-10-29 — user request "đóng gói quá trình thực
      // thi thay vì dải tin nhắn"): persist BƯỚC pipeline (step + description)
      // để history hiển thị được "Các bước triển khai" sau reload. Frontend
      // (groupTeamProcessMessages) gom message này vào panel qua
      // metadata.teamStep — KHÔNG render thành bubble rời rạc.
      const step = (event.step as string) || undefined
      const description = (event.description as string) || undefined
      const avatar = (event.avatar as string) || undefined
      if (step) {
        row = {
          role: 'assistant',
          content: `⚙️ Bước ${step}${description ? ` — ${description}` : ''}`,
          metadata: {
            isTeamMessage: true,
            agentName,
            agentPosition,
            teamStep: step,
            teamStepDescription: description,
            // ROUND-42: avatar để panel vẽ divider agent sau reload y như live
            ...(avatar ? { teamStepAvatar: avatar } : {}),
            ...seqMeta,
          },
        }
      }
    } else if (type === 'tool_call') {
      const tool = (event.tool as string) || 'tool'
      const detail = (event.detail as string) || ''
      row = {
        role: 'assistant',
        content: detail || `🔧 ${tool}`,
        metadata: { isTeamMessage: true, agentName, agentPosition, toolCallInfo: { tool, detail }, ...seqMeta },
      }
    } else if (type === 'tool_result') {
      // ROUND-42: persist kết quả thật (✓/✗ + duration + preview) — trước đây
      // tool_result KHÔNG được persist nên panel sau reload chỉ thấy tên tool
      // mà không biết lệnh đó thành/bại hay chạy bao lâu ("chung chung").
      // Frontend (groupTeamProcessMessages) PATCH metadata này vào tool event
      // cuối cùng agent chưa có kết quả — không đẻ event mới.
      const tool = (event.tool as string) || 'tool'
      const ok = event.result !== 'Error'
      const duration = typeof event.duration === 'number' ? event.duration : undefined
      const detail = (event.detail as string) || ''
      // ROUND-43 fix B1: toolSeq = seq của tool_call tương ứng (stamp ở emit
      // wrapper) — frontend patch KẾT QUẢ vào ĐÚNG tool bằng seq, bất kể row
      // result commit ra DB trước/sau row call thế nào (trước đây patch theo
      // vị trí → 4/70 result ghép nhầm tool sau reload — bằng chứng DB thật).
      const toolSeq = typeof event.toolSeq === 'number' ? event.toolSeq : undefined
      row = {
        role: 'assistant',
        content: `↳ ${ok ? '✓' : '✗'} ${tool}${duration != null ? ` (${duration}ms)` : ''}`,
        metadata: {
          isTeamMessage: true,
          agentName,
          agentPosition,
          toolResult: { tool, ok, ...(duration != null ? { durationMs: duration } : {}), ...(detail ? { preview: detail.slice(0, 300) } : {}), ...(toolSeq != null ? { toolSeq } : {}) },
          ...seqMeta,
        },
      }
    } else if (type === 'checkpoint') {
      const step = event.step as string | undefined
      const decision = event.decision as string | undefined
      const reasoning = event.reasoning as string | undefined
      const pending = event.pending === true
      row = {
        role: 'assistant',
        content: `📋 Checkpoint: Step ${step || '?'}${decision ? ` → ${decision}` : ''}${reasoning ? `\n${reasoning}` : ''}`,
        // ROUND-42: agentName = tên TL THẬT (engine giờ emit kèm) + structured
        // metadata.checkpoint (không còn regex-parse content ở frontend). Row
        // cũ (agentName='CHECKPOINT', không metadata.checkpoint) vẫn đọc được
        // qua fallback parse của groupTeamProcessMessages.
        metadata: {
          isTeamMessage: true,
          agentName: agentName || 'CHECKPOINT',
          agentPosition: agentPosition || 'TL',
          checkpoint: { step, ...(decision != null ? { decision } : {}), ...(reasoning != null ? { reasoning } : {}), ...(pending ? { pending } : {}) },
          ...seqMeta,
        },
      }
    } else if (type === 'workflow_done') {
      const totalDuration = event.totalDuration as number | undefined
      // FIX 2026-09-15 #1 (P1 — audit Team Code): message cuối tôn trọng THẬT
      // event.status — trước đây mọi kết thúc (kể cả escalated/failed) đều ghi
      // "✅ Workflow hoàn thành!" (vừa sai sự thật vừa che dấu thất bại).
      const status = String(event.status || 'completed')
      const durSuffix = totalDuration ? ` (${(totalDuration / 1000).toFixed(1)}s)` : ''
      let content: string
      if (status === 'completed') {
        content = `✅ Workflow hoàn thành!${durSuffix}`
      } else if (status === 'completed_with_errors') {
        content = `⚠️ Workflow hoàn thành kèm cảnh báo chất lượng (quality gate bắt lỗi lint/tsc) — đọc các bước để khắc phục.${durSuffix}`
      } else if (status === 'escalated') {
        content = `🔴 Workflow dừng sớm — TL ESCALATE (vấn đề đã được gửi tới Omega orchestrator để tìm cách xử lý).${durSuffix}`
      } else if (status === 'failed') {
        content = `❌ Workflow thất bại — đọc các bước phía trên để biết lỗi ở đâu.${durSuffix}`
      } else {
        content = `⏹ Workflow kết thúc (${status}).${durSuffix}`
      }
      row = {
        role: 'assistant',
        content,
        metadata: { isTeamMessage: true, agentName: 'SYSTEM', agentPosition: 'TL', workflowStatus: status, workflowDurationMs: totalDuration, ...seqMeta },
      }
    } else if (type === 'final_report') {
      // ROUND-42: persist báo cáo tổng kết workflow — frontend REPLACE phiên bằng
      // sự thật DB ~600ms sau workflow_done (chống panel nhân đôi); không persist
      // thì bubble BÁO CÁO TỔNG KẾT (client-only) bị auto-reload nuốt mất.
      const formatted = String(event.formattedReport || '').slice(0, 3000)
      if (formatted) {
        row = {
          role: 'assistant',
          content: `📋 **BÁO CÁO TỔNG KẾT WORKFLOW**\n\n\`\`\`\n${formatted}\n\`\`\``,
          metadata: { isTeamMessage: true, agentName: 'SYSTEM', agentPosition: 'TL', ...seqMeta },
        }
      }
    } else if (type === 'omega_escalation') {
      // FIX 2026-09-15 #2 (P2 — audit Team Code): AUTO-ESCALATE → Omega — persist
      // advisory vào ChatMessage để Omega/user/session-history đều đọc được
      // (trước đây tín hiệu thất bại của team KHÔNG bao giờ tới Omega).
      const advisory = String(event.advisory || '').slice(0, 2000)
      const reason = String(event.reason || '').slice(0, 300)
      const agentName = (event.agent as string) || 'Omega'
      if (advisory) {
        row = {
          role: 'assistant',
          content: `🧠 **TƯ VẤN TỪ OMEGA ORCHESTRATOR** (auto-escalate — vấn đề: ${reason || 'workflow gặp sự cố'})\n\n${advisory}`,
          metadata: { isTeamMessage: true, agentName, agentPosition: 'OMEGA', omegaEscalation: true, reason, tokensUsed: event.tokensUsed, ...seqMeta },
        }
      }
    } else if (type === 'error') {
      const message = (event.message as string) || 'Unknown error'
      // ROUND-43 fix B3: engine phân biệt error FATAL (workflow dừng thật —
      // frontend được phép chốt panel 'Lỗi') với error NON-TERMINAL (step fail
      // nhưng workflow VẪN CHẠY TIẾP — trước đây mọi error đều đội panel thành
      // 'Lỗi' + auto-collapse giữa chừng khi agents còn làm việc). Row cũ không
      // có metadata → mặc định fatal (giữ hành vi cũ cho dữ liệu legacy).
      const fatal = event.fatal !== false
      row = {
        role: 'error',
        content: `❌ Workflow Error${agentName ? ` (${agentName})` : ''}: ${message}`,
        metadata: { errorFatal: fatal, ...seqMeta },
      }
    }

    if (row) {
      db.chatMessage
        .create({
          data: {
            sessionId,
            role: row.role,
            content: row.content,
            metadata: row.metadata ? JSON.stringify(row.metadata) : null,
          },
        })
        .then(() => {
          // Cập nhật messageCount + updatedAt để session nổi lên đầu danh sách
          db.agentSession
            .update({
              where: { sessionId },
              data: { messageCount: { increment: 1 }, updatedAt: new Date() },
            })
            .catch(() => {})
        })
        .catch(err => {
          console.warn('[WorkflowAPI] Failed to persist team event:', err instanceof Error ? err.message : String(err))
        })
    }
  } catch { /* persistence là best-effort — không bao giờ phá stream */ }
}

export async function POST(request: NextRequest) {
  let body: { messages?: Array<{ role: string; content: string }>; sessionId?: string; userRequest?: string; routing?: Record<string, unknown>; continueOnDisconnect?: boolean; teamName?: string }

  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { messages = [], sessionId, userRequest, routing: rawRouting, teamName } = body

  // TOMBSTONE GUARD (fix review 2026-09-08 — HIGH): user đã xóa session này →
  // từ chối workflow mới. Trước đây POST workflow upsert agentSession KHÔNG
  // check tombstone → session đã xóa hiện lại trong sidebar (hồi sinh) +
  // persistTeamEvent đẻ chatMessage mồ côi.
  if (sessionId && (await isSessionDeletedDeep(sessionId))) {
    return new Response(JSON.stringify({ error: `Phiên ${sessionId} đã bị xóa — không thể chạy workflow trong phiên đã xóa. Hãy tạo phiên mới.` }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Validate required fields
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'sessionId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!userRequest) {
    return new Response(JSON.stringify({ error: 'userRequest is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Read continueOnDisconnect from body or query parameter (default: true)
  const queryContinue = request.nextUrl.searchParams.get('continueOnDisconnect')
  const continueOnDisconnect = body.continueOnDisconnect ?? (queryContinue === 'false' ? false : true)

  // AbortController — allows workflow engine to cancel when client disconnects
  const abortController = new AbortController()

  const encoder = new TextEncoder()
  let isClosed = false

  const stream = new ReadableStream({
    async start(controller) {
      // SSE emitter — sends events to client
      //
      // ROUND-43 fix B1: stamp seq đơn điệu cho MỌI event (persist vào
      // metadata.teamSeq + gửi kèm SSE event.seq) + toolSeq cho tool_result
      // (trỏ đúng tool_call tương ứng theo agent) — frontend khôi phục thứ tự
      // emit + patch kết quả chính xác bất kể thứ tự commit DB (INSERT
      // fire-and-forget chạy đua nhau ở SQLite không đảm bảo thứ tự), đồng
      // thời dedupe event live ↔ DB copy cùng seq (chống nhân đôi khi delta
      // kéo row về giữa lúc SSE còn sống).
      let teamEventSeq = 0
      const lastToolSeqByAgent = new Map<string, number>()
      const emit = (event: Record<string, unknown>) => {
        const stamped: Record<string, unknown> = { ...event, seq: teamEventSeq++ }
        if (stamped.type === 'tool_call') {
          const agentKey = (stamped.agent as string) || ''
          if (agentKey) lastToolSeqByAgent.set(agentKey, stamped.seq as number)
        } else if (stamped.type === 'tool_result') {
          const agentKey = (stamped.agent as string) || ''
          const toolSeqRef = agentKey ? lastToolSeqByAgent.get(agentKey) : undefined
          if (toolSeqRef != null) stamped.toolSeq = toolSeqRef
        }
        // USER REQUEST 2026-09-01: persist event quan trọng vào DB trước khi
        // gửi (best-effort — lỗi persist không chặn stream)
        persistTeamEvent(sessionId, stamped)
        if (isClosed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stamped)}\n\n`))
        } catch {
          // Client disconnected — mark as closed
          // NOTE: With continueOnDisconnect=true, workflow engine handles this gracefully
          // by switching to no-op emit instead of aborting
          isClosed = true
          if (!continueOnDisconnect) {
            abortController.abort()
          }
        }
      }

      // Heartbeat: send every 15s to prevent proxy/CDN timeout
      const heartbeatInterval = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeatInterval)
          return
        }
        try {
          controller.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`))
        } catch {
          isClosed = true
          if (!continueOnDisconnect) {
            abortController.abort()
          }
          clearInterval(heartbeatInterval)
        }
      }, 15000)

      try {
        // USER REQUEST 2026-09-01: lưu user request + đảm bảo AgentSession row
        // tồn tại (session do client auto-tạo `sess_...` chưa có row → không
        // hiện trong danh sách session; team events persist ở dưới sẽ mồ côi)
        try {
          await db.chatMessage.create({
            data: { sessionId, role: 'user', content: userRequest },
          })
          await db.agentSession.upsert({
            where: { sessionId },
            create: {
              sessionId,
              title: userRequest.slice(0, 50) || 'Team Workflow',
              teamMode: 'multi',
              teamName: teamName || null,
              messageCount: 1,
            },
            update: {
              messageCount: { increment: 1 },
              updatedAt: new Date(),
            },
          })
        } catch (err) {
          console.warn('[WorkflowAPI] Failed to persist user request:', err instanceof Error ? err.message : String(err))
        }

        // Phase 2: Smart TL Bridge — accept pre-computed routing from TL Assessment
        // If routing is provided, TL analyze step is skipped and pipeline starts immediately
        let routing: import('@/lib/code-team/worklog').RoutingDecision | undefined
        if (rawRouting && rawRouting.mode && rawRouting.tier && rawRouting.score !== undefined) {
          // Validate routing fields at runtime (type assertions don't validate)
          const validModes = ['A', 'B', 'C'] as const
          const validTiers = [1, 2, 3] as const
          const mode = validModes.includes(rawRouting.mode as typeof validModes[number])
            ? (rawRouting.mode as 'A' | 'B' | 'C')
            : undefined
          const tier = validTiers.includes(rawRouting.tier as typeof validTiers[number])
            ? (rawRouting.tier as 1 | 2 | 3)
            : undefined
          const score = typeof rawRouting.score === 'number'
            ? Math.min(9, Math.max(3, rawRouting.score))
            : undefined

          if (mode && tier && score !== undefined) {
            routing = {
              mode,
              tier,
              score,
              reasoning: (rawRouting.reasoning as string) || 'Pre-computed from TL Assessment',
              parts: Array.isArray(rawRouting.parts)
                ? rawRouting.parts as Array<{ name: string; type: 'visual' | 'backend'; description: string; dependency: string[] }>
                : [{ name: 'main', type: 'backend' as const, description: userRequest || '', dependency: [] }],
              spec: (rawRouting.spec as string) || userRequest || '',
            }
            console.log(`[WorkflowAPI] Pre-computed routing received: Mode ${routing.mode}, Tier ${routing.tier}, Score ${routing.score}`)
          } else {
            console.warn(`[WorkflowAPI] Invalid routing fields received (mode=${rawRouting.mode}, tier=${rawRouting.tier}, score=${rawRouting.score}) — falling back to TL analyze`)
          }
        }

        await runWorkflow(
          { messages, sessionId, userRequest, routing },
          emit,
          abortController.signal,
          { continueOnDisconnect }
        )
      } catch (err) {
        if (!isClosed) {
          emit({
            type: 'error',
            agent: 'SYSTEM',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        clearInterval(heartbeatInterval)
      }

      // Close the stream
      try {
        controller.close()
      } catch {
        // Stream already closed
      }
    },

    cancel() {
      // Client disconnected — mark stream as closed
      isClosed = true
      if (!continueOnDisconnect) {
        // Old behavior: abort workflow when client disconnects
        abortController.abort()
        console.log(`[WorkflowAPI] Client disconnected for session ${sessionId} — workflow aborted`)
      } else {
        // New behavior: workflow continues in background.
        //
        // FIX ROUND-40 (bug #40-1 — phát hiện qua test thực tế): trước đây nhánh
        // này VẪN gọi abortController.abort() với comment cho rằng engine-side
        // isAborted() sẽ bỏ qua abort khi clientDisconnected=true. Nhưng biến
        // clientDisconnected của engine chỉ được set khi emit() throw — mà emit
        // bên route có `if (isClosed) return` nuốt im lặng → engine KHÔNG BAO GIỜ
        // biết client đã rời → mọi workflow đều abort ở step kế tiếp dù
        // continueOnDisconnect=true (log thật: "continues in background" rồi
        // "Aborted at step 0"). Fix: KHÔNG abort signal ở nhánh này — engine
        // chạy tiếp, emit thành no-op (isClosed), persistTeamEvent vẫn ghi DB
        // (nằm TRƯỚC isClosed check) → UI mở lại session vẫn thấy đủ events.
        console.log(`[WorkflowAPI] Client disconnected for session ${sessionId} — workflow continues in background (continueOnDisconnect: true)`)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  })
}
