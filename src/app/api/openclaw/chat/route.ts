/**
 * OpenClaw Chat API — Upgraded for Phase OC-3 (Deep Integration)
 *
 * POST /api/openclaw/chat — Forward chat to OpenClaw Gateway or fallback
 *
 * Supports:
 * - { messages, model, sessionId, stream } — full OpenAI-compatible format
 * - Auto knowledge search before responding
 * - System prompt injection with knowledge context
 * - Session tracking in SQLite
 * - Intelligent routing: code queries → OpenCode with KB enrichment, knowledge queries → OpenClaw
 * - Knowledge-Aware Coding: enriches OpenCode sessions with KB context
 * - Cross-Session Learning: incorporates past corrections and insights
 * - Mock mode when gateway is offline
 */

import { NextRequest, NextResponse } from 'next/server'
import { chatCompletion } from '@/lib/openclaw'
import { ensureGatewayRunning } from '@/lib/openclaw-ondemand'
import { isOpenCodeOnline, createOpenCodeSession, opencodeFetch } from '@/lib/opencode'
import { enrichCodeContext, isCodeQuery as isCodeQueryAdvanced, detectCodeConfidence } from '@/lib/opencode-knowledge-context'
import { generateOpenCodeSystemPrompt } from '@/lib/opencode-system-prompt'
import { db } from '@/lib/db'
import { addTokensUsed, addTokensUsedByAgent } from '@/lib/llm'
import { autoLearnFromAnswer, shouldAutoLearn } from '@/lib/auto-learn'
import { recallMemories, extractMemoriesFromConversation, saveChatMessages, getUserProfile, ensureAgentMemoryCollection, decayMemories } from '@/lib/agent-memory'
// WORKING MEMORY (HOT) — user request 2026-08-28: ghi user/assistant exchange +
// inject digest "agent đã làm gì gần đây" vào system prompt
import { addToWorkingMemory, getWorkingMemory, getRecentWorkingMemory } from '@/lib/memory-tiers'
import { getStandaloneAgentTools } from '@/lib/standalone-agents'
// SESSION TOMBSTONE (user request 2026-09-08: "phiên chat đã bấm xóa phải xóa hẳn,
// lần sau vào lại không còn") — session đã xóa KHÔNG được upsert/persist lại
// (4 chỗ agentSession.upsert dưới đây từng khiến session "hồi sinh" khi user
// xóa xong vẫn còn request chạy dở trong session đó).
// TOMBSTONE 2 LỚP (fix review 2026-09-08): Set in-process (nhanh) + DB persist
// (chống hồi sinh sau app restart — browser tab cũ giữ sessionId gửi tiếp).
import { isSessionDeleted, isSessionDeletedDeep } from '@/lib/session-tombstone'
// Agent Run Tracker — Thought Process + Todos + Progress realtime trong chat
// (user request 2026-08-31: mọi agents hiển thị tư duy/tiến trình như Claude Code)
// 2026-09-01: start/end/thought/cancel đã chuyển vào agent-goal-loop.ts (run
// của toàn bộ goal loop); run summary route đọc qua helper chia sẻ
// buildAgentRunSummaryForMessage (goal-loop-finalize.ts, Task 14-c pure-move).
// CI-2 (Task 11-a): getActiveRunId dùng ở crash-path để đóng todo của run
// đang chạy dở khi goal loop văng exception.
import { getActiveRunId } from '@/lib/agent-run-tracker'
// CI-2 (Task 11-a) — PER-TASK TODO ISOLATION: 2 helper vòng đời todo theo
// runId (dev-tools TODO section): archive todo của run trước khi run mới bắt
// đầu + đóng per-item trung thực khi run kết thúc (thay bulk-close cũ).
import { archiveStaleRunTodos, closeRunTodosAtEnd } from '@/lib/code-team/dev-tools'
// GOAL-DRIVEN LONG-HORIZON LOOP (user request 2026-09-01): thay thế ReAct loop cũ —
// vòng lặp mục tiêu dài hạn: Xác định vấn đề → Triển khai → Kiểm định → Đánh giá
// hoàn thành → (chưa: Chẩn đoán lỗi + Lập kế hoạch lại → lặp) → Hoàn thành.
// Xem docs/DANH_GIA_REACT_LOOP_VS_CLAUDE_CODE.md + src/lib/agent-goal-loop.ts
import { runGoalDrivenLoop } from '@/lib/agent-goal-loop'
// CI-5 (GĐ4, Task 14-c — roadmap B5): DURABLE GOAL LOOP — khi flag bật, goal
// loop chạy NỀN qua GoalLoopWorker (enqueue job → trả jobId ngay) thay vì chặn
// request HTTP. finalize + các helper chia sẻ (isLlmErrorContent /
// closeGoalLoopRunTodos / buildAgentRunSummaryForMessage) tách sang
// goal-loop-finalize.ts để 2 đường 1 nguồn sự thật (pure move khỏi file này).
import { goalLoopWorker } from '@/lib/goal-loop-worker'
import {
  isLlmErrorContent,
  isTrivialExchange,
  closeGoalLoopRunTodos,
  buildAgentRunSummaryForMessage,
} from '@/lib/goal-loop-finalize'
// Phase A: Smart KB Routing — Intent Classifier
// Phase C: Smart KB Writeback — replaces autoLearnFromAnswer with confidence-filtered writeback
// Phase B: Smart KB Pre-Search — search Qdrant+Neo4j before building system prompt
// Phase 2 SMOLAB Prop 6 — writebackToKBTransactionally wraps writebackToKB with
// PendingWriteback saga tracking (batchId + per-step status + reconcile endpoint).
import { classifyIntent, searchUserKB } from '@/lib/kb-routing'
import { rewriteQuery } from '@/lib/kb-routing/query-rewriter'
import { isFlagEnabled } from '@/lib/feature-flags'
import { writebackToKBTransactionally } from '@/lib/kb-routing/transactional-writeback'
import { buildWorkspaceContext } from '@/lib/workspace/workspace-context'
// Task 20-c (self-evaluation) — link AgentRunRecord với ChatMessage id sau khi
// message persist (fire-and-forget, fail-open — qua raw-SQL bridge metrics-db)
import { updateLatestAgentRunRecord } from '@/lib/metrics-db'

export const dynamic = 'force-dynamic'

// CI-5 (GĐ4, Task 14-c — roadmap B5): flag bật nhánh durable của goal loop —
// POST chat enqueue GoalLoopJob (DB) + trả jobId NGAY thay vì chạy loop chặn
// request. Đọc 1 lần lúc module load (đồng bộ với worker start ở
// instrumentation-node.ts cũng đọc lúc boot — flip flag cần restart app).
const DURABLE_GOAL_LOOP = process.env.ENABLE_DURABLE_GOAL_LOOP === 'true'

// Module-level counter for periodic memory decay (Bug 3 fix)
let memoryDecayCounter = 0

// ============================================
// WORKSPACE CONTEXT — đã chuyển sang module chia sẻ
// src/lib/workspace/workspace-context.ts (2026-08-29) để MỌI agents dùng chung:
//   - /api/openclaw/chat (agents độc lập + team Research + user-created)
//   - code-team/workflow-engine runAgentStep (Team Code: TL/G1/G2-A/G2-B/G3)
// ============================================

// (isLlmErrorContent + isTrivialExchange — PURE MOVE sang
// src/lib/goal-loop-finalize.ts Task 14-c + REVIEW 14-g H1,
// route import lại từ đó để đường durable + inline dùng cùng 1 định nghĩa)

/**
 * Phase A: Generate a fast response for casual messages (greetings, thanks, etc.)
 * without hitting the LLM or Knowledge Base.
 *
 * This is the "fast path" — saves ~2s of latency and ~500 tokens per casual message.
 */
function generateCasualResponse(userMsg: string, agentName?: string): string {
  const name = agentName || 'The Magnum Opus'
  const lower = userMsg.toLowerCase().trim()

  // Greetings
  if (/^(hi|hello|hey|yo|chào|xin chào|halo|alo)\b/i.test(lower)) {
    return `Xin chào! Tôi là ${name}. Tôi có thể giúp gì cho bạn hôm nay?`
  }

  // Thanks
  if (/^(cảm ơn|cám ơn|thanks|thank you|ty|tks)\b/i.test(lower)) {
    return `Không có gì! Tôi luôn sẵn sàng giúp bạn. Còn gì nữa không?`
  }

  // Goodbye
  if (/^(bye|tạm biệt|goodbye|see you)\b/i.test(lower)) {
    return `Tạm biệt! Hẹn gặp lại bạn. 👋`
  }

  // Confirmations
  if (/^(ok|okay|được|vâng|yes|có|uh|ừm)\b/i.test(lower)) {
    return `Vâng, tôi hiểu. Bạn cần tôi làm gì tiếp theo?`
  }

  // Negative
  if (/^(no|không|sai|nope)\b/i.test(lower)) {
    return `Đã rõ. Bạn muốn tôi làm gì khác?`
  }

  // Default casual fallback
  return `Tôi đã nhận được tin nhắn của bạn. Bạn có thể hỏi tôi về bất kỳ chủ đề nào — tôi sẽ tìm trong Knowledge Base hoặc dùng kiến thức của mình để trả lời.`
}

// ============================================
// ReAct LOOP — đã NÂNG CẤP thành GOAL-DRIVEN LOOP (2026-09-01)
// ============================================
// runAgentReActLoop cũ (while iterations < 8, kết thúc khi LLM ngừng phát tool
// call — không kiểm chứng mục tiêu) được thay bằng runGoalDrivenLoop từ
// src/lib/agent-goal-loop.ts:
//   - Nhiều chu kỳ (mặc định 4) × vòng ReAct mỗi chu kỳ (mặc định 10)
//   - Protocol 3 giai đoạn: PLAN → EXECUTE → VERIFY (bằng chứng tool thật)
//   - Evaluator độc lập sau mỗi chu kỳ (evidence-based, không tin lời tuyên bố)
//   - Chưa đạt → chẩn đoán rootCause + kế hoạch mới → chu kỳ kế tiếp
//   - Budgets (time/token) + no-progress detection + báo cáo trung thực
// Return shape tương thích: { content, iterations, toolCallsExecuted, runId }
// + goalLoop metadata { cycles, complete, stopReason, ... }.

