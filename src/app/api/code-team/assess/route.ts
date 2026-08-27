/**
 * Code Team — TL Assessment API Endpoint
 *
 * POST /api/code-team/assess
 *
 * Allows frontend to request TL assessment of a user message
 * BEFORE deciding whether to trigger the full Code Team workflow.
 *
 * This is the core of the Smart TL Bridge (C2 resolution):
 *   - Frontend sends user message + chat history
 *   - TL assesses: SIMPLE (chat bình thường) or CODE_TEAM (cần workflow)
 *   - Frontend uses result to either show direct answer or Suggestion Card
 *
 * Request body:
 *   - message: string — The user's current message
 *   - chatHistory: Array<{ role: string; content: string }> — Recent chat history
 *   - timeoutMs?: number — Assessment timeout (default: 5000ms)
 *
 * Response:
 *   - assessment: TLAssessment — Decision + optional routing + suggestion
 *
 * Why a separate endpoint (not SSE):
 *   - Assessment is a single POST, not a stream
 *   - Response is fast (~2-3s)
 *   - Frontend needs the result before deciding whether to trigger workflow SSE
 *   - Separation of concerns: assess vs execute
 */

import { NextRequest, NextResponse } from 'next/server'
import { assessRequest, isDirectTrigger } from '@/lib/code-team/tl-bridge'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let body: {
    message?: string
    chatHistory?: Array<{ role: string; content: string }>
    timeoutMs?: number
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const { message, chatHistory = [], timeoutMs = 15000 } = body

  // Validate required fields
  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'message is required and must be a string' },
      { status: 400 },
    )
  }

  // Check for direct trigger keyword — skip assessment, return immediately
  // This preserves backward compatibility with Phase 1 keyword trigger.
  // IMPORTANT: Do NOT return pre-computed routing here — let the workflow engine
  // run TL analyze step to get proper routing based on the actual request content.
  // If we return routing here, workflow engine skips TL analyze and uses the
  // hardcoded Mode B/Tier 2/Score 5 regardless of actual request complexity.
  if (isDirectTrigger(message)) {
    return NextResponse.json({
      assessment: {
        decision: 'CODE_TEAM',
        reasoning: 'User sử dụng keyword trigger "tiến hành triển khai" → Trigger workflow trực tiếp. TL sẽ phân tích routing chi tiết trong workflow.',
        suggestion: 'Đang khởi động Code Team workflow...',
      },
      isDirectTrigger: true,
    })
  }

  try {
    const assessment = await assessRequest(message, chatHistory, timeoutMs)

    return NextResponse.json({
      assessment,
      isDirectTrigger: false,
    })
  } catch (err) {
    console.error('[AssessAPI] Assessment failed:', err instanceof Error ? err.message : String(err))

    // Return SIMPLE fallback — don't crash the chat
    return NextResponse.json({
      assessment: {
        decision: 'SIMPLE',
        reasoning: `Assessment error: ${err instanceof Error ? err.message : 'Unknown'}`,
      },
      isDirectTrigger: false,
    })
  }
}
