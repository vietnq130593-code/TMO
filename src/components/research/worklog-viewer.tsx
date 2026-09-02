'use client'

/**
 * WorklogViewer — P8 UI (Task S7-P8)
 * =================================================================
 * Spec:
 *  - TB-09 §4.2 — Worklog entry 8 trường required (mission/status/currentPhase/
 *    overallProgress/tlReadBack/done[]/issuesFaced[]/suggestionsNextGroup[]/filesChanged[]).
 *  - TB-04 §5 + TC-06 — Evidence required: claim trong done[] thiếu evidence → highlight RED.
 *  - TB-10 — Artifact Map: nếu artifactMapJson null → Alert warning "E4 TC-14 gate".
 *  - DR-C7 — modelSwitched[] entries (from→to, trigger, nextCheck, worklogLine).
 *
 * Behavior:
 *  - GET /api/research/worklog?missionId=X (hoặc taskId=X) — list entries.
 *  - Expand entry → 8 fields + evidence + artifactMap + modelSwitched.
 *  - Claims without evidence highlight RED (TC-06 visual).
 *
 * Fail-open: lỗi fetch → Alert. KHÔNG crash.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  AlertTriangle,
  ChevronDown,
  FileWarning,
  Loader2,
  RefreshCw,
  ScrollText,
  Zap,
} from 'lucide-react'

// ==================== Types (mirror API contract) ====================

interface WorklogEntry {
  mission: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'ESCALATED'
  currentPhase: 'G1' | 'G2' | 'G3'
  overallProgress: number
  tlReadBack: 'VERIFIED' | 'NEEDS-REVIEW' | 'PIVOT-NEEDED'
  done: string[]
  issuesFaced: string[]
  suggestionsNextGroup: string[]
  filesChanged: string[]
  header?: string
  taskId?: string
  metrics?: unknown[]
  findings?: { no: number; finding: string; evidence: string; severity: string; proposal: string }[]
  hypothesisStatus?: unknown[]
  issuesFound?: unknown[]
  concernsForTl?: string[]
  artifactMap?: unknown
  nextSteps?: string[]
  kbEntries?: string[]
  kbCandidates?: string[]
  modelNote?: string
}

interface EvidenceItem {
  claim: string
  file: string
  line: number | string
  excerpt: string
}

interface ModelSwitchEntry {
  at: string
  fromModel: string
  toModel: string
  trigger: string
  nextCheck: string
  worklogLine: string
}

interface Worklog {
  id: string
  taskId: string
  missionId: string
  phase: string
  entryJson: string
  evidenceJson: string
  artifactMapJson: string | null
  modelSwitchedJson: string
  createdAt: string
  updatedAt: string
  entry?: WorklogEntry
  evidence?: EvidenceItem[]
  artifactMap?: unknown
  modelSwitched?: ModelSwitchEntry[]
}

interface WorklogListResponse {
  status: string
  worklogs: Worklog[]
  total: number
  limit: number
  offset: number
}

interface WorklogViewerProps {
  missionId?: string
  taskId?: string
}

// ==================== Helpers ====================

const PHASE_COLORS: Record<string, string> = {
  TRIAGE: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  RESEARCH: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
  VERIFY: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  MONITOR: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  FINALIZE: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  DECOMPOSE: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  ESCALATE: 'border-red-500/40 text-red-300 bg-red-500/10',
}

function phaseBadgeClass(phase: string): string {
  return PHASE_COLORS[phase] ?? 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function tlReadBackBadgeClass(tl: string): string {
  if (tl === 'VERIFIED') return 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
  if (tl === 'NEEDS-REVIEW') return 'border-amber-500/40 text-amber-300 bg-amber-500/10'
  if (tl === 'PIVOT-NEEDED') return 'border-red-500/40 text-red-300 bg-red-500/10'
  return 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function statusBadgeClass(s: string): string {
  if (s === 'COMPLETED') return 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
  if (s === 'IN_PROGRESS') return 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
  if (s === 'BLOCKED') return 'border-red-500/40 text-red-300 bg-red-500/10'
  if (s === 'ESCALATED') return 'border-amber-500/40 text-amber-300 bg-amber-500/10'
  return 'border-stone-700 text-stone-300 bg-stone-800/50'
}

/** TC-06 visual: claim in done[] mà không match evidence.claim (substring 2 chiều) → gap. */
function claimHasEvidence(claim: string, evidence: EvidenceItem[]): boolean {
  if (!claim || claim.trim().length === 0) return true // skip empty
  const c = claim.toLowerCase()
  return evidence.some((e) => {
    const ec = (e.claim || '').toLowerCase()
    if (!ec) return false
    return c.includes(ec) || ec.includes(c)
  })
}

