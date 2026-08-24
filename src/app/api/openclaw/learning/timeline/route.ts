/**
 * Learning Timeline API
 *
 * GET — List learning events in chronological order
 * Params: ?type=insight&from=2026-01-01&to=2026-12-31&agentId=default&limit=50&offset=0
 *
 * Strategy: Use AgentInsight, AgentCorrection, AgentPreference as PRIMARY sources.
 * LearningLog is used ONLY for event types not covered by those tables (feedback, pattern).
 * This avoids duplicates since teach API writes to both.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || undefined
    const from = searchParams.get('from') || undefined
    const to = searchParams.get('to') || undefined
    // FIX (agentId mismatch): writers (chat writeback, auto-learn, feedback) store
    // rows under the real agentProfileId (cuid) — filtering by 'default' by default
    // made every auto-recorded event invisible in the timeline. Now a missing or
    // 'default'/'all' agentId means NO filter (aggregate across all agents); an
    // explicit agentId still filters to that agent.
    const agentIdParam = searchParams.get('agentId')
    const agentId = agentIdParam && agentIdParam !== 'all' && agentIdParam !== 'default'
      ? agentIdParam
      : undefined // undefined = aggregate all agents
    const agentFilter = agentId ? { agentId } : {}
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    // Date filter
    const dateFilter: Record<string, Date> = {}
    if (from) dateFilter.gte = new Date(from)
    if (to) dateFilter.lte = new Date(to)
    const hasDateFilter = Object.keys(dateFilter).length > 0

    type TimelineEvent = {
      id: string
      type: string
      content: string
      timestamp: string
      metadata: Record<string, unknown>
    }

    const timeline: TimelineEvent[] = []

    // 1. Fetch AgentInsight entries (PRIMARY source for insights)
    if (!type || type === 'insight') {
      const insightWhere: Record<string, unknown> = { ...agentFilter }
      if (hasDateFilter) insightWhere.createdAt = dateFilter

      const insights = await db.agentInsight.findMany({
        where: insightWhere,
        orderBy: { createdAt: 'desc' },
        take: type ? limit : 30,
        skip: type ? offset : 0,
      })

      for (const insight of insights) {
        timeline.push({
          id: insight.id,
          type: 'insight',
          content: insight.content,
          timestamp: insight.createdAt.toISOString(),
          metadata: { source: insight.source, insightType: insight.type, confidence: insight.confidence },
        })
      }
    }

    // 2. Fetch AgentCorrection entries (PRIMARY source for corrections)
    if (!type || type === 'correction') {
      const correctionWhere: Record<string, unknown> = { ...agentFilter }
      if (hasDateFilter) correctionWhere.createdAt = dateFilter

      const corrections = await db.agentCorrection.findMany({
        where: correctionWhere,
        orderBy: { createdAt: 'desc' },
        take: type ? limit : 30,
        skip: type ? offset : 0,
      })

      for (const correction of corrections) {
        timeline.push({
          id: correction.id,
          type: 'correction',
          content: `Sai: "${correction.wrongAnswer.substring(0, 80)}" → Đúng: "${correction.correctAnswer.substring(0, 80)}"`,
          timestamp: correction.createdAt.toISOString(),
          metadata: { applied: correction.applied, reason: correction.reason },
        })
      }
    }

    // 3. Fetch AgentPreference entries (PRIMARY source for preferences)
    if (!type || type === 'preference') {
      const prefWhere: Record<string, unknown> = { ...agentFilter }
      if (hasDateFilter) prefWhere.createdAt = dateFilter

      const preferences = await db.agentPreference.findMany({
        where: prefWhere,
        orderBy: { createdAt: 'desc' },
        take: 30,
      })

      for (const pref of preferences) {
        timeline.push({
          id: pref.id,
          type: 'preference',
          content: `${pref.preferenceKey}: ${pref.preferenceValue}`,
          timestamp: pref.createdAt.toISOString(),
          metadata: { source: pref.source, key: pref.preferenceKey, value: pref.preferenceValue },
        })
      }
    }

    // 4. Fetch LearningLog entries for feedback & pattern ONLY
    //    (insight/correction/preference are already covered by agent tables above)
    const logEventTypes = type
      ? (['feedback', 'pattern'].includes(type) ? [type] : [])
      : ['feedback', 'pattern']

    let logTotal = 0
    if (logEventTypes.length > 0) {
      const logWhere: Record<string, unknown> = { ...agentFilter, eventType: { in: logEventTypes } }
      if (hasDateFilter) logWhere.createdAt = dateFilter

      const [logEvents, logCount] = await Promise.all([
        db.learningLog.findMany({
          where: logWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: type ? offset : 0,
        }),
        db.learningLog.count({ where: logWhere }),
      ])
      logTotal = logCount

      for (const event of logEvents) {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(event.content) } catch { parsed = {} }

        // Build human-readable content for feedback events
        let displayContent: string
        if (event.eventType === 'feedback') {
          const feedbackType = parsed.type as string || 'unknown'
          const userContent = parsed.userContent as string || ''
          const agentResponse = parsed.agentResponse as string || ''
          const icon = feedbackType === 'positive' ? '👍' : '👎'
          displayContent = userContent
            ? `${icon} "${userContent.substring(0, 60)}" → "${agentResponse.substring(0, 60)}"`
            : `${icon} Feedback`
        } else {
          // Pattern events
          displayContent = parsed.text
            ? String(parsed.text)
            : parsed.action
              ? `Action: ${String(parsed.action)}`
              : event.content.substring(0, 150)
        }

        timeline.push({
          id: event.id,
          type: event.eventType,
          content: displayContent,
          timestamp: event.createdAt.toISOString(),
          metadata: { ...parsed, logEventType: event.eventType, sessionId: event.sessionId },
        })
      }
    }

    // Sort by timestamp descending
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Count by type (using agent tables for accurate counts)
    const [insightCount, correctionCount, prefCount, feedbackCount, patternCount] = await Promise.all([
      db.agentInsight.count({ where: { agentId } }),
      db.agentCorrection.count({ where: { agentId } }),
      db.agentPreference.count({ where: { agentId } }),
      db.learningLog.count({ where: { agentId, eventType: 'feedback' } }),
      db.learningLog.count({ where: { agentId, eventType: 'pattern' } }),
    ])

    const typeCounts: Record<string, number> = {
      feedback: feedbackCount,
      insight: insightCount,
      correction: correctionCount,
      preference: prefCount,
      pattern: patternCount,
    }

    // Total: sum of agent table counts + log-only counts
    const total = insightCount + correctionCount + prefCount + logTotal

    return NextResponse.json({
      events: timeline.slice(0, limit),
      total,
      typeCounts,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch timeline', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
