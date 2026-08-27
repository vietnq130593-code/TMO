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
import { chatCompletion, isGatewayOnline } from '@/lib/openclaw'
import { isOpenCodeOnline, createOpenCodeSession, opencodeFetch } from '@/lib/opencode'
import { enrichCodeContext, isCodeQuery as isCodeQueryAdvanced, detectCodeConfidence } from '@/lib/opencode-knowledge-context'
import { generateOpenCodeSystemPrompt } from '@/lib/opencode-system-prompt'
import { db } from '@/lib/db'
import { addTokensUsed, addTokensUsedByAgent, callLLMForAgent } from '@/lib/llm'
import { autoLearnFromAnswer, shouldAutoLearn } from '@/lib/auto-learn'
import { recallMemories, extractMemoriesFromConversation, saveChatMessages, getUserProfile, ensureAgentMemoryCollection, decayMemories } from '@/lib/agent-memory'
import { executeTool } from '@/lib/code-team/tool-executor'
import { parseToolCallsFromOutput, formatMessagesForLLM } from '@/lib/tool-calls'
import { getStandaloneAgentTools } from '@/lib/standalone-agents'
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

export const dynamic = 'force-dynamic'

// Module-level counter for periodic memory decay (Bug 3 fix)
let memoryDecayCounter = 0

// ============================================
// WORKSPACE CONTEXT — đã chuyển sang module chia sẻ
// src/lib/workspace/workspace-context.ts (2026-08-29) để MỌI agents dùng chung:
//   - /api/openclaw/chat (agents độc lập + team Research + user-created)
//   - code-team/workflow-engine runAgentStep (Team Code: TL/G1/G2-A/G2-B/G3)
// ============================================

/**
 * Check if a chat exchange is too trivial to warrant memory extraction.
 * Avoids wasting LLM tokens on greetings and short confirmations.
 */
function isTrivialExchange(userMsg: string, assistantMsg: string): boolean {
  // Skip memory extraction for trivial exchanges (greetings, short confirmations)
  if (userMsg.trim().length < 15 && assistantMsg.trim().length < 50) return true
  const trivialPatterns = /^(hi|hello|hey|chào|xin chào|ok|okay|cảm ơn|thanks|thank you|bye|tạm biệt|được|vâng|yes|no|không)$/i
  if (trivialPatterns.test(userMsg.trim())) return true
  return false
}

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
// ReAct LOOP — Standalone Agent Tool Execution
// ============================================

/**
 * Run a ReAct (Reason-Act-Observe) loop for an agent with tool execution.
 *
 * This enables standalone agents like Omega to actually USE their declared tools
 * (opencode, knowledge_search, tavily, etc.) instead of just having them in prompts.
 *
 * Flow:
 * 1. Call LLM with system prompt + user message
 * 2. Parse tool_call patterns from LLM output
 * 3. If tool calls found → execute → feed results back → repeat
 * 4. If no tool calls → return final answer
 * 5. Max 5 iterations to prevent infinite loops
 */
