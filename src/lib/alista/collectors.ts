/**
 * ALISTA — 7 Collectors (v1.1)
 * ============================
 * Mỗi collector là 1 hàm async fail-open — trả {ok, data?, error?, collectMs}.
 * KHÔNG throw ra ngoài collector (mọi query bọc try/catch, fail → ok:false +
 * error message). Pipeline tuần tự gọi lần lượt ① → ⑦.
 *
 * (1) Tools health         — ToolMetric 7d groupBy toolName
 * (2) Agent runs           — AgentRunRecord 24h/7d, failure signatures, zombies
 * (3) Escalations          — Neo4j ErrorOccurrence getEscalationCandidates
 * (4) Domain coverage      — Neo4j e.domain groupBy + last-updated per domain
 * (5) 3 layers             — Qdrant/Neo4j/embed-status + so sánh với lần trước
 * (6) Self-assessment      — collector ①-⑤ fail log + tool whitelist gaps
 * (7) DB + Memory + Learning — 7 sub-checks (a-g)
 */

import { db } from '@/lib/db'
import { findAgentRunRecordsSince, type AgentRunRecordRow } from '@/lib/metrics-db'
import {
  getEscalationCandidates,
  getErrorDashboard,
  getEpisodicGraphCounts,
  getAllLessonNodes,
  countEpisodeRecords,
  countLessonRecords,
  type ErrorDashboardRow,
} from '@/lib/episodic-memory'
import { getQdrantStats, checkQdrantHealth } from '@/lib/qdrant'
import { checkNeo4jHealth, readCypher } from '@/lib/neo4j'
import { getAutoLearnStats } from '@/lib/auto-learn'
import { ensureDbReady } from '@/lib/db-setup'
import { promises as fsP } from 'fs'
import path from 'path'
import type { CollectorResult, Finding, CheckId } from './types'

// ==================== HELPERS ====================

