'use client'

/**
 * Runtime Metrics Panel — Task 20-b + ALISTA v1.1
 *
 * Panel giám sát real-time tập trung (mount trong tab Analytics của page.tsx):
 *   - Token burn hôm nay (DailyTokenByAgent — tổng + input/output + top agents)
 *   - Tool health 24h (ToolMetric — total calls, success rate, avg duration,
 *     bảng tool tệ nhất kèm topErrorTag)
 *   - Agent runs 24h (AgentRunRecord — total/no-progress/failed + 10 runs gần
 *     nhất với stopReason badge màu)
 *   - Banner alerts (stuck loops / tool failures)
 *
 * v1.1 — ALISTA range picker: khi prop `analyticsRange` được set, panel chuyển
 * sang chế độ lịch sử: fetch 1 lần với ?from=&to=, DỪNG poll 10s, hiển thị badge
 * "📜 Đang xem DD/MM → DD/MM". Khi range = null → poll 10s live như cũ.
 *
 * Fail-open toàn bộ: endpoint lỗi/timeout → hiển thị "—", KHÔNG crash panel.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw, Activity, Wrench, ListChecks, AlertTriangle, Flame, Gauge, History } from 'lucide-react'

// ==================== Types (mirror /api/metrics/overview) ====================

interface OverviewData {
  generatedAt: string
  period: { hours: number }
  tokens: {
    total: number
    input: number
    output: number
    byAgent: Array<{ agentName: string; tokens: number; input: number; output: number }>
  }
  tools: {
    totalCalls: number
    successRate: number
    avgDurationMs: number
    topFailures: Array<{ toolName: string; errors: number; topErrorTag: string | null }>
  }
  runs: {
    total: number
    active: number
    completed: number
    failed: number
    noProgress: number
    byStopReason: Record<string, number>
    recentRuns: Array<{
      id: string
      sessionId: string
      agentName: string | null
      status: string | null
      stopReason: string | null
      cycles: number | null
      tokensUsed: number | null
      toolCalls: number | null
      toolFailures: number | null
      durationMs: number | null
      evaluatorConfidence: number | null
      complete: boolean | null
      startedAt: string | null
      completedAt: string | null
      createdAt: string | null
    }>
  }
  alerts: Array<{ severity: 'high' | 'medium'; type: string; message: string }>
}

// ==================== Helpers ====================

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('vi-VN')
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—'
  return `${Math.round(rate * 100)}%`
}

/** Màu badge theo stopReason — KHÔNG dùng indigo/blue */
function stopReasonBadge(reason: string | null): { label: string; className: string } {
  switch (reason) {
    case 'complete':
      return { label: 'complete', className: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50' }
    case 'no_progress':
      return { label: 'no_progress', className: 'bg-amber-950/60 text-amber-400 border-amber-500/50' }
    case 'error':
    case 'failed':
      return { label: reason, className: 'bg-rose-950/60 text-rose-400 border-rose-500/50' }
    case 'cancelled':
      return { label: 'cancelled', className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
    case 'max_cycles':
    case 'time_budget':
    case 'token_budget':
      return { label: reason, className: 'bg-orange-950/60 text-orange-400 border-orange-500/50' }
    // TASK 48 — needs_input: kết thúc CÓ MỤC ĐÍCH chờ user trả lời (không phải
    // lỗi/xám trung tính) — teal phân biệt với budget (orange) và fail (rose).
    case 'needs_input':
      return { label: 'needs_input', className: 'bg-teal-950/60 text-teal-400 border-teal-500/50' }
    default:
      return { label: reason || '—', className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
  }
}

// ==================== Component ====================

const POLL_INTERVAL_MS = 10_000

interface RuntimeMetricsPanelProps {
  /** v1.1 — ALISTA: null = poll live 24h (default), {from,to} = chế độ lịch sử */
  analyticsRange?: { from: string; to: string } | null
}

export function RuntimeMetricsPanel({ analyticsRange }: RuntimeMetricsPanelProps = {}) {
  const rangeActive = !!analyticsRange
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      // v1.1: range mode dùng ?from=&to= thay cho ?hours=24
      const url = analyticsRange
        ? `/api/metrics/overview?from=${encodeURIComponent(analyticsRange.from)}&to=${encodeURIComponent(analyticsRange.to)}`
        : '/api/metrics/overview?hours=24'
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as OverviewData
      setData(json)
      setError(false)
      setLastUpdated(new Date().toLocaleTimeString('vi-VN'))
    } catch {
      // Fail-open — giữ dữ liệu cũ (nếu có), đánh dấu error để hiển thị "—"
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [analyticsRange?.from, analyticsRange?.to])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (cancelled) return
      await fetchData()
    }
    void poll()
    // v1.1: range mode DỪNG poll (chỉ fetch 1 lần khi range thay đổi).
    // Live mode: poll 10s như cũ.
    let interval: ReturnType<typeof setInterval> | null = null
    if (!rangeActive) {
      interval = setInterval(poll, POLL_INTERVAL_MS)
    }
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [fetchData, rangeActive])

  const tokens = data?.tokens
  const tools = data?.tools
  const runs = data?.runs
  const alerts = data?.alerts || []

  return (
    <div className="space-y-4">
      {/* Alerts banner */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a, i) => (
            <div
              key={`${a.type}-${i}`}
              className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
                a.severity === 'high'
                  ? 'bg-rose-950/40 border-rose-500/55 text-rose-300'
                  : 'bg-amber-950/40 border-amber-500/55 text-amber-300'
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>
                <span className="font-semibold uppercase tracking-wide">{a.severity}</span>
                {' · '}
                {a.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 3 stat groups */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ===== Token burn hôm nay ===== */}
        <Card className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-amber-950/50">
                <Flame className="h-4 w-4 text-amber-400" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-stone-100">Token burn hôm nay</span>
            </div>
            <span className="text-[10px] text-stone-500">DailyTokenByAgent</span>
          </div>
          {loading ? (
            <SkeletonBlock />
          ) : error && !tokens ? (
            <ErrorText />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <MiniStat label="Tổng" value={fmtNum(tokens?.total)} tone="amber" />
                <MiniStat label="Input" value={fmtNum(tokens?.input)} tone="stone" />
                <MiniStat label="Output" value={fmtNum(tokens?.output)} tone="stone" />
              </div>
              {tokens && tokens.byAgent.length > 0 ? (
                <div className="space-y-1.5">
                  {tokens.byAgent.map(a => (
                    <div key={a.agentName} className="flex items-center justify-between text-xs">
                      <span className="text-stone-300 truncate max-w-[55%]">{a.agentName}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 rounded-full bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-amber-600 to-orange-500"
                            style={{
                              width: `${tokens.total > 0 ? Math.max(3, Math.round((a.tokens / tokens.total) * 100)) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-stone-100 font-mono tabular-nums">{fmtNum(a.tokens)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-stone-500">Chưa tốn token hôm nay</p>
              )}
            </>
          )}
        </Card>

        {/* ===== Tool health 24h ===== */}
        <Card className="nc-panel nc-sm nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-teal-950/50">
                <Wrench className="h-4 w-4 text-teal-400" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-stone-100">
                {rangeActive ? `Tool health (${analyticsRange?.from} → ${analyticsRange?.to})` : 'Tool health (24h)'}
              </span>
            </div>
            <span className="text-[10px] text-stone-500">ToolMetric</span>
          </div>
          {loading ? (
            <SkeletonBlock />
          ) : error && !tools ? (
            <ErrorText />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <MiniStat label="Calls" value={fmtNum(tools?.totalCalls)} tone="teal" />
                <MiniStat label="Success" value={fmtPct(tools?.successRate)} tone={tools && tools.successRate >= 0.8 ? 'emerald' : 'amber'} />
                <MiniStat label="Avg dur" value={fmtDuration(tools?.avgDurationMs)} tone="stone" />
              </div>
              {tools && tools.topFailures.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-stone-500">Tool tệ nhất</p>
                  {tools.topFailures.map(f => (
                    <div key={f.toolName} className="text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-stone-300 truncate max-w-[45%] font-mono">{f.toolName}</span>
                        <span className="text-rose-400 font-mono tabular-nums">{fmtNum(f.errors)} lỗi</span>
                      </div>
                      {f.topErrorTag && (
                        <p className="text-[10px] text-stone-500 truncate" title={f.topErrorTag}>
                          ↳ {f.topErrorTag}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-stone-500">Không có tool fail trong 24h — mọi thứ khỏe</p>
              )}
            </>
          )}
        </Card>

        {/* ===== Agent runs 24h ===== */}
        <Card className="nc-panel nc-sm nc-border-rose p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-rose-950/50">
                <ListChecks className="h-4 w-4 text-rose-400" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-stone-100">
                {rangeActive ? `Agent runs (${analyticsRange?.from} → ${analyticsRange?.to})` : 'Agent runs (24h)'}
              </span>
            </div>
            <span className="text-[10px] text-stone-500">AgentRunRecord</span>
          </div>
          {loading ? (
            <SkeletonBlock />
          ) : error && !runs ? (
            <ErrorText />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <MiniStat label="Runs" value={fmtNum(runs?.total)} tone="stone" />
                <MiniStat label="No-progress" value={fmtNum(runs?.noProgress)} tone={(runs?.noProgress || 0) > 0 ? 'amber' : 'stone'} />
                <MiniStat label="Failed" value={fmtNum(runs?.failed)} tone={(runs?.failed || 0) > 0 ? 'rose' : 'stone'} />
              </div>
              {runs && runs.recentRuns.length > 0 ? (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {runs.recentRuns.map(r => {
                    const badge = stopReasonBadge(r.stopReason)
                    return (
                      <div key={r.id} className="flex items-center gap-1.5 text-xs">
                        <span className="text-stone-300 truncate max-w-[30%]">{r.agentName || '—'}</span>
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${badge.className}`}>
                          {badge.label}
                        </Badge>
                        <span className="text-stone-500 text-[10px] ml-auto flex-shrink-0">
                          {fmtTime(r.createdAt || r.startedAt)} · {r.toolCalls ?? '—'} tools · {fmtDuration(r.durationMs)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-stone-500">Chưa có run nào kết thúc trong 24h</p>
              )}
            </>
          )}
        </Card>
      </div>

      {/* Footer — poll status */}
      <div className="flex items-center justify-between text-[10px] text-stone-500 px-1">
        <span className="flex items-center gap-1">
          <Gauge className="h-3 w-3" />
          {rangeActive
            ? `Nguồn: /api/metrics/overview?from=${analyticsRange?.from}&to=${analyticsRange?.to} — chế độ lịch sử (1 lần fetch, không poll)`
            : 'Nguồn: /api/metrics/overview (ToolMetric + DailyTokenByAgent + AgentRunRecord) — v1: tokens/run chờ task 20-c'}
        </span>
        <span className="flex items-center gap-1.5">
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> đang tải…
            </>
          ) : rangeActive ? (
            <>
              <History className="h-3 w-3" />
              đang xem lịch sử · cập nhật {lastUpdated || '—'}
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3" />
              {error ? 'lỗi fetch — giữ dữ liệu cũ (fail-open)' : `cập nhật ${lastUpdated || '—'} · poll 10s`}
            </>
          )}
        </span>
      </div>
    </div>
  )
}

// ==================== Small sub-components ====================

function MiniStat({ label, value, tone }: { label: string; value: string; tone: 'amber' | 'teal' | 'rose' | 'emerald' | 'stone' }) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-300'
      : tone === 'teal'
        ? 'text-teal-300'
        : tone === 'rose'
          ? 'text-rose-300'
          : tone === 'emerald'
            ? 'text-emerald-300'
            : 'text-stone-200'
  return (
    <div className="rounded-lg bg-stone-950/60 border border-stone-800/80 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wide text-stone-500">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}

function SkeletonBlock() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="grid grid-cols-3 gap-2">
        <div className="h-10 rounded-lg bg-stone-900/80" />
        <div className="h-10 rounded-lg bg-stone-900/80" />
        <div className="h-10 rounded-lg bg-stone-900/80" />
      </div>
      <div className="h-4 rounded bg-stone-900/60 w-3/4" />
      <div className="h-4 rounded bg-stone-900/40 w-2/3" />
    </div>
  )
}

function ErrorText() {
  return (
    <div className="flex items-center gap-2 text-xs text-stone-500">
      <Activity className="h-3.5 w-3.5" />
      <span>Không tải được metrics — hiển thị "—" (fail-open, sẽ thử lại sau 10s)</span>
    </div>
  )
}
