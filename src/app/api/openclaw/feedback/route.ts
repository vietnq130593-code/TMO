/**
 * OpenClaw Feedback API — Save user feedback (👍/👎)
 *
 * POST — Save feedback to LearningLog table
 * Body: { type: 'positive' | 'negative', sessionId, messageId, content, agentResponse, correction?, reason? }
 *
 * GET  ?sessionId=xxx — Restore feedback state for a chat session (user request
 *       2026-08-27: like/dislike phải "ghi nhận thật" — không reset sau reload).
 *       Trả về map messageId → 'positive' | 'negative' từ LearningLog để UI
 *       khôi phục trạng thái nút like/dislike khi load lại session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { storeMemory } from '@/lib/agent-memory'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }

    const logs = await db.learningLog.findMany({
      where: { eventType: 'feedback', sessionId },
      orderBy: { createdAt: 'desc' },
      select: { content: true, createdAt: true },
    })

    // content JSON: { type, messageId, userContent, agentResponse, ... }
    // Newest-first ordering + "first write wins" (không cho đổi ý qua reload)
    const feedbackByMessage: Record<string, 'positive' | 'negative'> = {}
    let parsedCount = 0
    for (const log of logs) {
      try {
        const parsed = JSON.parse(log.content) as {
          type?: string
          messageId?: string
        }
        if (parsed?.messageId && (parsed.type === 'positive' || parsed.type === 'negative')) {
          if (!(parsed.messageId in feedbackByMessage)) {
            feedbackByMessage[parsed.messageId] = parsed.type
            parsedCount++
          }
        }
      } catch { /* skip malformed rows */ }
    }

    return NextResponse.json({ sessionId, count: parsedCount, feedback: feedbackByMessage })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load feedback', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { type, sessionId, messageId, content, agentResponse, correction, reason, agentId } = body

    if (!type || !['positive', 'negative'].includes(type)) {
      return NextResponse.json(
        { error: 'type must be "positive" or "negative"' },
        { status: 400 }
      )
    }

    // Save to LearningLog
    const log = await db.learningLog.create({
      data: {
        sessionId: sessionId || null,
        agentId: agentId || 'default',
        eventType: 'feedback',
        content: JSON.stringify({
          type,
          messageId: messageId || null,
          userContent: content || '',
          agentResponse: agentResponse || '',
          correction: correction || null,
          reason: reason || null,
          timestamp: new Date().toISOString(),
        }),
        metadata: JSON.stringify({ feedbackType: type }),
      },
    })

    // If negative with correction, also create AgentCorrection
    if (type === 'negative' && correction) {
      const effectiveAgentId = agentId || 'default'

      // Store the correction as a memory so the agent can learn from it
      try {
        await storeMemory({
          agentId: effectiveAgentId,
          agentName: effectiveAgentId,
          category: 'correction',
          content: `Correction: ${correction}`,
          context: `User corrected agent. Wrong answer: ${(agentResponse || '').slice(0, 200)}`,
          importance: 0.8,
          source: 'user_feedback',
        })
      } catch (memErr) {
        console.warn('[Feedback] Failed to store correction as memory:', memErr instanceof Error ? memErr.message : String(memErr))
      }

      // Mark correction as applied since we've stored it in the agent's memory
      await db.agentCorrection.create({
        data: {
          agentId: effectiveAgentId,
          wrongAnswer: agentResponse || '',
          correctAnswer: correction,
          reason: reason || null,
          applied: true,
        },
      })
    }

    return NextResponse.json({
      success: true,
      logId: log.id,
      type,
      created: type === 'negative' && correction ? 'correction' : 'feedback',
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to save feedback', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
