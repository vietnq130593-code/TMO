/**
 * Chat Messages API — Persist and Retrieve Session Messages
 *
 * GET    /api/chat-messages   — Get messages for a session
 *   Query params:
 *     sessionId    (bắt buộc) — Session ID
 *     exchanges    (optional) — Lazy-load mode (user request 2026-09-01):
 *                                chỉ trả về N lượt trao đổi CUỐI (mỗi lượt bắt
 *                                đầu bằng 1 user message). Từ lượt thứ N+1 trở
 *                                đi phải kéo lên (beforeId) mới load — tránh
 *                                render hàng nghìn message mỗi lần mở session.
 *     beforeId     (optional) — Cursor (id của message CŨ NHẤT đang hiển thị)
 *                                → load N lượt trao đổi cũ hơn nữa.
 *                                Chỉ có tác dụng khi `exchanges` được set.
 *   Response (lazy-load mode):
 *     { messages, hasMore, oldestId } — messages theo thứ tự thời gian tăng dần
 *
 * POST   /api/chat-messages   — Save messages for a session
 * DELETE /api/chat-messages   — Delete all messages for a session (query param: sessionId)
 */

import { NextRequest, NextResponse } from 'next/server'
import { saveChatMessages, getSessionMessages } from '@/lib/agent-memory'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ==================== GET — GET SESSION MESSAGES ====================

interface ChatMessageRow {
  id: string
  sessionId: string
  role: string
  content: string
  model: string | null
  provider: string | null
  metadata: string | null
  createdAt: Date
}

/**
 * Walk backwards (mới → cũ) theo batch cho tới khi gộp đủ `exchanges` user
 * messages hoặc hết history. Trả về danh sách theo thứ tự DESC (mới nhất đầu).
 */
async function walkBack(
  sessionId: string,
  exchanges: number,
  cursor?: { id: string; createdAt: Date }
): Promise<{ walked: ChatMessageRow[]; exhausted: boolean }> {
  const BATCH = 40
  const MAX_WALK = 600 // safety cap — session 10k message không query hết 1 lần
  const walked: ChatMessageRow[] = []
  let exhausted = false
  let cursorId = cursor?.id
  let cursorTime = cursor?.createdAt

  while (walked.length < MAX_WALK) {
    let batch: ChatMessageRow[]
    if (cursorId && cursorTime) {
      // Composite order (createdAt, id) — cursor = message cũ nhất đang hiển thị
      batch = await db.chatMessage.findMany({
        where: {
          sessionId,
          OR: [
            { createdAt: { lt: cursorTime } },
            { createdAt: cursorTime, id: { lt: cursorId } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BATCH,
      })
    } else {
      batch = await db.chatMessage.findMany({
        where: { sessionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BATCH,
      })
    }

    if (batch.length === 0) {
      exhausted = true
      break
    }

    walked.push(...batch)
    const last = batch[batch.length - 1] // cũ nhất trong batch
    cursorId = last.id
    cursorTime = last.createdAt

    // Đủ số lượt user message → dừng
    const userCount = walked.filter(m => m.role === 'user').length
    if (userCount >= exchanges) break

    if (batch.length < BATCH) {
      exhausted = true
      break
    }
  }

  return { walked, exhausted }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      )
    }

    // ===== Lazy-load mode (user request 2026-09-01) =====
    const exchangesRaw = searchParams.get('exchanges')
    if (exchangesRaw) {
      const exchanges = Math.min(Math.max(1, Number(exchangesRaw) || 3), 20)
      const beforeId = searchParams.get('beforeId')

      // Resolve cursor message (message cũ nhất đang hiển thị ở client)
      let cursor: { id: string; createdAt: Date } | undefined
      if (beforeId) {
        const cursorMsg = await db.chatMessage.findUnique({ where: { id: beforeId } })
        if (cursorMsg && cursorMsg.sessionId === sessionId) {
          cursor = { id: cursorMsg.id, createdAt: cursorMsg.createdAt }
        }
        // Cursor không hợp lệ (đã bị xóa / sai session) → coi như load từ đầu
      }

      const { walked, exhausted } = await walkBack(sessionId, exchanges, cursor)

      // Trim: window = từ user message thứ `exchanges` (tính từ cuối) tới hết
      let cutIndex = -1
      let seen = 0
      for (let i = 0; i < walked.length; i++) {
        if (walked[i].role === 'user') {
          seen++
          if (seen >= exchanges) {
            cutIndex = i
            break
          }
        }
      }
      // cutIndex = -1 → chưa gộp đủ `exchanges` user messages (session ngắn)
      // → window = toàn bộ walked
      const windowDesc = cutIndex >= 0 ? walked.slice(0, cutIndex + 1) : walked

      // Có message cũ hơn ngoài window? (đã walk ra nhưng bị trim, hoặc chưa
      // hết batch → có thể còn nữa phía dưới)
      const trimmed = walked.length - windowDesc.length
      const hasMore = trimmed > 0 || !exhausted

      const messages = windowDesc.slice().reverse() // asc — cũ nhất đầu

      return NextResponse.json({
        messages,
        hasMore,
        oldestId: messages.length > 0 ? messages[0].id : null,
      })
    }

    // ===== Legacy mode — load ALL (các call site cũ: task polling...) =====
    const messages = await getSessionMessages(sessionId)

    return NextResponse.json({ messages })
  } catch (err) {
    console.error('[ChatMessagesAPI] GET error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to get session messages', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== POST — SAVE SESSION MESSAGES ====================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sessionId, messages } = body

    // Validate required fields
    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'messages must be a non-empty array' }, { status: 400 })
    }

    // Validate each message has required fields
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg.role || typeof msg.role !== 'string') {
        return NextResponse.json(
          { error: `messages[${i}].role is required and must be a string` },
          { status: 400 }
        )
      }
      if (!msg.content || typeof msg.content !== 'string') {
        return NextResponse.json(
          { error: `messages[${i}].content is required and must be a string` },
          { status: 400 }
        )
      }
    }

    // Normalize messages for storage
    const normalizedMessages = messages.map((msg: {
      role: string
      content: string
      model?: string
      provider?: string
      metadata?: Record<string, unknown>
    }) => ({
      role: msg.role,
      content: msg.content,
      model: msg.model || undefined,
      provider: msg.provider || undefined,
      metadata: msg.metadata || undefined,
    }))

    const saved = await saveChatMessages(sessionId, normalizedMessages)

    return NextResponse.json({ saved }, { status: 201 })
  } catch (err) {
    console.error('[ChatMessagesAPI] POST error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to save chat messages', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== DELETE — DELETE SESSION MESSAGES ====================

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      )
    }

    const result = await db.chatMessage.deleteMany({
      where: { sessionId },
    })

    return NextResponse.json({ success: true, deletedCount: result.count })
  } catch (err) {
    console.error('[ChatMessagesAPI] DELETE error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to delete chat messages', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
