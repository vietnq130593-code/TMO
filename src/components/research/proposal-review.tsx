'use client'

/**
 * ProposalReview — P8 UI (Task S7-P8) — Proposals tab content
 * =====================================================================
 * Spec:
 *  - TB-13 §2.2 — List proposals + create form + review dialog.
 *  - TB-11 §1 — Proposal schema (code P-YYYYMMDD-NNN, title, summary,
 *    changes[], verificationPlan[]).
 *  - TB-11 §3 — Lifecycle: DRAFT → SUBMITTED → APPROVED → APPLIED (+ REJECTED).
 *  - DR-C5 §C5 — KING cấm tự duyệt; deputy SIVIL/HAN khi timeout.
 *  - TB-12 §3.2 TC-11 — REJECT reason BẮT BUỘC non-empty.
 *
 * Behavior:
 *  - GET /api/research/proposals?limit=50 — list.
 *  - Create: Select missionId + Input title + Textarea summary + Textarea changes
 *    (newline-sep) + Textarea verificationPlan (newline-sep) → POST.
 *  - Review dialog (SUBMITTED proposals): Approve (Input reviewedBy, default 'user')
 *    + Reject (Input reviewedBy + Textarea reason BẮT BUỘC) → POST /review.
 *    Handle 400: KING self-approve blocked; REJECT reason required.
 *  - Deputy note: nếu timeoutAt expired → Badge "TIMEOUT — deputy có thể duyệt"
 *    + hint deputy:SIVIL (research) or deputy:HAN (kb).
 *
 * Fail-open: API error → Alert + toast. KHÔNG crash.
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'

// ==================== Types (mirror API contract) ====================

interface ProposalSchema {
  code: string
  title: string
  summary: string
  changes: string[]
  verificationPlan: string[]
  pocRef?: string
  diffSummary?: string
  [key: string]: unknown
}

interface Proposal {
  id: string
  code: string
  missionId: string
  status: string
  schemaJson: string
  branchName: string
  diffSummary: string | null
  reviewedBy: string | null
  timeoutAt: string
  decidedAt: string | null
  createdAt: string
  updatedAt: string
  schema?: ProposalSchema
}

interface ProposalsListResponse {
  status: string
  proposals: Proposal[]
  total: number
  limit: number
  offset: number
}

interface Mission {
  id: string
  code: string
  title: string | null
  missionType: string
  tier: string
  status: string
}

interface MissionsListResponse {
  status: string
  missions: Mission[]
  total: number
}

interface CreateResponse {
  status: 'ok' | 'error'
  proposal?: Proposal
  error?: string
}

interface ReviewResponse {
  status: 'ok' | 'error'
  proposal?: Proposal
  applied?: boolean
  applyError?: string | null
  error?: string
}

// TASK 3-fix WORK 7f: Apply button (POST /api/research/proposals/[id]/apply)
interface ApplyResponse {
  status: 'ok' | 'error'
  proposal?: Proposal
  merged?: boolean
  mergeError?: string | null
  error?: string
}

// ==================== Helpers ====================

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'border-stone-600 text-stone-300 bg-stone-800/50',
  SUBMITTED: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
  APPROVED: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  REJECTED: 'border-red-500/40 text-red-300 bg-red-500/10',
  APPLIED: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
}

function statusBadgeClass(status: string): string {
  return STATUS_COLORS[status] ?? 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function isExpired(timeoutAt: string): boolean {
  try {
    return new Date(timeoutAt).getTime() < Date.now()
  } catch {
    return false
  }
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

// ==================== Component ====================

export function ProposalReview() {
  // --- List state ---
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')

  // --- Missions (for create form select) ---
  const [missions, setMissions] = useState<Mission[]>([])

  // --- Create state ---
  const [createMissionId, setCreateMissionId] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [createSummary, setCreateSummary] = useState('')
  const [createChanges, setCreateChanges] = useState('')
  const [createVerification, setCreateVerification] = useState('')
  const [creating, setCreating] = useState(false)

  // --- Review dialog state ---
  const [reviewProposal, setReviewProposal] = useState<Proposal | null>(null)
  const [reviewReviewedBy, setReviewReviewedBy] = useState('user')
  const [reviewReason, setReviewReason] = useState('')
  const [reviewing, setReviewing] = useState<'APPROVE' | 'REJECT' | null>(null)

  // --- Apply state (TASK 3-fix WORK 7f) ---
  const [applyingId, setApplyingId] = useState<string | null>(null)

  // -------------------- Fetch list --------------------
  const fetchProposals = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (filterStatus !== 'all') params.set('status', filterStatus)
      const res = await fetch(`/api/research/proposals?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ProposalsListResponse
      setProposals(data.proposals)
      setTotal(data.total)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
      setProposals([])
    } finally {
      setListLoading(false)
    }
  }, [filterStatus])

  // -------------------- Fetch missions for select --------------------
  const fetchMissions = useCallback(async () => {
    try {
      const res = await fetch('/api/research/missions?limit=200')
      if (!res.ok) return
      const data = (await res.json()) as MissionsListResponse
      setMissions(data.missions)
      if (data.missions.length > 0 && !createMissionId) {
        setCreateMissionId(data.missions[0].id)
      }
    } catch {
      // silent fail — missions select sẽ empty
    }
  }, [createMissionId])

  useEffect(() => {
    queueMicrotask(() => void fetchProposals())
  }, [fetchProposals])

  useEffect(() => {
    queueMicrotask(() => void fetchMissions())
  }, [fetchMissions])

  // -------------------- Create proposal --------------------
  async function handleCreate() {
    if (!createMissionId) {
      toast.error('Chọn mission để tạo proposal')
      return
    }
    if (!createTitle.trim()) {
      toast.error('Title bắt buộc')
      return
    }
    if (!createSummary.trim()) {
      toast.error('Summary bắt buộc')
      return
    }
    const changes = splitLines(createChanges)
    if (changes.length === 0) {
      toast.error('Changes phải có ít nhất 1 dòng (TB-11 §1)')
      return
    }
    const verificationPlan = splitLines(createVerification)
    if (verificationPlan.length === 0) {
      toast.error('Verification Plan phải có ít nhất 1 dòng (TB-11 §7)')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/research/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missionId: createMissionId,
          title: createTitle.trim(),
          summary: createSummary.trim(),
          changes,
          verificationPlan,
        }),
      })
      const json = (await res.json()) as CreateResponse
      if (!res.ok || json.status === 'error' || !json.proposal) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(`Created proposal ${json.proposal.code} (DRAFT)`)
      setCreateTitle('')
      setCreateSummary('')
      setCreateChanges('')
      setCreateVerification('')
      void fetchProposals()
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  // -------------------- Submit proposal (DRAFT → SUBMITTED) --------------------
  async function handleSubmit(proposal: Proposal) {
    try {
      const res = await fetch('/api/research/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', id: proposal.id }),
      })
      const json = (await res.json()) as CreateResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(`Submitted ${proposal.code} → branch ${json.proposal?.branchName}`)
      void fetchProposals()
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -------------------- Review (APPROVE / REJECT) --------------------
  async function handleReview(decision: 'APPROVE' | 'REJECT') {
    if (!reviewProposal) return
    if (!reviewReviewedBy.trim()) {
      toast.error('reviewedBy bắt buộc')
      return
    }
    if (decision === 'REJECT' && !reviewReason.trim()) {
      toast.error('REJECT reason BẮT BUỘC non-empty (TC-11)')
      return
    }
    setReviewing(decision)
    try {
      const res = await fetch(`/api/research/proposals/${reviewProposal.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reviewedBy: reviewReviewedBy.trim(),
          reason: reviewReason.trim() || undefined,
        }),
      })
      const json = (await res.json()) as ReviewResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      if (decision === 'APPROVE') {
        const applied = json.applied
        const applyError = json.applyError
        if (applied) {
          toast.success(`Approved ${reviewProposal.code} — applied to self-direction`)
        } else if (applyError) {
          toast.warning(`Approved ${reviewProposal.code} — apply failed: ${applyError}`)
        } else {
          toast.success(`Approved ${reviewProposal.code}`)
        }
      } else {
        toast.success(`Rejected ${reviewProposal.code} (TC-11 reason logged)`)
      }
      setReviewProposal(null)
      setReviewReviewedBy('user')
      setReviewReason('')
      void fetchProposals()
    } catch (err) {
      toast.error(`Review failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReviewing(null)
    }
  }

  const filteredProposals = useMemo(() => proposals, [proposals])

  // -------------------- Apply proposal (APPROVED → APPLIED) — TASK 3-fix WORK 7f --------------------
  async function handleApply(proposal: Proposal) {
    setApplyingId(proposal.id)
    try {
      const res = await fetch(`/api/research/proposals/${proposal.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = (await res.json()) as ApplyResponse
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      if (json.merged) {
        toast.success(`Applied ${proposal.code} — branch merged`)
      } else if (json.mergeError) {
        toast.warning(`Apply ${proposal.code} — merge failed: ${json.mergeError}`)
      } else {
        toast.success(`Applied ${proposal.code}`)
      }
      void fetchProposals()
    } catch (err) {
      toast.error(`Apply failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setApplyingId(null)
    }
  }

  // ==================== Render ====================
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      {/* Create form */}
      <Card className="lg:col-span-2 bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Plus className="h-4 w-4 text-violet-400" />
            New Proposal (DRAFT)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <div className="space-y-1">
            <Label className="text-[11px] text-stone-400">
              Mission <span className="text-red-400">*</span>
            </Label>
            <Select value={createMissionId} onValueChange={setCreateMissionId}>
              <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-200 text-xs h-8">
                <SelectValue placeholder="Chọn mission…" />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {missions.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No missions available
                  </SelectItem>
                ) : (
                  missions.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.code} · {m.missionType}/{m.tier || '?'} · {m.status} ·{' '}
                      {(m.title || '(no title)').slice(0, 40)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-stone-400">
              Title <span className="text-red-400">*</span>
            </Label>
            <Input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="VD: Optimize chat latency p95"
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-stone-400">
              Summary <span className="text-red-400">*</span>
            </Label>
            <Textarea
              value={createSummary}
              onChange={(e) => setCreateSummary(e.target.value)}
              placeholder="1-2 câu mô tả proposal (what + why)"
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[60px] resize-y"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-stone-400">
              Changes <span className="text-red-400">*</span>{' '}
              <span className="text-stone-600">(1 per line)</span>
            </Label>
            <Textarea
              value={createChanges}
              onChange={(e) => setCreateChanges(e.target.value)}
              placeholder={'change timeout 30m→8m\nadd retry logic'}
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[60px] resize-y font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-stone-400">
              Verification Plan <span className="text-red-400">*</span>{' '}
              <span className="text-stone-600">(1 per line)</span>
            </Label>
            <Textarea
              value={createVerification}
              onChange={(e) => setCreateVerification(e.target.value)}
              placeholder={'manual test latency\nbenchmark p95<10s'}
              className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[60px] resize-y font-mono"
            />
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating}
            className="w-full bg-violet-600 hover:bg-violet-500 text-white text-xs h-9"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-2" />
            )}
            Create DRAFT Proposal
          </Button>
          <div className="text-[10px] text-stone-500 italic">
            Proposal tạo ở trạng thái DRAFT — click "Submit" trong list để tạo branch + timeoutAt.
          </div>
        </CardContent>
      </Card>

      {/* List */}
      <Card className="lg:col-span-3 bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">
              Proposals{' '}
              <Badge variant="outline" className="ml-1 text-[10px] border-stone-700 text-stone-400">
                {total}
              </Badge>
            </CardTitle>
            <button
              onClick={() => void fetchProposals()}
              className="text-[11px] text-stone-400 hover:text-stone-200 inline-flex items-center gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${listLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex items-center gap-1 text-[10px] text-stone-400">
              <Filter className="h-3 w-3" /> Filter:
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-300 text-xs h-7 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="DRAFT">DRAFT</SelectItem>
                <SelectItem value="SUBMITTED">SUBMITTED</SelectItem>
                <SelectItem value="APPROVED">APPROVED</SelectItem>
                <SelectItem value="REJECTED">REJECTED</SelectItem>
                <SelectItem value="APPLIED">APPLIED</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full bg-stone-900/60" />
              ))}
            </div>
          ) : listError ? (
            <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Fetch failed</AlertTitle>
              <AlertDescription className="text-xs">{listError}</AlertDescription>
            </Alert>
          ) : filteredProposals.length === 0 ? (
            <div className="text-xs text-stone-500 italic py-8 text-center">
              Không có proposal nào.
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <div className="space-y-1.5 pr-2">
                {filteredProposals.map((p) => {
                  const schema = p.schema
                  const expired = isExpired(p.timeoutAt)
                  const isSubmitted = p.status === 'SUBMITTED'
                  return (
                    <div
                      key={p.id}
                      className="rounded-md border border-stone-800 bg-stone-900/40 p-3"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <code className="text-[10px] text-stone-300 font-mono">{p.code}</code>
                          <Badge className={`text-[10px] h-5 ${statusBadgeClass(p.status)}`}>
                            {p.status}
                          </Badge>
                          {isSubmitted && expired && (
                            <Badge variant="outline" className="text-[10px] h-5 border-amber-500/40 text-amber-300 bg-amber-500/10">
                              <Clock className="h-2.5 w-2.5 mr-0.5" />
                              TIMEOUT
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {p.status === 'DRAFT' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleSubmit(p)}
                              className="h-6 px-2 text-[10px] border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
                            >
                              Submit
                            </Button>
                          )}
                          {isSubmitted && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setReviewProposal(p)
                                setReviewReviewedBy('user')
                                setReviewReason('')
                              }}
                              className="h-6 px-2 text-[10px] border-violet-500/40 text-violet-300 hover:bg-violet-500/10"
                            >
                              Review
                            </Button>
                          )}
                          {/* TASK 3-fix WORK 7f: Apply button khi APPROVED */}
                          {p.status === 'APPROVED' && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={applyingId === p.id}
                              onClick={() => void handleApply(p)}
                              className="h-6 px-2 text-[10px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                              title="POST /apply — merge branch + bridge self-direction"
                            >
                              {applyingId === p.id ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <CheckCircle2 className="h-3 w-3 mr-1" />
                              )}
                              Apply
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-stone-200 font-medium mb-0.5">
                        {schema?.title || <span className="text-stone-500 italic">(no title)</span>}
                      </div>
                      {schema?.summary && (
                        <div className="text-[11px] text-stone-400 line-clamp-2 mb-1">{schema.summary}</div>
                      )}
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-stone-500">
                        <div>Branch: <code className="text-stone-400">{p.branchName}</code></div>
                        <div>Mission: <code className="text-stone-400">{p.missionId.slice(-12)}</code></div>
                        {p.reviewedBy && <div>By: <code className="text-stone-400">{p.reviewedBy}</code></div>}
                        {p.decidedAt && (
                          <div>Decided: {p.decidedAt.slice(0, 10)}</div>
                        )}
                        {isSubmitted && (
                          <div className="col-span-2">
                            Timeout: <span className={expired ? 'text-amber-300' : 'text-stone-400'}>
                              {p.timeoutAt.slice(0, 19).replace('T', ' ')}
                            </span>
                          </div>
                        )}
                      </div>
                      {p.diffSummary && (
                        <div className="text-[10px] text-red-300 italic mt-1">
                          {p.diffSummary}
                        </div>
                      )}
                      {isSubmitted && expired && (
                        <div className="text-[10px] text-amber-300 mt-1">
                          ⚠ TIMEOUT — deputy có thể duyệt: <code className="text-stone-300">deputy:SIVIL</code> (research domain)
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Review Dialog */}
      <Dialog open={!!reviewProposal} onOpenChange={(open) => !open && setReviewProposal(null)}>
        <DialogContent className="bg-stone-950 border-stone-800 text-stone-200 max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm text-stone-100 flex items-center gap-2">
              <FileText className="h-4 w-4 text-violet-400" />
              Review Proposal{' '}
              {reviewProposal && (
                <code className="text-[11px] text-stone-400 font-mono">{reviewProposal.code}</code>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-stone-400">
              DR-C5 §C5: KING cấm tự duyệt. TC-11: REJECT reason BẮT BUỘC.
            </DialogDescription>
          </DialogHeader>

          {reviewProposal?.schema && (
            <ScrollArea className="flex-1 max-h-[50vh] pr-2">
              <div className="space-y-2 text-xs">
                <div>
                  <div className="text-[10px] text-violet-400 uppercase">Title</div>
                  <div className="text-stone-200">{reviewProposal.schema.title}</div>
                </div>
                <div>
                  <div className="text-[10px] text-violet-400 uppercase">Summary</div>
                  <div className="text-stone-300">{reviewProposal.schema.summary}</div>
                </div>
                <Separator className="bg-stone-800" />
                <div>
                  <div className="text-[10px] text-emerald-400 uppercase">Changes</div>
                  <ul className="text-stone-300 list-disc list-inside space-y-0.5">
                    {reviewProposal.schema.changes.map((c, i) => (
                      <li key={i} className="text-[11px]">{c}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[10px] text-cyan-400 uppercase">Verification Plan</div>
                  <ul className="text-stone-300 list-disc list-inside space-y-0.5">
                    {reviewProposal.schema.verificationPlan.map((v, i) => (
                      <li key={i} className="text-[11px]">{v}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </ScrollArea>
          )}

          <Separator className="bg-stone-800 my-2" />

          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-stone-400">
                Reviewed By <span className="text-red-400">*</span>
              </Label>
              <Input
                value={reviewReviewedBy}
                onChange={(e) => setReviewReviewedBy(e.target.value)}
                placeholder="user | deputy:SIVIL | deputy:HAN (KING blocked)"
                className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs h-8"
              />
              <p className="text-[10px] text-stone-500">
                DR-C5: reviewedBy='KING' → 400. Deputy 'deputy:SIVIL'/'deputy:HAN' chỉ valid khi proposal timeout.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-stone-400">
                Reason (REJECT — BẮT BUỘC){' '}
                <span className="text-stone-600">(ignored for APPROVE)</span>
              </Label>
              <Textarea
                value={reviewReason}
                onChange={(e) => setReviewReason(e.target.value)}
                placeholder="Lý do reject — TC-11 non-empty required"
                className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[50px] resize-y"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2 mt-2">
            <Button
              size="sm"
              variant="outline"
              disabled={reviewing !== null || !reviewReviewedBy.trim()}
              onClick={() => void handleReview('APPROVE')}
              className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs h-9"
            >
              {reviewing === 'APPROVE' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <ThumbsUp className="h-3.5 w-3.5 mr-1.5" />
              )}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                reviewing !== null ||
                !reviewReviewedBy.trim() ||
                !reviewReason.trim()
              }
              onClick={() => void handleReview('REJECT')}
              className="border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs h-9"
            >
              {reviewing === 'REJECT' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <ThumbsDown className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReviewProposal(null)}
              className="text-stone-400 hover:text-stone-200 text-xs h-9"
            >
              Cancel
            </Button>
          </DialogFooter>

          <Alert className="bg-stone-900/40 border-stone-800 py-2">
            <CheckCircle2 className="h-3 w-3 text-stone-500" />
            <AlertDescription className="text-[10px] text-stone-500">
              APPROVE → bridge to self-direction (apply có thể fail orchestrator/git, không ảnh hưởng status APPROVED).
              REJECT → diffSummary ghi reason; TC-11 gate enforced server-side (400 nếu reason empty).
            </AlertDescription>
          </Alert>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export { ProposalReview as default }
