/**
 * Learning Stats API
 *
 * GET — Return learning statistics for the agent
 * Includes: total counts, accuracy rate, daily trends, top domains
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    // FIX (agentId mismatch): aggregate across ALL agents unless an explicit
    // agentId is given (writers store under real agentProfileId cuids — the old
    // 'default' filter hid every auto-recorded event).
    const agentIdParam = searchParams.get('agentId')
    const agentId = agentIdParam && agentIdParam !== 'all' && agentIdParam !== 'default'
      ? agentIdParam
      : undefined
    const agentFilter = agentId ? { agentId } : {}
    const days = parseInt(searchParams.get('days') || '30')

    const since = new Date()
    since.setDate(since.getDate() - days)

    // Get total counts
    // For feedback counting, fetch ALL feedback logs and parse JSON to count accurately
    // (Avoids fragile `contains` queries that depend on JSON serialization format)
    const [
      totalInsights,
      totalCorrections,
      totalPreferences,
      totalStandingOrders,
      allFeedbackLogs,
      appliedCorrections,
      recentInsights,
      recentCorrections,
    ] = await Promise.all([
      db.agentInsight.count({ where: agentFilter }),
      db.agentCorrection.count({ where: agentFilter }),
      db.agentPreference.count({ where: agentFilter }),
      db.standingOrder.count({ where: agentFilter }),
      db.learningLog.findMany({
        where: { ...agentFilter, eventType: 'feedback' },
        select: { content: true },
      }),
      db.agentCorrection.count({ where: { ...agentFilter, applied: true } }),
      db.agentInsight.findMany({
        where: { ...agentFilter, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true, type: true, confidence: true, source: true, createdAt: true },
      }),
      db.agentCorrection.findMany({
        where: { ...agentFilter, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, wrongAnswer: true, correctAnswer: true, applied: true, createdAt: true },
      }),
    ])

    // Calculate accuracy rate from parsed feedback logs (robust against JSON format changes)
    let totalFeedbackPositive = 0
    let totalFeedbackNegative = 0
    for (const log of allFeedbackLogs) {
      try {
        const parsed = JSON.parse(log.content)
        if (parsed.type === 'positive') totalFeedbackPositive++
        else if (parsed.type === 'negative') totalFeedbackNegative++
      } catch {
        // Unparseable, skip
      }
    }

    // Calculate accuracy rate (positive / total feedback)
    const totalFeedback = totalFeedbackPositive + totalFeedbackNegative
    const accuracyRate = totalFeedback > 0 ? totalFeedbackPositive / totalFeedback : 0

    // Build daily trends for last N days
    const insightsByDay: Array<{ date: string; count: number }> = []
    const correctionsByDay: Array<{ date: string; count: number }> = []

    for (let i = days - 1; i >= 0; i--) {
      const day = new Date()
      day.setDate(day.getDate() - i)
      const dateStr = day.toISOString().split('T')[0]
      insightsByDay.push({ date: dateStr, count: 0 })
      correctionsByDay.push({ date: dateStr, count: 0 })
    }

    // Count insights per day
    for (const insight of recentInsights) {
      const dateStr = insight.createdAt.toISOString().split('T')[0]
      const entry = insightsByDay.find(d => d.date === dateStr)
      if (entry) entry.count++
    }

    // Count corrections per day
    for (const correction of recentCorrections) {
      const dateStr = correction.createdAt.toISOString().split('T')[0]
      const entry = correctionsByDay.find(d => d.date === dateStr)
      if (entry) entry.count++
    }

    // Insight types distribution
    const insightTypes = await db.agentInsight.groupBy({
      by: ['type'],
      where: agentFilter,
      _count: { type: true },
    })

    // Insight sources distribution
    const insightSources = await db.agentInsight.groupBy({
      by: ['source'],
      where: agentFilter,
      _count: { source: true },
    })

    // Recent standing orders
    const standingOrders = await db.standingOrder.findMany({
      where: { ...agentFilter, enabled: true },
      orderBy: { priority: 'desc' },
    })

    return NextResponse.json({
      totalInsights,
      totalCorrections,
      totalPreferences,
      totalStandingOrders,
      totalFeedbackPositive,
      totalFeedbackNegative,
      accuracyRate: Math.round(accuracyRate * 100) / 100,
      appliedCorrections,
      pendingCorrections: totalCorrections - appliedCorrections,
      insightsByDay,
      correctionsByDay,
      insightTypeDistribution: insightTypes.map(t => ({ type: t.type, count: t._count.type })),
      insightSourceDistribution: insightSources.map(s => ({ source: s.source, count: s._count.source })),
      standingOrders: standingOrders.map(o => ({ id: o.id, order: o.order, priority: o.priority })),
      recentInsights: recentInsights.slice(0, 10),
      recentCorrections: recentCorrections.slice(0, 10),
      period: { days, since: since.toISOString() },
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch learning stats', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
