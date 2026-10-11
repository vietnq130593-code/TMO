/**
 * NEURAL-ARCHITECTURE API — phục tab "Kiến trúc Neural" (module Database)
 * ======================================================================
 *
 * GET  → đồ thị 6 lớp + trạng thái 13 tham số runtime + số liệu sống từng
 *        node (mỗi phép đếm fail-open độc lập — 1 lỗi không làm sập cả map)
 *        + top-Q advice + SAL gần nhất.
 * POST → action=set (body {key, value}) | action=reset (body {key}) —
 *        validate theo TUNING_SPECS (ngoài phạm vi / sai type → 400), ghi
 *        Prisma TuningParam, consumer cùng process thấy tức thì qua
 *        snapshot (chuỗi hiệu lực STORE > ENV > DEFAULT).
 *
 * Nhẹ cho SQLite: toàn bộ là count/findMany take nhỏ trên bảng đã có index;
 * KHÔNG $transaction (bài học BUG2-119 — giữ lock làm socket timeout lan).
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { NEURAL_GRAPH } from '@/lib/learning/neural-types'
import {
  getTuningState,
  setTuningValue,
  resetTuningValue,
  getTuningChangeLog,
  TuningValidationError,
} from '@/lib/learning/tuning-store'
import {
  qEntryCount,
  getTopQAdvice,
  agentRuntimeStateKey,
  type QAdviceEntry,
} from '@/lib/learning/q-table'

export const dynamic = 'force-dynamic'

interface LiveEntry {
  label: string
  value: string
}

type LiveMap = Record<string, LiveEntry[]>

const viNum = (n: number): string => n.toLocaleString('vi-VN')

/** Đếm an toàn — lỗi → null (node bỏ qua dòng số liệu, không sập response). */
async function safeCount(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

/** Số liệu sống cho một node — mỗi nguồn độc lập fail-open. */
async function liveForNode(nodeId: string, qTop: QAdviceEntry[]): Promise<[string, LiveEntry[]]> {
  const entries: LiveEntry[] = []
  const push = (label: string, n: number | null) => {
    if (n !== null) entries.push({ label, value: viNum(n) })
  }
  switch (nodeId) {
    case 'doc-upload':
      push('Tài liệu', await safeCount(() => db.document.count()))
      break
    case 'chat':
      push('Tin nhắn', await safeCount(() => db.chatMessage.count()))
      break
    case 'goal-loop':
      push('Goal jobs', await safeCount(() => db.goalLoopJob.count()))
      break
    case 'workflow':
      push('Phiên workflow', await safeCount(() => db.workflowSession.count()))
      break
    case 'chunk-embed':
      push('Embedding cache', await safeCount(() => db.embeddingCache.count()))
      break
    case 'entity-res':
      push('Thực thể hợp nhất', await safeCount(() => db.localResolvedEntity.count()))
      break
    case 'sqlite': {
      try {
        // Tagged template Prisma — bảng hệ thống SQLite, không input user
        const rows = await db.$queryRaw<Array<{ n: number | bigint }>>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`
        const n = Number(rows[0]?.n ?? 0)
        if (Number.isFinite(n)) entries.push({ label: 'Bảng dữ liệu', value: viNum(n) })
      } catch { /* fail-open */ }
      break
    }
    case 'q-table': {
      const stats = await qEntryCount()
      if (stats.entries > 0 || stats.totalVisits > 0) {
        entries.push({ label: 'Q entries', value: viNum(stats.entries) })
        entries.push({ label: 'Tổng visits', value: viNum(stats.totalVisits) })
      } else {
        entries.push({ label: 'Q entries', value: '0 (chưa học)' })
      }
      break
    }
    case 'adaptation': {
      const total = await safeCount(() => db.strategyAdaptationLog.count())
      push('SAL tổng', total)
      const pending = await safeCount(() => db.strategyAdaptationLog.count({ where: { successful: null } }))
      push('Chưa chốt', pending)
      break
    }
    case 'lessons':
      push('Lessons', await safeCount(() => db.lessonRecord.count()))
      push('Episodes', await safeCount(() => db.episodeRecord.count()))
      break
    case 'hist-feedback':
      push('Run records', await safeCount(() => db.agentRunRecord.count()))
      break
    case 'anomaly':
      push('Anomaly 24h', await safeCount(() =>
        db.metricAnomaly.count({ where: { observedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
      ))
      break
    case 'llm-call': {
      try {
        const latest = await db.dailyTokenUsage.findFirst({ orderBy: { date: 'desc' }, select: { date: true, tokens: true } })
        if (latest) entries.push({ label: `Token ${latest.date}`, value: viNum(latest.tokens) })
      } catch { /* fail-open */ }
      break
    }
    case 'agent-response':
      push('Verdicts trọng tài', await safeCount(() => db.arbiterVerdict.count()))
      break
    case 'q-advice':
      entries.push({
        label: 'Top-Q',
        value: qTop[0] ? `${qTop[0].action} (Q=${qTop[0].q.toFixed(2)}, ${qTop[0].visits} lần)` : '— chưa có dữ liệu',
      })
      break
    default:
      break // storage khác (qdrant/neo4j/r2) — section ghép từ /api/health client-side
  }
  return [nodeId, entries]
}

export async function GET() {
  try {
    const [tuning, qTop] = await Promise.all([
      getTuningState(),
      getTopQAdvice(agentRuntimeStateKey(), 5).catch((): QAdviceEntry[] => []),
    ])

    const liveEntries = await Promise.all(
      NEURAL_GRAPH.nodes.map(n => liveForNode(n.id, qTop)),
    )
    const live: LiveMap = {}
    for (const [nodeId, entries] of liveEntries) {
      if (entries.length > 0) live[nodeId] = entries
    }

    let salRecent: Array<{
      id: string
      fromStrategy: string
      toStrategy: string
      reason: string
      confidence: number | null
      successful: boolean | null
      createdAt: Date
    }> = []
    try {
      salRecent = await db.strategyAdaptationLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          fromStrategy: true,
          toStrategy: true,
          reason: true,
          confidence: true,
          successful: true,
          createdAt: true,
        },
      })
    } catch { /* fail-open */ }

    return NextResponse.json({
      graph: NEURAL_GRAPH,
      tuning,
      live,
      qTop,
      salRecent,
      changeLog: await getTuningChangeLog(10),
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[NeuralArch] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không tải được kiến trúc neural', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let body: { action?: string; key?: string; value?: string | number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON không hợp lệ' }, { status: 400 })
  }
  const { action, key } = body
  if (typeof key !== 'string' || key.trim() === '') {
    return NextResponse.json({ error: 'Thiếu key tham số' }, { status: 400 })
  }
  try {
    if (action === 'set') {
      const entry = await setTuningValue(key, body.value)
      return NextResponse.json({
        ok: true,
        entry,
        tuning: await getTuningState(),
        changeLog: await getTuningChangeLog(10),
      })
    }
    if (action === 'reset') {
      const entry = await resetTuningValue(key)
      return NextResponse.json({
        ok: true,
        entry,
        tuning: await getTuningState(),
        changeLog: await getTuningChangeLog(10),
      })
    }
    return NextResponse.json({ error: `action không hỗ trợ: ${String(action)} (set | reset)` }, { status: 400 })
  } catch (err) {
    if (err instanceof TuningValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[NeuralArch] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Ghi tham số thất bại', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