// ==================== Component ====================

export function WorklogViewer({ missionId, taskId }: WorklogViewerProps) {
  const [worklogs, setWorklogs] = useState<Worklog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const fetchWorklogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (missionId) params.set('missionId', missionId)
      if (taskId) params.set('taskId', taskId)
      const res = await fetch(`/api/research/worklog?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as WorklogListResponse
      setWorklogs(data.worklogs)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setWorklogs([])
    } finally {
      setLoading(false)
    }
  }, [missionId, taskId])

  useEffect(() => {
    queueMicrotask(() => void fetchWorklogs())
  }, [fetchWorklogs])

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full bg-stone-900/60" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Worklog fetch failed</AlertTitle>
        <AlertDescription className="text-xs">{error}</AlertDescription>
      </Alert>
    )
  }

  if (worklogs.length === 0) {
    return (
      <div className="rounded-md border border-stone-800 bg-stone-900/30 p-4 text-center">
        <ScrollText className="h-5 w-5 text-stone-600 mx-auto mb-1.5" />
        <div className="text-xs text-stone-500">
          No worklog entries for {missionId ? `mission ${missionId.slice(-8)}` : `task ${taskId?.slice(-8)}`}.
        </div>
        <div className="text-[10px] text-stone-600 mt-1">
          Worklog entries sinh ra khi KING DECOMPOSE/MONITOR/FINALIZE chạy (P3-P5 pipeline).
        </div>
      </div>
    )
  }

  return (
    <Card className="bg-stone-950/60 border-stone-800 text-stone-200">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium">
            Worklog Entries{' '}
            <Badge variant="outline" className="text-[10px] border-stone-700 text-stone-400">
              {total}
            </Badge>
          </CardTitle>
          <button
            onClick={() => void fetchWorklogs()}
            className="text-[11px] text-stone-400 hover:text-stone-200 inline-flex items-center gap-1"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-2">
        <ScrollArea className="max-h-[500px]">
          <div className="space-y-1.5 pr-2">
            {worklogs.map((w) => {
              const entry = w.entry
              const evidence = w.evidence ?? []
              const modelSwitched = w.modelSwitched ?? []
              const artifactMap = w.artifactMap
              const isOpen = expandedId === w.id
              const hasArtifactMap = artifactMap !== null && artifactMap !== undefined
              if (!entry) {
                return (
                  <div key={w.id} className="rounded-md border border-red-500/40 bg-red-950/30 p-2 text-[11px] text-red-300">
                    Worklog {w.id} — entryJson decode failed
                  </div>
                )
              }
              // TC-06: collect claims missing evidence
              const gapClaims = entry.done.filter((d) => !claimHasEvidence(d, evidence))
              return (
                <Collapsible
                  key={w.id}
                  open={isOpen}
                  onOpenChange={(open) => setExpandedId(open ? w.id : null)}
                >
                  <CollapsibleTrigger asChild>
                    <button className="w-full text-left rounded-md border border-stone-800 bg-stone-900/40 hover:bg-stone-900/70 hover:border-stone-700 transition-colors p-2.5 group">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <Badge variant="outline" className={`text-[9px] h-4 ${phaseBadgeClass(w.phase)}`}>
                            {w.phase}
                          </Badge>
                          <Badge variant="outline" className={`text-[9px] h-4 ${statusBadgeClass(entry.status)}`}>
                            {entry.status}
                          </Badge>
                          <Badge variant="outline" className="text-[9px] h-4 border-stone-700 text-stone-400">
                            {entry.currentPhase}
                          </Badge>
                          <Badge variant="outline" className={`text-[9px] h-4 ${tlReadBackBadgeClass(entry.tlReadBack)}`}>
                            TL: {entry.tlReadBack}
                          </Badge>
                          {gapClaims.length > 0 && (
                            <Badge variant="outline" className="text-[9px] h-4 border-red-500/40 text-red-300 bg-red-500/10">
                              <FileWarning className="h-2.5 w-2.5 mr-0.5" />
                              {gapClaims.length} evidence gap
                            </Badge>
                          )}
                          {!hasArtifactMap && (
                            <Badge variant="outline" className="text-[9px] h-4 border-amber-500/40 text-amber-300 bg-amber-500/10">
                              no artifact map
                            </Badge>
                          )}
                          {modelSwitched.length > 0 && (
                            <Badge variant="outline" className="text-[9px] h-4 border-cyan-500/40 text-cyan-300 bg-cyan-500/10">
                              <Zap className="h-2.5 w-2.5 mr-0.5" />
                              {modelSwitched.length} model switch
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="text-[10px] text-stone-400 tabular-nums">{entry.overallProgress}%</span>
                          <ChevronDown className={`h-3 w-3 text-stone-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </div>
                      </div>
                      <Progress value={entry.overallProgress} className="h-1 bg-stone-800" />
                      <div className="text-[10px] text-stone-500 mt-1.5">
                        {w.createdAt.slice(0, 19).replace('T', ' ')} · task <code className="text-stone-400">{w.taskId.slice(-8)}</code>
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="rounded-md border border-stone-800 bg-stone-900/20 p-3 mt-1 space-y-2.5">
                      {/* 8 fields */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div>
                          <div className="text-[9px] text-stone-500 uppercase">Mission</div>
                          <div className="text-stone-300 font-medium">{entry.mission}</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-stone-500 uppercase">Status</div>
                          <div className="text-stone-300 font-medium">{entry.status}</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-stone-500 uppercase">Phase</div>
                          <div className="text-stone-300 font-medium">{entry.currentPhase}</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-stone-500 uppercase">Progress</div>
                          <div className="text-stone-300 font-medium tabular-nums">{entry.overallProgress}%</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-stone-500 uppercase">TL ReadBack</div>
                          <div className="text-stone-300 font-medium">{entry.tlReadBack}</div>
                        </div>
                      </div>

                      {/* done[] */}
                      <div>
                        <div className="text-[10px] text-emerald-400 uppercase tracking-wide mb-0.5">
                          Done ({entry.done.length})
                        </div>
                        <ul className="text-[11px] text-stone-300 list-disc list-inside space-y-0.5">
                          {entry.done.map((d, i) => {
                            const hasEv = claimHasEvidence(d, evidence)
                            return (
                              <li
                                key={i}
                                className={hasEv ? '' : 'text-red-300 bg-red-950/30 px-1 rounded'}
                                title={hasEv ? undefined : 'TC-06: claim missing evidence'}
                              >
                                {d}
                                {!hasEv && (
                                  <span className="ml-1 text-[9px] text-red-400 italic">(no evidence)</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>

                      {/* issuesFaced[] */}
                      <div>
                        <div className="text-[10px] text-red-400 uppercase tracking-wide mb-0.5">
                          Issues Faced ({entry.issuesFaced.length})
                        </div>
                        {entry.issuesFaced.length === 0 ? (
                          <div className="text-[11px] text-stone-500 italic">None</div>
                        ) : (
                          <ul className="text-[11px] text-stone-300 list-disc list-inside space-y-0.5">
                            {entry.issuesFaced.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* suggestionsNextGroup[] */}
                      <div>
                        <div className="text-[10px] text-cyan-400 uppercase tracking-wide mb-0.5">
                          Suggestions Next Group ({entry.suggestionsNextGroup.length})
                        </div>
                        {entry.suggestionsNextGroup.length === 0 ? (
                          <div className="text-[11px] text-stone-500 italic">None</div>
                        ) : (
                          <ul className="text-[11px] text-stone-300 list-disc list-inside space-y-0.5">
                            {entry.suggestionsNextGroup.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* filesChanged[] */}
                      <div>
                        <div className="text-[10px] text-violet-400 uppercase tracking-wide mb-0.5">
                          Files Changed ({entry.filesChanged.length})
                        </div>
                        {entry.filesChanged.length === 0 ? (
                          <div className="text-[11px] text-stone-500 italic">None</div>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {entry.filesChanged.map((f, i) => (
                              <code key={i} className="text-[10px] text-stone-300 bg-stone-900 px-1.5 py-0.5 rounded border border-stone-800">
                                {f}
                              </code>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Evidence */}
                      {evidence.length > 0 && (
                        <>
                          <Separator className="bg-stone-800" />
                          <div>
                            <div className="text-[10px] text-amber-400 uppercase tracking-wide mb-1">
                              Evidence ({evidence.length})
                            </div>
                            <div className="space-y-1.5">
                              {evidence.map((ev, i) => (
                                <div key={i} className="rounded border border-stone-800 bg-stone-900/40 p-1.5">
                                  <div className="text-[11px] text-stone-200 font-medium mb-0.5">{ev.claim}</div>
                                  <div className="text-[10px] text-stone-500 font-mono">
                                    {ev.file}:{ev.line}
                                  </div>
                                  <pre className="text-[10px] text-stone-400 bg-stone-950/60 p-1.5 rounded mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                                    {ev.excerpt}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {/* Artifact Map */}
                      <Separator className="bg-stone-800" />
                      <div>
                        <div className="text-[10px] text-violet-400 uppercase tracking-wide mb-0.5">
                          Artifact Map (TB-10)
                        </div>
                        {hasArtifactMap ? (
                          <pre className="text-[10px] text-stone-300 bg-stone-950/60 p-2 rounded border border-stone-800 overflow-x-auto max-h-40 font-mono whitespace-pre-wrap break-words">
                            {typeof artifactMap === 'string' ? artifactMap : JSON.stringify(artifactMap, null, 2)}
                          </pre>
                        ) : (
                          <Alert className="bg-amber-950/30 border-amber-500/30 py-1.5">
                            <AlertTriangle className="h-3 w-3 text-amber-300" />
                            <AlertDescription className="text-[10px] text-amber-200">
                              Artifact Map missing — gate E4 TC-14 (handoff yêu cầu Artifact Map).
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>

                      {/* Model Switched */}
                      {modelSwitched.length > 0 && (
                        <>
                          <Separator className="bg-stone-800" />
                          <div>
                            <div className="text-[10px] text-cyan-400 uppercase tracking-wide mb-1">
                              Model Switched (DR-C7) — {modelSwitched.length} event(s)
                            </div>
                            <div className="space-y-1">
                              {modelSwitched.map((ms, i) => (
                                <div key={i} className="text-[10px] text-stone-300 bg-stone-900/40 rounded p-1.5 border border-stone-800">
                                  <div className="flex flex-wrap gap-1 mb-0.5">
                                    <code className="text-cyan-300">{ms.fromModel}</code>
                                    <span className="text-stone-500">→</span>
                                    <code className="text-emerald-300">{ms.toModel}</code>
                                  </div>
                                  <div className="text-stone-500">
                                    Trigger: <span className="text-amber-300">{ms.trigger}</span>
                                  </div>
                                  <div className="text-stone-500">
                                    Next check: <code className="text-stone-400">{ms.nextCheck}</code>
                                  </div>
                                  <div className="text-stone-400 italic mt-0.5">{ms.worklogLine}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export { WorklogViewer as default }
