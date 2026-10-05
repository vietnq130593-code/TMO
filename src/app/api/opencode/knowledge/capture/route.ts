/**
 * OC-3.3: Auto-Knowledge Capture from OpenCode Sessions
 * 
 * POST /api/opencode/knowledge/capture
 * 
 * After an OpenCode session completes, this endpoint:
 * 1. Extracts insights from session summary
 * 2. Saves insights as AgentInsight records
 * 3. Creates entities in Knowledge Graph
 * 4. Logs the capture event
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { extractInsightsFromSessionData } from '@/lib/opencode-knowledge-context'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sessionId, summary, filesChanged, toolsUsed, outcome } = body

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required (string)' }, { status: 400 })
    }

    // ━━ ROUND-38 fix Y7 — validate + ép kiểu đầu vào ━━
    // Trước đây `filesChanged: "src/x.ts"` (string) khiến `for (const file of
    // ...)` duyệt TỪNG KÝ TỰ (entity rác mỗi chữ cái) và V3.4 map/slice trên
    // string throw → episode bị skip im lặng. Giờ: chỉ nhận array, ép từng
    // phần tử String, cap độ dài mảng.
    const summaryText = typeof summary === 'string' ? summary : ''
    const filesList = (Array.isArray(filesChanged) ? filesChanged : [])
      .map((f: unknown) => String(f).slice(0, 300))
      .slice(0, 50)
    const toolsList = (Array.isArray(toolsUsed) ? toolsUsed : [])
      .map((t: unknown) => String(t).slice(0, 100))
      .slice(0, 50)
    // Outcome từ caller (session có thể fail/abandon — trước đây hardcode
    // SUCCESS khiến opencode KHÔNG BAO GIỜ ghi được episode thất bại).
    const validOutcomes = new Set(['SUCCESS', 'FAILURE', 'PARTIAL', 'ABANDONED'])
    const episodeOutcome = (
      typeof outcome === 'string' && validOutcomes.has(outcome) ? outcome : 'SUCCESS'
    ) as 'SUCCESS' | 'FAILURE' | 'PARTIAL' | 'ABANDONED'

    // 1. Extract insights from session data
    const insights = extractInsightsFromSessionData(
      summaryText,
      filesList,
      toolsList
    )

    let capturedCount = 0

    // 2. Save insights to DB
    for (const insight of insights) {
      try {
        await db.agentInsight.create({
          data: {
            agentId: 'opencode',
            content: insight.content,
            source: 'auto_opencode',
            type: insight.type,
            confidence: insight.confidence,
          },
        })
        capturedCount++
      } catch {
        // Skip if fails
      }
    }

    // 3. Create entities in KB for code modules
    for (const file of filesList) {
      try {
        await db.localEntity.create({
          data: {
            entityName: file,
            entityType: 'CodeFile',
            description: `Code file modified in OpenCode session ${sessionId}`,
            domain: 'codebase',
            source: 'auto_opencode',
            properties: JSON.stringify({
              sessionId,
              modifiedAt: new Date().toISOString(),
              summary: summaryText.substring(0, 200),
            }),
          },
        })
      } catch {
        // Entity may already exist
      }
    }

    // 4. Update the OpenCodeSession record
    try {
      const session = await db.openCodeSession.findFirst({
        where: { sessionId },
      })
      if (session) {
        const existingTools = JSON.parse(session.toolsUsed || '[]')
        const existingFiles = JSON.parse(session.filesTouched || '[]')
        await db.openCodeSession.update({
          where: { id: session.id },
          data: {
            status: 'completed',
            toolsUsed: JSON.stringify([...new Set([...existingTools, ...toolsList])]),
            filesTouched: JSON.stringify([...new Set([...existingFiles, ...filesList])]),
          },
        })
      }
    } catch {
      // Session may not exist
    }

    // 5. Log capture event
    try {
      await db.learningLog.create({
        data: {
          eventType: 'pattern',
          content: JSON.stringify({
            type: 'opencode_knowledge_capture',
            sessionId,
            insightsCaptured: capturedCount,
            filesChanged: filesList.length,
            toolsUsed: toolsList.length,
          }),
        },
      })
    } catch {
      // Log may fail
    }

    // 6. ROUND-37 V3.4 — EPISODIC CONSOLIDATE: session OpenCode thành episode
    // Trước đây opencode-route không ghi episode — công việc/khối lượng lỗi
    // (nếu có) của session không bao giờ vào bộ não. Capture endpoint là điểm
    // "session hoàn tất" duy nhất → record ở đây: filesChanged/toolsUsed làm
    // evidence thành công, summary làm context. Fire-and-forget fail-open.
    //
    // ROUND-38 fix Y7: (a) outcome từ body (không còn hardcode SUCCESS);
    // (b) DEDUPE theo sessionId — double-POST (retry mạng/client gọi lại)
    // trước đây sinh episode TRÙNG cho cùng 1 session (nhiễu bộ nhớ episodic).
    try {
      const { recordAgentEpisode } = await import('@/lib/episodic-memory/agent-brain')
      const sessionRow = await db.openCodeSession.findFirst({
        where: { sessionId },
        select: { prompt: true, createdAt: true },
      })
      const existingEpisode = await db.episodeRecord.findFirst({
        where: { sessionId },
        select: { id: true },
      }).catch(() => null)
      if (existingEpisode) {
        console.log(`[opencode/knowledge/capture] Episode cho session ${sessionId} đã tồn tại (${existingEpisode.id}) — skip record (dedupe, fix Y7)`)
      } else {
        recordAgentEpisode({
          family: 'opencode',
          agentName: 'OpenCode session',
          goal: (sessionRow?.prompt || summaryText || `OpenCode session ${sessionId}`).slice(0, 500),
          sessionId,
          startedAt: sessionRow?.createdAt ?? undefined, // fix Y3 — startedAt thật từ OpenCodeSession row
          outcome: episodeOutcome,
          stopReason: 'complete',
          toolEvidence: [
            ...filesList.slice(0, 15).map((f: string) => ({
              tool: 'opencode:file', success: true, text: `Đã sửa file: ${f}`,
            })),
            ...toolsList.slice(0, 15).map((t: string) => ({
              tool: `opencode:${t}`, success: true, text: `Session dùng tool ${t}`,
            })),
            ...(summaryText ? [{ tool: 'opencode:summary', success: true, text: summaryText.slice(0, 400) }] : []),
          ],
        })
      }
    } catch {
      // Episodic capture fail-open — KHÔNG làm hỏng knowledge capture
    }

    return NextResponse.json({
      captured: capturedCount,
      insights: insights.map(i => ({
        content: i.content,
        type: i.type,
        confidence: i.confidence,
      })),
      entitiesCreated: filesList.length,
      sessionId,
    })
  } catch (error) {
    console.error('[opencode/knowledge/capture] Error:', error)
    return NextResponse.json(
      { error: 'Failed to capture knowledge', details: String(error) },
      { status: 500 }
    )
  }
}
