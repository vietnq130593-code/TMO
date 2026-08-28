/**
 * OC-3.6b: Session Timeline API
 * 
 * GET /api/opencode/sessions/[id]/timeline
 * Returns timeline events for an OpenCode session
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Một event trên timeline của session (annotation tường minh — tránh never[]) */
type TimelineEvent = {
  timestamp: string
  type: string
  icon: string
  label: string
  detail: string
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    
    // Find the session in DB
    const session = await db.openCodeSession.findFirst({
      where: { sessionId: id },
    })

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Build timeline from session data
    const toolsUsed: string[] = JSON.parse(session.toolsUsed || '[]')
    const filesTouched: string[] = JSON.parse(session.filesTouched || '[]')

    const timeline: TimelineEvent[] = []
    const createdAt = new Date(session.createdAt)
    const updatedAt = new Date(session.updatedAt)

    // Session start event
    timeline.push({
      timestamp: createdAt.toISOString(),
      type: 'start',
      icon: '🚀',
      label: 'Session bắt đầu',
      detail: session.prompt || 'No prompt',
    })

    // Events được rải ĐỀU (deterministic) trên khoảng thời gian THẬT
    // [createdAt → updatedAt] của session. Trước đây dùng Math.random() offset
    // (timestamp giả) — giờ dùng phân bố đều: trung thực với dữ liệu thật,
    // gọi 2 lần cho ra cùng kết quả.
    // NOTE: OpenCode session hiện chỉ lưu AGGREGATE (filesTouched/toolsUsed),
    // chưa có event-level log — thứ tự sự kiện là suy diễn từ aggregate, không
    // phải chronology thật của từng tool call.
    const derivedEvents: { type: string; icon: string; label: string; detail: string }[] = []

    for (const file of filesTouched) {
      derivedEvents.push({
        type: 'file_read',
        icon: '📁',
        label: `Đọc file: ${file}`,
        detail: file,
      })
    }

    const toolLabels: Record<string, { icon: string; label: string }> = {
      knowledge_search: { icon: '🔍', label: 'Tìm kiếm KB' },
      knowledge_graph: { icon: '🕸️', label: 'Truy vấn Graph' },
      knowledge_write: { icon: '💾', label: 'Ghi vào KB' },
      file_edit: { icon: '✏️', label: 'Chỉnh sửa file' },
      file_read: { icon: '📁', label: 'Đọc file' },
      bash_exec: { icon: '⚡', label: 'Chạy lệnh' },
      lsp_diagnostics: { icon: '🔍', label: 'LSP Check' },
      web_search: { icon: '🌐', label: 'Tìm kiếm web' },
    }
    for (const tool of toolsUsed) {
      const info = toolLabels[tool] || { icon: '🔧', label: tool }
      derivedEvents.push({
        type: 'tool_call',
        icon: info.icon,
        label: info.label,
        detail: tool,
      })
    }

    // Rải đều N derived events trong (start, end] — deterministic
    const totalMs = Math.max(updatedAt.getTime() - createdAt.getTime(), derivedEvents.length * 1000)
    const step = totalMs / (derivedEvents.length + 1)
    derivedEvents.forEach((event, i) => {
      timeline.push({
        timestamp: new Date(createdAt.getTime() + Math.round(step * (i + 1))).toISOString(),
        type: event.type,
        icon: event.icon,
        label: event.label,
        detail: event.detail,
      })
    })

    // Add completion event (thời điểm thật — updatedAt)
    if (session.status === 'completed') {
      timeline.push({
        timestamp: updatedAt.toISOString(),
        type: 'complete',
        icon: '✅',
        label: 'Session hoàn thành',
        detail: `${filesTouched.length} files, ${toolsUsed.length} tools used`,
      })
    } else if (session.status === 'failed') {
      timeline.push({
        timestamp: updatedAt.toISOString(),
        type: 'error',
        icon: '❌',
        label: 'Session thất bại',
        detail: 'Xem log để biết chi tiết',
      })
    } else if (session.status === 'paused') {
      timeline.push({
        timestamp: updatedAt.toISOString(),
        type: 'paused',
        icon: '⏸️',
        label: 'Session tạm dừng',
        detail: 'Đang chờ tiếp tục',
      })
    }

    return NextResponse.json({
      sessionId: id,
      session: {
        model: session.model,
        provider: session.provider,
        prompt: session.prompt,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        filesTouched,
        toolsUsed,
      },
      timeline,
      stats: {
        totalEvents: timeline.length,
        filesTouched: filesTouched.length,
        toolsUsed: toolsUsed.length,
        duration: totalMs,
      },
    })
  } catch (error) {
    console.error('[opencode/sessions/[id]/timeline] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get timeline', details: String(error) },
      { status: 500 }
    )
  }
}