/** Bọc 1 async function thành CollectorResult fail-open + đo collectMs */
async function withCollector<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<CollectorResult<T>> {
  const start = Date.now()
  try {
    const data = await fn()
    return { ok: true, data, collectMs: Date.now() - start }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[ALISTA][collector:${label}] fail-open:`, error)
    return { ok: false, error, collectMs: Date.now() - start }
  }
}

/** Helper lấy list AgentRunRecord gần đây (cho ① và ②) */
async function fetchRunRecords(days: number): Promise<AgentRunRecordRow[]> {
  const since = new Date(Date.now() - days * 24 * 3600_000)
  return findAgentRunRecordsSince(since)
}

// ==================== ① TOOLS HEALTH ====================

export interface ToolsHealthData {
  window: '7d'
  tools: Array<{
    toolName: string
    calls: number
    errors: number
    successRate: number
    avgDurationMs: number
    topErrorTag: string | null
    /** 3 thông điệp lỗi mẫu (raw text) — không có nếu 0 lỗi */
    sampleErrors: string[]
  }>
}

const TOOL_WINDOW_DAYS = 7

export async function collectToolsHealth(): Promise<CollectorResult<ToolsHealthData>> {
  return withCollector('tools', async () => {
    const since = new Date(Date.now() - TOOL_WINDOW_DAYS * 24 * 3600_000)
    const metrics = await db.toolMetric.findMany({
      where: { timestamp: { gte: since } },
      select: { toolName: true, success: true, durationMs: true, errorTag: true, sessionId: true },
      orderBy: { timestamp: 'desc' },
      take: 10_000, // safety cap
    })

    // Group by toolName + collect sample errors per tool
    const byTool = new Map<string, {
      calls: number
      errors: number
      success: number
      totalDurationMs: number
      errorTags: Map<string, number>
      sampleErrors: string[]
    }>()

    for (const m of metrics) {
      const agg = byTool.get(m.toolName) ?? {
        calls: 0, errors: 0, success: 0, totalDurationMs: 0,
        errorTags: new Map<string, number>(), sampleErrors: [],
      }
      agg.calls++
      agg.totalDurationMs += m.durationMs
      if (m.success) {
        agg.success++
      } else {
        agg.errors++
        if (m.errorTag) agg.errorTags.set(m.errorTag, (agg.errorTags.get(m.errorTag) || 0) + 1)
        // Sample 3 lỗi đầu tiên của tool (để LLM có bối cảnh)
        if (agg.sampleErrors.length < 3 && m.errorTag) agg.sampleErrors.push(m.errorTag)
      }
      byTool.set(m.toolName, agg)
    }

    const tools = Array.from(byTool.entries())
      .map(([toolName, agg]) => {
        let topErrorTag: string | null = null
        let topCount = 0
        for (const [tag, count] of agg.errorTags) {
          if (count > topCount) { topCount = count; topErrorTag = tag }
        }
        return {
          toolName,
          calls: agg.calls,
          errors: agg.errors,
          successRate: agg.calls > 0 ? agg.success / agg.calls : 0,
          avgDurationMs: agg.calls > 0 ? Math.round(agg.totalDurationMs / agg.calls) : 0,
          topErrorTag,
          sampleErrors: agg.sampleErrors,
        }
      })
      .sort((a, b) => b.errors - a.errors)

    return { window: '7d' as const, tools }
  })
}

// ==================== ② AGENT RUNS ====================

export interface AgentRunsData {
  window24h: {
    total: number
    failed: number
    noProgress: number
    completed: number
    running: number
    byStopReason: Record<string, number>
    /** Run chạy >30' không end (zombie — chạy rất dài) */
    stuckRunning: AgentRunRecordRow[]
  }
  window7d: {
    /** Failure signature = `${agentName}|${stopReason}` groupBy, đếm số ngày khác nhau + total */
    failureSignatures: Array<{
      signature: string
      agentName: string | null
      stopReason: string | null
      occurrences: number
      distinctDays: number
      /** true nếu run gần nhất vẫn fail (chưa resolved) */
      recentStillFailing: boolean
      recentRunAt: Date | null
    }>
  }
  /** Run hiện đang running >30' — zombie */
  zombies: AgentRunRecordRow[]
}

export async function collectAgentRuns(): Promise<CollectorResult<AgentRunsData>> {
  return withCollector('agent-runs', async () => {
    const [runs24h, runs7d] = await Promise.all([fetchRunRecords(1), fetchRunRecords(7)])

    const now = Date.now()
    const STUCK_RUNNING_MS = 30 * 60_000 // 30 phút

    // 24h stats
    const byStopReason24: Record<string, number> = {}
    let failed24 = 0, noProgress24 = 0, completed24 = 0, running24 = 0
    const stuckRunning: AgentRunRecordRow[] = []
    for (const r of runs24h) {
      if (r.stopReason) byStopReason24[r.stopReason] = (byStopReason24[r.stopReason] || 0) + 1
      if (r.status === 'failed') failed24++
      if (r.stopReason === 'no_progress') noProgress24++
      if (r.status === 'completed') completed24++
      if (r.status === 'running') {
        running24++
        const startMs = (r.startedAt ?? r.createdAt).getTime()
        if (now - startMs > STUCK_RUNNING_MS) stuckRunning.push(r)
      }
    }

    // 7d failure signatures
    const sigMap = new Map<string, {
      agentName: string | null
      stopReason: string | null
      occurrences: number
      daySet: Set<string>
      recentRunAt: Date | null
    }>()
    for (const r of runs7d) {
      // Chỉ xét run có vấn đề (failed hoặc stopReason khác 'complete')
      const isFailing = r.status === 'failed' || (r.stopReason && r.stopReason !== 'complete')
      if (!isFailing) continue
      const sig = `${r.agentName || 'unknown'}|${r.stopReason || r.status || 'unknown'}`
      const agg = sigMap.get(sig) ?? {
        agentName: r.agentName, stopReason: r.stopReason,
        occurrences: 0, daySet: new Set<string>(), recentRunAt: null,
      }
      agg.occurrences++
      const dayKey = (r.createdAt ?? new Date(0)).toISOString().slice(0, 10)
      agg.daySet.add(dayKey)
      const runAt = r.completedAt ?? r.createdAt
      if (runAt && (!agg.recentRunAt || runAt > agg.recentRunAt)) agg.recentRunAt = runAt
      sigMap.set(sig, agg)
    }

    const failureSignatures = Array.from(sigMap.entries()).map(([sig, agg]) => ({
      signature: sig,
      agentName: agg.agentName,
      stopReason: agg.stopReason,
      occurrences: agg.occurrences,
      distinctDays: agg.daySet.size,
      recentStillFailing: agg.recentRunAt ? (now - agg.recentRunAt.getTime() < 24 * 3600_000) : false,
      recentRunAt: agg.recentRunAt,
    })).sort((a, b) => b.occurrences - a.occurrences)

    return {
      window24h: {
        total: runs24h.length,
        failed: failed24,
        noProgress: noProgress24,
        completed: completed24,
        running: running24,
        byStopReason: byStopReason24,
        stuckRunning,
      },
      window7d: { failureSignatures },
      zombies: stuckRunning,
    }
  })
}

// ==================== ③ ESCALATIONS ====================

export interface EscalationsData {
  /** Pattern escalation: root_cause lặp ≥3 lần */
  escalations: Array<{
    rootCause: string
    occurrences: number
    resolved: number
    recentErrors: string[]
  }>
  /** Bảng lỗi hay gặp (Q5 dashboard) — category × rootCause */
  errorDashboard: ErrorDashboardRow[]
}

export async function collectEscalations(): Promise<CollectorResult<EscalationsData>> {
  return withCollector('escalations', async () => {
    const [escalations, errorDashboard] = await Promise.all([
      getEscalationCandidates(3),
      getErrorDashboard(10),
    ])
    return { escalations, errorDashboard }
  })
}

// ==================== ④ DOMAIN COVERAGE ====================

export interface DomainCoverageData {
  /** Tổng entity trong graph (Neo4j) hoặc SQLite fallback */
  totalEntities: number
  /** Tổng relationship */
  totalRelationships: number
  /** Neo4j có khả dụng không (nếu false → fallback SQLite buffer) */
  neo4jReachable: boolean
  /** Distribution theo domain: {programming: 1240, ml: 380, ...} */
  domainDistribution: Record<string, number>
  /** Domain chuẩn TMO (8 cái) + last-updated (ngày) — null nếu không có dữ liệu */
  domainLastUpdated: Record<string, string | null>
  /** Source: 'neo4j' | 'sqlite-buffer' */
  source: 'neo4j' | 'sqlite-buffer'
}

/** 8 domain chuẩn TMO (đối chiếu docs/FULLSTACK_CAPABILITY_PLAN_V2) */
const STANDARD_DOMAINS = ['programming', 'algorithm', 'ml', 'data', 'devops', 'security', 'business', 'mixed']

export async function collectDomainCoverage(): Promise<CollectorResult<DomainCoverageData>> {
  return withCollector('domain-coverage', async () => {
    // Đếm tổng entity từ Neo4j (source of truth) — fallback SQLite nếu Neo4j chết
    let totalEntities = 0
    let totalRelationships = 0
    let neo4jReachable = false
    const domainDistribution: Record<string, number> = {}
    const domainLastUpdated: Record<string, string | null> = {}

    try {
      const entityCountRows = await readCypher<{ total: unknown }>('MATCH (e) RETURN count(e) AS total')
      totalEntities = Number(entityCountRows[0]?.total ?? 0)
      const relCountRows = await readCypher<{ total: unknown }>('MATCH ()-[r]->() RETURN count(r) AS total')
      totalRelationships = Number(relCountRows[0]?.total ?? 0)
      neo4jReachable = true

      // Distribution + last-updated per domain
      const distRows = await readCypher<{ domain: string; count: unknown; lastUpdated: unknown }>(`
        MATCH (e) WHERE e.domain IS NOT NULL
        WITH e.domain AS domain, count(*) AS count, max(coalesce(e.updatedAt, e.createdAt, e.created_at, '')) AS lastUpdated
        RETURN domain, count, lastUpdated
        ORDER BY count DESC
      `)
      for (const r of distRows) {
        if (r.domain) {
          domainDistribution[r.domain] = Number(r.count ?? 0)
          domainLastUpdated[r.domain] = r.lastUpdated ? String(r.lastUpdated).slice(0, 10) : null
        }
      }
    } catch (err) {
      console.warn('[ALISTA][collector:domain-coverage] Neo4j unreachable — fallback SQLite:', err instanceof Error ? err.message : String(err))
    }

    if (!neo4jReachable) {
      // Fallback: SQLite localEntity (raw buffer — NOT graph)
      try {
        const groups = await db.localEntity.groupBy({ by: ['domain'], _count: { _all: true } })
        for (const g of groups) {
          if (g.domain) {
            domainDistribution[g.domain] = g._count._all
            // SQLite không có updatedAt trên localEntity → dùng createdAt max
            try {
              const latest = await db.localEntity.findFirst({
                where: { domain: g.domain },
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
              })
              domainLastUpdated[g.domain] = latest?.createdAt ? latest.createdAt.toISOString().slice(0, 10) : null
            } catch { /* skip */ }
          }
        }
        totalEntities = await db.localEntity.count()
        totalRelationships = await db.localRelationship.count()
      } catch { /* fail-open — để trống */ }
    }

    // Đảm bảo 8 domain chuẩn có entry (0 nếu thiếu)
    for (const d of STANDARD_DOMAINS) {
      if (!(d in domainDistribution)) domainDistribution[d] = 0
      if (!(d in domainLastUpdated)) domainLastUpdated[d] = null
    }

    return {
      totalEntities,
      totalRelationships,
      neo4jReachable,
      domainDistribution,
      domainLastUpdated,
      source: neo4jReachable ? 'neo4j' : 'sqlite-buffer',
    }
  })
}

// ==================== ⑤ 3 TẦNG DỮ LIỆU ====================

export interface ThreeLayersData {
  qdrant: {
    connected: boolean
    error?: string
    collections: string[]
    totalDocuments: number
    totalChunks: number
    vectorsIndexed: number
  }
  neo4j: {
    connected: boolean
    error?: string
    nodeCount?: number
    relCount?: number
  }
  embed: {
    total: number
    real: number
    realRatio: number
    hasRealEmbeddings: boolean
    dimension: number
  }
  /** Snapshot của lần 'alista-check' gần nhất — để so sánh sụt giảm */
  previousSnapshot?: {
    runAt: string
    qdrantVectors: number | null
    neo4jNodes: number | null
    neo4jRels: number | null
  }
}

export async function collect3Layers(previousSnapshot?: ThreeLayersData['previousSnapshot']): Promise<CollectorResult<ThreeLayersData>> {
  return withCollector('3-layers', async () => {
    const [qdrantHealth, qdrantStats, neo4jHealth] = await Promise.all([
      checkQdrantHealth(),
      getQdrantStats(),
      checkNeo4jHealth(),
    ])

    // Embed-status pattern: total = totalChunks, real = vectorsIndexed
    // (Qdrant architecture: every chunk has real embedding — pseudo removed)
    const total = qdrantStats.totalChunks
    const real = qdrantStats.vectorsIndexed
    const realRatio = total > 0 ? real / total : 0

    return {
      qdrant: {
        connected: !!qdrantHealth.connected,
        error: qdrantHealth.error,
        collections: qdrantStats.collections,
        totalDocuments: qdrantStats.totalDocuments,
        totalChunks: qdrantStats.totalChunks,
        vectorsIndexed: qdrantStats.vectorsIndexed,
      },
      neo4j: {
        connected: !!neo4jHealth.connected,
        error: neo4jHealth.error,
        nodeCount: neo4jHealth.nodeCount,
        // Neo4jHealthResult dùng `relationshipCount` — map sang `relCount` của mình
        relCount: neo4jHealth.relationshipCount,
      },
      embed: {
        total,
        real,
        realRatio,
        hasRealEmbeddings: real > 0,
        dimension: 2048,
      },
      previousSnapshot,
    }
  })
}

// ==================== ⑥ TỰ-ĐÁNH-GIÁ ALISTA ====================

export interface SelfAssessmentData {
  /** Collector nào fail trong ca này */
  failedCollectors: Array<{ checkId: CheckId; label: string; error: string }>
  /** Số lần 'alista-check' gần đây + tỷ lệ thành công */
  recentRunStats: { total: number; completed: number; failed: number; budgetExhausted: number }
  /** Tool whitelist của ALISTA (đọc từ standalone-agents) */
  toolsCount: number
  /** Đề xuất cải tiến ALISTA (tự viết 1 finding nếu có vấn đề) */
  recommendations: string[]
}

export async function collectSelfAssessment(
  perCheckResults: Array<{ checkId: CheckId; label: string; result: CollectorResult }>,
): Promise<CollectorResult<SelfAssessmentData>> {
  return withCollector('self-assessment', async () => {
    const failedCollectors = perCheckResults
      .filter(r => !r.result.ok)
      .map(r => ({ checkId: r.checkId, label: r.label, error: r.result.error || 'unknown' }))

    // Recent alista-check stats
    let recentRunStats = { total: 0, completed: 0, failed: 0, budgetExhausted: 0 }
    try {
      const recent = await db.taskExecution.findMany({
        where: { type: 'alista-check' },
        orderBy: { startedAt: 'desc' },
        take: 30,
        select: { status: true, result: true, startedAt: true },
      })
      recentRunStats = {
        total: recent.length,
        completed: recent.filter(r => r.status === 'completed').length,
        failed: recent.filter(r => r.status === 'failed').length,
        budgetExhausted: recent.filter(r => r.result?.includes('budget_exhausted')).length,
      }
    } catch { /* fail-open */ }

    // Tools count — dynamic import để tránh circular
    let toolsCount = 0
    try {
      const { getStandaloneAgentTools } = await import('@/lib/standalone-agents')
      toolsCount = getStandaloneAgentTools('ALISTA').length
    } catch { /* fail-open */ }

    const recommendations: string[] = []
    if (failedCollectors.length > 0) {
      recommendations.push(`Collector ${failedCollectors.map(f => f.label).join(', ')} fail trong ca này — điều tra root cause + thêm retry/fallback cho collector.`)
    }
    if (recentRunStats.budgetExhausted > recentRunStats.total * 0.3 && recentRunStats.total > 5) {
      recommendations.push(`Tỷ lệ ca trực bị cắt ngang do budget quá cao (${recentRunStats.budgetExhausted}/${recentRunStats.total}) — cân nhắc giảm số collector hoặc tăng deadline.`)
    }
    if (toolsCount < 10) {
      recommendations.push(`Tool whitelist của ALISTA có ${toolsCount} tool — quá ít cho khảo sát toàn diện; bổ sung thêm tool đọc/khảo sát.`)
    }

    return { failedCollectors, recentRunStats, toolsCount, recommendations }
  })
}

// ==================== ⑦ DATABASE + MEMORY + LEARNING ====================

export interface DatabaseSystemData {
  // (a) SQLite integrity & schema drift
  schemaDrift: {
    migrated: boolean
    reason: string | null
    /** Bảng "ma" không trong Prisma schema — không检测 được dễ (cần introspection), để null */
    orphanTables: string[] | null
  }
  // (b) SQLite zombie rows
  zombies: {
    agentRunRunning6h: number
    taskExecutionRunning24h: number
    smolabTaskRunning30m: number
    goalLoopJobRunning15m: number
    details: Array<{ table: string; count: number; oldest: string | null }>
  }
  // (c) Memory mirror drift
  memoryDrift: {
    episodeMirrorCount: number
    episodeGraphCount: number
    episodeDriftPct: number // (graph - mirror) / graph * 100
    lessonMirrorCount: number
    lessonGraphCount: number
    lessonDriftPct: number
    neo4jReachable: boolean
  }
  // (d) Learning system health
  learning: {
    autoLearn: {
      total: number
      completed: number
      failed: number
      pending: number
      failedIn24h: number
      pendingStuck24h: number
    }
    pendingWriteback: number
    lessonsNeedReview: number
  }
  // (e) KnowledgeGraph sync drift
  kgSync: {
    unsyncedResolvedEntities: number
    rawBufferSize: number
    graphEntityCount: number
    bufferToGraphRatio: number // raw / graph
  }
  // (f) Token anomaly
  tokenAnomaly: {
    agentsWithSpike: Array<{ agentName: string; today: number; mean7d: number; stddev: number; zScore: number }>
    agentsWithDrop: Array<{ agentName: string; today: number; mean7d: number }>
  }
  // (g) DB size & storage
  dbStorage: {
    sqliteBytes: number
    tableRowCounts: Record<string, number>
    largeTables: Array<{ table: string; rows: number }>
  }
}

export async function collectDatabaseSystem(): Promise<CollectorResult<DatabaseSystemData>> {
  return withCollector('database-system', async () => {
    const now = Date.now()
    const now6h = new Date(now - 6 * 3600_000)
    const now24h = new Date(now - 24 * 3600_000)
    const now30m = new Date(now - 30 * 60_000)
    const now15m = new Date(now - 15 * 60_000)

    // (a) schemaDrift — gọi ensureDbReady (đã có probe drift + auto migrate)
    let schemaDrift = { migrated: false, reason: null as string | null, orphanTables: null as string[] | null }
    try {
      const result = await ensureDbReady()
      schemaDrift = { migrated: !!result.migrated, reason: result.reason ?? null, orphanTables: null }
    } catch (err) {
      schemaDrift = { migrated: false, reason: `ensureDbReady failed: ${err instanceof Error ? err.message : String(err)}`, orphanTables: null }
    }

    // (b) zombie rows — query each table in parallel (fail-open từng cái)
    const [
      agentRunZombieRows, taskExecutionZombieRows, smolabZombieRows, goalLoopZombieRows,
    ] = await Promise.all([
      (async () => {
        try { return await db.agentRunRecord.count({ where: { status: 'running', startedAt: { lt: now6h } } }) }
        catch { return 0 }
      })(),
      (async () => {
        try { return await db.taskExecution.count({ where: { status: 'running', startedAt: { lt: now24h } } }) }
        catch { return 0 }
      })(),
      (async () => {
        try { return await db.smolabTask.count({ where: { status: 'running', updatedAt: { lt: now30m } } }) }
        catch { return 0 }
      })(),
      (async () => {
        try { return await db.goalLoopJob.count({ where: { status: 'running', heartbeatAt: { lt: now15m } } }) }
        catch { return 0 }
      })(),
    ])

    const zombies = {
      agentRunRunning6h: agentRunZombieRows,
      taskExecutionRunning24h: taskExecutionZombieRows,
      smolabTaskRunning30m: smolabZombieRows,
      goalLoopJobRunning15m: goalLoopZombieRows,
      details: [
        { table: 'AgentRunRecord (running >6h)', count: agentRunZombieRows, oldest: null },
        { table: 'TaskExecution (running >24h)', count: taskExecutionZombieRows, oldest: null },
        { table: 'SmolabTask (running >30m)', count: smolabZombieRows, oldest: null },
        { table: 'GoalLoopJob (running >15m heartbeat)', count: goalLoopZombieRows, oldest: null },
      ],
    }

    // (c) Memory mirror drift — Episode/Lesson SQLite vs Neo4j
    const [episodeMirrorCount, lessonMirrorCount, graphCounts, graphLessons] = await Promise.all([
      countEpisodeRecords(),
      countLessonRecords(),
      getEpisodicGraphCounts(),
      getAllLessonNodes(500),
    ])
    const episodeGraphCount = graphCounts?.episodes ?? 0
    const lessonGraphCount = graphLessons.length > 0 ? graphLessons.length : (graphCounts?.lessons ?? 0)
    const episodeDriftPct = episodeGraphCount > 0
      ? Math.max(0, ((episodeGraphCount - episodeMirrorCount) / episodeGraphCount) * 100)
      : 0
    const lessonDriftPct = lessonGraphCount > 0
      ? Math.max(0, ((lessonGraphCount - lessonMirrorCount) / lessonGraphCount) * 100)
      : 0

    // (d) Learning system health
    let learning = {
      autoLearn: { total: 0, completed: 0, failed: 0, pending: 0, failedIn24h: 0, pendingStuck24h: 0 },
      pendingWriteback: 0,
      lessonsNeedReview: 0,
    }
    try {
      const stats = await getAutoLearnStats()
      // Failed trong 24h — query trực tiếp vì getAutoLearnStats không expose window
      let failedIn24h = 0
      try {
        failedIn24h = await db.autoLearnRecord.count({
          where: { status: 'failed', createdAt: { gte: now24h } },
        })
      } catch { /* skip */ }
      let pendingStuck24h = 0
      try {
        pendingStuck24h = await db.autoLearnRecord.count({
          where: { status: 'pending', createdAt: { lt: now24h } },
        })
      } catch { /* skip */ }
      const pendingWritebackCount = await db.pendingWriteback.count({ where: { status: 'pending' } }).catch(() => 0)
      const lessonsNeedReview = await db.lessonRecord.count({ where: { needsReview: true } }).catch(() => 0)
      learning = {
        autoLearn: {
          total: stats.totalRecords,
          completed: stats.completedRecords,
          failed: stats.failedRecords,
          pending: stats.pendingRecords,
          failedIn24h,
          pendingStuck24h,
        },
        pendingWriteback: pendingWritebackCount,
        lessonsNeedReview,
      }
    } catch (err) {
      console.warn('[ALISTA][collector:database-system] learning health partial fail:', err instanceof Error ? err.message : String(err))
    }

    // (e) KnowledgeGraph sync drift
    let kgSync = { unsyncedResolvedEntities: 0, rawBufferSize: 0, graphEntityCount: 0, bufferToGraphRatio: 0 }
    try {
      const [unsynced, rawBuffer] = await Promise.all([
        db.localResolvedEntity.count({ where: { synced: false } }).catch(() => 0),
        db.localEntity.count().catch(() => 0),
      ])
      const graphEntityCount = episodeGraphCount > 0 ? 0 : 0 // Placeholder — sẽ lấy từ ⑤
      // Note: graphEntityCount lấy từ collector ⑤ (Neo4j nodeCount) — collector ⑦
      // không có context đó nên ghi 0 + để rule quyết trên ⑤ thay (rule ⑦-e
      // KHÔNG trigger nếu graphEntityCount=0, chỉ trigger trên unsynced)
      kgSync = {
        unsyncedResolvedEntities: unsynced,
        rawBufferSize: rawBuffer,
        graphEntityCount,
        bufferToGraphRatio: graphEntityCount > 0 ? rawBuffer / graphEntityCount : 0,
      }
    } catch (err) {
      console.warn('[ALISTA][collector:database-system] kgSync partial fail:', err instanceof Error ? err.message : String(err))
    }

    // (f) Token anomaly — DailyTokenByAgent 7d + hôm nay
    let tokenAnomaly = { agentsWithSpike: [], agentsWithDrop: [] } as DatabaseSystemData['tokenAnomaly']
    try {
      // Lấy 8 ngày gần nhất (today + 7 ngày trước) — groupBy agentName+date
      const since7d = new Date(now - 7 * 24 * 3600_000)
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
      const rows = await db.dailyTokenByAgent.findMany({
        where: { date: { gte: since7d.toISOString().slice(0, 10) } },
        select: { agentName: true, date: true, tokens: true },
      })
      // Group by agentName: today vs 7d mean+stddev
      const byAgent = new Map<string, { today: number; history: number[] }>()
      for (const r of rows) {
        const agg = byAgent.get(r.agentName) ?? { today: 0, history: [] as number[] }
        if (r.date === todayStr) agg.today = r.tokens
        else if (r.date < todayStr) agg.history.push(r.tokens)
        byAgent.set(r.agentName, agg)
      }
      const spikeAgents: DatabaseSystemData['tokenAnomaly']['agentsWithSpike'] = []
      const dropAgents: DatabaseSystemData['tokenAnomaly']['agentsWithDrop'] = []
      for (const [agentName, agg] of byAgent) {
        if (agg.history.length < 3) continue // quá ít dữ liệu
        const mean = agg.history.reduce((s, v) => s + v, 0) / agg.history.length
        const variance = agg.history.reduce((s, v) => s + (v - mean) ** 2, 0) / agg.history.length
        const stddev = Math.sqrt(variance)
        if (stddev > 0 && agg.today > mean + 3 * stddev) {
          const zScore = (agg.today - mean) / stddev
          spikeAgents.push({ agentName, today: agg.today, mean7d: Math.round(mean), stddev: Math.round(stddev), zScore: Math.round(zScore * 10) / 10 })
        } else if (mean > 1000 && agg.today < mean * 0.1) {
          dropAgents.push({ agentName, today: agg.today, mean7d: Math.round(mean) })
        }
      }
      tokenAnomaly = { agentsWithSpike: spikeAgents, agentsWithDrop: dropAgents }
    } catch (err) {
      console.warn('[ALISTA][collector:database-system] tokenAnomaly fail:', err instanceof Error ? err.message : String(err))
    }

    // (g) DB size & storage
    let dbStorage = { sqliteBytes: 0, tableRowCounts: {} as Record<string, number>, largeTables: [] as Array<{ table: string; rows: number }> }
    try {
      const dbPath = path.join(process.cwd(), 'db', 'custom.db')
      const stat = await fsP.stat(dbPath).catch(() => null)
      if (stat) dbStorage.sqliteBytes = stat.size

      // Đếm row các bảng lớn — raw SQL count (cheap)
      const tables = ['Document', 'LocalEntity', 'LocalRelationship', 'AgentRunRecord', 'ToolMetric', 'ChatMessage', 'AutoLearnRecord', 'PendingWriteback', 'EpisodeRecord', 'LessonRecord']
      const counts = await Promise.all(tables.map(async (t) => {
        try {
          const rows = await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) AS n FROM ${t}`)
          return { table: t, rows: Number(rows[0]?.n ?? 0) }
        } catch {
          return { table: t, rows: 0 } // Bảng không tồn tại hoặc lỗi khác
        }
      }))
      for (const c of counts) dbStorage.tableRowCounts[c.table] = c.rows
      dbStorage.largeTables = counts.filter(c => c.rows > 100_000).sort((a, b) => b.rows - a.rows)
    } catch (err) {
      console.warn('[ALISTA][collector:database-system] dbStorage fail:', err instanceof Error ? err.message : String(err))
    }

    return {
      schemaDrift,
      zombies,
      memoryDrift: {
        episodeMirrorCount,
        episodeGraphCount,
        episodeDriftPct,
        lessonMirrorCount,
        lessonGraphCount,
        lessonDriftPct,
        neo4jReachable: episodeGraphCount > 0 || lessonGraphCount > 0,
      },
      learning,
      kgSync,
      tokenAnomaly,
      dbStorage,
    }
  })
}

