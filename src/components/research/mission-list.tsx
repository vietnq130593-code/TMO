'use client'

/**
 * MissionList — P8 UI (Task S7-P8) — Missions tab content
 * ==================================================================
 * Spec:
 *  - TB-13 §2.2 — List missions + create form + classify clarify flow.
 *  - TB-02 §6 edge #1 — LOW confidence → clarifyingQuestion; UI cho user trả lời.
 *  - DR-C2 — Confidence HIGH/MEDIUM classified ngay; LOW hỏi 1 câu.
 *
 * Behavior:
 *  - GET /api/research/missions?limit=50 — list (table row click → open detail Dialog).
 *  - POST /api/research/missions { request, title? } — create + classify.
 *    - response.status='needs_clarification' → Alert với clarifyingQuestion + Select tier.
 *    - response.status='classified' → Badge tier + success toast.
 *  - Clarify submit → PATCH /api/research/missions/[id] { status:'TRIAGING', tier:'T2',
 *    decision:{agent:'USER', decision:'CLARIFY', reason} }.
 *  - Filter by status/tier (Select), search (Input).
 *  - Loading (Skeleton), Error (Alert), Empty state.
 *
 * Fail-open: LLM error (conflicts='LLM error: ...') → hiển thị warning Alert, KHÔNG crash.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertTriangle,
  ChevronRight,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import { MissionDetail } from './mission-detail'

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

interface MissionsListResponse {
  status: string
  missions: Mission[]
  total: number
  limit: number
  offset: number
}

interface CreateResponse {
  status: 'classified' | 'needs_clarification' | 'error'
  mission?: Mission
  clarifyingQuestion?: string
  classify?: {
    missionType: string
    confidence: ConfidenceSignals
    clarifyingQuestion?: string
    rawSignals?: ConfidenceSignals
  }
  error?: string
}

interface PatchResponse {
  status: 'ok' | 'error'
  mission?: Mission
  error?: string
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

export function MissionList() {
  // --- List state ---
  const [missions, setMissions] = useState<Mission[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // --- Filter state ---
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterTier, setFilterTier] = useState<string>('all')
  const [search, setSearch] = useState('')

  // --- Create state ---
  const [createRequest, setCreateRequest] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null)

  // --- Clarify state ---
  const [clarifyTier, setClarifyTier] = useState<string>('T2')
  const [clarifyMissionType, setClarifyMissionType] = useState<string>('M2')
  const [clarifying, setClarifying] = useState(false)

  // --- Detail dialog state ---
  const [detailId, setDetailId] = useState<string | null>(null)

  // -------------------- Fetch list --------------------
  const fetchMissions = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (filterStatus !== 'all') params.set('status', filterStatus)
      if (filterTier !== 'all') params.set('tier', filterTier)
      const res = await fetch(`/api/research/missions?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as MissionsListResponse
      setMissions(data.missions)
      setTotal(data.total)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
      setMissions([])
    } finally {
      setListLoading(false)
    }
  }, [filterStatus, filterTier])

  useEffect(() => {
    queueMicrotask(() => void fetchMissions())
  }, [fetchMissions])

  // -------------------- Create mission --------------------
  async function handleCreate() {
    const req = createRequest.trim()
    if (!req) {
      toast.error('Request không được rỗng')
      return
    }
    setCreating(true)
    setCreateResult(null)
    try {
      const res = await fetch('/api/research/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: req, title: createTitle.trim() || undefined }),
      })
      const json = (await res.json()) as CreateResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setCreateResult(json)
      if (json.status === 'classified' && json.mission) {
        toast.success(`Classified: ${json.mission.missionType}/${json.mission.tier || '?'} (confidence ${json.mission.confidence?.level ?? '?'})`)
      } else if (json.status === 'needs_clarification') {
        toast.info('Mission needs clarification — answer the question below')
      }
      void fetchMissions()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Create failed: ${msg}`)
      setCreateResult({ status: 'error', error: msg })
    } finally {
      setCreating(false)
    }
  }

  // -------------------- Submit clarification --------------------
  async function handleClarify() {
    if (!createResult?.mission) return
    const missionId = createResult.mission.id
    setClarifying(true)
    try {
      const res = await fetch(`/api/research/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'TRIAGING',
          tier: clarifyTier,
          missionType: clarifyMissionType, // TASK 3-fix WORK 6 (C.13): user's M1/M2/M3 selection
          decision: {
            agent: 'USER',
            decision: 'CLARIFY',
            reason: `User clarified: missionType=${clarifyMissionType}, tier=${clarifyTier}`,
          },
        }),
      })
      const json = (await res.json()) as PatchResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(`Clarified → TRIAGING / ${clarifyTier}`)
      setCreateResult(null)
      setCreateRequest('')
      setCreateTitle('')
      void fetchMissions()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Clarify failed: ${msg}`)
    } finally {
      setClarifying(false)
    }
  }

  // -------------------- Filtered missions (client-side search) --------------------
  const filteredMissions = useMemo(() => {
    if (!search.trim()) return missions
    const q = search.toLowerCase()
    return missions.filter(
      (m) =>
        m.code.toLowerCase().includes(q) ||
        (m.title ?? '').toLowerCase().includes(q) ||
        m.request.toLowerCase().includes(q) ||
        m.missionType.toLowerCase().includes(q),
    )
  }, [missions, search])

  // ==================== Render ====================
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      {/* Create form — 2/5 width on lg */}
      <Card className="lg:col-span-2 bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Plus className="h-4 w-4 text-violet-400" />
            New Mission
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mission-title" className="text-[11px] text-stone-400">
              Title (optional)
            </Label>
            <Input
              id="mission-title"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="VD: Tối ưu p95 chat latency"
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mission-request" className="text-[11px] text-stone-400">
              Request <span className="text-red-400">*</span>
            </Label>
            <Textarea
              id="mission-request"
              value={createRequest}
              onChange={(e) => setCreateRequest(e.target.value)}
              placeholder="Mô tả mission — KING sẽ classify M1/M2/M3 + tier T1/T2/T3"
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[100px] resize-y"
            />
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating || !createRequest.trim()}
            className="w-full bg-violet-600 hover:bg-violet-500 text-white text-xs h-9"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-2" />
            )}
            {creating ? 'Classifying…' : 'Tạo + Classify'}
          </Button>

          {/* Create result */}
          {createResult && createResult.status === 'error' && (
            <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Create failed</AlertTitle>
              <AlertDescription className="text-xs">{createResult.error}</AlertDescription>
            </Alert>
          )}

          {createResult && createResult.status === 'classified' && createResult.mission && (
            <Alert className="bg-emerald-950/40 border-emerald-500/40">
              <Sparkles className="h-4 w-4 text-emerald-300" />
              <AlertTitle className="text-emerald-200 text-xs">
                Classified — {createResult.mission.code}
              </AlertTitle>
              <AlertDescription className="text-xs space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className={`text-[10px] ${mtBadgeClass(createResult.mission.missionType)}`}>
                    {createResult.mission.missionType}
                  </Badge>
                  <Badge className={`text-[10px] ${tierBadgeClass(createResult.mission.tier)}`}>
                    {createResult.mission.tier || '?'}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] border-stone-700 text-stone-400">
                    {createResult.mission.confidence?.level ?? '?'}
                  </Badge>
                </div>
                {isFailOpen(createResult.mission.confidence) && (
                  <div className="text-[10px] text-amber-300 italic">
                    ⚠ LLM fail-open — classify không dùng LLM.
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {createResult && createResult.status === 'needs_clarification' && createResult.mission && (
            <Alert className="bg-amber-950/40 border-amber-500/40">
              <AlertTriangle className="h-4 w-4 text-amber-300" />
              <AlertTitle className="text-amber-200 text-xs">
                Needs clarification — {createResult.mission.code}
              </AlertTitle>
              <AlertDescription className="text-xs space-y-2">
                <div className="text-stone-300">{createResult.clarifyingQuestion}</div>
                {isFailOpen(createResult.mission.confidence) && (
                  <div className="text-[10px] text-amber-300 italic">
                    ⚠ LLM fail-open — trả câu hỏi mặc định.
                  </div>
                )}
                <Separator className="bg-stone-800 my-1.5" />
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-stone-400">Mission Type</Label>
                    <Select value={clarifyMissionType} onValueChange={setClarifyMissionType}>
                      <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-200 text-xs h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="M1">M1 — Verify</SelectItem>
                        <SelectItem value="M2">M2 — Change</SelectItem>
                        <SelectItem value="M3">M3 — Grand</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-stone-400">Tier</Label>
                    <Select value={clarifyTier} onValueChange={setClarifyTier}>
                      <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-200 text-xs h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="T1">T1 — Quick</SelectItem>
                        <SelectItem value="T2">T2 — Standard</SelectItem>
                        <SelectItem value="T3">T3 — Deep</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  onClick={handleClarify}
                  disabled={clarifying}
                  size="sm"
                  className="w-full bg-amber-600 hover:bg-amber-500 text-white text-xs h-8"
                >
                  {clarifying ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                  ) : null}
                  Submit Clarification
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Mission list — 3/5 width on lg */}
      <Card className="lg:col-span-3 bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">
              Missions{' '}
              <Badge variant="outline" className="ml-1 text-[10px] border-stone-700 text-stone-400">
                {total}
              </Badge>
            </CardTitle>
            <button
              onClick={() => void fetchMissions()}
              className="text-[11px] text-stone-400 hover:text-stone-200 inline-flex items-center gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${listLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <div className="flex items-center gap-1 text-[10px] text-stone-400">
              <Filter className="h-3 w-3" /> Filter:
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-300 text-xs h-7 w-[120px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="CLASSIFY">CLASSIFY</SelectItem>
                <SelectItem value="TRIAGING">TRIAGING</SelectItem>
                <SelectItem value="DECOMPOSING">DECOMPOSING</SelectItem>
                <SelectItem value="RESEARCHING">RESEARCHING</SelectItem>
                <SelectItem value="MONITORING">MONITORING</SelectItem>
                <SelectItem value="FINALIZED">FINALIZED</SelectItem>
                <SelectItem value="ESCALATED">ESCALATED</SelectItem>
                <SelectItem value="PIVOTED">PIVOTED</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterTier} onValueChange={setFilterTier}>
              <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-300 text-xs h-7 w-[100px]">
                <SelectValue placeholder="Tier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tier</SelectItem>
                <SelectItem value="T1">T1</SelectItem>
                <SelectItem value="T2">T2</SelectItem>
                <SelectItem value="T3">T3</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative flex-1 min-w-[120px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-stone-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code/title…"
                className="bg-stone-900 border-stone-700 text-stone-300 placeholder:text-stone-500 text-xs h-7 pl-7"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full bg-stone-900/60" />
              ))}
            </div>
          ) : listError ? (
            <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Fetch failed</AlertTitle>
              <AlertDescription className="text-xs">{listError}</AlertDescription>
            </Alert>
          ) : filteredMissions.length === 0 ? (
            <div className="text-xs text-stone-500 italic py-8 text-center">
              Không có mission nào. Tạo mission mới ở form bên trái.
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <div className="space-y-1.5 pr-2">
                {filteredMissions.map((m) => {
                  const failOpen = isFailOpen(m.confidence)
                  return (
                    <button
                      key={m.id}
                      onClick={() => setDetailId(m.id)}
                      className="w-full text-left rounded-md border border-stone-800 bg-stone-900/40 hover:bg-stone-900/70 hover:border-stone-700 transition-colors p-3 group"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <code className="text-[10px] text-stone-500 font-mono">{m.code}</code>
                          <Badge className={`text-[10px] h-5 ${mtBadgeClass(m.missionType)}`}>
                            {m.missionType}
                          </Badge>
                          <Badge className={`text-[10px] h-5 ${tierBadgeClass(m.tier)}`}>
                            {m.tier || '?'}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] h-5 ${statusBadgeClass(m.status)}`}>
                            {m.status}
                          </Badge>
                          {failOpen && (
                            <Badge variant="outline" className="text-[10px] h-5 border-amber-500/40 text-amber-300 bg-amber-500/10">
                              fail-open
                            </Badge>
                          )}
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-stone-600 group-hover:text-stone-300 flex-shrink-0" />
                      </div>
                      <div className="text-xs text-stone-200 truncate font-medium">
                        {m.title || <span className="text-stone-500 italic">(no title)</span>}
                      </div>
                      <div className="text-[11px] text-stone-400 line-clamp-2 mt-0.5">{m.request}</div>
                      <div className="text-[10px] text-stone-600 mt-1">
                        {m.createdAt.slice(0, 19).replace('T', ' ')} · {m.confidence?.level ?? '?'} confidence
                      </div>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={!!detailId} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="bg-stone-950 border-stone-800 text-stone-200 max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm text-stone-100">Mission Detail</DialogTitle>
            <DialogDescription className="text-xs text-stone-400">
              Click outside hoặc nút X để đóng. Detail tự-refresh sau mỗi action.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {detailId && <MissionDetail missionId={detailId} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export { MissionList as default }