const DEFAULT_SYSTEM_PROMPT = `Bạn là AI Agent của The Magnum Opus — Hệ thống GraphRAG Knowledge Base.

Bạn có quyền truy cập Knowledge Base local với các công cụ:
- knowledge_search: Tìm kiếm semantic trong Knowledge Base
- knowledge_graph: Truy vấn đồ thị Neo4j (Cypher)
- knowledge_write: Ghi entity/relationship mới vào Knowledge Base

Quy tắc:
1. Knowledge Base là nguồn BỔ SUNG — bạn có vốn kiến thức riêng, HÃY SỬ DỤNG tự do
2. Tìm kiếm trong Knowledge Base TRƯỚC khi trả lời — nếu có dữ liệu, cite nguồn
3. Nếu Knowledge Base không có dữ liệu liên quan, trả lời bằng vốn kiến thức của bạn — KHÔNG nói "tôi không tìm thấy thông tin"
4. Khi phát hiện thông tin mới giá trị, đề xuất ghi vào Knowledge Base
5. Trả lời bằng tiếng Việt trừ khi user dùng ngôn ngữ khác
6. Cite nguồn từ Knowledge Base khi sử dụng dữ liệu từ đó`

// Lightweight static system prompt context (no DB queries)
const STATIC_KB_CONTEXT = `SQLite Models: JobQueue, DailyTokenUsage, DailyTokenByProvider, DailyTokenByProviderSlot, DailyTokenByProviderModel, LocalEntity, LocalRelationship, LocalResolvedEntity, AgentProfile, AgentSession, LearningLog, AgentInsight, AgentCorrection, AgentPreference, AgentSkill, ToolPermission, KnowledgeAccessPolicy, CronJob, Webhook, StandingOrder, TaskExecution, ChannelConfig, OpenCodeSession, MCPBridgeConfig
Neo4j: Entity nodes with properties (name, type, domain, description), Relationship edges
Qdrant: theopus_documents, theopus_chunks (1536-dim vectors, nvidia/nemotron-3-embed-1b)`

// ============================================
// CODE QUERY DETECTION — Intelligent Routing
// Uses shared patterns from opencode-knowledge-context
// ============================================

// Additional patterns specific to chat routing (supplement the shared isCodeQuery)
const CHAT_CODE_PATTERNS = [
  /npm run/i,
  /chỉnh sửa.*file/i,
  /undefined.*variable/i,
  /git (commit|push|pull|merge)/i,
  /terminal|command line/i,
  /deploy/i,
]

function isCodeQuery(message: string): boolean {
  // Use the shared advanced detection from opencode-knowledge-context, plus chat-specific patterns
  return isCodeQueryAdvanced(message) || CHAT_CODE_PATTERNS.some(pattern => pattern.test(message))
}

// ============================================
// OPENCODE ROUTING
// ============================================