// ==================== MAIN ENTRY (dùng trong comprehensive-check) ====================

export interface AllCollectorResults {
  tools?: CollectorResult<ToolsHealthData>
  agentRuns?: CollectorResult<AgentRunsData>
  escalations?: CollectorResult<EscalationsData>
  domainCoverage?: CollectorResult<DomainCoverageData>
  threeLayers?: CollectorResult<ThreeLayersData>
  selfAssessment?: CollectorResult<SelfAssessmentData>
  databaseSystem?: CollectorResult<DatabaseSystemData>
}

/** Helper trích previousSnapshot cho collector ⑤ từ TaskExecution gần nhất */
export async function getPreviousSnapshot(): Promise<ThreeLayersData['previousSnapshot'] | undefined> {
  try {
    const recent = await db.taskExecution.findFirst({
      where: { type: 'alista-check', status: 'completed' },
      orderBy: { startedAt: 'desc' },
      select: { result: true, startedAt: true },
    })
    if (!recent?.result) return undefined
    const parsed = JSON.parse(recent.result) as { steps?: Array<{ id: number; collected?: { data?: { qdrant?: { vectorsIndexed: number }, neo4j?: { nodeCount?: number, relCount?: number } } } }> }
    const layerStep = parsed.steps?.find(s => s.id === 5)
    const data = layerStep?.collected?.data
    if (!data) return undefined
    return {
      runAt: recent.startedAt.toISOString(),
      qdrantVectors: data.qdrant?.vectorsIndexed ?? null,
      neo4jNodes: data.neo4j?.nodeCount ?? null,
      neo4jRels: data.neo4j?.relCount ?? null,
    }
  } catch {
    return undefined
  }
}

/** Type-guard đơn giản — tìm Finding trong perCheck để ⑥ dùng */
export function _typeGuardFinding(): Finding | null { return null }
