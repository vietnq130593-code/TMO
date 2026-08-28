/**
 * Smolab Chat API — Background Task Integration
 *
 * POST /api/smolab/chat
 *
 * Flow:
 *   1. Validate agent/team selection (BẮT BUỘC)
 *   2. Get agent profile FIRST (tránh FK constraint violation)
 *   3. Create or reuse session
 *   4. Save user message to DB
 *   5. Enqueue background task → call LLM in worker
 *   6. Return immediately (non-blocking) with sessionId + taskId
 *
 * Fixes applied (from SMOLAB_IMPLEMENTATION_PLAN.md notes):
 *   - callLLMForAgent signature: (prompt, agentConfig, systemPrompt, options)
 *     NOT (agentId, messages, {systemPrompt, signal})
 *   - LLMResult has no `duration` field — manual Date.now() timing
 *   - callLLMForAgent has no `signal` param — check signal.aborted after call
 *   - Build prompt string from history (not messages array)
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateChatContext, createIsolatedSession } from '@/lib/smolab/session-manager'
import { smolabWorker } from '@/lib/smolab/background-task-worker'
import { db } from '@/lib/db'
import type { AgentProfile } from '@prisma/client'

export const dynamic = 'force-dynamic'

/**
 * POST /api/smolab/chat
 *
 * Body:
 *   mode: 'single' | 'multi'
 *   agentProfileId?: string (bắt buộc nếu single)
 *   teamName?: string (bắt buộc nếu multi)
 *   sessionId?: string (nếu có session rồi)
 *   message: string
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mode, agentProfileId, teamName, sessionId, message } = body

    // 1. Validate — BẮT BUỘC chọn agent/team
    const validation = validateChatContext({ mode, agentProfileId, teamName })
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Tin nhắn không được để trống' }, { status: 400 })
    }

    // 2. Lấy agent profile TRƯỚC khi tạo session — tránh FK constraint violation
    // Annotation kiểu rõ ràng: findUnique/findFirst trả AgentProfile | null
    let agentProfile: AgentProfile | null = null
    if (mode === 'single' && agentProfileId) {
      agentProfile = await db.agentProfile.findUnique({ where: { id: agentProfileId } })
    } else if (mode === 'multi' && teamName) {
      agentProfile = await db.agentProfile.findFirst({
        where: { team: teamName, position: 'TL', enabled: true },
      })
    }

    if (!agentProfile) {
      return NextResponse.json(
        { error: 'Agent không tồn tại hoặc chưa được bật' },
        { status: 404 }
      )
    }

    // 3. Tạo hoặc dùng session hiện có
    let currentSessionId = sessionId
    if (!currentSessionId) {
      const session = await createIsolatedSession({
        mode,
        agentProfileId,
        teamName,
        title: message.slice(0, 50),
      })
      currentSessionId = session.sessionId
    }

    // 4. Lưu user message vào DB
    await db.chatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: 'user',
        content: message,
      },
    })

    // Capture values for closure (prevent race conditions)
    const capturedSessionId = currentSessionId
    const capturedAgentId = agentProfile.id
    const capturedAgentName = agentProfile.name
    const capturedProvider = agentProfile.provider
    const capturedModel = agentProfile.model
    const capturedInstruction = agentProfile.instruction
    const capturedTemperature = agentProfile.temperature
    const capturedMaxTokens = agentProfile.maxTokens

    // 5. Tạo background task
    const taskId = await smolabWorker.enqueue({
      type: mode === 'single' ? 'agent_chat' : 'team_workflow',
      sessionId: capturedSessionId,
      agentProfileId: capturedAgentId,
      teamName: mode === 'multi' ? teamName : undefined,
      inputSummary: message.slice(0, 200),
      execute: async (signal: AbortSignal) => {
        // ===== THỰC THI CHAT TRONG BACKGROUND =====

        // Check if already cancelled before starting
        if (signal.aborted) {
          throw new Error('Task was cancelled before execution')
        }

        // Import LLM caller
        const { callLLMForAgent } = await import('@/lib/llm')

        // Lấy lịch sử chat
        const history = await db.chatMessage.findMany({
          where: { sessionId: capturedSessionId },
          orderBy: { createdAt: 'asc' },
          take: 40, // Last 40 messages context
        })

        // Build prompt từ history — callLLMForAgent nhận string, không phải messages array
        const promptParts: string[] = []
        for (const msg of history) {
          if (msg.role === 'user') {
            promptParts.push(`User: ${msg.content}`)
          } else if (msg.role === 'assistant') {
            promptParts.push(`Assistant: ${msg.content}`)
          }
          // Skip system/tool_call/error messages in prompt
        }

        // Nếu chỉ có 1 user message (vừa gửi), dùng trực tiếp
        // Nếu có nhiều hơn, gộp thành conversation context
        const prompt = promptParts.length <= 2
          ? message // Chỉ có message vừa gửi → dùng trực tiếp
          : `Conversation history:\n${promptParts.join('\n')}\n\nPlease respond to the latest message.`

        // Call LLM — FIXED signature: (prompt, agentConfig, systemPrompt, options)
        // NOTE: callLLMForAgent does NOT accept signal param
        const startTime = Date.now()
        const result = await callLLMForAgent(
          prompt,
          { provider: capturedProvider, model: capturedModel },
          capturedInstruction,
          {
            temperature: capturedTemperature,
            maxTokens: capturedMaxTokens,
            agentId: capturedAgentId,
            agentName: capturedAgentName,
          }
        )
        const durationMs = Date.now() - startTime

        // Check if cancelled after LLM call — if aborted, don't save result
        if (signal.aborted) {
          throw new Error('Task was cancelled during execution')
        }

        // Lưu assistant message vào DB
        await db.chatMessage.create({
          data: {
            sessionId: capturedSessionId,
            role: 'assistant',
            content: result.content,
            model: result.model,
            provider: result.provider,
            metadata: JSON.stringify({
              tokensUsed: result.tokensUsed,
              durationMs,
            }),
          },
        })

        // Update session message count + updatedAt
        await db.agentSession.update({
          where: { sessionId: capturedSessionId },
          data: { messageCount: { increment: 1 }, updatedAt: new Date() },
        })

        // Return result as JSON string (task result format)
        return JSON.stringify({
          content: result.content,
          model: result.model,
          provider: result.provider,
          tokensUsed: result.tokensUsed,
          durationMs,
        })
      },
    })

    // 6. Return ngay — không đợi task xong
    return NextResponse.json({
      sessionId: currentSessionId,
      taskId,
      status: 'processing',
    })

  } catch (err) {
    console.error('[Smolab Chat] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lỗi nội bộ' },
      { status: 500 }
    )
  }
}
