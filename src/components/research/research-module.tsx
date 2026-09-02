'use client'

/**
 * ResearchModule — P8 UI container (Task S7-P8)
 * =================================================================
 * Spec:
 *  - TB-13 §2.2 — UI container render 4 sub-tab (Missions / Proposals / KB / Escalations).
 *  - TB-13 §5 — Health badge (built=X/16) — fetch /api/research/health.
 *
 * Behavior:
 *  - Mount → fetch health (5s timeout, fail-open → "?/16").
 *  - Tabs switch — mỗi tab render 1 component con (KHÔNG fetch data cha → con tự fetch).
 *  - Responsive: mobile stack, desktop grid (sidebar-like trên mobile).
 *
 * Fail-open: lỗi fetch health → badge "?/16" vàng + tooltip lỗi. KHÔNG crash.
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  FlaskConical,
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react'
import { MissionList } from './mission-list'
import { ProposalReview } from './proposal-review'
import { KbBrowser } from './kb-browser'

// ==================== Types (mirror API contract) ====================

interface HealthRegistryEntry {
  path: string
  phase: string
  spec: string
  status: string
}

interface HealthResponse {
  status: string
  service: string
  phase: string
  gate: { p0Passed: boolean; description: string }
  db: { ok: boolean; researchTables: { ok: boolean; expected: number; found: string[]; missing: string[] }; kb: { ok: boolean; entries: number; note: string } }
  nim: { ok: boolean; provider: string; keys: { total: number; available: number; quotaExhausted: number }; modelStack: string[]; primaryModel: string; fallbackChain: string[]; kimiK3Enforced: boolean }
  roster: { id: string; position: string; jd: string }[]
  operationalConstants: Record<string, unknown>
  modules: { total: number; built: number; planned: number; registry: HealthRegistryEntry[] }
  timestamp: string
}

// ==================== Component ====================

export function ResearchModule() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'missions' | 'proposals' | 'kb' | 'escalations'>('missions')

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    setHealthError(null)
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch('/api/research/health', { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as HealthResponse
      setHealth(data)
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err))
      setHealth(null)
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void fetchHealth())
  }, [fetchHealth])

  const built = health?.modules?.built ?? '?'
  const total = health?.modules?.total ?? 16
  const dbOk = health?.db?.ok ?? false
  const nimOk = health?.nim?.ok ?? false

  return (
    <div className="w-full flex flex-col gap-4 px-4 py-4">
      {/* Header — title + health badge */}
      <Card className="bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/15 border border-violet-400/30 flex-shrink-0">
                <FlaskConical className="h-5 w-5 text-violet-300" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base font-semibold text-stone-100 truncate">
                  🔬 Research Team
                </CardTitle>
                <p className="text-[11px] text-stone-400 truncate">
                  KING · SIVIL · BELI · LISMA · HAN — 5-agent research pipeline (TB-01..14)
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={`gap-1.5 border ${
                  healthLoading
                    ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                    : health
                      ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                      : 'border-red-500/40 text-red-300 bg-red-500/10'
                }`}
                title={healthError ? `Health check failed: ${healthError}` : 'Modules BUILT'}
              >
                {healthLoading ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : health ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                <span className="tabular-nums">
                  {built}/{total} modules
                </span>
              </Badge>
              <Badge
                variant="outline"
                className={`gap-1.5 border ${
                  dbOk
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-stone-700 text-stone-400 bg-stone-800/50'
                }`}
              >
                DB {dbOk ? 'OK' : '?'}
              </Badge>
              <Badge
                variant="outline"
                className={`gap-1.5 border ${
                  nimOk
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-stone-700 text-stone-400 bg-stone-800/50'
                }`}
                title={health?.nim ? `keys ${health.nim.keys.available}/${health.nim.keys.total} · primary ${health.nim.primaryModel}` : 'NIM unknown'}
              >
                NIM {nimOk ? 'OK' : '?'}
              </Badge>
              <button
                onClick={() => void fetchHealth()}
                disabled={healthLoading}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-700 text-stone-400 hover:text-stone-200 hover:border-stone-600 transition-colors disabled:opacity-50"
                title="Refresh health"
                aria-label="Refresh health"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${healthLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {healthError && (
            <Alert variant="destructive" className="mb-3 bg-red-950/40 border-red-500/40">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Health check failed (fail-open)</AlertTitle>
              <AlertDescription className="text-xs">
                Lỗi: {healthError}. UI vẫn hoạt động — dữ liệu sẽ fetch khi API sẵn sàng.
              </AlertDescription>
            </Alert>
          )}
          {health && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-[10px] text-stone-400">
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">Tables</div>
                <div className="text-stone-300 font-medium">
                  {health.db.researchTables.found.length}/{health.db.researchTables.expected}
                </div>
              </div>
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">KB entries</div>
                <div className="text-stone-300 font-medium">{health.db.kb.entries}</div>
              </div>
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">NIM keys</div>
                <div className="text-stone-300 font-medium">
                  {health.nim.keys.available}/{health.nim.keys.total}
                </div>
              </div>
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">Primary</div>
                <div className="text-stone-300 font-medium truncate" title={health.nim.primaryModel}>
                  {health.nim.primaryModel.split('/').pop()}
                </div>
              </div>
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">Roster</div>
                <div className="text-stone-300 font-medium">
                  {health.roster.length} agents
                </div>
              </div>
              <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                <div className="text-stone-500 uppercase tracking-wide">P0 gate</div>
                <div className={`font-medium ${health.gate.p0Passed ? 'text-emerald-300' : 'text-red-300'}`}>
                  {health.gate.p0Passed ? 'PASSED' : 'FAIL'}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs — 4 sub-panels */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="w-full">
        <TabsList className="bg-stone-900/70 border border-stone-800 grid grid-cols-4 w-full max-w-xl h-auto">
          <TabsTrigger
            value="missions"
            className="data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400 text-xs"
          >
            Missions
          </TabsTrigger>
          <TabsTrigger
            value="proposals"
            className="data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400 text-xs"
          >
            Proposals
          </TabsTrigger>
          <TabsTrigger
            value="kb"
            className="data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400 text-xs"
          >
            KB
          </TabsTrigger>
          <TabsTrigger
            value="escalations"
            className="data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400 text-xs"
          >
            Escalations
          </TabsTrigger>
        </TabsList>

        <TabsContent value="missions" className="mt-4">
          <MissionList />
        </TabsContent>
        <TabsContent value="proposals" className="mt-4">
          <ProposalReview />
        </TabsContent>
        <TabsContent value="kb" className="mt-4">
          <KbBrowser />
        </TabsContent>
        <TabsContent value="escalations" className="mt-4">
          <EscalationQueue />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ==================== Escalation Queue (inline — small component) ====================
// Defined here to keep file count manageable — escalations endpoint is simple GET-only.

interface EscalationRow {
  missionId: string
  escalatedAt: string
  reason: string
  escalateTo: string
  timeoutHours: number
  remindHours: number
  status: string
  remindersSent: number
  resolvedAt: string | null
  resolvedBy: string | null
}

interface EscalationsResponse {
  status: string
  escalations: EscalationRow[]
  total: number
  filter: { status: string | null; missionId: string | null }
}

function EscalationQueue() {
  const [data, setData] = useState<EscalationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/research/escalations?limit=50')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as EscalationsResponse
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void fetchData())
  }, [fetchData])

  return (
    <Card className="bg-stone-950/70 border-stone-800 text-stone-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-amber-400" />
            Escalation Queue
            {data && (
              <Badge variant="outline" className="text-[10px] border-stone-700 text-stone-400">
                {data.total}
              </Badge>
            )}
          </CardTitle>
          <button
            onClick={() => void fetchData()}
            className="text-[11px] text-stone-400 hover:text-stone-200 inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-xs text-stone-500 italic">Loading…</div>
        ) : error ? (
          <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">Lỗi fetch: {error}</AlertDescription>
          </Alert>
        ) : !data || data.escalations.length === 0 ? (
          <div className="text-xs text-stone-500 italic py-6 text-center">
            Không có escalation nào.
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <div className="space-y-2 pr-2">
              {data.escalations.map((row, idx) => (
                <div
                  key={`${row.missionId}-${idx}`}
                  className="rounded-md border border-stone-800 bg-stone-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <Badge
                      variant="outline"
                      className={`text-[10px] border ${
                        row.status === 'RESOLVED'
                          ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                          : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                      }`}
                    >
                      {row.status}
                    </Badge>
                    <span className="text-[10px] text-stone-500">
                      → {row.escalateTo} · {row.timeoutHours}h timeout
                    </span>
                  </div>
                  <div className="text-[10px] text-stone-400 mb-1">
                    Mission: <code className="text-stone-300">{row.missionId.slice(-12)}</code>
                  </div>
                  <div className="text-xs text-stone-300 mb-1.5">{row.reason}</div>
                  <div className="text-[10px] text-stone-500 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>⏱ {row.escalatedAt.slice(0, 19).replace('T', ' ')}</span>
                    <span>Reminders sent: {row.remindersSent}</span>
                    {row.resolvedAt && (
                      <span>
                        Resolved by <code className="text-stone-400">{row.resolvedBy}</code>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

export { ResearchModule as default }
