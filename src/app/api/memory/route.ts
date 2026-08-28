/**
 * Agent Memory API — Store, Recall, Extract, and Decay Memories
 *
 * GET    /api/memory          — Recall memories (query params: agentId, query, topK, category)
 * POST   /api/memory          — Store a new memory
 * PATCH  /api/memory          — Extract memories from conversation (after chat completes)
 * DELETE /api/memory          — Decay old memories (body: { agentId? })
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  ensureAgentMemoryCollection,
  recallMemories,
  storeMemory,
  extractMemoriesFromConversation,
  decayMemories,
} from '@/lib/agent-memory'

export const dynamic = 'force-dynamic'

// ==================== GET — RECALL MEMORIES ====================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agentId')
    const query = searchParams.get('query')
    const topKStr = searchParams.get('topK')
    const category = searchParams.get('category') || undefined

    if (!agentId) {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 }
      )
    }

    if (!query) {
      return NextResponse.json(
        { error: 'query is required' },
        { status: 400 }
      )
    }

    const topK = topKStr ? parseInt(topKStr, 10) : 5

    if (isNaN(topK) || topK < 1 || topK > 100) {
      return NextResponse.json(
        { error: 'topK must be a number between 1 and 100' },
        { status: 400 }
      )
    }

    // Ensure the Qdrant collection exists before recalling
    await ensureAgentMemoryCollection()

    const memories = await recallMemories({
      agentId,
      query,
      topK,
      category,
    })

    return NextResponse.json({ memories })
  } catch (err) {
    console.error('[MemoryAPI] GET error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to recall memories', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== POST — STORE MEMORY ====================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      agentId,
      agentName,
      sessionId,
      category,
      content,
      context,
      importance,
      source,
      tags,
    } = body

    // Validate required fields
    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
    }

    if (!agentName || typeof agentName !== 'string') {
      return NextResponse.json({ error: 'agentName is required' }, { status: 400 })
    }

    if (!category || typeof category !== 'string') {
      return NextResponse.json({ error: 'category is required' }, { status: 400 })
    }

    const validCategories = ['insight', 'fact', 'preference', 'correction', 'procedure', 'user_info']
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${validCategories.join(', ')}` },
        { status: 400 }
      )
    }

    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content is required' }, { status: 400 })
    }

    // Validate optional fields
    if (importance !== undefined && (typeof importance !== 'number' || importance < 0 || importance > 1)) {
      return NextResponse.json({ error: 'importance must be a number between 0 and 1' }, { status: 400 })
    }

    // Ensure the Qdrant collection exists before storing
    await ensureAgentMemoryCollection()

    const result = await storeMemory({
      agentId,
      agentName,
      sessionId: sessionId || undefined,
      category: category as 'insight' | 'fact' | 'preference' | 'correction' | 'procedure' | 'user_info',
      content,
      context: context || undefined,
      importance: importance ?? undefined,
      source: source || undefined,
      tags: Array.isArray(tags) ? tags : undefined,
    })

    return NextResponse.json({ id: result.id, qdrantPointId: result.qdrantPointId }, { status: 201 })
  } catch (err) {
    console.error('[MemoryAPI] POST error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to store memory', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== PATCH — EXTRACT MEMORIES FROM CONVERSATION ====================

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentId, agentName, sessionId, userMessage, assistantMessage } = body

    // Validate required fields
    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
    }

    if (!agentName || typeof agentName !== 'string') {
      return NextResponse.json({ error: 'agentName is required' }, { status: 400 })
    }

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }

    if (!userMessage || typeof userMessage !== 'string') {
      return NextResponse.json({ error: 'userMessage is required' }, { status: 400 })
    }

    if (!assistantMessage || typeof assistantMessage !== 'string') {
      return NextResponse.json({ error: 'assistantMessage is required' }, { status: 400 })
    }

    const result = await extractMemoriesFromConversation({
      agentId,
      agentName,
      sessionId,
      userMessage,
      assistantMessage,
    })

    return NextResponse.json({
      memoriesCreated: result.memoriesCreated,
      userProfileUpdates: result.userProfileUpdates,
    })
  } catch (err) {
    console.error('[MemoryAPI] PATCH error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to extract memories', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== DELETE — DECAY MEMORIES ====================

export async function DELETE(request: NextRequest) {
  try {
    let body: { agentId?: string } = {}

    try {
      body = await request.json()
    } catch {
      // No body or invalid JSON — decay all agents
    }

    const { agentId } = body

    // agentId undefined = decay TOÀN BỘ agents (Prisma bỏ qua filter undefined) —
    // lib decayMemories ký string, cast giữ nguyên runtime
    const result = await decayMemories(agentId as string)

    return NextResponse.json({
      decayed: result.decayed,
      deactivated: result.deactivated,
    })
  } catch (err) {
    console.error('[MemoryAPI] DELETE error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to decay memories', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
