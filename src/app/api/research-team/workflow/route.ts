/**
 * Research Team — Workflow SSE API Endpoint (Task 19 — user request 2026-09-03)
 * ==================================================================================
 * POST /api/research-team/workflow
 *
 * "Tôi muốn nếu tôi là người làm việc trực tiếp với team research thì sẽ dùng
 *  khung chat trong module Smolab như team code, mọi thứ chuyển giao bằng prompt
 *  nên không cần màn hình Missions UI" — mirror contract /api/code-team/workflow
 * (SSE + persist ChatMessage DB) nhưng chạy Research Team pipeline thật:
 *
 *   prompt user → CLASSIFY (LLM) → tạo mission MS-YYYYMMDD-NNN
 *     - LOW confidence (TB-02 §6 edge #1) → NEMESIS hỏi đúng 1 câu trong chat;
 *       câu trả lời user (message kế tiếp) → clarify mission đó rồi chạy tiếp
 *       (pending mission id lưu trong ChatMessage metadata.researchMissionId).
 *     - HIGH/MEDIUM → kingFullLifecycle (RECEIVE → TRIAGE → DECOMPOSE → G1/G2/G3
 *       per-tier → MONITOR → DECIDE → FINALIZE) với stage events stream realtime.
 *     - M2 → proposals DRAFT tự tạo (king/engine) → route SUBMIT + báo code
 *       P-YYYYMMDD-NNN cho user duyệt qua prompt.
 *   Intent duyệt: prompt chứa mã P-YYYYMMDD-NNN + từ khoá duyệt/approve/reject
 *     → approveProposal/rejectProposal với reviewedBy='USER' (DR-C5: NEMESIS
 *     recused, USER là authority tối cao).
 *
 * SSE Events (tương thích code-team reader):
 *   - workflow_start: { sessionId, missionCode?, missionType?, tier? }
 *   - agent_start:    { agent: 'NEMESIS', position: 'TL', step, avatar }
 *   - agent_chunk:    { agent, position, content }
 *   - agent_complete: { agent, position, step, content, duration }
 *   - workflow_done:  { totalDuration, sessionId, status, missionCode? }
 *   - error: { agent?, message }
 *   - heartbeat mỗi 15s (giữ kết nối qua proxy)
 *
 * persistTeamEvent mirror code-team: event quan trọng ghi ChatMessage DB ngay
 * khi emit → user rời session quay lại vẫn thấy full cuộc trao đổi.
 *
 * Fail-open toàn tuyến (TB-13 §4): lỗi ở bước nào cũng emit error + workflow_done
 * status='failed' — KHÔNG treo stream.
 */

import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isSessionDeleted, isSessionDeletedDeep } from '@/lib/session-tombstone'
import { classifyMission } from '@/lib/research-team/classify'
import { createMission, getMission, updateClarification } from '@/lib/research-team/mission-store'
import { kingFullLifecycle } from '@/lib/research-team/king/engine'
import type { KingLifecycleEvent } from '@/lib/research-team/king/engine'
import { submitProposal, approveProposal, rejectProposal } from '@/lib/research-team/proposal/store'
import { decodeProposal } from '@/lib/research-team/types'
// FIX TEAM-MODEL-1 (2026-10-20): model user chọn (team research) wrap flow qua
// ALS — mọi resolveResearchBrain của flow thấy override trước AgentProfile DB.
import { withResearchModelOverride } from '@/lib/research-team/model-override-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ============================================================
// §1. PERSIST TEAM EVENT → ChatMessage DB (mirror code-team workflow route)
// ============================================================