async function routeToOpenCode(
  userMessage: string,
  model?: string,
  sessionId?: string,
  messages?: Array<{ role: string; content: string }>,
  agentProfileId?: string,
  teamMode?: string,
  teamName?: string,
): Promise<NextResponse | null> {
  try {
    const online = await isOpenCodeOnline()
    if (!online) return null

    // OC-3.1: Enrich with Knowledge Base context before creating session
    const codeConfidence = detectCodeConfidence(userMessage)
    const enrichment = await enrichCodeContext(userMessage)
    
    // OC-3.5: Cross-Session Learning — incorporate past corrections and insights
    let entityTypeCount = 0
    let documentCount = 0  
    let correctionCount = 0
    let insightCount = 0
    let filesInWorkspace = 0
    try {
      entityTypeCount = await db.localEntity.count()
      correctionCount = await db.agentCorrection.count({ where: { applied: true } })
      insightCount = await db.agentInsight.count()
      documentCount = await db.localEntity.count({ where: { domain: 'document' } })
    } catch {}

    // Count workspace files (cross-platform: uses Node.js fs instead of `find` command)
    try {
      const { readdirSync, statSync } = await import('fs')
      const { join } = await import('path')
      const workspaceDir = process.env.OPENCODE_WORKSPACE || process.cwd()
      const skipDirs = new Set(['.next', 'node_modules', '.git', 'qdrant-storage', 'db', 'upload', 'skills'])
      function countFiles(dir: string): number {
        let count = 0
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            try {
              const stat = statSync(full)
              if (stat.isDirectory()) {
                if (!skipDirs.has(entry)) count += countFiles(full)
              } else {
                count++
              }
            } catch {}
          }
        } catch {}
        return count
      }
      filesInWorkspace = countFiles(workspaceDir)
    } catch {}

    // OC-3.7: Generate enriched system prompt with KB context
    const enrichedSystemPrompt = generateOpenCodeSystemPrompt({
      entityTypeCount,
      documentCount,
      correctionCount,
      insightCount,
      filesInWorkspace,
      modelList: [],
      kbEnabled: true,
      mcpToolsEnabled: ['knowledge_search', 'knowledge_graph', 'knowledge_write', 'web_search'],
      recentCorrections: enrichment.corrections,
      recentInsights: enrichment.insights.slice(0, 5),
      relatedEntities: enrichment.entities,
    })

    // WORKSPACE CONTEXT (user request 2026-08-28): code session cũng cần biết root
    const workspaceCtxForOC = await buildWorkspaceContext()
    const workspaceAwarePrompt = workspaceCtxForOC.text
      ? enrichedSystemPrompt + `\n\n${workspaceCtxForOC.text}`
      : enrichedSystemPrompt

    // Try to create an OpenCode session with the prompt + enriched context
    const session = await createOpenCodeSession({
      prompt: userMessage,
      model: model || undefined,
    })

    if (!session) return null

    // Track in SQLite (TOMBSTONE GUARD: session đã xóa → không upsert lại)
    if (sessionId && !(await isSessionDeletedDeep(sessionId))) {
      try {
        await db.agentSession.upsert({
          where: { sessionId },
          create: {
            sessionId,
            model: model || 'opencode',
            provider: 'opencode',
            title: userMessage.slice(0, 50) || 'Code Session',
            messageCount: 1,
            agentProfileId: agentProfileId || null,
            teamMode: teamMode || null,
            teamName: teamName || null,
          },
          update: {
            messageCount: { increment: 1 },
            model: model || undefined,
          },
        })
      } catch {}
    }

    // Also track as OpenCodeSession
    try {
      await db.openCodeSession.create({
        data: {
          sessionId: session.sessionId || session.id || `oc-${Date.now()}`,
          model: model || null,
          provider: 'opencode',
          prompt: userMessage,
          status: 'active',
        },
      })
    } catch {}

    // Build enrichment info for the response
    const enrichmentInfo = enrichment.enrichmentScore > 0
      ? `\n\n📊 **KB Context Enrichment** (score: ${(enrichment.enrichmentScore * 100).toFixed(0)}%):\n` +
        (enrichment.entities.length > 0 ? `• Entities: ${enrichment.entities.length} found (${enrichment.entities.slice(0, 3).map(e => e.name).join(', ')}${enrichment.entities.length > 3 ? '...' : ''})\n` : '') +
        (enrichment.documents.length > 0 ? `• Documents: ${enrichment.documents.length} relevant\n` : '') +
        (enrichment.corrections.length > 0 ? `• Corrections: ${enrichment.corrections.length} from past sessions\n` : '') +
        (enrichment.insights.length > 0 ? `• Insights: ${enrichment.insights.length} available\n` : '')
      : ''

    // Return a response indicating the session was created with KB enrichment
    return NextResponse.json({
      content: `🔧 **Đã tạo Knowledge-Aware OpenCode Session** — "${userMessage.slice(0, 80)}${userMessage.length > 80 ? '...' : ''}"${workspaceCtxForOC.root ? `\n\n📁 **Workspace root**: \`${workspaceCtxForOC.root}\`` : ''}\n\nSession đã được gửi đến OpenCode Server với Knowledge Base context. Agent sẽ:\n1. 📖 Đọc file liên quan${workspaceCtxForOC.root ? ` trong workspace \`${workspaceCtxForOC.root}\`` : ''}\n2. 🔍 Tìm kiếm Knowledge Base qua MCP Bridge\n3. 📝 Kiểm tra corrections từ sessions trước\n4. ✏️ Phân tích và thực hiện chỉnh sửa\n5. 🔧 Chạy LSP diagnostics để kiểm tra\n6. 💡 Tự động capture insights mới vào KB${enrichmentInfo}\n📋 **Session ID**: ${session.sessionId || session.id}\n💻 Xem tiến trình trong tab **Code** → Active Sessions\n\n🤖 _Agent đang xử lý... Xem real-time progress tại Code Tab_`,
      model: model || 'opencode',
      provider: 'opencode',
      sessionId: sessionId || `session-${Date.now()}`,
      opencodeSessionId: session.sessionId || session.id,
      kbResults: 'opencode-routed-enriched',
      routedTo: 'opencode',
      enrichment: {
        score: enrichment.enrichmentScore,
        entitiesFound: enrichment.entities.length,
        documentsFound: enrichment.documents.length,
        correctionsFound: enrichment.corrections.length,
        insightsFound: enrichment.insights.length,
        codeConfidence,
      },
      systemPromptLength: workspaceAwarePrompt.length,
    })
  } catch (err) {
    console.warn('[OpenClaw Chat] OpenCode routing error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ============================================
// MAIN HANDLER
// ============================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { messages: clientMessages, model, sessionId, stream, systemPromptAdditions,
            agentInstruction, agentTemperature, agentMaxTokens, agentProfileId, agentProfileName,
            agentProvider, agentModel, teamMode, teamName, promptBudgetChars } = body

    // 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): request có thể ghi
    // đè trần ký tự system prompt cho đúng tác vụ này. -1 (hoặc ≤0) = KHÔNG
    // GIỚI HẠN; số dương = trần cụ thể; thiếu/NaN = mặc định hệ thống.
    const effectivePromptBudget: number | undefined =
      typeof promptBudgetChars === 'number' && Number.isFinite(promptBudgetChars)
        ? Math.floor(promptBudgetChars)
        : undefined

    if (!clientMessages || !Array.isArray(clientMessages) || clientMessages.length === 0) {
      return NextResponse.json(
        { error: 'Messages array is required' },
        { status: 400 }
      )
    }

    // Extract last user message early — needed for memory recall and routing
    const lastUserMsg = [...clientMessages].reverse().find((m: { role: string }) => m.role === 'user')
    const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    // ============================================
    // USER REQUEST 2026-09-01 (session persistence) — LƯU USER MESSAGE NGAY
    // khi nhận request (không đợi response xong như trước). Trước đây user+
    // assistant lưu cùng lúc CUỐI request → user rời phiên giữa chừng (đổi
    // module / mở phiên khác) rồi quay lại sẽ KHÔNG thấy tin mình vừa gửi.
    // Giờ: user message vào DB ngay → reload phiên đang chạy vẫn thấy; các
    // lệnh save cuối request (casual/ReAct/fallback) giờ chỉ lưu assistant.
    // AWAIT để DB-history merge bên dưới chắc chắn thấy (tránh race khi user
    // gửi 2 lần nội dung giống nhau).
    // TOMBSTONE GUARD (2026-09-08): session đã bị user xóa → KHÔNG lưu gì nữa
    // (phiên đã xóa = xóa hẳn, không hồi sinh). Deep check (Set + DB persist)
    // — chặn cả sessionId từ browser tab cũ sau khi app đã restart.
    // ============================================
    // CI-5 (Task 14-c): id của user message vừa early-save (nếu có) — nhánh
    // durable enqueue GoalLoopJob kèm messageId này để job truy vết về đúng
    // tin nhắn trigger (không có/duplicate → null → enqueue nhận undefined).
    let savedUserMessageId: string | null = null
    if (sessionId && lastUserContent && !(await isSessionDeletedDeep(sessionId))) {
      try {
        // DEDUPE (fix E2E 2026-09-08): user bấm Dừng rồi GỬI LẠI cùng nội dung
        // (hoặc cancel giữa chừng rồi retry) → request cũ đã early-save user
        // message này rồi → KHÔNG lưu bản trùng (E2E thấy 2 rows y hệt nhau).
        const threeMinAgo = new Date(Date.now() - 3 * 60_000)
        const dup = await db.chatMessage.findFirst({
          where: {
            sessionId,
            role: 'user',
            content: lastUserContent,
            createdAt: { gte: threeMinAgo },
          },
          select: { id: true },
        })
        if (!dup) {
          const savedUserMsg = await db.chatMessage.create({ data: { sessionId, role: 'user', content: lastUserContent } })
          savedUserMessageId = savedUserMsg.id
          db.agentSession
            .updateMany({
              where: { sessionId },
              data: { messageCount: { increment: 1 }, updatedAt: new Date() },
            })
            .catch(() => {})
        }
      } catch (err) {
        console.warn('[OpenClaw Chat] Early user-message save failed:', err instanceof Error ? err.message : String(err))
      }

      // WORKING MEMORY (HOT) — user request 2026-08-28: lưu user message vào
      // WorkingMemory theo (agent, session). Hết phiên, promoteWorkingMemoryToWarm
      // sẽ dùng các entry này (kèm tool-log từ goal loop) để LLM chưng cất thành
      // AgentMemory dài hạn — "đã làm dự án gì, triển khai gì, kết quả thế nào".
      if (agentProfileId) {
        addToWorkingMemory({
          agentId: agentProfileId,
          sessionId,
          content: lastUserContent.slice(0, 2000),
          role: 'user',
        }).catch(() => { /* fail-open */ })
      }
    }

    // ============================================
    // USER REQUEST 2026-09-01 (lazy-load history) — MERGE DB HISTORY
    // Frontend giờ chỉ gửi phần hội thoại đang HIỂN THỊ (mặc định 3 lượt cuối,
    // phần cũ phải kéo lên mới load) → nếu dùng nguyên mảng client, LLM sẽ
    // MẤT context của các lượt trao đổi cũ. Merge với history trong DB:
    //   - DB có full lịch sử của session (mọi lượt đều được saveChatMessages)
    //   - user message vừa gửi CHƯA có trong DB (server save SAU khi response
    //     xong) → append vào cuối
    // Fail-open: lỗi DB → dùng nguyên messages client như cũ.
    // ============================================
    let messages = clientMessages
    if (sessionId) {
      try {
        const dbHistory = await db.chatMessage.findMany({
          where: { sessionId, role: { in: ['user', 'assistant'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 30, // 30 message gần nhất (≈ 15 lượt) — đủ context, không phình prompt
        })
        if (dbHistory.length > 0) {
          const dbMapped = dbHistory
            .slice()
            .reverse() // desc → asc
            .map(m => ({ role: m.role, content: m.content }))
          // DB đã chứa user message mới nhất? (request gửi lại / duplicate) →
          // không append nữa để tránh lặp
          const lastDbUser = [...dbMapped].reverse().find(m => m.role === 'user')
          messages = lastDbUser && lastDbUser.content === lastUserContent
            ? dbMapped
            : [...dbMapped, ...(lastUserMsg ? [lastUserMsg] : [])]
        }
      } catch (err) {
        console.warn('[OpenClaw Chat] DB history merge failed — using client messages:', err instanceof Error ? err.message : String(err))
      }
    }

    // ============================================
    // PHASE A: INTENT CLASSIFICATION — Smart KB Routing
    // Classify the user message intent BEFORE doing any KB/memory work.
    // This allows casual messages (greetings, thanks) to skip the entire
    // KB pipeline — saving ~2s of latency and ~500 tokens per casual message.
    // ============================================
    let intent: 'casual' | 'factual' | 'procedural' | 'meta' = 'factual'
    let intentConfidence = 0
    let intentSource = 'default'

    if (lastUserContent) {
      try {
        // skipLLMFallback=true: for chat, we don't want to add LLM latency for ambiguous messages
        // — just default to 'factual' and let the existing flow handle it
        const intentResult = await classifyIntent(lastUserContent, { skipLLMFallback: true })
        intent = intentResult.intent
        intentConfidence = intentResult.confidence
        intentSource = intentResult.source
        console.log(`[OpenClaw Chat] Intent: ${intent} (confidence: ${intentConfidence.toFixed(2)}, source: ${intentSource})`)
      } catch (err) {
        console.warn('[OpenClaw Chat] Intent classification failed, defaulting to factual:', err instanceof Error ? err.message : String(err))
      }
    }

    // CASUAL intent: skip everything — return fast response without hitting LLM or KB
    // FIX 2026-08-28: câu hỏi về workspace/thư mục dự án KHÔNG phải casual —
    // chúng cần workspace context trong system prompt để agent trả lời đúng.
    // Nếu classifyIntent nhầm thành casual → đổi sang factual để đi full flow.
    // FIX RESET-2026-08-30: thêm từ khóa về năng lực bản thân agent (skill/tool/
    // mcp/todo/công cụ) — "bạn có tool gì?" phải đi agent/capability path chứ
    // không phải casual canned response.
    if (intent === 'casual' && /(thư mục|workspace|root|project|folder|directory|file|tệp|skill|công cụ|tool|mcp|todo|kỹ năng)/i.test(lastUserContent)) {
      intent = 'factual'
      intentSource = 'workspace-keyword-override'
      console.log('[OpenClaw Chat] Workspace keyword detected — casual → factual')
    }
    if (intent === 'casual') {
      const casualResponse = generateCasualResponse(lastUserContent, agentProfileName)

      // Save chat messages (non-blocking — for session history)
      // 2026-09-01: user message đã lưu Ở ĐẦU request → chỉ lưu assistant ở đây
      if (sessionId) {
        saveChatMessages(sessionId, [
          { role: 'assistant', content: casualResponse, model: 'casual-fast-path', provider: 'intent-classifier' },
        ]).catch(() => {})
      }

      return NextResponse.json({
        content: casualResponse,
        model: 'casual-fast-path',
        provider: 'intent-classifier',
        sessionId: sessionId || `session-${Date.now()}`,
        agentProfileId: agentProfileId || undefined,
        intent,
        intentConfidence,
        kbResults: 'skipped',
        memoriesRecalled: 0,
      })
    }

    // PROCEDURAL intent: route to OpenCode (keep existing isCodeQuery logic as backup)
    // classifyIntent may catch procedural queries that isCodeQuery misses
    //
    // FIX 2026-08-28: KHÔNG short-circuit khi user đang chat với agent có
    // provider/model riêng (Omega...) — ReAct loop bên dưới THỰC THI tool thật
    // (file_read/file_list/grep/shell theo active workspace), trong khi
    // routeToOpenCode chỉ tạo session STUB trên opencode-server (record prompt,
    // không xử lý) → user nhận canned response thay vì agent làm việc thật.
    // OpenCode routing giờ chỉ là fallback cho chat KHÔNG có agent config.
    const hasAgentProviderModel = !!(agentProvider && agentModel)
    if ((intent === 'procedural' || isCodeQuery(lastUserContent)) && !hasAgentProviderModel) {
      const opencodeResponse = await routeToOpenCode(lastUserContent, model, sessionId, messages, agentProfileId, teamMode, teamName)
      if (opencodeResponse) {
        return opencodeResponse
      }
      // If OpenCode is offline, fall through to regular flow (with a note)
    }

    // META intent: queries about the agent itself ("who are you", "what can you do")
    // Skip KB context injection (Phase B will handle this), but continue with existing flow
    // so the agent can use its profile + skills to respond

    // FACTUAL intent: run full flow (memory recall + KB + LLM) — existing behavior continues below

    // ============================================
    // PROACTIVE MEMORY RECALL — Phase 5
    // Before building the response, recall relevant memories for this agent
    // and inject them into the system prompt so the agent remembers past interactions.
    // ============================================
    let recalledMemories: Array<{ id: string; content: string; category: string; importance: number; relevance: number; context?: string | null }> = []
    let userProfileContext = ''

    if (agentProfileId && lastUserContent) {
      try {
        // Ensure agent_memory collection exists in Qdrant
        await ensureAgentMemoryCollection().catch(() => {})

        // Recall relevant memories (non-blocking if it fails)
        recalledMemories = await recallMemories({
          agentId: agentProfileId,
          query: lastUserContent,
          topK: 5,
          minImportance: 0.3,
        }).catch(err => {
          console.warn('[OpenClaw Chat] Memory recall failed:', err instanceof Error ? err.message : String(err))
          return []
        })

        // Load user profile
        const profile = await getUserProfile().catch(() => [])
        if (profile.length > 0) {
          userProfileContext = profile.map(p => `- ${p.key}: ${p.value}`).join('\n')
        }
      } catch (err) {
        console.warn('[OpenClaw Chat] Memory system error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ============================================
    // PHASE B: KB PRE-SEARCH — Smart KB Routing
    // For factual queries, search Qdrant chunks + Neo4j entities BEFORE building
    // the system prompt. This gives the agent dynamic KB context (instead of static).
    // Results are stored in kbSearchResult for later use by writeback (Phase C) and /api/query (Phase D).
    // ============================================
    let kbSearchResult: Awaited<ReturnType<typeof searchUserKB>> | null = null
    let dynamicKBContext = ''

    if (intent === 'factual' && lastUserContent) {
      try {
        // Phase 4 SMOLAB Task C — Prop 3.9: query rewrite + HyDE (flag-gated).
        // Rewrites the latest query to be self-contained (pronoun resolution via
        // the last 2 prior turns) + generates a HyDE hypothetical answer whose
        // embedding becomes the dense search vector. Returns null on ANY failure
        // → we fall back to the plain query (retrieval never breaks).
        let hydeEmbedding: number[] | undefined
        let effectiveQuery = lastUserContent
        if (isFlagEnabled('ENABLE_QUERY_REWRITE')) {
          // Prior turns BEFORE the latest user message (the query itself is NOT context)
          const lastUserIdx = messages.map((m: { role: string }) => m.role === 'user').lastIndexOf(true)
          const recentHistory = messages
            .slice(0, lastUserIdx === -1 ? messages.length : lastUserIdx)
            .filter((m: { role: string; content?: string }) =>
              (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-2)
            .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }))
          const rewrite = await rewriteQuery(lastUserContent, recentHistory)
          if (rewrite) {
            hydeEmbedding = rewrite.hydeEmbedding.length > 0 ? rewrite.hydeEmbedding : undefined
            effectiveQuery = rewrite.rewrittenQuery || lastUserContent
            console.log(`[Chat] Query rewrite: "${lastUserContent.slice(0, 50)}" → "${effectiveQuery.slice(0, 50)}" (HyDE ${rewrite.cacheHit ? 'cache-hit' : `${rewrite.durationMs}ms`})`)
          }
        }
        kbSearchResult = await searchUserKB(effectiveQuery, agentProfileId || undefined, { topK: 5, embeddingOverride: hydeEmbedding })
        console.log(`[OpenClaw Chat] KB pre-search: ${kbSearchResult.chunks.length} chunks, ${kbSearchResult.entities.length} entities, confidence=${kbSearchResult.confidence.toFixed(2)}`)

        // Build dynamic KB context from search results
        const parts: string[] = []
        if (kbSearchResult.chunks.length > 0) {
          parts.push('--- Document Chunks (from Knowledge Base) ---')
          parts.push(kbSearchResult.chunks.map((c, i) =>
            `[${i + 1}] (similarity: ${c.score.toFixed(2)}) ${c.text.slice(0, 500)}`
          ).join('\n'))
        }
        if (kbSearchResult.entities.length > 0) {
          parts.push('--- Known Entities (from Knowledge Graph) ---')
          parts.push(kbSearchResult.entities.map(e =>
            `- ${e.name} (${e.type}): ${e.description.slice(0, 200)}`
          ).join('\n'))
        }
        // Leiden community context (user request 2026-09-05): bức tranh lớn từ
        // entity graph — Agents thấy cả "chủ đề nào đang nói tới" chứ không chỉ
        // từng chunk rời rạc
        if (kbSearchResult.communities.length > 0) {
          parts.push('--- Knowledge Communities (Leiden graph clusters) ---')
          parts.push(kbSearchResult.communities.map(c =>
            `[${c.score?.toFixed(2) ?? '?'}] ${c.summary.slice(0, 600)}`
          ).join('\n'))
        }
        dynamicKBContext = parts.join('\n\n')
      } catch (err) {
        console.warn('[OpenClaw Chat] KB pre-search failed:', err instanceof Error ? err.message : String(err))
      }
    }

    // Build system prompt — use dynamic KB context if available, otherwise static
    // If agentInstruction is provided (from Agent Profile), prepend it to the system prompt
    const kbContextForPrompt = dynamicKBContext || STATIC_KB_CONTEXT
    let systemPrompt = DEFAULT_SYSTEM_PROMPT + `\n\n--- Knowledge Base Context ---\n${kbContextForPrompt}`

    // WORKSPACE CONTEXT (user request 2026-08-28): root + cấu trúc cấp 1 + tool hướng dẫn.
    // Giúp agent TRẢ LỜI được "thư mục gốc hiện tại là gì / có file gì" và EMIT tool calls
    // (file_read/file_list/grep/shell) resolve theo active workspace (workspace-root.ts).
    const workspaceCtx = await buildWorkspaceContext()
    if (workspaceCtx.text) {
      systemPrompt += `\n\n${workspaceCtx.text}`
    }

    // RUNTIME CAPABILITY REPORT (user request 2026-08-29): agents phải BIẾT tool nào
    // thực sự hoạt động — probe thật (fs/shell/qdrant/neo4j/web/skills/mcp/todo)
    // chạy ngay trước cuộc hội thoại, kết quả verified inject vào system prompt.
    // Fail-open: probe lỗi → block rút gọn, KHÔNG chặn chat.
    try {
      const { buildCapabilityPromptBlock } = await import('@/lib/agent-capabilities')
      const capabilityBlock = await buildCapabilityPromptBlock()
      systemPrompt += `\n${capabilityBlock}`
    } catch (capErr) {
      console.warn('[OpenClaw Chat] Capability probe failed (fail-open):', capErr instanceof Error ? capErr.message : String(capErr))
    }

    // AGENT ROSTER (user request 2026-09-08: "các Agents cần nắm được kỹ năng
    // chuyên môn của nhau, xác định khi cần có thể gọi Agents có kỹ năng chuyên
    // môn tốt hơn") — danh bạ đồng nghiệp inject vào system prompt MỌI agents:
    // ai giỏi gì + cách gọi (escalate_problem → Omega / delegate_task Code Team /
    // dispatch_agent mọi agent). Fail-open: DB lỗi → bỏ qua block.
    try {
      const { buildAgentRosterPromptBlock } = await import('@/lib/agent-roster')
      const rosterBlock = await buildAgentRosterPromptBlock(agentProfileName || undefined)
      if (rosterBlock) systemPrompt += `\n${rosterBlock}`
    } catch (rosterErr) {
      console.warn('[OpenClaw Chat] Agent roster injection failed (fail-open):', rosterErr instanceof Error ? rosterErr.message : String(rosterErr))
    }

    if (agentInstruction && typeof agentInstruction === 'string' && agentInstruction.trim()) {
      systemPrompt = agentInstruction.trim() + '\n\n--- Base System Prompt ---\n' + systemPrompt
    }

    // Inject enabled skills from AgentSkill DB table into the system prompt
    // NOTE: Skills are injected via TWO mechanisms serving DIFFERENT paths:
    //   1. DB → systemPrompt (this code) — used by OpenClaw Chat & Workflow Engine
    //   2. Filesystem (skills/<slug>/SKILL.md) — used by z.ai platform sandbox
    //   Do NOT add a third injection point without checking for duplication.
    try {
      // Load ALL enabled skills — skills are global (not per-agent)
      // agentId field on AgentSkill is for future per-agent assignment
      let enabledSkills = await db.agentSkill.findMany({
        where: { enabled: true },
        select: { name: true, slug: true, content: true, source: true },
      })
      // 2026-09-01 — SKILL ACCESS prompt-side: SkillAssignment override
      // enabled=false → KHÔNG inject skill đó vào prompt agent này (agent
      // vẫn không đọc được qua read_skill — executor hard-gate). Fail-open.
      if (enabledSkills.length > 0 && agentProfileName) {
        try {
          const { getDisabledSlugsForAgent } = await import('@/lib/skill-access')
          const disabled = await getDisabledSlugsForAgent(agentProfileName)
          if (disabled.size > 0) {
            const before = enabledSkills.length
            enabledSkills = enabledSkills.filter(s => !disabled.has(s.slug))
            console.log(`[OpenClaw Chat] Skill access: lọc ${before - enabledSkills.length}/${before} skill bị chặn cho agent "${agentProfileName}"`)
          }
        } catch { /* fail-open — inject đủ */ }
      }
      if (enabledSkills.length > 0) {
        // Token budget: limit skills injection to ~4K tokens (~16K chars) to avoid bloating system prompt
        const MAX_SKILLS_CHARS = 16000
        let skillsText = ''
        for (const skill of enabledSkills) {
          const section = `## Skill: ${skill.name} (source: ${skill.source})\n${skill.content}\n\n---\n\n`
          if ((skillsText + section).length > MAX_SKILLS_CHARS) {
            skillsText += `## Skill: ${skill.name} (source: ${skill.source})\n[Content truncated — skill content too large. Use the skill name to look up details.]\n\n---\n\n`
            break
          }
          skillsText += section
        }
        systemPrompt += `\n\n--- Available Skills ---\nYou have access to the following skills. Each skill is a guide that tells you WHEN and HOW to use a specific capability. Follow the instructions in each skill when the situation calls for it.\n\n${skillsText}`
      }
    } catch (skillErr) {
      console.warn('[OpenClaw Chat] Failed to load enabled skills:', skillErr instanceof Error ? skillErr.message : String(skillErr))
    }

    // CUSTOM TOOLS (user request 2026-08-30): agents TỰ VIẾT tools khi thiếu.
    // Inject danh sách custom tools đã có + hướng dẫn create_custom_tool để
    // agent biết có thể tự tạo tool mới và DÙNG NGAY (hot-register).
    try {
      const { ensureCustomToolsLoaded, getAllCustomTools } = await import('@/lib/custom-tool-registry')
      await ensureCustomToolsLoaded()
      const customTools = getAllCustomTools().filter(t => t.enabled)
      let customToolsText = `\n\n--- Custom Tools (TỰ VIẾT) ---\n`
      customToolsText += `Bạn có thể TỰ VIẾT tool mới khi thiếu tool cho task:\n`
      customToolsText += `tool_call: create_custom_tool({"name": "tool_snake_case", "description": "...", "parameters": {"type":"object","properties":{...},"required":[...]}, "handlerCode": "function handler(args) { ... return result }"})\n`
      customToolsText += `- Handler JS thuần, sandbox có: fetch/JSON/Math/Date/console. KHÔNG process/require/import/eval/fs.\n`
      customToolsText += `- Sau tạo THÀNH CÔNG → gọi NGAY: tool_call: <name>({...}). Tool + SKILL.md guide lưu vĩnh viễn, mọi agents dùng được.\n`
      customToolsText += `- Liệt kê: tool_call: list_custom_tools({}) — Xóa: tool_call: delete_custom_tool({"name": "..."})\n`
      if (customTools.length > 0) {
        customToolsText += `\nCustom tools hiện có (${customTools.length}) — gọi trực tiếp bằng tên:\n`
        for (const t of customTools) {
          const props = t.parameters && typeof t.parameters === 'object' && (t.parameters as { properties?: Record<string, unknown> }).properties
            ? Object.keys((t.parameters as { properties: Record<string, unknown> }).properties).join(', ')
            : ''
          customToolsText += `- ${t.name}(${props}): ${t.description.slice(0, 150)} [đã gọi ${t.callCount} lần]\n`
        }
      } else {
        customToolsText += `\n(Chưa có custom tool nào — bạn là agent đầu tiên có thể tạo.)\n`
      }
      systemPrompt += customToolsText
    } catch (ctErr) {
      console.warn('[OpenClaw Chat] Custom tools injection failed (fail-open):', ctErr instanceof Error ? ctErr.message : String(ctErr))
    }

    // Inject standing orders — persistent agent instructions
    try {
      const standingOrders = await db.standingOrder.findMany({
        where: { enabled: true },
        select: { order: true, priority: true },
        orderBy: { priority: 'desc' },
      })
      if (standingOrders.length > 0) {
        const ordersText = standingOrders.map(o => `- [P${o.priority}] ${o.order}`).join('\n')
        systemPrompt += `\n\n--- Standing Orders ---\nYou MUST follow these standing orders at all times:\n${ordersText}`
      }
    } catch (orderErr) {
      console.warn('[OpenClaw Chat] Failed to load standing orders:', orderErr instanceof Error ? orderErr.message : String(orderErr))
    }

    // Inject recalled memories into system prompt
    if (recalledMemories.length > 0) {
      const memoryText = recalledMemories.map((m, i) =>
        `[Memory ${i + 1}] (${m.category}, importance: ${m.importance.toFixed(1)}) ${m.content}${m.context ? ` \n  Context: ${m.context}` : ''}`
      ).join('\n')
      systemPrompt += `\n\n--- Recalled Memories ---\nYou have the following memories from past interactions. Use them to personalize your response and remember what you've learned:\n${memoryText}`
    }

    // ============================================
    // WORKING MEMORY (HOT) DIGEST — user request 2026-08-28
    // "Agents có được thiết lập để truy vấn vào vùng nhớ HOT không?" → CÓ.
    // Inject các hoạt động gần đây của agent (files đã đọc, lệnh đã chạy, kết
    // quả, mục tiêu đã xong) vào system prompt. Mục đích kép:
    //   (a) Agent NHỚ việc đã làm → không phải chạy tool lại để "nhớ lại"
    //   (b) TIẾT KIỆM TOKEN — thông tin nằm sẵn trong prompt, khỏi re-read
    // Cap ~2000 ký tự để không phình prompt. Fail-open toàn bộ.
    // ============================================
    if (agentProfileId) {
      try {
        const sessionHot = sessionId ? await getWorkingMemory(agentProfileId, sessionId, 12) : []
        const recentHot = await getRecentWorkingMemory(agentProfileId, 8)
        const otherSessionHot = recentHot.filter(h => h.sessionId !== sessionId)

        const lines: string[] = []
        if (sessionHot.length > 0) {
          lines.push('Hoạt động trong PHIÊN NÀY (mới nhất trước — DÙNG LUÔN thông tin này, KHÔNG chạy tool đọc lại những gì đã có kết quả):')
          for (const h of sessionHot) {
            lines.push(`- ${h.content.replace(/\s+/g, ' ').slice(0, 180)}`)
          }
        }
        if (otherSessionHot.length > 0) {
          lines.push('')
          lines.push('Hoạt động gần đây khác (phiên khác, còn hiệu lực HOT):')
          for (const h of otherSessionHot) {
            lines.push(`- ${h.content.replace(/\s+/g, ' ').slice(0, 160)}`)
          }
        }

        let hotDigest = lines.join('\n')
        if (hotDigest.length > 2000) hotDigest = hotDigest.slice(0, 2000) + '\n…(giới hạn 2000 ký tự)'

        if (hotDigest) {
          systemPrompt += `\n\n--- Working Memory (HOT — quá trình làm việc gần đây) ---\n${hotDigest}\nQuy tắc: nếu dữ liệu cần cho câu trả lời ĐÃ có trong working memory ở trên, dùng ngay — không gọi tool lặp lại. Chỉ chạy tool mới khi cần thông tin chưa có.`
        }
      } catch (hotErr) {
        console.warn('[OpenClaw Chat] Working Memory digest failed (fail-open):', hotErr instanceof Error ? hotErr.message : String(hotErr))
      }
    }

    // Inject user profile into system prompt
    if (userProfileContext) {
      systemPrompt += `\n\n--- User Profile ---\nWhat you know about the user:\n${userProfileContext}`
    }

    // Append systemPromptAdditions AFTER skills so user-provided additions take precedence
    if (systemPromptAdditions) {
      systemPrompt += `\n\n${systemPromptAdditions}`
    }

    // Prepend system prompt to messages
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ]

    // ============================================
    // INTELLIGENT ROUTING — Phase OC-2 + Phase 3
    // ============================================
    // Phase 3: When an Agent has a configured provider/model,
    // skip the gateway and go directly to /api/query (which uses callLLMForAgent).
    // This ensures the Agent uses its OWN provider/model, NOT the gateway's routing.
    //
    // Flow:
    //   1. Code query → try OpenCode
    //   2. Agent with configured provider/model → go directly to /api/query (Phase 3)
    //   3. No agent config → try Gateway → then /api/query → then mock

    // If the query is code-related, try routing to OpenCode first
    // NOTE: Phase A already handles this via classifyIntent() above (intent === 'procedural')
    // This is a safety net for when classifyIntent defaults to 'factual' but isCodeQuery still matches
    // FIX 2026-08-28: same guard as Phase A — agent có provider/model → ReAct loop xử lý
    // (thực thi tool thật trong workspace) thay vì canned OpenCode session.
    if (intent !== 'procedural' && isCodeQuery(lastUserContent) && !hasAgentProviderModel) {
      const opencodeResponse = await routeToOpenCode(lastUserContent, model, sessionId, messages, agentProfileId, teamMode, teamName)
      if (opencodeResponse) {
        return opencodeResponse
      }
      // If OpenCode is offline, fall through to regular flow
      // (with a note that code features are unavailable)
    }

    // Phase 3+: Agent with configured provider/model → use ReAct loop for tool execution
    // This enables agents like Omega to actually USE their declared tools (opencode, knowledge_search, tavily, etc.)
    // instead of just having them in prompts. Falls back to /api/query if the ReAct loop fails.
    // (hasAgentProviderModel declared earlier — Phase A procedural guard)

    if (hasAgentProviderModel) {
      console.log(`[OpenClaw Chat] Goal-driven loop: Agent using own provider/model (${agentProvider}/${agentModel})`)

      try {
        // Determine agent tools — DB-first (user request 2026-09-08 Agent Factory):
        //   1. AgentProfile.tools (JSON) — agent do Omega create_agent tạo có toolset riêng
        //   2. Standalone definition (Omega hardcoded whitelist)
        //   3. [] — agent custom không khai báo tools → MỌI tool đều được phép
        //      (goal loop: agentTools.length===0 → không filter)
        let agentTools = agentProfileName ? getStandaloneAgentTools(agentProfileName) : []
        if (agentProfileId) {
          try {
            const dbProfile = await db.agentProfile.findUnique({
              where: { id: agentProfileId },
              select: { tools: true },
            })
            if (dbProfile?.tools) {
              const parsed = JSON.parse(dbProfile.tools)
              if (Array.isArray(parsed) && parsed.length > 0) {
                agentTools = parsed.map((t: unknown) => String(t))
              }
            }
          } catch (toolErr) {
            console.warn('[OpenClaw Chat] DB tools resolve failed (fail-open → standalone def):', toolErr instanceof Error ? toolErr.message : String(toolErr))
          }
        }

        // ━━━ 21-c — PROMPT-SIDE TOOL-ACCESS ENFORCEMENT ━━━
        // ToolAssignment override (Tools Manager UI / Omega manage_tools): tool bị
        // disable → loại khỏi whitelist (LLM không thấy + goal-loop không cho gọi);
        // enable-thêm → vào whitelist. Fail-open: lỗi DB → giữ whitelist như trên.
        try {
          const { getEffectiveToolNames } = await import('@/lib/tool-access')
          agentTools = await getEffectiveToolNames(agentProfileName, agentTools)
        } catch (toolAccessErr) {
          console.warn('[OpenClaw Chat] ToolAccess enforce failed (fail-open):', toolAccessErr instanceof Error ? toolAccessErr.message : String(toolAccessErr))
        }

        // GOAL-DRIVEN LOOP (2026-09-01): thay ReAct loop 8 vòng — chạy nhiều chu kỳ
        // PLAN → EXECUTE → VERIFY → EVALUATE (trọng tài độc lập) → DIAGNOSE+REPLAN
        // cho đến khi mục tiêu hoàn thành hoặc hết budget. maxIterations không còn
        // hardcoded ở đây — cấu hình qua env trong agent-goal-loop.ts.
        //
        // CI-2 (Task 11-a) — PER-TASK TODO ISOLATION: NGAY TRƯỚC khi run mới bắt
        // đầu, lưu trữ (archive) mọi todo CÒN ĐANG MỞ (pending/in_progress/
        // blocked) của các run TRƯỚC trong session (runId != null) → status
        // 'archived' + archivedAt. Chọn hook ở ĐÂY (chat route, trước
        // runGoalDrivenLoop) thay vì trong startAgentRun (tracker) vì:
        //   (a) tracker là in-memory + fail-open — không nên gánh DB write;
        //   (b) mọi goal-loop run của chat đều đi qua đúng 1 điểm này → không
        //       archive nhầm todo của run đang chuẩn bị tạo (run mới chưa có
        //       todo nào — archive chạy trước startAgentRun trong loop);
        //   (c) todo runId=null (legacy, trước CI-2) được GIỮ NGUYÊN — hành vi
        //       hiển thị theo session của mọi dữ liệu cũ không đổi.
        // Fail-open tuyệt đối: isolation lỗi không được phép chặn chat.
        if (sessionId) {
          try {
            await archiveStaleRunTodos(sessionId)
          } catch { /* fail-open — archive lỗi không chặn chat */ }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // CI-5 (GĐ4, Task 14-c — roadmap B5): DURABLE BRANCH — ENQUEUE + TRẢ
        // JOBID NGAY. Khi ENABLE_DURABLE_GOAL_LOOP=true (đọc lúc boot) và có
        // sessionId: KHÔNG chạy goal loop chặn request này nữa — enqueue job
        // vào DB queue, GoalLoopWorker nền (tick ≤5s) claim + chạy + checkpoint
        // mỗi vòng + finalize (lưu ChatMessage assistant khi hoàn tất). User
        // đóng tab / app restart: job sống sót, resume từ checkpoint, nút Dừng
        // sống qua DB flag cancelRequestedAt.
        //
        // Mọi thứ PHÍA TRƯỚC đã chạy xong như đường inline (user message save,
        // archiveStaleRunTodos, tool resolve/enforce phía trên) — jobInput dưới
        // đây mang ĐỦ tham số runGoalDrivenLoop cần (closure không sống qua
        // restart nên phải serialize toàn bộ). Fail-open 2 lớp:
        //   (a) enqueue lỗi → LOG + rơi xuống chạy INLINE như cũ (KHÔNG 500);
        //   (b) worker chưa start (flag lệch boot) → job vẫn nằm queued trong
        //       DB, tick sẽ claim khi worker được bật.
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (DURABLE_GOAL_LOOP && sessionId) {
          // REVIEW 14-g M1 — try HẸP CHỈ BAO enqueue (job row ĐÃ tạo mà throw
          // thì tuyệt đối KHÔNG rơi xuống inline: job queued + inline chạy =
          // DOUBLE-RUN cùng 1 request). Mọi bước sau enqueue (upsert/return)
          // nằm NGOÀI try: sai lệch nhỏ (upsert fail...) được nuốt im lặng,
          // response durable vẫn trả về jobId — đúng tinh thần fail-open của
          // kiến trúc worker (job nằm queued, tick claim khi worker bật).
          let durableJobId: string | null = null
          try {
            durableJobId = await goalLoopWorker.enqueue({
              sessionId,
              messageId: savedUserMessageId ?? undefined,
              jobInput: {
                systemPrompt,
                userMessage: lastUserContent,
                // ĐÚNG filter như inline — chỉ user/assistant (bỏ system ở client)
                chatHistory: messages.filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant'),
                agentProvider,
                agentModel,
                agentId: agentProfileId || 'unknown',
                agentName: agentProfileName || 'Agent',
                agentTemperature,
                agentMaxTokens,
                agentTools,
                agentSessionId: sessionId,
                // 2026-10-27 — trần prompt theo tác vụ (user directive): -1 = unlimited
                promptBudgetChars: effectivePromptBudget,
              },
            })
          } catch (enqueueErr) {
            // FAIL-OPEN: enqueue lỗi (DB nghẽn/schema lệch...) → LOG + chạy
            // inline như cũ ngay bên dưới — user vẫn được phục vụ, KHÔNG 500.
            console.warn(
              '[OpenClaw Chat] Durable enqueue thất bại — fallback chạy goal loop inline:',
              enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
            )
          }

          if (durableJobId) {
            const jobId = durableJobId

            // Track session NGAY (mirror khối upsert sau loop của đường inline —
            // không đợi job chạy xong vì có thể mất nhiều phút; TOMBSTONE GUARD:
            // session đã xóa → không upsert lại). Đặt SAU enqueue thành công để
            // nhánh fallback inline không bị double-increment messageCount.
            try {
              if (!(await isSessionDeletedDeep(sessionId))) {
                try {
                  await db.agentSession.upsert({
                    where: { sessionId },
                    create: {
                      sessionId,
                      model: agentModel,
                      provider: agentProvider,
                      title: messages[0]?.content?.slice(0, 50) || 'New Chat',
                      messageCount: messages.length + 1,
                      agentProfileId: agentProfileId || null,
                      teamMode: teamMode || null,
                      teamName: teamName || null,
                    },
                    update: {
                      messageCount: { increment: 1 },
                    },
                  })
                } catch {}
              }
            } catch { /* isSessionDeletedDeep fail → vẫn upsert best-effort */ }

            console.log(
              `[OpenClaw Chat] Durable goal loop: job ${jobId} đã enqueue (session ${sessionId}, agent ${agentProfileName || 'Agent'}) — trả jobId ngay, worker nền sẽ chạy + finalize`
            )

            // Response giữ MỌI field frontend đang đọc (page.tsx sendMessage:
            // content/model/provider/sources/confidence/agentRun) + thêm
            // durable:true + jobId để UI (14-e) poll /api/goal-loop-jobs.
            // content = placeholder tiếng Việt — kết quả thật arrive qua poll
            // (finalize lưu ChatMessage assistant vào session gốc).
            return NextResponse.json({
              content: `⏳ Tác vụ đã vào hàng đợi nền (job ${jobId.slice(0, 12)}…) — Phiên chat sẽ tự cập nhật khi hoàn tất.`,
              model: agentModel,
              provider: agentProvider,
              sessionId: sessionId || `session-${Date.now()}`,
              agentProfileId: agentProfileId || undefined,
              sources: [],
              kbResults: 'agent-react',
              reactIterations: 0,
              toolCallsExecuted: 0,
              // confidence/agentRun/goalLoop: chưa có kết quả (job chạy nền) —
              // JSON.stringify bỏ key undefined, frontend đọc undefined an toàn
              durable: true,
              jobId,
              memoriesRecalled: recalledMemories.length || undefined,
              intent,
              kbConfidence: kbSearchResult?.confidence || undefined,
            })
          }
        }

        const reactResult = await runGoalDrivenLoop({
          systemPrompt,
          userMessage: lastUserContent,
          chatHistory: messages.filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant'),
          agentProvider,
          agentModel,
          agentId: agentProfileId || 'unknown',
          agentName: agentProfileName || 'Agent',
          agentTemperature,
          agentMaxTokens,
          agentTools,
          agentSessionId: sessionId || null,
          // 2026-10-27 — trần prompt theo tác vụ (user directive): -1 = unlimited
          promptBudgetChars: effectivePromptBudget,
        })

        const content = reactResult.content

        // WORKING MEMORY (HOT) — lưu câu trả lời của agent (phần cuối cùng của
        // exchange user↔assistant; promoteWorkingMemoryToWarm sẽ chưng cất cặp
        // này thành AgentMemory dài hạn khi hết phiên)
        if (agentProfileId && sessionId && content && !isLlmErrorContent(content)) {
          addToWorkingMemory({
            agentId: agentProfileId,
            sessionId,
            content: content.slice(0, 2500),
            role: 'assistant',
          }).catch(() => { /* fail-open */ })
        }

        // Thought Process summary (user request 2026-08-31) — trích từ run tracker
        // để (a) response JSON trả về frontend, (b) persist vào chat message
        // metadata cho session reload (hiện lại panel tĩnh collapsed).
        // FIX (E2E 2026-09-08): thêm EVENTS (compact) vào metadata — trước đây
        // chỉ persist counters, thought steps chi tiết chỉ sống trong
        // /api/agent-run (in-memory) → app restart là mất toàn bộ quá trình
        // thực thi (user yêu cầu xem được Thought Process của Omega).
        // (Task 14-c: PURE MOVE IIFE này thành helper chia sẻ
        // buildAgentRunSummaryForMessage trong goal-loop-finalize.ts — đường
        // durable finalize dùng cùng 1 nguồn sự thật.)
        const agentRunSummary = buildAgentRunSummaryForMessage(sessionId, reactResult.runId)

        // CI-2 (Task 11-a) — PER-ITEM HONEST CLOSE (thay bulk-close "TẤT CẢ cùng
        // lúc" quá thô): chỉ đóng todo của ĐÚNG run này (runId = reactResult.
        // runId; tracker fail → runId null → scope legacy của session), mỗi item
        // theo trạng thái thật của nó:
        //   - in_progress → completed (mục tiêu đạt) | failed (chưa đạt — đã bắt
        //     tay làm mà dở)
        //   - pending (chưa từng bắt tay) → completed (mục tiêu đạt) | GIỮ pending
        //     + archivedAt (chưa đạt — không đổ lỗi failed, nhưng ẩn khỏi run sau)
        // Todo của CÁC run khác trong session KHÔNG bị đụng (đã được archive khi
        // run này bắt đầu).
        // (Task 14-c: PURE MOVE khối inline này thành helper chia sẻ
        // closeGoalLoopRunTodos trong goal-loop-finalize.ts — đường durable
        // finalize dùng cùng 1 nguồn sự thật; helper tự fail-open.)
        await closeGoalLoopRunTodos({ sessionId, runId: reactResult.runId, goalLoop: reactResult.goalLoop })

        // Track session (TOMBSTONE GUARD: session đã xóa → không upsert lại)
        if (sessionId && !(await isSessionDeletedDeep(sessionId))) {
          try {
            await db.agentSession.upsert({
              where: { sessionId },
              create: {
                sessionId,
                model: agentModel,
                provider: agentProvider,
                title: messages[0]?.content?.slice(0, 50) || 'New Chat',
                messageCount: messages.length + 1,
                agentProfileId: agentProfileId || null,
                teamMode: teamMode || null,
                teamName: teamName || null,
              },
              update: {
                messageCount: { increment: 1 },
              },
            })
          } catch {}
        }

        // Phase C: Smart KB Writeback — replaces autoLearnFromAnswer
        // writebackToKB extracts entities/relationships with confidence filter (> 0.5),
        // writes to Qdrant + Neo4j + AgentMemory. Falls back to autoLearnFromAnswer if it fails.
        // Phase B: uses kbSearchResult (pre-searched) instead of empty step1Result
        // Phase 2 SMOLAB Prop 6 — uses writebackToKBTransactionally (PendingWriteback saga
        // tracking via batchId). Each writeback is now reconcilable via POST /api/storage/reconcile-writebacks.
        const hasAgent = !!(agentProfileId && agentProvider && agentModel)
        // KIMI-ONLY: lỗi LLM → bỏ writeback (không nhiễm KB bằng error message)
        const llmErrContent = isLlmErrorContent(content)
        if (hasAgent && !llmErrContent && !isTrivialExchange(lastUserContent, content)) {
          writebackToKBTransactionally({
            query: lastUserContent,
            step2Result: { used: true, content, supplemented: true, source: 'model-knowledge' },
            step1Result: kbSearchResult || { chunks: [], entities: [], memories: recalledMemories, communities: [], confidence: 0, source: 'user-kb' },
            agentId: agentProfileId!,
            agentName: agentProfileName || 'unknown',
            sessionId,
          }).then(({ batchId, result }) => {
            console.log(`[Writeback] ReAct batchId=${batchId} entities=${result.entitiesWritten} rels=${result.relationshipsWritten} chunks=${result.chunksWritten} memory=${result.memoryStored}`)
          }).catch(err => {
            console.error('[Writeback] Failed, falling back to autoLearn:', err instanceof Error ? err.message : String(err))
            // Fallback: old auto-learn path (writes to SQLite buffer)
            // FIX (confidence giả 0.5/0.6): dùng confidence THẬT (verdict
            // trọng tài của ReAct loop → KB pre-search → 0.6 trung tính cuối)
            // — trước đây hardcode 0.5/0.6: nếu AUTO_LEARN_MIN_CONFIDENCE nâng
            // lên 0.7 thì đường fallback im lặng ngừng học; record lưu
            // confidence giả 0.6 làm sai audit/lọc sau này.
            const fallbackConfidence =
              reactResult.goalLoop?.evaluatorConfidence ?? kbSearchResult?.confidence ?? 0.6
            if (shouldAutoLearn(fallbackConfidence, hasAgent)) {
              autoLearnFromAnswer({
                query: lastUserContent,
                answer: content,
                confidence: fallbackConfidence,
                agentId: agentProfileId!,
                agentName: agentProfileName || 'unknown',
                provider: agentProvider!,
                model: agentModel!,
                sources: [],
              }).catch(() => {})
            }
          })
        }

        // Background: Memory & Learning
        // Task 20-c — confidence THẬT (evaluator của goal-loop ?? KB retrieval):
        // dùng cho response JSON + persist vào message metadata (UI badge hiển
        // thị đúng khi reload session; undefined → JSON.stringify bỏ key →
        // badge tự ẩn — hết 0.6 giả hardcode)
        const finalConfidence = reactResult.goalLoop?.evaluatorConfidence ?? kbSearchResult?.confidence ?? undefined
        if (agentProfileId && sessionId) {
          // 2026-09-01: user message đã lưu ở ĐẦU request → chỉ lưu assistant
          saveChatMessages(sessionId, [
            { role: 'assistant', content, model: agentModel, provider: agentProvider, metadata: { confidence: finalConfidence, reactIterations: reactResult.iterations, toolCallsExecuted: reactResult.toolCallsExecuted, agentRun: agentRunSummary, goalLoop: reactResult.goalLoop, taskSummary: reactResult.taskSummary } },
          ])
            .then(async () => {
              // Task 20-c — link AgentRunRecord của run này với ChatMessage id
              // vừa persist (message mới nhất của session). Fire-and-forget,
              // fail-open — metrics không được phép làm hỏng chat flow.
              try {
                const latest = await db.chatMessage.findFirst({
                  where: { sessionId, role: 'assistant' },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  select: { id: true },
                })
                if (latest) {
                  await updateLatestAgentRunRecord(sessionId, { messageId: latest.id })
                }
              } catch { /* fail-open */ }

              // OPUS AUTO-REVIEW HOOK (REVIEW 13-f BUG #1): đường inline
              // (ENABLE_DURABLE_GOAL_LOOP=false — mặc định sandbox) KHÔNG qua
              // goal-loop-worker nên hook của worker không bao giờ fire cho
              // run do USER khởi tạo → auto mode chết với user chat. Fire sau
              // khi assistant message ĐÃ persist (gate query DB). Import động
              // chống circular; fire-and-forget — maybeAutoOpusReview tự gate
              // (mode auto + kill switch + dedupe 45s + 4 tín hiệu) + KHÔNG
              // throw. Session manual → gate im lặng skip (0 side-effect).
              try {
                const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
                void maybeAutoOpusReview(sessionId, {
                  runRef: reactResult.runId ?? null,
                  messageId: null, // resolveReviewTarget tự lấy assistant message cuối
                })
              } catch (opusErr) {
                console.warn('[OpenClaw Chat] Opus auto-review hook lỗi (fail-open):', opusErr instanceof Error ? opusErr.message : String(opusErr))
              }
            })
            .catch(err => console.warn('[Memory] Failed to save chat messages:', err instanceof Error ? err.message : String(err)))

          // KIMI-ONLY: lỗi LLM → không extract memory từ error message
          if (!llmErrContent && !isTrivialExchange(lastUserContent, content)) {
            extractMemoriesFromConversation({
              agentId: agentProfileId,
              agentName: agentProfileName || 'unknown',
              sessionId,
              userMessage: lastUserContent,
              assistantMessage: content,
            }).catch(err => console.warn('[Memory] Failed to extract memories:', err instanceof Error ? err.message : String(err)))
          }

          // Periodic memory decay + HOT→WARM promotion
          memoryDecayCounter++
          if (memoryDecayCounter >= 20 && agentProfileId) {
            memoryDecayCounter = 0
            // HOT→WARM (user request 2026-08-28): entry WorkingMemory hết TTL được
            // LLM chưng cất thành AgentMemory dài hạn — "đã làm gì, kết quả thế nào"
            // không bị mất khi TTL 1h hết
            import('@/lib/memory-tiers')
              .then(m => m.promoteWorkingMemoryToWarm(agentProfileId))
              .catch(err => console.warn('[Memory] HOT→WARM promotion error:', err instanceof Error ? err.message : String(err)))
            decayMemories(agentProfileId).catch(err =>
              console.warn('[Memory] Periodic decay error:', err instanceof Error ? err.message : String(err))
            )
          }
        }

        // Task 20-c — confidence THẬT (tính ở trên) thay hardcode 0.6:
        // ưu tiên verdict của trọng tài độc lập (goal-loop evaluator), fallback
        // KB retrieval confidence. Không có nguồn nào → KHÔNG set field
        // (UI badge tự ẩn khi null — page.tsx check msg.confidence != null).
        return NextResponse.json({
          content,
          model: agentModel,
          provider: agentProvider,
          sessionId: sessionId || `session-${Date.now()}`,
          agentProfileId: agentProfileId || undefined,
          sources: [],
          ...(finalConfidence !== undefined ? { confidence: finalConfidence } : {}),
          kbResults: 'agent-react',
          reactIterations: reactResult.iterations,
          toolCallsExecuted: reactResult.toolCallsExecuted,
          agentRun: agentRunSummary,
          goalLoop: reactResult.goalLoop,
          memoriesRecalled: recalledMemories.length || undefined,
          intent,
          kbConfidence: kbSearchResult?.confidence || undefined,
        })
      } catch (err) {
        console.warn('[OpenClaw Chat] Goal loop error, falling back to /api/query:', err instanceof Error ? err.message : String(err))
        // CI-2 (Task 11-a) — CRASH-PATH HONEST CLOSE: goal loop văng exception
        // (trước khi endAgentRun chạy) → todo của run đang dở phải được đóng
        // trung thực NGAY: in_progress → 'failed' (đã bắt tay làm mà run chết),
        // pending → 'archived' (không còn cơ resume — ẩn khỏi run sau). Lấy
        // runId qua getActiveRunId vì reactResult không tồn tại ở nhánh này.
        // try/catch lồng — crash-path không được phép sinh lỗi thứ hai.
        if (sessionId) {
          try {
            const crashRunId = getActiveRunId(sessionId)
            const closed = await closeRunTodosAtEnd({
              sessionId,
              runId: crashRunId,
              goalComplete: false,
              crash: true,
            })
            const closedTotal = closed.inProgressClosed + closed.pendingCompleted + closed.pendingArchived
            if (closedTotal > 0) {
              console.log(`[Todo CI-2] Run ${crashRunId || '(legacy)'} crash → đóng ${closed.inProgressClosed} in_progress→failed, ${closed.pendingArchived} pending→archived trong session ${sessionId}`)
            }
          } catch { /* non-blocking — không được phép che lỗi gốc */ }
        }
        // Fall through to /api/query fallback below
      }
    }

    if (!hasAgentProviderModel) {
      // No agent config → try OpenClaw Gateway first (original flow)
      // ON-DEMAND (2026-09-07): ensureGatewayRunning() sẽ SPAWN gateway nếu
      // offline (lazy start) thay vì bỏ qua — đảm bảo fallback path dùng được
      // gateway khi user cần, mà không tốn RAM khi không ai gọi.
      try {
        const onlineResult = await ensureGatewayRunning()
        if (onlineResult.online) {
          const res = await chatCompletion({
            messages: fullMessages,
            model: model || 'openclaw/default',
            sessionId,
            stream: false,
            temperature: agentTemperature,
            max_tokens: agentMaxTokens,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'knowledge_search',
                  description: 'Tìm kiếm semantic trong Knowledge Base',
                  parameters: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', description: 'Câu hỏi cần tìm kiếm' },
                      topK: { type: 'number', description: 'Số kết quả trả về', default: 5 },
                    },
                    required: ['query'],
                  },
                },
              },
            ],
          })

          const data = await res.json()
          const content = data.choices?.[0]?.message?.content || data.content || data.message || 'No response'
          const toolCalls = data.choices?.[0]?.message?.tool_calls

          // Track token usage from gateway response (if available)
          const gwUsage = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
          const gwTotalTokens = gwUsage?.total_tokens ?? ((gwUsage?.prompt_tokens ?? 0) + (gwUsage?.completion_tokens ?? 0))
          if (gwTotalTokens > 0) {
            addTokensUsed(gwTotalTokens, 'openclaw', undefined, data.model || model)
          }

          // Update session in SQLite (TOMBSTONE GUARD: session đã xóa → không upsert lại)
          if (sessionId && !(await isSessionDeletedDeep(sessionId))) {
            try {
              await db.agentSession.upsert({
                where: { sessionId },
                create: {
                  sessionId,
                  model: model || 'openclaw/default',
                  provider: 'openclaw',
                  title: messages[0]?.content?.slice(0, 50) || 'New Chat',
                  messageCount: messages.length + 1,
                  agentProfileId: agentProfileId || null,
                  teamMode: teamMode || null,
                  teamName: teamName || null,
                },
                update: {
                  messageCount: { increment: 1 },
                  model: model || undefined,
                },
              })
            } catch {}
          }

          return NextResponse.json({
            content,
            toolCalls,
            model: data.model || model,
            provider: 'openclaw',
            agentProfileId: agentProfileId || undefined,
            usage: data.usage,
            sessionId: sessionId || data.session_id,
            kbResults: 'gateway',
          })
        }
      } catch (err) {
        console.warn('[OpenClaw Chat] Gateway error:', err instanceof Error ? err.message : String(err))
      }
    }

    // /api/query fallback path — used for:
    //   - Agent with configured provider/model when ReAct loop fails (fallback)
    //   - Gateway offline fallback (no agent config)
    if (hasAgentProviderModel) {
      console.log(`[OpenClaw Chat] ReAct loop failed, falling back to /api/query for agent (${agentProvider}/${agentModel})`)
    }
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
      const queryRes = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: lastUserContent,
          options: {
            chatHistory: messages.filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant').slice(-6).map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
            // Skip meta-cognitive reasoning for chat flow — reduces latency by ~15s
            // KB results are already enriched with memories in the system prompt
            skipMetaCog: true,
            // Phase D (Option b): Pass pre-fetched KB results from Phase B
            // /api/query can use these instead of searching again (avoiding duplicate search)
            ...(kbSearchResult ? {
              prefetchedKB: {
                chunks: kbSearchResult.chunks.map(c => ({ text: c.text, score: c.score, documentId: c.documentId })),
                entities: kbSearchResult.entities.map(e => ({ name: e.name, type: e.type, description: e.description })),
                confidence: kbSearchResult.confidence,
              },
              skipKBSearch: kbSearchResult.confidence >= 0.5, // skip /api/query's own search if we already have good results
            } : {}),
            ...(agentTemperature !== undefined ? { temperature: agentTemperature } : {}),
            ...(agentMaxTokens !== undefined ? { maxTokens: agentMaxTokens } : {}),
            ...(agentProfileId ? { agentId: agentProfileId } : {}),
            ...(agentProfileName ? { agentName: agentProfileName } : {}),
            ...(agentProvider ? { agentProvider } : {}),
            ...(agentModel ? { agentModel } : {}),
          },
        }),
        signal: AbortSignal.timeout(60000),
      })

      if (queryRes.ok) {
        const data = await queryRes.json()
        const content = data.answer || 'Không thể tạo câu trả lời.'

        // WORKING MEMORY (HOT) — lưu câu trả lời fallback path (agent vẫn là
        // chủ nhân của exchange — HOT phải đầy đủ user + assistant)
        if (agentProfileId && sessionId && content && !isLlmErrorContent(content)) {
          addToWorkingMemory({
            agentId: agentProfileId,
            sessionId,
            content: content.slice(0, 2500),
            role: 'assistant',
          }).catch(() => { /* fail-open */ })
        }

        // If this was a code query but OpenCode was offline, add a note
        const codeNote = isCodeQuery(lastUserContent)
          ? '\n\n⚠️ **OpenCode Server đang offline** — Không thể thực hiện code editing. Kết quả trên chỉ dựa trên Knowledge Base. Hãy bật OpenCode Server để sử dụng đầy đủ tính năng code.'
          : ''

        // Track session (include agentProfileId if from an Agent)
        // NOTE: agentTemperature/agentMaxTokens are now passed to the local fallback via /api/query
        // TOMBSTONE GUARD: session đã xóa → không upsert lại
        if (sessionId && !(await isSessionDeletedDeep(sessionId))) {
          try {
            await db.agentSession.upsert({
              where: { sessionId },
              create: {
                sessionId,
                model: model || 'local-rag',
                provider: 'local-fallback',
                title: messages[0]?.content?.slice(0, 50) || 'New Chat',
                messageCount: messages.length + 1,
                agentProfileId: agentProfileId || null,
                teamMode: teamMode || null,
                teamName: teamName || null,
              },
              update: {
                messageCount: { increment: 1 },
              },
            })
          } catch {}
        }

        // Phase C: Smart KB Writeback — replaces autoLearnFromAnswer
        // Same as ReAct path: writeback with confidence filter, fallback to autoLearnFromAnswer
        // Phase B: uses kbSearchResult (pre-searched) instead of empty step1Result
        // Phase 2 SMOLAB Prop 6 — uses writebackToKBTransactionally (PendingWriteback saga).
        const queryConfidence = data.confidence ?? 0
        const hasAgent = !!(agentProfileId && agentProvider && agentModel)
        // KIMI-ONLY: lỗi LLM → bỏ writeback (không nhiễm KB bằng error message)
        if (hasAgent && !isLlmErrorContent(content) && !isTrivialExchange(lastUserContent, content)) {
          writebackToKBTransactionally({
            query: lastUserContent,
            step2Result: { used: true, content, supplemented: true, source: 'model-knowledge' },
            step1Result: kbSearchResult || { chunks: [], entities: [], memories: recalledMemories, communities: [], confidence: queryConfidence, source: 'user-kb' },
            agentId: agentProfileId!,
            agentName: agentProfileName || 'unknown',
            sessionId,
          }).then(({ batchId, result }) => {
            console.log(`[Writeback] fallback batchId=${batchId} entities=${result.entitiesWritten} rels=${result.relationshipsWritten} chunks=${result.chunksWritten} memory=${result.memoryStored}`)
          }).catch(err => {
            console.error('[Writeback] Failed (fallback path), falling back to autoLearn:', err instanceof Error ? err.message : String(err))
            if (shouldAutoLearn(queryConfidence, hasAgent)) {
              autoLearnFromAnswer({
                query: lastUserContent,
                answer: content,
                confidence: queryConfidence,
                agentId: agentProfileId!,
                agentName: agentProfileName || 'unknown',
                provider: agentProvider!,
                model: agentModel!,
                sources: data.sources,
              }).catch(() => {})
            }
          })
        }

        // Phase 5: Memory & Learning — save messages + extract memories in background
        // Non-blocking: fire-and-forget, don't delay the response.
        if (agentProfileId && sessionId) {
          // Save chat messages to DB for persistence
          // 2026-09-01: user message đã lưu ở ĐẦU request → chỉ lưu assistant
          saveChatMessages(sessionId, [
            { role: 'assistant', content, model: agentModel || model, provider: agentProvider || 'local-fallback', metadata: { confidence: queryConfidence, sources: data.sources?.length || 0 } },
          ])
            .then(async () => {
              // OPUS AUTO-REVIEW HOOK (REVIEW 13-f BUG #1) — đường fallback
              // local-RAG cũng là 1 run hoàn chỉnh (agent chain fail → degrade
              // trung thực): auto mode cần review như mọi run khác. Fire sau
              // khi persist; fail-open tuyệt đối.
              try {
                const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
                void maybeAutoOpusReview(sessionId, { runRef: null, messageId: null })
              } catch (opusErr) {
                console.warn('[OpenClaw Chat] Opus auto-review hook (fallback path) lỗi (fail-open):', opusErr instanceof Error ? opusErr.message : String(opusErr))
              }
            })
            .catch(err => console.warn('[Memory] Failed to save chat messages:', err instanceof Error ? err.message : String(err)))

          // Extract memories from this conversation (skip trivial exchanges to save LLM tokens)
          // KIMI-ONLY: lỗi LLM → không extract memory từ error message
          if (!isLlmErrorContent(content) && !isTrivialExchange(lastUserContent, content)) {
            extractMemoriesFromConversation({
              agentId: agentProfileId,
              agentName: agentProfileName || 'unknown',
              sessionId,
              userMessage: lastUserContent,
              assistantMessage: content,
            }).catch(err => console.warn('[Memory] Failed to extract memories:', err instanceof Error ? err.message : String(err)))
          }

          // Periodic memory decay + HOT→WARM promotion (bản fallback path)
          // every ~20 chat requests — decay old memories + promote expired HOT
          memoryDecayCounter++
          if (memoryDecayCounter >= 20 && agentProfileId) {
            memoryDecayCounter = 0
            import('@/lib/memory-tiers')
              .then(m => m.promoteWorkingMemoryToWarm(agentProfileId))
              .catch(err => console.warn('[Memory] HOT→WARM promotion error:', err instanceof Error ? err.message : String(err)))
            decayMemories(agentProfileId).catch(err =>
              console.warn('[Memory] Periodic decay error:', err instanceof Error ? err.message : String(err))
            )
          }
        }

        return NextResponse.json({
          content: content + codeNote,
          model: model || 'local-rag',
          provider: 'local-fallback',
          sessionId: sessionId || `session-${Date.now()}`,
          agentProfileId: agentProfileId || undefined,
          sources: data.sources || [],
          confidence: data.confidence,
          kbResults: 'included',
          codeQuery: isCodeQuery(lastUserContent) || undefined,
          memoriesRecalled: recalledMemories.length || undefined,
          intent,
          kbConfidence: kbSearchResult?.confidence || undefined,
        })
      }
    } catch (err) {
      console.warn('[OpenClaw Chat] Local fallback error:', err instanceof Error ? err.message : String(err))
    }

    // Final fallback: mock response
    const userContent = lastUserContent || ''
    const mockContent = userContent.toLowerCase().includes('hello') || userContent.toLowerCase().includes('hi')
      ? `Xin chào! Tôi là AI Agent của The Magnum Opus. Gateway hiện đang offline nên tôi hoạt động ở chế độ mock. Hãy kết nối Gateway để nhận phản hồi AI thực sự.`
      : `Tôi đã nhận tin nhắn của bạn: "${userContent.slice(0, 100)}${userContent.length > 100 ? '...' : ''}"\n\nOpenClaw Gateway đang offline và Knowledge Base cũng không khả dụng. Tôi đang ở chế độ mock. Vui lòng kiểm tra kết nối.`

    return NextResponse.json({
      content: mockContent,
      model: model || 'mock',
      provider: 'mock',
      sessionId: sessionId || `session-${Date.now()}`,
      kbResults: 'none',
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid request body', details: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    )
  }
}
