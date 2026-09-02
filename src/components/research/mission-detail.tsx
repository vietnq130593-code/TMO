'use client'

/**
 * MissionDetail — P8 UI (Task S7-P8)
 * =================================================================
 * Spec:
 *  - TB-13 §2.2 — Mission detail (decision log + changelog + tasks) + actions.
 *  - TB-02 §7 — Status flow: CLASSIFY → TRIAGING → DECOMPOSING → RESEARCHING
 *    → MONITORING → FINALIZED (+ ESCALATED, PIVOTED).
 *  - TB-06 — KING actions: DECOMPOSE / MONITOR / FINALIZE.
 *
 * Behavior:
 *  - GET /api/research/missions/[id] — fetch mission.
 *  - Action buttons (status-gated):
 *      TRIAGING/DECOMPOSING → "Decompose" (POST /decompose)
 *      RESEARCHING/MONITORING → "Monitor" (POST /monitor)
 *      RESEARCHING/MONITORING/ESCALATED/FINALIZED → "Finalize" (POST /finalize)
 *  - Decision Log (decode decisionLogJson) + Changelog (decode changelogJson).
 *  - Tasks section: API không có list endpoint (chỉ GET /tasks/[id]); show note + link
 *    to worklog-viewer (worklog là luồng chính cho task progress).
 *
 * Fail-open: LLM error → action API trả 200 với result rỗng + escalated=true. UI Alert.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileText,
  GitBranch,
  History,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  XCircle,
} from 'lucide-react'
import { WorklogViewer } from './worklog-viewer'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ==================== Types (mirror API contract) ====================

interface ConfidenceSignals {
  signals: string[]
  conflicts: string[]
  level: 'HIGH' | 'MEDIUM' | 'LOW'
}

interface DecisionLogEntry {
  at: string
  agent: string
  decision: string
  reason: string
  ref?: string
}

interface ChangelogEntry {
  at: string
  field: string
  from: string
  to: string
  reason: string
}

interface Mission {
  id: string
  code: string
  title: string | null
  request: string
  missionType: string
  tier: string
  status: string
  confidenceJson: string
  decisionLogJson: string
  changelogJson: string
  createdAt: string
  updatedAt: string
  confidence?: ConfidenceSignals
  decisionLog?: DecisionLogEntry[]
  changelog?: ChangelogEntry[]
}

interface MissionResponse {
  status: 'ok' | 'error'
  mission?: Mission
  error?: string
}

interface DecomposeResult {
  status: 'ok' | 'error'
  parts?: unknown[]
  council1Verdict?: string
  escalated?: boolean
  worklog?: unknown
  error?: string
}

interface MonitorResult {
  status: 'ok' | 'error'
  worklog?: unknown
  captured?: unknown[]
  pivotTriggered?: boolean
  pivotReason?: string
  error?: string
}

interface FinalizeResult {
  status: 'ok' | 'error'
  finalReport?: string
  proposalItems?: unknown[]
  council4Verdict?: string
  captured?: unknown[]
  error?: string
}

// TASK 3-fix WORK 7f: Run lifecycle result (kingFullLifecycle)
interface RunResult {
  status: 'ok' | 'error'
  mission?: Mission
  finalReport?: string
  parts?: number
  errors?: string[]
  error?: string
}

// TASK 3-fix WORK 7f: Tasks list (was dead-end Alert — now real data)
interface SuccessCriterion {
  id: string
  criterion: string
  measure: string
  met?: boolean
}

interface TaskAmendment {
  at: string
  amendment: string
  reason: string
}

interface ResearchTask {
  id: string
  missionId: string
  partIdx: number
  title: string
  taskMdPath: string
  status: string
  assignedGroup: string | null
  successCriteriaJson: string
  amendmentsJson: string
  createdAt: string
  updatedAt: string
  successCriteria?: SuccessCriterion[]
  amendments?: TaskAmendment[]
}

interface TasksListResponse {
  status: 'ok' | 'error'
  tasks?: ResearchTask[]
  total?: number
  error?: string
}

interface MissionDetailProps {
  missionId: string
}

// ==================== Helpers ====================

const STATUS_COLORS: Record<string, string> = {
  CLASSIFY: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  TRIAGING: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  DECOMPOSING: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  RESEARCHING: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
  MONITORING: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
  FINALIZED: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  ESCALATED: 'border-red-500/40 text-red-300 bg-red-500/10',
  PIVOTED: 'border-yellow-500/40 text-yellow-300 bg-yellow-500/10',
}

function statusBadgeClass(status: string): string {
  return STATUS_COLORS[status] ?? 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function tierBadgeClass(tier: string): string {
  if (!tier) return 'border-stone-700 text-stone-400 bg-stone-800/50'
  if (tier === 'T1') return 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
  if (tier === 'T2') return 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
  if (tier === 'T3') return 'border-amber-500/40 text-amber-300 bg-amber-500/10'
  return 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function mtBadgeClass(missionType: string): string {
  if (missionType === 'M1') return 'border-sky-500/40 text-sky-300 bg-sky-500/10'
  if (missionType === 'M2') return 'border-violet-500/40 text-violet-300 bg-violet-500/10'
  if (missionType === 'M3') return 'border-fuchsia-500/40 text-fuchsia-300 bg-fuchsia-500/10'
  return 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function isFailOpen(confidence?: ConfidenceSignals): boolean {
  if (!confidence || !confidence.conflicts) return false
  return confidence.conflicts.some((c) => c.toLowerCase().includes('llm error'))
}

// ==================== Component ====================

export function MissionDetail({ missionId }: MissionDetailProps) {
  const [mission, setMission] = useState<Mission | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<
    | { kind: 'decompose'; result: DecomposeResult }
    | { kind: 'monitor'; result: MonitorResult }
    | { kind: 'finalize'; result: FinalizeResult }
    | { kind: 'run'; result: RunResult }
    | null
  >(null)

  // TASK 3-fix WORK 7f: Tasks list state (was dead-end Alert — now real data)
  const [tasks, setTasks] = useState<ResearchTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null)

  // -------------------- Fetch mission --------------------
  const fetchMission = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/research/missions/${missionId}`)
      const json = (await res.json()) as MissionResponse
      if (!res.ok || json.status === 'error' || !json.mission) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setMission(json.mission)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMission(null)
    } finally {
      setLoading(false)
    }
  }, [missionId])

  useEffect(() => {
    queueMicrotask(() => void fetchMission())
  }, [fetchMission])

  // -------------------- Fetch tasks (TASK 3-fix WORK 7f) --------------------
  // Trước đây: dead-end Alert "API chưa có endpoint list tasks".
  // Giờ: GET /api/research/tasks?missionId=X → render task table + click row Dialog.
  const fetchTasks = useCallback(async () => {
    setTasksLoading(true)
    setTasksError(null)
    try {
      const res = await fetch(`/api/research/tasks?missionId=${encodeURIComponent(missionId)}`)
      const json = (await res.json()) as TasksListResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setTasks(json.tasks ?? [])
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : String(err))
      setTasks([])
    } finally {
      setTasksLoading(false)
    }
  }, [missionId])

  useEffect(() => {
    queueMicrotask(() => void fetchTasks())
  }, [fetchTasks])

  // -------------------- Generic action runner --------------------
  async function runAction(
    kind: 'decompose' | 'monitor' | 'finalize' | 'run',
    endpoint: string,
  ) {
    setActionLoading(kind)
    setActionResult(null)
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      const json = (await res.json()) as DecomposeResult & MonitorResult & FinalizeResult & RunResult
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      if (kind === 'decompose') {
        const r = json as DecomposeResult
        setActionResult({ kind, result: r })
        const partsCount = Array.isArray(r.parts) ? r.parts.length : 0
        toast.success(
          `Decompose OK — ${partsCount} part(s) · council ① ${r.council1Verdict ?? '?'}${
            r.escalated ? ' · ESCALATED' : ''
          }`,
        )
        void fetchTasks() // refresh tasks list after decompose
      } else if (kind === 'monitor') {
        const r = json as MonitorResult
        setActionResult({ kind, result: r })
        const capCount = Array.isArray(r.captured) ? r.captured.length : 0
        toast.success(
          `Monitor OK — ${capCount} captured${r.pivotTriggered ? ` · PIVOT: ${r.pivotReason}` : ''}`,
        )
      } else if (kind === 'finalize') {
        const r = json as FinalizeResult
        setActionResult({ kind, result: r })
        const propCount = Array.isArray(r.proposalItems) ? r.proposalItems.length : 0
        toast.success(
          `Finalize OK — council ④ ${r.council4Verdict ?? '?'} · ${propCount} proposal(s) · ${r.captured?.length ?? 0} captured`,
        )
      } else if (kind === 'run') {
        const r = json as RunResult
        setActionResult({ kind, result: r })
        const errorsCount = Array.isArray(r.errors) ? r.errors.length : 0
        toast.success(
          `Run OK — ${r.parts ?? 0} part(s) · ${errorsCount} error(s) · finalReport ${r.finalReport ? '✓' : '✗'}`,
        )
        void fetchTasks() // refresh tasks after run
      }
      // Refresh mission after action
      void fetchMission()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`${kind} failed: ${msg}`)
      // Build error result with the correct shape per kind (TS discriminated union)
      const errResult = { status: 'error', error: msg } as unknown as
        | DecomposeResult
        | MonitorResult
        | FinalizeResult
        | RunResult
      setActionResult({ kind, result: errResult } as typeof actionResult)
    } finally {
      setActionLoading(null)
    }
  }

  // -------------------- Render --------------------
  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-12 w-full bg-stone-900/60" />
        <Skeleton className="h-32 w-full bg-stone-900/60" />
        <Skeleton className="h-32 w-full bg-stone-900/60" />
      </div>
    )
  }

  if (error || !mission) {
    return (
      <Alert variant="destructive" className="m-4 bg-red-950/40 border-red-500/40">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Mission load failed</AlertTitle>
        <AlertDescription className="text-xs">
          {error ?? 'Mission không tồn tại.'}
        </AlertDescription>
      </Alert>
    )
  }

  const status = mission.status
  const canDecompose = ['TRIAGING', 'DECOMPOSING'].includes(status)
  const canMonitor = ['RESEARCHING', 'MONITORING', 'DECOMPOSING', 'ESCALATED'].includes(status)
  const canFinalize = ['RESEARCHING', 'MONITORING', 'ESCALATED', 'FINALIZED'].includes(status)
  // TASK 3-fix WORK 7f: Run button visible khi mission CHƯA terminal (FINALIZED)
  const canRun = status !== 'FINALIZED'
  const failOpen = isFailOpen(mission.confidence)

  return (
    <ScrollArea className="h-full max-h-[78vh]">
      <div className="space-y-3 p-1 pr-3">
        {/* Header */}
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <code className="text-xs text-stone-300 font-mono">{mission.code}</code>
            <Badge className={`text-[10px] h-5 ${mtBadgeClass(mission.missionType)}`}>
              {mission.missionType}
            </Badge>
            <Badge className={`text-[10px] h-5 ${tierBadgeClass(mission.tier)}`}>
              {mission.tier || '?'}
            </Badge>
            <Badge variant="outline" className={`text-[10px] h-5 ${statusBadgeClass(status)}`}>
              {status}
            </Badge>
            {failOpen && (
              <Badge variant="outline" className="text-[10px] h-5 border-amber-500/40 text-amber-300 bg-amber-500/10">
                LLM fail-open
              </Badge>
            )}
          </div>
          <div className="text-sm font-medium text-stone-100 mb-1">
            {mission.title || <span className="text-stone-500 italic">(no title)</span>}
          </div>
          <div className="text-xs text-stone-400 mb-2 whitespace-pre-wrap break-words">
            {mission.request}
          </div>
          <div className="text-[10px] text-stone-500 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>Created: {mission.createdAt.slice(0, 19).replace('T', ' ')}</span>
            <span>Updated: {mission.updatedAt.slice(0, 19).replace('T', ' ')}</span>
            <span>ID: <code>{mission.id}</code></span>
          </div>
        </div>

        {/* Confidence signals */}
        {mission.confidence && (
          <Card className="bg-stone-950/60 border-stone-800 text-stone-200">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs font-medium text-stone-300">
                Confidence — level:{' '}
                <Badge variant="outline" className="text-[10px] border-stone-700 text-stone-300">
                  {mission.confidence.level}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2 px-3 space-y-1.5">
              <div>
                <div className="text-[10px] text-emerald-400 uppercase tracking-wide mb-0.5">
                  Signals ({mission.confidence.signals.length})
                </div>
                {mission.confidence.signals.length === 0 ? (
                  <div className="text-[11px] text-stone-500 italic">No signals</div>
                ) : (
                  <ul className="text-[11px] text-stone-300 list-disc list-inside space-y-0.5">
                    {mission.confidence.signals.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="text-[10px] text-red-400 uppercase tracking-wide mb-0.5">
                  Conflicts ({mission.confidence.conflicts.length})
                </div>
                {mission.confidence.conflicts.length === 0 ? (
                  <div className="text-[11px] text-stone-500 italic">No conflicts</div>
                ) : (
                  <ul className="text-[11px] text-stone-300 list-disc list-inside space-y-0.5">
                    {mission.confidence.conflicts.map((c, i) => (
                      <li key={i} className={c.toLowerCase().includes('llm error') ? 'text-amber-300' : ''}>
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action buttons */}
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-3">
          <div className="text-[10px] text-stone-500 uppercase tracking-wide mb-2">
            KING Actions
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canDecompose || actionLoading !== null}
              onClick={() => runAction('decompose', `/api/research/missions/${missionId}/decompose`)}
              className="border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-xs h-8"
              title={canDecompose ? 'POST /decompose' : `Status ${status} không hợp lệ cho DECOMPOSE`}
            >
              {actionLoading === 'decompose' ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              ) : (
                <GitBranch className="h-3 w-3 mr-1.5" />
              )}
              Decompose
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canMonitor || actionLoading !== null}
              onClick={() => runAction('monitor', `/api/research/missions/${missionId}/monitor`)}
              className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-xs h-8"
              title={canMonitor ? 'POST /monitor' : `Status ${status} không hợp lệ cho MONITOR`}
            >
              {actionLoading === 'monitor' ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              ) : (
                <Activity className="h-3 w-3 mr-1.5" />
              )}
              Monitor
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canFinalize || actionLoading !== null}
              onClick={() => runAction('finalize', `/api/research/missions/${missionId}/finalize`)}
              className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs h-8"
              title={canFinalize ? 'POST /finalize' : `Status ${status} không hợp lệ cho FINALIZE`}
            >
              {actionLoading === 'finalize' ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              ) : (
                <Square className="h-3 w-3 mr-1.5" />
              )}
              Finalize
            </Button>
            {/* TASK 3-fix WORK 7f: Run full lifecycle (KING 7 nhiệm vụ + G1/G2/G3) */}
            <Button
              size="sm"
              variant="outline"
              disabled={!canRun || actionLoading !== null}
              onClick={() => runAction('run', `/api/research/missions/${missionId}/run`)}
              className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-xs h-8"
              title={canRun ? 'POST /run — kingFullLifecycle (G1→G2→G3+Tournament)' : `Status ${status} không hợp lệ cho RUN`}
            >
              {actionLoading === 'run' ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              ) : (
                <Play className="h-3 w-3 mr-1.5" />
              )}
              Run
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void fetchMission()}
              className="text-stone-400 hover:text-stone-200 text-xs h-8"
            >
              <RefreshCw className="h-3 w-3 mr-1.5" />
              Refresh
            </Button>
          </div>

          {/* Action result */}
          {actionResult && (
            <div className="mt-2">
              {actionResult.result.status === 'ok' ? (
                <Alert className="bg-emerald-950/40 border-emerald-500/40 py-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                  <AlertTitle className="text-xs text-emerald-200">
                    {actionResult.kind} OK
                  </AlertTitle>
                  <AlertDescription className="text-[11px] text-stone-300">
                    {actionResult.kind === 'decompose' && (() => {
                      const r = actionResult.result as DecomposeResult
                      return `Parts: ${Array.isArray(r.parts) ? r.parts.length : 0} · Council ① ${r.council1Verdict ?? '?'}${r.escalated ? ' · ESCALATED' : ''}`
                    })()}
                    {actionResult.kind === 'monitor' && (() => {
                      const r = actionResult.result as MonitorResult
                      return `Captured: ${Array.isArray(r.captured) ? r.captured.length : 0}${r.pivotTriggered ? ` · PIVOT: ${r.pivotReason}` : ' (no pivot)'}`
                    })()}
                    {actionResult.kind === 'finalize' && (() => {
                      const r = actionResult.result as FinalizeResult
                      return `Council ④ ${r.council4Verdict ?? '?'} · proposals ${Array.isArray(r.proposalItems) ? r.proposalItems.length : 0} · captured ${r.captured?.length ?? 0}`
                    })()}
                    {actionResult.kind === 'run' && (() => {
                      const r = actionResult.result as RunResult
                      return `Run: ${r.parts ?? 0} parts · ${Array.isArray(r.errors) ? r.errors.length : 0} errors · finalReport ${r.finalReport ? '✓' : '✗'}`
                    })()}
                    {failOpen && (
                      <span className="block mt-1 text-amber-300 italic">
                        ⚠ LLM fail-open — action có thể không dùng LLM (return VETO / empty).
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive" className="bg-red-950/40 border-red-500/40 py-2">
                  <XCircle className="h-3.5 w-3.5" />
                  <AlertTitle className="text-xs">{actionResult.kind} failed</AlertTitle>
                  <AlertDescription className="text-[11px]">
                    {actionResult.result.error}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        {/* Tabs: Decision Log / Changelog / Tasks / Worklog */}
        <Tabs defaultValue="decisions" className="w-full">
          <TabsList className="bg-stone-900/70 border border-stone-800 grid grid-cols-4 w-full h-auto">
            <TabsTrigger value="decisions" className="text-[11px] data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400">
              <History className="h-3 w-3 mr-1" /> Decision Log
            </TabsTrigger>
            <TabsTrigger value="changelog" className="text-[11px] data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400">
              <ScrollText className="h-3 w-3 mr-1" /> Changelog
            </TabsTrigger>
            <TabsTrigger value="tasks" className="text-[11px] data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400">
              <ListChecks className="h-3 w-3 mr-1" /> Tasks
              <Badge variant="outline" className="text-[9px] h-3.5 ml-1 px-1 border-stone-700 text-stone-400">
                {tasks.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="worklog" className="text-[11px] data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-200 text-stone-400">
              <Activity className="h-3 w-3 mr-1" /> Worklog
            </TabsTrigger>
          </TabsList>

          <TabsContent value="decisions" className="mt-2">
            <Card className="bg-stone-950/60 border-stone-800 text-stone-200">
              <CardContent className="p-2">
                {(!mission.decisionLog || mission.decisionLog.length === 0) ? (
                  <div className="text-[11px] text-stone-500 italic py-4 text-center">
                    No decision log entries.
                  </div>
                ) : (
                  <ScrollArea className="max-h-64">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-stone-800 hover:bg-transparent">
                          <TableHead className="text-[10px] text-stone-500 h-7">At</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Agent</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Decision</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Reason</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Ref</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {mission.decisionLog.map((entry, i) => (
                          <TableRow key={i} className="border-stone-800/60">
                            <TableCell className="text-[10px] text-stone-400 font-mono py-1.5">
                              {entry.at.slice(0, 19).replace('T', ' ')}
                            </TableCell>
                            <TableCell className="text-[10px] py-1.5">
                              <Badge variant="outline" className="text-[9px] border-stone-700 text-stone-300">
                                {entry.agent}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-[10px] py-1.5">
                              <Badge variant="outline" className="text-[9px] border-violet-500/40 text-violet-300 bg-violet-500/10">
                                {entry.decision}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-[10px] text-stone-300 py-1.5 max-w-[300px]">
                              <div className="line-clamp-3">{entry.reason}</div>
                            </TableCell>
                            <TableCell className="text-[10px] text-stone-500 font-mono py-1.5">
                              {entry.ref || '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="changelog" className="mt-2">
            <Card className="bg-stone-950/60 border-stone-800 text-stone-200">
              <CardContent className="p-2">
                {(!mission.changelog || mission.changelog.length === 0) ? (
                  <div className="text-[11px] text-stone-500 italic py-4 text-center">
                    No changelog entries.
                  </div>
                ) : (
                  <ScrollArea className="max-h-64">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-stone-800 hover:bg-transparent">
                          <TableHead className="text-[10px] text-stone-500 h-7">At</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Field</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">From</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">To</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {mission.changelog.map((entry, i) => (
                          <TableRow key={i} className="border-stone-800/60">
                            <TableCell className="text-[10px] text-stone-400 font-mono py-1.5">
                              {entry.at.slice(0, 19).replace('T', ' ')}
                            </TableCell>
                            <TableCell className="text-[10px] text-violet-300 font-mono py-1.5">
                              {entry.field}
                            </TableCell>
                            <TableCell className="text-[10px] text-stone-400 font-mono py-1.5 max-w-[150px] truncate" title={entry.from}>
                              {entry.from || '—'}
                            </TableCell>
                            <TableCell className="text-[10px] text-stone-300 font-mono py-1.5 max-w-[150px] truncate" title={entry.to}>
                              {entry.to || '—'}
                            </TableCell>
                            <TableCell className="text-[10px] text-stone-400 py-1.5 max-w-[200px]">
                              <div className="line-clamp-2">{entry.reason}</div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TASK 3-fix WORK 7f: Tasks tab — trước đây là dead-end Alert, giờ
              là task table thật (GET /api/research/tasks?missionId=X). Click row
              → mở Dialog hiển thị task .md path + Success Criteria + Amendments. */}
          <TabsContent value="tasks" className="mt-2" forceMount>
            <Card className="bg-stone-950/60 border-stone-800 text-stone-200">
              <CardContent className="p-2">
                {tasksLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full bg-stone-900/60" />
                    ))}
                  </div>
                ) : tasksError ? (
                  <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertTitle className="text-xs">Tasks fetch failed</AlertTitle>
                    <AlertDescription className="text-[11px]">{tasksError}</AlertDescription>
                  </Alert>
                ) : tasks.length === 0 ? (
                  <div className="text-[11px] text-stone-500 italic py-6 text-center">
                    Chưa có task nào. Mission chưa DECOMPOSE hoặc chưa run lifecycle.
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canDecompose || actionLoading !== null}
                        onClick={() => runAction('decompose', `/api/research/missions/${missionId}/decompose`)}
                        className="h-7 px-2 text-[10px] border-violet-500/40 text-violet-300 hover:bg-violet-500/10"
                      >
                        <GitBranch className="h-3 w-3 mr-1" /> Decompose now
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-stone-800 hover:bg-transparent">
                          <TableHead className="text-[10px] text-stone-500 h-7">#</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Title</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Status</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">Group</TableHead>
                          <TableHead className="text-[10px] text-stone-500 h-7">SC count</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tasks.map((t) => {
                          const scCount = (t.successCriteria ?? []).length
                          return (
                            <TableRow
                              key={t.id}
                              className="border-stone-800/60 cursor-pointer hover:bg-stone-900/40"
                              onClick={() => setSelectedTask(t)}
                            >
                              <TableCell className="text-[10px] text-stone-400 font-mono py-1.5">
                                {t.partIdx}
                              </TableCell>
                              <TableCell className="text-[11px] text-stone-200 py-1.5 max-w-[280px]">
                                <div className="line-clamp-2">{t.title || '(no title)'}</div>
                              </TableCell>
                              <TableCell className="text-[10px] py-1.5">
                                <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-300 bg-cyan-500/10">
                                  {t.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-[10px] text-stone-400 py-1.5">
                                {t.assignedGroup ?? '—'}
                              </TableCell>
                              <TableCell className="text-[10px] text-stone-400 py-1.5">
                                {scCount}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="worklog" className="mt-2">
            <WorklogViewer missionId={missionId} />
          </TabsContent>
        </Tabs>

        <Separator className="bg-stone-800" />

        {/* Task detail Dialog — hiển thị task .md path + Success Criteria + Amendments */}
        <Dialog open={!!selectedTask} onOpenChange={(open) => !open && setSelectedTask(null)}>
          <DialogContent className="bg-stone-950 border-stone-800 text-stone-200 max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="text-sm text-stone-100 flex items-center gap-2">
                <FileText className="h-4 w-4 text-violet-400" />
                Task Detail{' '}
                {selectedTask && (
                  <code className="text-[11px] text-stone-400 font-mono">part #{selectedTask.partIdx}</code>
                )}
              </DialogTitle>
              <DialogDescription className="text-xs text-stone-400">
                Task .md path + Success Criteria (gate TC-13) + Amendments (DR-C3 append-only).
              </DialogDescription>
            </DialogHeader>
            {selectedTask && (
              <ScrollArea className="flex-1 max-h-[60vh] pr-2">
                <div className="space-y-3 text-xs">
                  <div>
                    <div className="text-[10px] text-violet-400 uppercase">Title</div>
                    <div className="text-stone-200">{selectedTask.title || '(no title)'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-400 uppercase">Task .md path</div>
                    <code className="text-[11px] text-cyan-300 font-mono break-all">
                      {selectedTask.taskMdPath || '(no path)'}
                    </code>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-stone-500">
                    <div>Status: <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-300 bg-cyan-500/10">{selectedTask.status}</Badge></div>
                    <div>Group: <code className="text-stone-400">{selectedTask.assignedGroup ?? '—'}</code></div>
                  </div>
                  <Separator className="bg-stone-800" />
                  <div>
                    <div className="text-[10px] text-emerald-400 uppercase mb-1">
                      Success Criteria ({(selectedTask.successCriteria ?? []).length}) — gate TC-13
                    </div>
                    {(selectedTask.successCriteria ?? []).length === 0 ? (
                      <div className="text-[11px] text-stone-500 italic">No success criteria (will be VETO by council ①)</div>
                    ) : (
                      <ul className="text-stone-300 list-disc list-inside space-y-0.5">
                        {(selectedTask.successCriteria ?? []).map((sc, i) => (
                          <li key={i} className="text-[11px]">
                            <code className="text-emerald-300 mr-1">{sc.id}</code>
                            {sc.criterion}
                            <span className="text-stone-500 ml-1">— measure: {sc.measure}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Separator className="bg-stone-800" />
                  <div>
                    <div className="text-[10px] text-amber-400 uppercase mb-1">
                      Amendments ({(selectedTask.amendments ?? []).length}) — DR-C3 append-only
                    </div>
                    {(selectedTask.amendments ?? []).length === 0 ? (
                      <div className="text-[11px] text-stone-500 italic">No amendments</div>
                    ) : (
                      <div className="space-y-1">
                        {(selectedTask.amendments ?? []).map((am, i) => (
                          <div key={i} className="text-[11px] text-stone-300 border-l-2 border-amber-500/30 pl-2">
                            <div className="text-[10px] text-stone-500">{am.at.slice(0, 19).replace('T', ' ')}</div>
                            <div>{am.amendment}</div>
                            <div className="text-stone-500 italic">reason: {am.reason}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </ScrollArea>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  )
}

export { MissionDetail as default }