function persistTeamEvent(
  sessionId: string,
  event: Record<string, unknown>,
): void {
  const type = event.type as string
  try {
    if (isSessionDeleted(sessionId)) return
    const agentName = (event.agent as string) || 'NEMESIS'
    const agentPosition = (event.position as string) || 'TL'
    let row: { role: string; content: string; metadata?: Record<string, unknown> } | null = null

    if (type === 'agent_complete') {
      const content = (event.content as string) || ''
      if (content.trim()) {
        // Metadata researchMissionId — để message kế tiếp của user resolve
        // pending clarification mission (TB-02 §6 edge #1 chat flow).
        const metadata: Record<string, unknown> = { isTeamMessage: true, agentName, agentPosition }
        if (event.researchMissionId) metadata.researchMissionId = event.researchMissionId
        if (event.researchMissionStatus) metadata.researchMissionStatus = event.researchMissionStatus
        row = { role: 'assistant', content, metadata }
      }
    } else if (type === 'workflow_done') {
      const status = String(event.status || 'completed')
      const durSuffix = event.totalDuration ? ` (${((event.totalDuration as number) / 1000).toFixed(1)}s)` : ''
      let content: string
      if (status === 'completed') {
        content = `✅ Research Team hoàn thành mission!${durSuffix}`
      } else if (status === 'needs_clarification') {
        content = `❓ NEMESIS cần làm rõ thêm — trả lời câu hỏi phía trên để mission tiếp tục.${durSuffix}`
      } else if (status === 'failed') {
        content = `❌ Research Team workflow lỗi — xem các bước phía trên.${durSuffix}`
      } else {
        content = `⏹ Research Team workflow kết thúc (${status}).${durSuffix}`
      }
      row = {
        role: 'assistant',
        content,
        metadata: { isTeamMessage: true, agentName: 'SYSTEM', agentPosition: 'TL', workflowStatus: status },
      }
    } else if (type === 'error') {
      const message = (event.message as string) || 'Unknown error'
      row = {
        role: 'error',
        content: `❌ Research Team Error${agentName ? ` (${agentName})` : ''}: ${message}`,
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
          db.agentSession
            .update({
              where: { sessionId },
              data: { messageCount: { increment: 1 }, updatedAt: new Date() },
            })
            .catch(() => {})
        })
        .catch((err) => {
          console.warn(
            '[ResearchWorkflowAPI] Failed to persist team event:',
            err instanceof Error ? err.message : String(err),
          )
        })
    }
  } catch {
    /* persistence là best-effort — không bao giờ phá stream */
  }
}

// ============================================================
// §2. INTENT DETECTION — duyệt proposal qua prompt
// ============================================================

/** Trích mã Proposal P-YYYYMMDD-NNN từ text (nếu có). */
function extractProposalCode(text: string): string | null {
  const m = text.match(/\b(P-\d{8}-\d{3})\b/i)
  return m ? m[1].toUpperCase() : null
}

/** Kiểm tra intent duyệt (approve/reject) — PHẢI kèm mã P-. */
function detectReviewIntent(text: string): 'approve' | 'reject' | null {
  const hasCode = extractProposalCode(text) !== null
  if (!hasCode) return null
  const lower = text.toLowerCase()
  if (/\b(từ chối|tư chối|reject|deny|loại bỏ|không duyệt|khong duyet)\b/.test(lower)) return 'reject'
  if (/\b(duyệt|duyet|approve|chấp nhận|chap nhan|xác nhận|xac nhan)\b/.test(lower)) return 'approve'
  return null
}

/** Tìm proposal theo code — decode schemaJson rồi so khớp (SQLite không query JSON). */
async function findProposalByCode(code: string) {
  try {
    const rows = await db.researchProposal.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })
    for (const r of rows) {
      const decoded = decodeProposal(r)
      if ((decoded.schema?.code || '').toUpperCase() === code) return decoded
    }
  } catch {
    /* fail-open */
  }
  return null
}

// ============================================================
// §3. PENDING CLARIFICATION — resolve mission chờ user trả lời
// ============================================================

/**
 * Tìm mission đang CLASSIFY trong session này (metadata.researchMissionId của
 * assistant message gần nhất) → user trả lời clarifying question.
 */