async function runAgentReActLoop(params: {
  systemPrompt: string
  userMessage: string
  chatHistory: Array<{ role: string; content: string }>
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  agentTemperature?: number
  agentMaxTokens?: number
  agentTools?: string[]
  maxIterations?: number
  /** Chat sessionId — truyền vào executeTool để Agent Activity Log/Terminal echo gắn đúng session */
  agentSessionId?: string | null
}): Promise<{ content: string; iterations: number; toolCallsExecuted: number }> {
  const {
    systemPrompt,
    userMessage,
    chatHistory,
    agentProvider,
    agentModel,
    agentId,
    agentName,
    agentTemperature,
    agentMaxTokens,
    agentTools = [],
    maxIterations = 5,
    agentSessionId = null,
  } = params

  // Build messages array for multi-turn conversation
  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
  }> = [
    { role: 'system', content: systemPrompt },
    // Include last 6 messages from chat history for context
    ...chatHistory.slice(-6).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ]

  let finalContent = ''
  let iterations = 0
  let totalToolCalls = 0

  // CUSTOM TOOLS (user request 2026-08-30): nạp custom tool registry 1 lần
  // trước loop — whitelist check bên dưới cho phép gọi custom tools đã register
  // (agents TỰ VIẾT qua create_custom_tool, kể cả tool tạo trong cùng loop này).
  try {
    const { ensureCustomToolsLoaded } = await import('@/lib/custom-tool-registry')
    await ensureCustomToolsLoaded()
  } catch { /* fail-open */ }

  while (iterations < maxIterations) {
    iterations++

    // Format messages for LLM (since callLLMForAgent takes a single prompt string)
    const formattedPrompt = formatMessagesForLLM(messages)

    // Call LLM for this agent
    const result = await callLLMForAgent(
      formattedPrompt,
      { provider: agentProvider, model: agentModel },
      systemPrompt,
      {
        agentId,
        agentName,
        temperature: agentTemperature,
        maxTokens: agentMaxTokens,
      }
    )

    if (!result || (result.error && !result.content)) {
      finalContent = result?.error || 'LLM call failed'
      break
    }

    finalContent = result.content

    // Check if LLM output contains tool calls
    const toolCalls = parseToolCallsFromOutput(result.content)

    if (toolCalls.length === 0) {
      // No tool calls → agent is done
      break
    }

    // Execute tool calls
    console.log(`[ReAct] ${agentName} calling ${toolCalls.length} tools (iteration ${iterations})`)

    // Add assistant message with tool calls to conversation
    messages.push({
      role: 'assistant',
      content: result.content,
    })

    for (const tc of toolCalls) {
      totalToolCalls++

      // Only execute tools that the agent has permission for
      // EXCEPTION (user request 2026-08-30): custom tools (agent TỰ VIẾT qua
      // create_custom_tool) luôn được phép — mọi agents dùng chung registry.
      let isCustomTool = false
      try {
        const { isCustomToolRegistered } = await import('@/lib/custom-tool-registry')
        isCustomTool = isCustomToolRegistered(tc.name)
      } catch { /* fail-open */ }
      if (agentTools.length > 0 && !agentTools.includes(tc.name) && !isCustomTool) {
        messages.push({
          role: 'tool',
          content: JSON.stringify({ tool: tc.name, success: false, result: `Tool "${tc.name}" not available for this agent. Available tools: ${agentTools.join(', ')}` }),
        })
        continue
      }

      console.log(`[ReAct] Executing: ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})`)

      // FIX 2026-08-27: inject chat sessionId vào todo_write — trước đây todos
      // của MỌI phiên chat đổ dồn vào session "default", panel Agent Tasks không
      // phân biệt được phiên nào. Giờ mỗi chat có todo list riêng (dropdown
      // session trong panel hoạt động đúng).
      const toolArgs: Record<string, unknown> = { ...tc.args }
      if (tc.name === 'todo_write' && agentSessionId && !toolArgs.sessionId) {
        toolArgs.sessionId = agentSessionId
      }

      const toolResult = await executeTool(tc.name, toolArgs, { agentName, sessionId: agentSessionId })

      // Add tool result to conversation
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          tool: tc.name,
          success: toolResult.success,
          result: toolResult.result,
        }),
      })
    }

    // If max iterations reached, break
    if (iterations >= maxIterations) {
      finalContent += `\n\n⚠️ Đạt max ${maxIterations} vòng iteration.`
      break
    }
  }

  console.log(`[ReAct] ${agentName} done: ${iterations} iterations, ${totalToolCalls} tool calls`)
  return { content: finalContent, iterations, toolCallsExecuted: totalToolCalls }
}

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

    // Track in SQLite
    if (sessionId) {
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
    const { messages, model, sessionId, stream, systemPromptAdditions,
            agentInstruction, agentTemperature, agentMaxTokens, agentProfileId, agentProfileName,
            agentProvider, agentModel, teamMode, teamName } = body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'Messages array is required' },
        { status: 400 }
      )
    }

    // Extract last user message early — needed for memory recall and routing
    const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user')
    const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

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
      if (sessionId) {
        saveChatMessages(sessionId, [
          { role: 'user', content: lastUserContent },
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
      const enabledSkills = await db.agentSkill.findMany({
        where: { enabled: true },
        select: { name: true, slug: true, content: true, source: true },
      })
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
      console.log(`[OpenClaw Chat] ReAct loop: Agent using own provider/model (${agentProvider}/${agentModel})`)

      try {
        // Determine agent tools from standalone agents definition
        const agentTools = agentProfileName ? getStandaloneAgentTools(agentProfileName) : []

        const reactResult = await runAgentReActLoop({
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
          // 8 vòng: plan (1) + 4-5 hành động + update todo + báo cáo cuối.
          // Trước đây 5 vòng bị cut ngay trước bước tổng kết (task thành công
          // nhưng thiếu báo cáo cuối — "Đạt max 5 vòng iteration").
          maxIterations: 8,
          agentSessionId: sessionId || null,
        })

        const content = reactResult.content

        // FIX 2026-08-27 (user bug report "4 task đã chạy xong nhưng vẫn báo có 4
        // task đang chạy"): LLM thường quên gọi todo_write lần cuối để đóng các
        // bước (đánh dấu in_progress rồi báo cáo luôn). Auto-close mọi todo còn
        // in_progress/pending của session này khi ReAct loop đã kết thúc —
        // agent đã trả lời xong thì không còn gì "đang chạy".
        if (sessionId) {
          try {
            const closed = await db.todo.updateMany({
              where: { sessionId, status: { in: ['in_progress', 'pending'] } },
              data: { status: 'completed' },
            })
            if (closed.count > 0) console.log(`[ReAct] Auto-closed ${closed.count} stale todo(s) in session ${sessionId}`)
          } catch { /* non-blocking — todo hiển thị chỉ là UI progress */ }
        }

        // Track session
        if (sessionId) {
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
        if (hasAgent && !isTrivialExchange(lastUserContent, content)) {
          writebackToKBTransactionally({
            query: lastUserContent,
            step2Result: { used: true, content, supplemented: true, source: 'model-knowledge' },
            step1Result: kbSearchResult || { chunks: [], entities: [], memories: recalledMemories, confidence: 0, source: 'user-kb' },
            agentId: agentProfileId!,
            agentName: agentProfileName || 'unknown',
            sessionId,
          }).then(({ batchId, result }) => {
            console.log(`[Writeback] ReAct batchId=${batchId} entities=${result.entitiesWritten} rels=${result.relationshipsWritten} chunks=${result.chunksWritten} memory=${result.memoryStored}`)
          }).catch(err => {
            console.error('[Writeback] Failed, falling back to autoLearn:', err instanceof Error ? err.message : String(err))
            // Fallback: old auto-learn path (writes to SQLite buffer)
            if (shouldAutoLearn(0.5, hasAgent)) {
              autoLearnFromAnswer({
                query: lastUserContent,
                answer: content,
                confidence: 0.6,
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
        if (agentProfileId && sessionId) {
          saveChatMessages(sessionId, [
            { role: 'user', content: lastUserContent },
            { role: 'assistant', content, model: agentModel, provider: agentProvider, metadata: { reactIterations: reactResult.iterations, toolCallsExecuted: reactResult.toolCallsExecuted } },
          ]).catch(err => console.warn('[Memory] Failed to save chat messages:', err instanceof Error ? err.message : String(err)))

          if (!isTrivialExchange(lastUserContent, content)) {
            extractMemoriesFromConversation({
              agentId: agentProfileId,
              agentName: agentProfileName || 'unknown',
              sessionId,
              userMessage: lastUserContent,
              assistantMessage: content,
            }).catch(err => console.warn('[Memory] Failed to extract memories:', err instanceof Error ? err.message : String(err)))
          }

          // Periodic memory decay
          memoryDecayCounter++
          if (memoryDecayCounter >= 20 && agentProfileId) {
            memoryDecayCounter = 0
            decayMemories(agentProfileId).catch(err =>
              console.warn('[Memory] Periodic decay error:', err instanceof Error ? err.message : String(err))
            )
          }
        }

        return NextResponse.json({
          content,
          model: agentModel,
          provider: agentProvider,
          sessionId: sessionId || `session-${Date.now()}`,
          agentProfileId: agentProfileId || undefined,
          sources: [],
          confidence: 0.6,
          kbResults: 'agent-react',
          reactIterations: reactResult.iterations,
          toolCallsExecuted: reactResult.toolCallsExecuted,
          memoriesRecalled: recalledMemories.length || undefined,
          intent,
          kbConfidence: kbSearchResult?.confidence || undefined,
        })
      } catch (err) {
        console.warn('[OpenClaw Chat] ReAct loop error, falling back to /api/query:', err instanceof Error ? err.message : String(err))
        // Fall through to /api/query fallback below
      }
    }

    if (!hasAgentProviderModel) {
      // No agent config → try OpenClaw Gateway first (original flow)
      try {
        const onlineResult = await isGatewayOnline()
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

          // Update session in SQLite
          if (sessionId) {
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

        // If this was a code query but OpenCode was offline, add a note
        const codeNote = isCodeQuery(lastUserContent)
          ? '\n\n⚠️ **OpenCode Server đang offline** — Không thể thực hiện code editing. Kết quả trên chỉ dựa trên Knowledge Base. Hãy bật OpenCode Server để sử dụng đầy đủ tính năng code.'
          : ''

        // Track session (include agentProfileId if from an Agent)
        // NOTE: agentTemperature/agentMaxTokens are now passed to the local fallback via /api/query
        if (sessionId) {
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
        if (hasAgent && !isTrivialExchange(lastUserContent, content)) {
          writebackToKBTransactionally({
            query: lastUserContent,
            step2Result: { used: true, content, supplemented: true, source: 'model-knowledge' },
            step1Result: kbSearchResult || { chunks: [], entities: [], memories: recalledMemories, confidence: queryConfidence, source: 'user-kb' },
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
          saveChatMessages(sessionId, [
            { role: 'user', content: lastUserContent },
            { role: 'assistant', content, model: agentModel || model, provider: agentProvider || 'local-fallback', metadata: { confidence: queryConfidence, sources: data.sources?.length || 0 } },
          ]).catch(err => console.warn('[Memory] Failed to save chat messages:', err instanceof Error ? err.message : String(err)))

          // Extract memories from this conversation (skip trivial exchanges to save LLM tokens)
          if (!isTrivialExchange(lastUserContent, content)) {
            extractMemoriesFromConversation({
              agentId: agentProfileId,
              agentName: agentProfileName || 'unknown',
              sessionId,
              userMessage: lastUserContent,
              assistantMessage: content,
            }).catch(err => console.warn('[Memory] Failed to extract memories:', err instanceof Error ? err.message : String(err)))
          }

          // Periodic memory decay — every ~20 chat requests, decay old memories
          // This prevents stale memories from accumulating without requiring a cron scheduler
          memoryDecayCounter++
          if (memoryDecayCounter >= 20 && agentProfileId) {
            memoryDecayCounter = 0
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
