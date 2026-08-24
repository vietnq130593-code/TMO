import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Phase 2 SMOLAB Proposal 8 — Layer 9 metrics endpoint.
// Surfaces aggregated operational metrics (ExecutionMetrics) + recent failure
// patterns (FailurePattern) + recent adaptations (StrategyAdaptationLog) +
// ML quality placeholders. Read-only — no actions exposed (UI is display-only).
//
// Consumers: src/app/page.tsx LearningTabContent "Layer 9 — Adaptation
// Intelligence" subpanel (auto-refresh every 30s).

export async function GET() {
  try {
    // Aggregated metrics from ExecutionMetrics table (last 100 workflow runs).
    const allMetrics = await db.executionMetrics.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const totalRuns = allMetrics.length
    const totalCompletedSteps = allMetrics.reduce((s, m) => s + m.completedSteps, 0)
    const totalFailedSteps = allMetrics.reduce((s, m) => s + m.failedSteps, 0)
    const totalSteps = allMetrics.reduce((s, m) => s + m.totalSteps, 0)
    const totalTokensUsed = allMetrics.reduce((s, m) => s + m.totalTokensUsed, 0)
    const totalTokensBudgeted = allMetrics.reduce((s, m) => s + m.totalTokensBudgeted, 0)
    const overallSuccessRate = totalSteps > 0 ? totalCompletedSteps / totalSteps : 0
    const overallTokenEfficiency =
      totalTokensBudgeted > 0 ? totalTokensUsed / totalTokensBudgeted : 0

    // Aggregate by routing mode (proxy for task complexity: 'A' | 'B' | 'C').
    const byRoutingMode: Record<
      string,
      { count: number; avgSuccess: number; avgTokens: number; avgTime: number }
    > = {}
    for (const m of allMetrics) {
      if (!byRoutingMode[m.routingMode]) {
        byRoutingMode[m.routingMode] = { count: 0, avgSuccess: 0, avgTokens: 0, avgTime: 0 }
      }
      const bucket = byRoutingMode[m.routingMode]
      bucket.avgSuccess = (bucket.avgSuccess * bucket.count + m.stepSuccessRate) / (bucket.count + 1)
      bucket.avgTokens = (bucket.avgTokens * bucket.count + m.totalTokensUsed) / (bucket.count + 1)
      bucket.avgTime = (bucket.avgTime * bucket.count + m.totalTimeSpent) / (bucket.count + 1)
      bucket.count++
    }

    // Success rate trend — last 10 runs, oldest first (for sparkline rendering).
    const successRateTrend = allMetrics
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        runId: m.id,
        successRate: m.stepSuccessRate,
        timestamp: m.createdAt.toISOString(),
      }))

    // Recent failure patterns (last 5). NOTE: FailurePattern schema (Phase 6
    // Prop 2) does not have a createdAt field — we sort client-side by cuid id
    // (cuids embed a monotonic timestamp counter, so this approximates recency).
    // Defensive: schema may be missing in some environments — return [] instead
    // of 500'ing.
    const recentPatternsRaw = await db.failurePattern
      .findMany({
        take: 5,
      })
      .catch(() => [])
    const recentPatterns = [...recentPatternsRaw]
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        type: p.type,
        count: p.count,
        nextStrategy: p.nextStrategy,
        resolved: p.resolved,
        // FailurePattern has no createdAt — use empty string as placeholder.
        createdAt: '',
      }))

    // Recent adaptation logs (last 5).
    const recentAdaptations = await db.strategyAdaptationLog
      .findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      })
      .catch(() => [])

    return NextResponse.json({
      aggregated: {
        totalRuns,
        totalCompletedSteps,
        totalFailedSteps,
        totalTokensUsed,
        overallSuccessRate,
        overallTokenEfficiency,
      },
      byRoutingMode,
      successRateTrend,
      recentPatterns,
      recentAdaptations: recentAdaptations.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        fromStrategy: a.fromStrategy,
        toStrategy: a.toStrategy,
        reason: a.reason,
        confidence: a.confidence,
        successful: a.successful,
        createdAt: a.createdAt.toISOString(),
      })),
      // ML quality subpanel (Phase 4 will populate the TBDs).
      mlQuality: {
        embeddingCacheHitRate: null, // TBD — needs instrumentation
        pseudoHashVectorCount: 0, // Must be 0 after Pre-Phase 1 P0.1 fix
        autoLearnVerificationRate: null, // TBD — needs `verified` field on AgentInsight
      },
    })
  } catch (err) {
    console.error('[Layer9Metrics] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch Layer 9 metrics' },
      { status: 500 }
    )
  }
}