async function findPendingClarificationMission(sessionId: string) {
  try {
    const rows = await db.chatMessage.findMany({
      where: { sessionId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { metadata: true },
    })
    for (const r of rows) {
      if (!r.metadata) continue
      try {
        const meta = JSON.parse(r.metadata) as { researchMissionId?: string }
        if (meta.researchMissionId) {
          const mission = await getMission(meta.researchMissionId)
          if (mission && mission.status === 'CLASSIFY') return mission
          return null // missionId mới nhất đã xử lý — không fallback cũ hơn
        }
      } catch {
        /* metadata không phải JSON — skip */
      }
    }
  } catch {
    /* fail-open */
  }
  return null
}

// ============================================================
// §4. POST — WORKFLOW SSE
// ============================================================

interface WorkflowBody {
  messages?: Array<{ role: string; content: string }>
  sessionId?: string
  userRequest?: string
  teamName?: string
}

export async function POST(request: NextRequest) {
  let body: WorkflowBody
  try {
    body = (await request.json()) as WorkflowBody
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { sessionId, userRequest } = body

  // TOMBSTONE GUARD (mirror code-team): session đã xóa → từ chối
  if (sessionId && (await isSessionDeletedDeep(sessionId))) {
    return new Response(
      JSON.stringify({ error: `Phiên ${sessionId} đã bị xóa — tạo phiên mới để tiếp tục.` }),
      { status: 410, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'sessionId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!userRequest || !userRequest.trim()) {
    return new Response(JSON.stringify({ error: 'userRequest is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const startedAt = Date.now()
  const encoder = new TextEncoder()
  let isClosed = false

  // FIX TEAM-MODEL-1 (2026-10-20 — user report "khi chọn team thì không thể chọn
  // model như khi chọn agent độc lập"): model user chọn ở dropdown model indicator
  // (team research) → áp cho TOÀN BỘ flow (classify/king/g1/g2/g3/tournament...
  // qua ALS — resolveResearchBrain thấy override TRƯỚC AgentProfile DB).
  // Validate mirror code-team route: id chỉ nhận [A-Za-z0-9._/-]; sai format →
  // warn + bỏ qua (fail-open — model sai không chặn flow).
  const moRaw = (body as Record<string, unknown>).modelOverride
  const poRaw = (body as Record<string, unknown>).providerOverride
  let modelOv: { model: string; provider: string } | undefined
  if (typeof moRaw === 'string' && moRaw.trim() && /^[A-Za-z0-9._\/-]{1,120}$/.test(moRaw.trim())) {
    modelOv = {
      model: moRaw.trim(),
      provider: typeof poRaw === 'string' && /^[a-z]{2,20}$/.test(poRaw.trim()) ? poRaw.trim() : 'nvidia',
    }
    console.log(`[ResearchWorkflowAPI] TEAM-MODEL-1 override: flow chạy trên ${modelOv.provider}/${modelOv.model}`)
  } else if (typeof moRaw === 'string' && moRaw.trim()) {
    console.warn(`[ResearchWorkflowAPI] modelOverride "${moRaw.slice(0, 40)}" sai format — bỏ qua (dùng model sẵn từng agent)`)
  }

  const buildStream = () => new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        persistTeamEvent(sessionId, event)
        if (isClosed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          isClosed = true
        }
      }

      // Heartbeat 15s (mirror code-team — chống proxy timeout)
      const heartbeatInterval = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeatInterval)
          return
        }
        try {
          controller.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`))
        } catch {
          isClosed = true
          clearInterval(heartbeatInterval)
        }
      }, 15000)

      // NEMESIS emit helper — stage lifecycle → agent_complete (reader code-team style)
      const emitNemesis = (content: string, step: string, extra: Record<string, unknown> = {}) => {
        emit({
          type: 'agent_complete',
          agent: 'NEMESIS',
          position: 'TL',
          step,
          avatar: '👑',
          content,
          ...extra,
        })
      }

      const finish = (status: string, extra: Record<string, unknown> = {}) => {
        emit({
          type: 'workflow_done',
          sessionId,
          status,
          totalDuration: Date.now() - startedAt,
          ...extra,
        })
      }

      try {
        // 1. Persist user request + ensure AgentSession row (mirror code-team)
        try {
          await db.chatMessage.create({ data: { sessionId, role: 'user', content: userRequest } })
          await db.agentSession.upsert({
            where: { sessionId },
            create: {
              sessionId,
              title: userRequest.slice(0, 50) || 'Research Workflow',
              teamMode: 'multi',
              teamName: 'research',
              messageCount: 1,
            },
            update: { messageCount: { increment: 1 }, updatedAt: new Date() },
          })
        } catch (err) {
          console.warn(
            '[ResearchWorkflowAPI] Failed to persist user request:',
            err instanceof Error ? err.message : String(err),
          )
        }

        emit({ type: 'workflow_start', sessionId })

        // ============ 2. INTENT: duyệt Proposal qua prompt ============
        const reviewIntent = detectReviewIntent(userRequest)
        if (reviewIntent) {
          const code = extractProposalCode(userRequest) as string
          const proposal = await findProposalByCode(code)
          if (!proposal) {
            emitNemesis(
              `Không tìm thấy Proposal **${code}** trong hệ thống. Kiểm tra lại mã — danh sách proposal hiện tại lấy qua GET /api/research/proposals.`,
              'proposal-lookup',
            )
            finish('completed')
            return
          }
          if (reviewIntent === 'approve') {
            if (proposal.status === 'APPLIED') {
              emitNemesis(`Proposal ${code} đã được APPROVED + APPLIED trước đó — không cần duyệt lại.`, 'proposal-review')
              finish('completed')
              return
            }
            // USER duyệt (DR-C5 §C5 — NEMESIS recused, USER là authority)
            if (proposal.status === 'DRAFT') {
              // Auto-submit trước (DRAFT → SUBMITTED tạo branch) rồi approve
              try {
                await submitProposal(proposal.id)
              } catch (err) {
                emitNemesis(
                  `Không thể submit Proposal ${code} (DRAFT → SUBMITTED): ${
                    err instanceof Error ? err.message : String(err)
                  } — duyệt thủ công qua API /api/research/proposals/${proposal.id}/review.`,
                  'proposal-submit',
                )
                finish('failed')
                return
              }
            }
            if (proposal.status !== 'SUBMITTED' && proposal.status !== 'APPROVED') {
              emitNemesis(
                `Proposal ${code} đang ở status ${proposal.status} — chỉ SUBMITTED mới duyệt được (TB-11 §3 lifecycle).`,
                'proposal-review',
              )
              finish('completed')
              return
            }
            try {
              const result = await approveProposal(proposal.id, 'USER')
              emitNemesis(
                `✅ **Proposal ${code} APPROVED bởi USER** (DR-C5 — NEMESIS recused)\n\n` +
                  `- Bridge self-direction: ${result.applied ? '✅ đã trigger orchestration' : `⚠️ ${result.applyError || 'chưa apply (merge branch thủ công qua /apply)'}`}\n` +
                  `- Trạng thái: ${result.proposal.status}\n` +
                  `- Lifecycle: DRAFT → SUBMITTED → APPROVED → ${result.proposal.status}`,
                'proposal-approve',
              )
              finish('completed')
              return
            } catch (err) {
              emitNemesis(
                `❌ Duyệt Proposal ${code} thất bại: ${err instanceof Error ? err.message : String(err)}`,
                'proposal-approve',
              )
              finish('failed')
              return
            }
          } else {
            // reject
            const reason = userRequest.replace(/\b(P-\d{8}-\d{3})\b/gi, '').trim() || 'USER từ chối qua chat'
            try {
              const rejected = await rejectProposal(proposal.id, 'USER', reason)
              emitNemesis(
                `🚫 **Proposal ${code} REJECTED bởi USER** — lý do: ${reason}\n\n` +
                  `Mission quay lại RESEARCHING (TC-11 — không re-submit nguyên trạng).`,
                'proposal-reject',
              )
              finish('completed')
              return
            } catch (err) {
              emitNemesis(
                `❌ Từ chối Proposal ${code} thất bại: ${err instanceof Error ? err.message : String(err)}`,
                'proposal-reject',
              )
              finish('failed')
              return
            }
          }
        }

        // ============ 3. PENDING CLARIFICATION (TB-02 §6 — chat flow) ============
        const pending = await findPendingClarificationMission(sessionId)
        let missionId: string

        if (pending) {
          // User vừa trả lời clarifying question → classify lại với context đầy đủ
          emitNemesis(
            `Nhận câu trả lời làm rõ — NEMESIS phân loại lại mission **${pending.code}** với thông tin bổ sung...`,
            'clarify-reclassify',
          )
          const combinedRequest = `${pending.request}\n\n[CÂU TRẢ LỜI LÀM RÕ TỪ USER]: ${userRequest}`
          const classify = await classifyMission(combinedRequest, pending.title || undefined)

          const missionType = classify.missionType // luôn có (fail-open default)
          const tier = classify.tier || 'T2' // vẫn LOW → default T2 (đã hỏi 1 câu — TB-02 §6: KHÔNG hỏi vòng 2)

          try {
            const updated = await updateClarification(pending.id, {
              missionType,
              tier,
              confidence: classify.confidence,
              decision: {
                at: new Date().toISOString(),
                agent: 'NEMESIS',
                decision: 'RESEARCH',
                reason: `User clarified mission qua chat → ${missionType}/${tier} (confidence: ${classify.confidence.level})`,
              },
            })
            missionId = updated.id
            emitNemesis(
              `✅ Mission **${updated.code}** đã được làm rõ → loại **${missionType}** · tier **${tier}** (confidence ${classify.confidence.level}). Bắt đầu pipeline...`,
              'clarify-done',
              { researchMissionId: updated.id, researchMissionStatus: updated.status },
            )
          } catch (err) {
            emitNemesis(
              `Không thể cập nhật mission ${pending.code} với câu trả lời: ${
                err instanceof Error ? err.message : String(err)
              } — tạo mission mới với context đầy đủ.`,
              'clarify-fallback',
            )
            const mission = await createMission({
              request: combinedRequest,
              title: pending.title || undefined,
              missionType,
              tier,
              confidence: classify.confidence,
            })
            missionId = mission.id
          }
        } else {
          // ============ 4. MISSION MỚI: CLASSIFY → CREATE ============
          emitNemesis(
            `NEMESIS (TL — Research Team) tiếp nhận request. Chạy **CLASSIFY** (Bước 0 — TB-02 §1): phân loại M1/M2/M3 + chấm confidence...`,
            'classify-start',
          )
          const classify = await classifyMission(userRequest)

          // LOW confidence → hỏi đúng 1 câu (TB-02 §6 edge #1 — KHÔNG đoán mò)
          if (classify.confidence.level === 'LOW' && classify.clarifyingQuestion) {
            const mission = await createMission({
              request: userRequest,
              missionType: classify.missionType,
              tier: classify.tier, // undefined → store set ''
              confidence: classify.confidence,
              initialDecisionLog: [
                {
                  at: new Date().toISOString(),
                  agent: 'NEMESIS',
                  decision: 'RESEARCH',
                  reason: `Classified (LOW confidence — needs clarification) ${classify.missionType}/?`,
                },
              ],
            })
            emitNemesis(
              `📋 Mission **${mission.code}** đã tạo — nhưng request còn **mơ hồ (LOW confidence — DR-C2)**.\n\n` +
                `NEMESIS cần làm rõ đúng 1 câu (TB-02 §6 — không đoán mò):\n\n> **${classify.clarifyingQuestion}**\n\n` +
                `Trả lời trực tiếp trong chat — mission sẽ tự tiếp tục với phân loại đã rõ.`,
              'needs-clarification',
              { researchMissionId: mission.id, researchMissionStatus: mission.status },
            )
            finish('needs_clarification')
            return
          }

          const mission = await createMission({
            request: userRequest,
            missionType: classify.missionType,
            tier: classify.tier,
            confidence: classify.confidence,
            initialDecisionLog: [
              {
                at: new Date().toISOString(),
                agent: 'NEMESIS',
                decision: 'RESEARCH',
                reason: `Classified as ${classify.missionType}/${classify.tier || '?'} (confidence: ${classify.confidence.level})`,
              },
            ],
          })
          missionId = mission.id
          emitNemesis(
            `✅ Mission **${mission.code}** tạo xong — loại **${classify.missionType}** · tier **${classify.tier}** · confidence **${classify.confidence.level}** (${classify.confidence.signals.length} tín hiệu).`,
            'classify-done',
            { researchMissionId: mission.id, researchMissionStatus: mission.status },
          )
        }

        // ============ 5. KING FULL LIFECYCLE — pipeline thật ============
        const onEvent = (event: KingLifecycleEvent) => {
          if (event.type === 'stage' && event.stage === 'done') return // workflow_done lo phần này
          emitNemesis(event.message, `lifecycle-${event.stage}`, {
            researchMissionId: missionId,
            ...(event.data || {}),
          })
        }

        const result = await kingFullLifecycle(missionId, { onEvent })

        // 5.5 SUBMIT proposals DRAFT (M2) — tạo branch + timeout để user duyệt
        const submittedCodes: string[] = []
        if (result.proposals && result.proposals.length > 0) {
          for (const p of result.proposals) {
            try {
              await submitProposal(p.id)
              submittedCodes.push(p.code)
            } catch (err) {
              console.warn(
                `[ResearchWorkflowAPI] submitProposal ${p.code} failed:`,
                err instanceof Error ? err.message : String(err),
              )
            }
          }
        }

        // 6. Final report → chat
        const errorsNote =
          result.errors.length > 0
            ? `\n\n⚠️ **${result.errors.length} cảnh báo pipeline** (fail-open — xem worklog chi tiết):\n${result.errors
                .slice(0, 5)
                .map((e) => `- ${e}`)
                .join('\n')}`
            : ''

        const proposalsNote =
          submittedCodes.length > 0
            ? `\n\n📝 **${submittedCodes.length} Proposal đã SUBMITTED — chờ USER duyệt (DR-C5: NEMESIS recused):**\n${submittedCodes
                .map((c) => `- **${c}** — duyệt bằng cách nhắn "duyệt ${c}" hoặc "từ chối ${c}" kèm lý do`)
                .join('\n')}`
            : ''

        emitNemesis(
          `${result.finalReport || '(no final report)'}${errorsNote}${proposalsNote}`,
          'final-report',
          { researchMissionId: missionId, researchMissionStatus: result.mission.status },
        )

        finish(result.errors.length > 0 ? 'completed_with_errors' : 'completed', {
          missionCode: result.mission.code,
          missionStatus: result.mission.status,
          proposals: submittedCodes.length,
        })
      } catch (err) {
        emit({
          type: 'error',
          agent: 'SYSTEM',
          message: err instanceof Error ? err.message : String(err),
        })
        finish('failed')
      } finally {
        clearInterval(heartbeatInterval)
      }

      try {
        controller.close()
      } catch {
        /* stream already closed */
      }
    },
    cancel() {
      isClosed = true
      console.log(`[ResearchWorkflowAPI] Client disconnected for session ${sessionId} — pipeline tiếp tục nền (events đã persist DB)`)
    },
  })

  // FIX TEAM-MODEL-1: construct stream TRONG ALS context — start() được gọi
  // ngay trong constructor (WHATWG streams) nên nằm trong context; mọi await
  // chain bên trong start kế thừa → resolveResearchBrain thấy override.
  // Không có override → buildStream() thẳng (behavior cũ 100%).
  const stream = modelOv
    ? await withResearchModelOverride(modelOv, async () => buildStream())
    : buildStream()

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
