'use client'

/**
 * Self-Direction Module — Task 5 (frontend-styling-expert)
 *
 * UI cho pipeline "tự chủ" của hệ thống TMO:
 *   - Agents tự quét hệ thống (khoảng trống / KB mâu thuẫn / tool hay fail /
 *     thiếu skill / thiếu test / cải tiến / dài hạn) → tạo "đề xuất" (proposal).
 *   - Đề xuất chờ Mr. Architect phê duyệt — hoặc ủy quyền cho Opus duyệt thay
 *     (Switch "Ủy quyền duyệt cho Opus" — user decision #3: chuyển từ Omega
 *     sang Opus CTO; orchestration/implementation vẫn của Omega).
 *   - Được duyệt → Omega lập kế hoạch từng bước, giao agents thực hiện, đánh giá
 *     và viết báo cáo hoàn thiện — xem trong Detail Dialog.
 *
 * API contract (backend /api/self-direction/*):
 *   GET    /api/self-direction/proposals           → { proposals, settings }
 *   GET    /api/self-direction/proposals/{id}      → { proposal, steps }
 *   PATCH  /api/self-direction/proposals/{id}      → { proposal }  (approve|reject|notes|reschedule)
 *   POST   /api/self-direction/delegation          → { settings }  ({ enabled })
 *   POST   /api/self-direction/scan                → { created, proposals }
 *   POST   /api/self-direction/proposals/{id}/deploy → { ok, proposal }
 *
 * Poll GET /api/self-direction/proposals mỗi 4s (cleanup khi unmount — không leak).
 * Fail-open: lỗi poll nền → giữ dữ liệu cũ + banner cảnh báo (KHÔNG toast spam);
 * lỗi fetch chủ động (lần đầu / refresh thủ công) → toast destructive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CheckCircle2,
  Compass,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Lightbulb,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  RotateCcw,
  Route,
  Sparkles,
  Target,
  TrendingUp,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ==================== Types (mirror API contract — prefix `Sd` tránh trùng Prisma model) ====================

export type SdCategory =
  | 'gap'
  | 'kb_contradiction'
  | 'tool_failure'
  | 'missing_skill'
  | 'missing_test'
  | 'improvement'
  | 'long_term'
  | 'automation'

export type SdPriority = 'low' | 'medium' | 'high' | 'critical'

export type SdStatus =
  | 'pending'
  | 'approved'
  | 'ready'
  | 'planning'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rejected'

export type SdStepStatus = 'pending' | 'in_progress' | 'done' | 'failed'

export interface SdProposal {
  id: string
  title: string
  category: SdCategory
  priority: SdPriority
  problem: string
  solution: string
  implementation: string
  scheduleAt: string | null
  impact: string | null
  status: SdStatus
  source: string
  createdBy: string
  /** CI-6 B5: llm | code-workflow (optional — API cũ có thể thiếu field) */
  executionMode?: string | null
  userNotes: string | null
  /** Người duyệt: Mr. Architect | Opus (ủy quyền — user decision #3) | omega (dữ liệu cũ) */
  reviewer: 'mr-architect' | 'opus' | 'omega' | null
  decisionReason: string | null
  reviewedAt: string | null
  planSummary: string | null
  omegaReport: string | null
  executedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  stepCount: number
  doneSteps: number
}

export interface SdStep {
  id: string
  stepOrder: number
  title: string
  description: string | null
  assignee: string
  status: SdStepStatus
  output: string | null
  evaluation: string | null
  attempts: number
  startedAt: string | null
  finishedAt: string | null
}

export interface SdSettings {
  /** USER DECISION #3: ủy quyền duyệt chuyển Omega → Opus (cột opusDelegated) */
  opusDelegated: boolean
  delegatedAt: string | null
}

interface SdListResponse {
  proposals: SdProposal[]
  settings: SdSettings
}

interface SdDetailResponse {
  proposal: SdProposal
  steps: SdStep[]
}

interface SdScanResponse {
  created: number
  proposals: SdProposal[]
}

// ==================== Constants ====================

const POLL_INTERVAL_MS = 4_000

type HistoryFilter = 'all' | 'approved' | 'rejected' | 'failed'

const CATEGORY_META: Record<SdCategory, { label: string; icon: LucideIcon }> = {
  gap: { label: 'Khoảng trống', icon: Target },
  kb_contradiction: { label: 'KB mâu thuẫn', icon: AlertTriangle },
  tool_failure: { label: 'Tool hay fail', icon: Wrench },
  missing_skill: { label: 'Thiếu skill', icon: Sparkles },
  missing_test: { label: 'Thiếu test', icon: FlaskConical },
  improvement: { label: 'Cải tiến', icon: TrendingUp },
  long_term: { label: 'Dài hạn', icon: Route },
  // AUTOMATION (user request 2026-09-13): đề xuất cron job / webhook /
  // standing order / task flow do agent gửi qua propose_automation (Omega
  // forward) — được duyệt → tài nguyên tự tạo trong Smolab > Automation.
  automation: { label: 'Tự động hóa', icon: Zap },
}

const PRIORITY_META: Record<SdPriority, { label: string; className: string }> = {
  critical: { label: 'Nghiêm trọng', className: 'bg-red-950/60 text-red-300 border-red-500/40' },
  high: { label: 'Cao', className: 'bg-orange-950/60 text-orange-300 border-orange-500/40' },
  medium: { label: 'Trung bình', className: 'bg-amber-950/60 text-amber-300 border-amber-500/40' },
  low: { label: 'Thấp', className: 'bg-stone-900/60 text-stone-300 border-stone-600/40' },
}

const PRIORITY_RANK: Record<SdPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const STATUS_META: Record<SdStatus, { label: string; className: string }> = {
  pending: { label: 'Chờ duyệt', className: 'bg-stone-900/60 text-stone-300 border-stone-600/50' },
  approved: { label: 'Đã duyệt', className: 'bg-amber-950/60 text-amber-300 border-amber-500/40' },
  ready: { label: 'Đến hạn triển khai', className: 'bg-amber-950/60 text-amber-300 border-amber-500/40 animate-pulse' },
  planning: { label: 'Omega đang lập kế hoạch', className: 'bg-violet-950/60 text-violet-300 border-violet-500/40' },
  executing: { label: 'Đang triển khai', className: 'bg-violet-950/60 text-violet-300 border-violet-500/40 animate-pulse' },
  completed: { label: 'Hoàn tất', className: 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40' },
  rejected: { label: 'Không duyệt', className: 'bg-stone-900/60 text-stone-400 border-stone-700' },
  failed: { label: 'Thất bại', className: 'bg-red-950/60 text-red-300 border-red-500/40' },
}

const STEP_STATUS_META: Record<SdStepStatus, { label: string; className: string }> = {
  done: { label: 'Xong', className: 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40' },
  in_progress: { label: 'Đang chạy', className: 'bg-violet-950/60 text-violet-300 border-violet-500/40' },
  failed: { label: 'Thất bại', className: 'bg-red-950/60 text-red-300 border-red-500/40' },
  pending: { label: 'Chờ', className: 'bg-stone-900/60 text-stone-400 border-stone-700' },
}

/** Status tính là "đã duyệt" cho filter Lịch sử */
const APPROVED_LIKE: readonly SdStatus[] = ['approved', 'ready', 'planning', 'executing', 'completed']

// ==================== Helpers ====================

/** Format ISO → "dd/MM/yyyy HH:mm" */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? false : Date.now() < t
}

/** Dòng đầu của text (markdown report) — dùng làm snippet truncate */
function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

async function readApiError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: string }
  return data.details || data.error || `HTTP ${res.status}`
}

// ==================== Small sub-components (module-level — identity ổn định) ====================

function CategoryBadge({ category, compact = false }: { category: SdCategory; compact?: boolean }) {
  const meta = CATEGORY_META[category] ?? { label: category, icon: Sparkles }
  const Icon = meta.icon
  return (
    <Badge
      variant="outline"
      className={`bg-slate-950/60 text-stone-300 border-stone-600/50 ${compact ? 'text-[9px] h-4 px-1.5' : 'text-[10px]'}`}
    >
      <Icon className="h-3 w-3 text-amber-400/80" />
      {meta.label}
    </Badge>
  )
}

function PriorityBadge({ priority, compact = false }: { priority: SdPriority; compact?: boolean }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.low
  return (
    <Badge
      variant="outline"
      className={`${meta.className} ${compact ? 'text-[9px] h-4 px-1.5' : 'text-[10px]'}`}
    >
      {meta.label}
    </Badge>
  )
}

function StatusBadge({ status }: { status: SdStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending
  return (
    <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
      {status === 'planning' && <Loader2 className="h-3 w-3 animate-spin" />}
      {meta.label}
    </Badge>
  )
}

function ReviewerBadge({ reviewer }: { reviewer: 'mr-architect' | 'opus' | 'omega' }) {
  // USER DECISION #3: Opus duyệt thay Mr. Architect khi ủy quyền bật;
  // 'omega' chỉ còn ở dữ liệu lịch sử (được duyệt trước 2026-09-30).
  if (reviewer.toLowerCase() === 'opus') {
    return (
      <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/40 text-amber-300 bg-amber-950/30">
        Duyệt: Opus (ủy quyền)
      </Badge>
    )
  }
  if (reviewer.toLowerCase() === 'omega') {
    return (
      <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/40 text-amber-300 bg-amber-950/30">
        Duyệt: Omega (ủy quyền cũ)
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-stone-600 text-stone-300 bg-slate-950/50">
      Duyệt: Mr. Architect
    </Badge>
  )
}

function StepStatusBadge({ status }: { status: SdStepStatus }) {
  const meta = STEP_STATUS_META[status] ?? STEP_STATUS_META.pending
  return (
    <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${meta.className}`}>
      {meta.label}
    </Badge>
  )
}

/** CI-6 B5: badge đề xuất chạy chế độ code-workflow (thực thi code thật + pipeline kiểm định) */
function CodeWorkflowBadge({ compact = false }: { compact?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={`bg-amber-950/30 text-amber-300 border-amber-500/40 ${compact ? 'text-[9px] h-4 px-1.5' : 'text-[10px]'}`}
      title="Đề xuất thực thi CODE THẬT trong workspace: agents sửa file qua tool executor + bước cuối chạy pipeline kiểm định 9 bước (lint → typecheck → tests → smoke → secret-scan → commit → push → pull)"
    >
      <GitBranch className="h-3 w-3" />
      Code-workflow
    </Badge>
  )
}

/** Block thông tin: label uppercase nhỏ + nội dung whitespace-pre-wrap */
function InfoBlock({ label, content }: { label: string; content: string }) {
  return (
    <div className="space-y-1 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-stone-500">{label}</p>
      <p className="text-xs text-stone-300 whitespace-pre-wrap break-words">{content}</p>
    </div>
  )
}

/** 1 bước triển khai trong timeline của Detail Dialog */
function StepItem({
  step,
  outputOpen,
  onToggleOutput,
}: {
  step: SdStep
  outputOpen: boolean
  onToggleOutput: (stepId: string) => void
}) {
  const borderClass =
    step.status === 'done'
      ? 'border-emerald-500/60'
      : step.status === 'in_progress'
        ? 'border-violet-400/60'
        : step.status === 'failed'
          ? 'border-red-500/60'
          : 'border-stone-700'

  return (
    <div className={`border-l-2 pl-3 py-0.5 space-y-1.5 ${borderClass}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-medium text-stone-100">
          Bước {step.stepOrder}: {step.title}
        </p>
        <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-slate-950/50 text-stone-300 border-stone-600/50">
          <Bot className="h-3 w-3 text-cyan-400/70" />
          {step.assignee}
        </Badge>
        <StepStatusBadge status={step.status} />
        {step.attempts > 1 && (
          <span className="text-[10px] text-amber-400/80">thử lại {step.attempts} lần</span>
        )}
      </div>

      {step.description && (
        <p className="text-xs text-stone-400 whitespace-pre-wrap">{step.description}</p>
      )}

      {step.output && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => onToggleOutput(step.id)}
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            Output {outputOpen ? '▾' : '▸'}
          </button>
          {outputOpen && (
            <div className="bg-slate-900/50 p-2 rounded text-xs text-stone-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">
              {step.output}
            </div>
          )}
        </div>
      )}

      {step.evaluation && (() => {
        // FIX 2026-09-02 (Omega audit #4): evaluation có thể do OPUS chấm khi
        // ủy quyền bật (user decision #3) — orchestrator ghi marker "[Tên] "
        // đầu chuỗi. Đọc marker để hiển thị đúng người chấm thay vì hardcode
        // "Omega"; dữ liệu cũ không marker → mặc định Omega (tương thích ngược).
        const markerMatch = step.evaluation.match(/^\[([^\]]{1,24})\]\s*/)
        const evaluator = markerMatch?.[1] ?? 'Omega'
        const evaluationText = markerMatch
          ? step.evaluation.slice(markerMatch[0].length)
          : step.evaluation
        return (
          <p className="text-xs text-amber-300/80 whitespace-pre-wrap">
            Đánh giá của {evaluator}: {evaluationText}
          </p>
        )
      })()}
    </div>
  )
}

// ==================== Component chính ====================

export default function SelfDirectionModule() {
  // ----- Data -----
  const [proposals, setProposals] = useState<SdProposal[]>([])
  const [settings, setSettings] = useState<SdSettings>({ opusDelegated: false, delegatedAt: null })
  const [loading, setLoading] = useState(true) // lần fetch đầu
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ----- Actions -----
  const [scanning, setScanning] = useState(false)
  const [delegating, setDelegating] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const busyRef = useRef<Record<string, boolean>>({})

  // ----- Flash "Đã lưu ✓" per-proposal (show → fade → remove) -----
  const [savedFlash, setSavedFlash] = useState<Record<string, 'show' | 'fade'>>({})
  const flashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>[]>>({})

  // ----- Lịch sử filter -----
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')

  // ----- Detail dialog -----
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailHeader, setDetailHeader] = useState<SdProposal | null>(null) // từ list — có ngay khi mở dialog
  const [detail, setDetail] = useState<SdDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailNonce, setDetailNonce] = useState(0) // retry
  const [openOutputs, setOpenOutputs] = useState<Record<string, boolean>>({})

  // ==================== Fetch + poll ====================

  const fetchList = useCallback(async (background = false) => {
    try {
      const res = await fetch('/api/self-direction/proposals', { cache: 'no-store' })
      if (!res.ok) throw new Error(await readApiError(res))
      const data = (await res.json()) as SdListResponse
      setProposals(Array.isArray(data.proposals) ? data.proposals : [])
      if (data.settings) setSettings(data.settings)
      setLoadError(null)
    } catch (err) {
      const msg = errMsg(err, 'Không thể tải danh sách đề xuất')
      setLoadError(msg)
      // Poll nền fail-open (giữ dữ liệu cũ, banner cảnh báo) — KHÔNG toast spam 4s/lần
      if (!background) {
        toast({ title: 'Lỗi tải đề xuất', description: msg, variant: 'destructive' })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      if (!cancelled) void fetchList(true)
    }
    queueMicrotask(() => {
      if (!cancelled) void fetchList()
    })
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [fetchList])

  // Dọn flash timers khi unmount — không leak
  useEffect(() => {
    const timersById = flashTimersRef.current
    return () => {
      Object.values(timersById).forEach((timers) => timers.forEach(clearTimeout))
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await fetchList()
    } finally {
      setRefreshing(false)
    }
  }, [fetchList])

  // ==================== Busy helpers ====================

  const markBusy = useCallback((key: string) => {
    busyRef.current[key] = true
    setBusy((prev) => ({ ...prev, [key]: true }))
  }, [])

  const clearBusy = useCallback((key: string) => {
    busyRef.current[key] = false
    setBusy((prev) => ({ ...prev, [key]: false }))
  }, [])

  // ==================== Ghi chú Mr. Architect (auto-save onBlur) ====================

  const markSaved = useCallback((id: string) => {
    setSavedFlash((prev) => ({ ...prev, [id]: 'show' }))
    const timers = flashTimersRef.current[id]
    if (timers) timers.forEach(clearTimeout)
    // 1.6s sau bắt đầu fade (transition-opacity 700ms), rồi remove khỏi DOM
    const t1 = setTimeout(() => {
      setSavedFlash((prev) => (prev[id] ? { ...prev, [id]: 'fade' } : prev))
      const t2 = setTimeout(() => {
        setSavedFlash((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }, 800)
      flashTimersRef.current[id] = [t2]
    }, 1_600)
    flashTimersRef.current[id] = [t1]
  }, [])

  const saveNotes = useCallback(
    async (p: SdProposal, value: string) => {
      if (value === (p.userNotes ?? '')) return
      try {
        const res = await fetch(`/api/self-direction/proposals/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'notes', notes: value }),
        })
        if (!res.ok) throw new Error(await readApiError(res))
        const data = (await res.json()) as { proposal: SdProposal }
        if (data.proposal) {
          const updated = data.proposal
          setProposals((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
        }
        markSaved(p.id)
      } catch (err) {
        toast({
          title: 'Không lưu được ghi chú',
          description: errMsg(err, 'Lưu ghi chú thất bại'),
          variant: 'destructive',
        })
      }
    },
    [markSaved],
  )

  // ==================== Duyệt / Hủy ====================

  const patchProposalAction = useCallback(
    async (p: SdProposal, action: 'approve' | 'reject') => {
      const key = `${action}:${p.id}`
      if (busyRef.current[key]) return
      markBusy(key)
      try {
        const res = await fetch(`/api/self-direction/proposals/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (!res.ok) throw new Error(await readApiError(res))
        const data = (await res.json()) as { proposal: SdProposal }
        if (data.proposal) {
          const updated = data.proposal
          setProposals((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
        }
        if (action === 'approve') {
          const future = isFuture(p.scheduleAt)
          toast({
            title: 'Đã duyệt',
            description: future
              ? `Sẽ triển khai lúc ${fmtDateTime(p.scheduleAt)}`
              : 'Omega bắt đầu triển khai',
          })
        } else {
          toast({ title: 'Đã từ chối đề xuất' })
        }
        void fetchList(true)
      } catch (err) {
        toast({
          title: action === 'approve' ? 'Không duyệt được đề xuất' : 'Không từ chối được đề xuất',
          description: errMsg(err, 'Thao tác thất bại'),
          variant: 'destructive',
        })
      } finally {
        clearBusy(key)
      }
    },
    [markBusy, clearBusy, fetchList],
  )

  // ==================== Deploy ngay / Thử lại ====================

  const deployProposal = useCallback(
    async (p: SdProposal) => {
      const key = `deploy:${p.id}`
      if (busyRef.current[key]) return
      markBusy(key)
      try {
        const res = await fetch(`/api/self-direction/proposals/${p.id}/deploy`, { method: 'POST' })
        if (!res.ok) throw new Error(await readApiError(res))
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; proposal?: SdProposal }
        if (data.proposal) {
          const updated = data.proposal
          setProposals((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
        }
        toast({
          title: 'Đã kích hoạt triển khai',
          description: 'Omega bắt đầu triển khai đề xuất này',
        })
        void fetchList(true)
      } catch (err) {
        toast({
          title: 'Triển khai thất bại',
          description: errMsg(err, 'Không kích hoạt được triển khai'),
          variant: 'destructive',
        })
      } finally {
        clearBusy(key)
      }
    },
    [markBusy, clearBusy, fetchList],
  )

  // ==================== Quét hệ thống ====================

  const runScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    try {
      const res = await fetch('/api/self-direction/scan', { method: 'POST' })
      if (!res.ok) throw new Error(await readApiError(res))
      const data = (await res.json()) as SdScanResponse
      const created = data.created ?? 0
      if (created > 0) {
        toast({ title: `Tạo ${created} đề xuất mới` })
      } else {
        toast({ title: 'Không có đề xuất mới', description: 'Quét hoàn tất — hệ thống chưa phát hiện khoảng trống cần xử lý' })
      }
      void fetchList(true)
    } catch (err) {
      toast({
        title: 'Quét hệ thống thất bại',
        description: errMsg(err, 'Không quét được hệ thống'),
        variant: 'destructive',
      })
    } finally {
      setScanning(false)
    }
  }, [scanning, fetchList])

  // ==================== Ủy quyền duyệt cho Opus (user decision #3) ====================

  const toggleDelegation = useCallback(
    async (enabled: boolean) => {
      const prevSettings = settings
      setDelegating(true)
      setSettings((prev) => ({ ...prev, opusDelegated: enabled })) // optimistic
      try {
        const res = await fetch('/api/self-direction/delegation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) throw new Error(await readApiError(res))
        const data = (await res.json()) as { settings: SdSettings }
        if (data.settings) setSettings(data.settings)
        toast({
          title: enabled ? 'Đã bật ủy quyền duyệt cho Opus' : 'Đã tắt ủy quyền duyệt',
          description: enabled
            ? 'Opus sẽ tự phê duyệt các đề xuất mới thay Mr. Architect'
            : 'Các đề xuất quay lại chờ Mr. Architect phê duyệt',
        })
      } catch (err) {
        setSettings(prevSettings) // revert
        toast({
          title: 'Không đổi được cài đặt ủy quyền',
          description: errMsg(err, 'Cập nhật ủy quyền thất bại'),
          variant: 'destructive',
        })
      } finally {
        setDelegating(false)
      }
    },
    [settings],
  )

  // ==================== Detail dialog ====================

  // Reset + mở dialog — mọi setState reset nằm trong EVENT HANDLER
  // (không setState sync trong effect body — rule react-hooks/set-state-in-effect)
  const openDetail = useCallback((p: SdProposal) => {
    setDetailHeader(p)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    setOpenOutputs({})
    setDetailId(p.id)
  }, [])

  const closeDetail = useCallback(() => {
    setDetailId(null)
    setDetailError(null)
    setDetailLoading(false)
  }, [])

  const retryDetail = useCallback(() => {
    setDetailError(null)
    setDetailLoading(true)
    setDetailNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!detailId) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/self-direction/proposals/${detailId}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(await readApiError(res))
        const data = (await res.json()) as SdDetailResponse
        if (cancelled) return
        setDetail(data)
        if (data.proposal) setDetailHeader(data.proposal)
      } catch (err) {
        if (cancelled) return
        const msg = errMsg(err, 'Không tải được chi tiết đề xuất')
        setDetailError(msg)
        toast({ title: 'Lỗi tải chi tiết', description: msg, variant: 'destructive' })
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [detailId, detailNonce])

  const toggleOutput = useCallback((stepId: string) => {
    setOpenOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }))
  }, [])

  // ==================== Derived ====================

  const pendingProposals = useMemo(
    () =>
      proposals
        .filter((p) => p.status === 'pending')
        .sort((a, b) => {
          const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
          if (rank !== 0) return rank
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        }),
    [proposals],
  )

  const historyProposals = useMemo(
    () =>
      proposals
        .filter((p) => p.status !== 'pending')
        .filter((p) => {
          if (historyFilter === 'all') return true
          if (historyFilter === 'approved') return APPROVED_LIKE.includes(p.status)
          if (historyFilter === 'rejected') return p.status === 'rejected'
          return p.status === 'failed'
        })
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [proposals, historyFilter],
  )

  const sortedSteps = useMemo(() => {
    if (!detail?.steps) return []
    return [...detail.steps].sort((a, b) => (a.stepOrder ?? 0) - (b.stepOrder ?? 0))
  }, [detail])

  // ==================== Render ====================

  return (
    <div className="nc-wrap nc-amber nc-corner-glow">
      <Card className="nc-panel nc-md nc-border-amber">
        <CardContent className="pt-5 pb-5 space-y-4">
          {/* ===== Header: icon + title + controls ===== */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-1.5 rounded-lg bg-amber-950/50 border border-amber-500/30 flex-shrink-0">
                <Compass className="h-4 w-4 text-amber-400" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold tracking-tight text-stone-100">SELF-DIRECTION</h2>
                <p className="text-[10px] text-stone-500 truncate">
                  Tự phát hiện khoảng trống • Đề xuất chờ Mr. Architect phê duyệt
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                size="sm"
                className="h-8 px-3 text-xs bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold border-0"
                onClick={() => void runScan()}
                disabled={scanning}
              >
                {scanning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radar className="h-3.5 w-3.5" />
                )}
                {scanning ? 'Đang quét...' : 'Quét hệ thống'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 border-amber-400/35 text-amber-400 hover:bg-amber-950/30"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                aria-label="Tải lại danh sách đề xuất"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* ===== Ủy quyền duyệt cho Opus (user decision #3: chuyển từ Omega sang Opus CTO) ===== */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-slate-950/40 border border-stone-800/80 px-3 py-2">
            <Switch
              id="sd-opus-delegation"
              checked={settings.opusDelegated}
              onCheckedChange={(checked) => void toggleDelegation(checked)}
              disabled={delegating}
            />
            <label
              htmlFor="sd-opus-delegation"
              className="text-xs text-stone-300 select-none cursor-pointer"
            >
              Ủy quyền duyệt cho Opus
            </label>
            {delegating && <Loader2 className="h-3 w-3 animate-spin text-amber-400" />}
            {settings.opusDelegated && (
              <Badge variant="outline" className="text-[10px] border-amber-400/40 text-amber-300">
                ⚖️ Opus duyệt thay Mr. Architect
              </Badge>
            )}
          </div>

          {/* ===== Body ===== */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14">
              <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
              <span className="text-sm text-stone-400">Đang tải...</span>
            </div>
          ) : loadError && proposals.length === 0 ? (
            /* Error state — pattern AgentsModule */
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/40 mb-4">
                <AlertTriangle className="h-9 w-9 text-red-400/70" />
              </div>
              <p className="text-sm text-red-400 font-medium mb-1">Không thể tải danh sách đề xuất</p>
              <p className="text-xs text-stone-500 max-w-md mb-4">{loadError}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-4 text-xs border-amber-400/35 text-amber-400 hover:bg-amber-950/30"
                onClick={() => {
                  setLoading(true)
                  void fetchList()
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Thử lại
              </Button>
            </div>
          ) : (
            <>
              {/* Fail-open banner: có dữ liệu cũ nhưng poll đang lỗi */}
              {loadError && proposals.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  Mất kết nối tới API — hiển thị dữ liệu cũ (fail-open, poll lại sau 4s)
                </div>
              )}

              <Tabs defaultValue="pending" className="w-full">
                <TabsList className="bg-slate-950/60 border border-stone-800/80 h-9 w-full sm:w-auto">
                  <TabsTrigger value="pending" className="text-xs">
                    Chờ phê duyệt ({pendingProposals.length})
                  </TabsTrigger>
                  <TabsTrigger value="history" className="text-xs">
                    Lịch sử
                  </TabsTrigger>
                </TabsList>

                {/* ==================== TAB 1: Chờ phê duyệt ==================== */}
                <TabsContent value="pending" className="space-y-3">
                  {pendingProposals.length === 0 ? (
                    <Card className="border-dashed border-amber-400/25 bg-slate-950/20 p-6">
                      <div className="flex flex-col items-center text-center gap-2">
                        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-400/25 mb-1">
                          <Lightbulb className="h-6 w-6 text-amber-400/60" />
                        </div>
                        <p className="text-sm text-stone-300">Không có đề xuất nào chờ duyệt</p>
                        <p className="text-xs text-stone-500 max-w-sm">
                          Hệ thống đang đầy đủ — bấm{' '}
                          <span className="text-amber-300 font-medium">&quot;Quét hệ thống&quot;</span>{' '}
                          để agents tự kiểm tra và đề xuất cải tiến
                        </p>
                      </div>
                    </Card>
                  ) : (
                    pendingProposals.map((p) => {
                      const approving = !!busy[`approve:${p.id}`]
                      const rejecting = !!busy[`reject:${p.id}`]
                      const proposalBusy = approving || rejecting
                      return (
                        <Card key={p.id} className="border-stone-700/60 bg-slate-950/40 p-4 gap-3">
                          {/* Hàng badge + nguồn */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <CategoryBadge category={p.category} />
                            <PriorityBadge priority={p.priority} />
                            {p.executionMode === 'code-workflow' && <CodeWorkflowBadge />}
                            <span className="text-[10px] text-stone-500 ml-auto">
                              {p.source}/{p.createdBy} • {fmtDateTime(p.createdAt)}
                            </span>
                          </div>

                          {/* Tiêu đề */}
                          <h3 className="text-sm font-semibold text-stone-100 break-words">{p.title}</h3>

                          {/* 4 block thông tin */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                            <InfoBlock label="VẤN ĐỀ LÀ GÌ?" content={p.problem} />
                            <InfoBlock label="GIẢI QUYẾT NHƯ THẾ NÀO?" content={p.solution} />
                            <InfoBlock label="TRIỂN KHAI NHƯ THẾ NÀO?" content={p.implementation} />
                            <div className="space-y-3">
                              <InfoBlock
                                label="THỜI ĐIỂM TRIỂN KHAI?"
                                content={p.scheduleAt ? fmtDateTime(p.scheduleAt) : 'Ngay khi được duyệt'}
                              />
                              {p.impact && <InfoBlock label="TÁC ĐỘNG KỲ VỌNG" content={p.impact} />}
                            </div>
                          </div>

                          {/* Ghi chú Mr. Architect — auto-save onBlur */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 min-h-4">
                              <label className="text-[10px] uppercase tracking-wider text-stone-500">
                                Ghi chú của Mr. Architect (ý kiến, yêu cầu bổ sung)
                              </label>
                              {savedFlash[p.id] && (
                                <span
                                  className={`text-[10px] text-emerald-400 transition-opacity duration-700 ${
                                    savedFlash[p.id] === 'fade' ? 'opacity-0' : 'opacity-100'
                                  }`}
                                >
                                  Đã lưu ✓
                                </span>
                              )}
                            </div>
                            <Textarea
                              defaultValue={p.userNotes ?? ''}
                              placeholder="Thêm ý kiến, yêu cầu bổ sung cho đề xuất này..."
                              onBlur={(e) => void saveNotes(p, e.target.value)}
                              className="min-h-16 text-xs bg-slate-950/50 border-cyan-400/35 text-stone-200 focus-visible:ring-cyan-400/30"
                            />
                          </div>

                          {/* Footer actions */}
                          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void patchProposalAction(p, 'reject')}
                              disabled={proposalBusy}
                            >
                              {rejecting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5" />
                              )}
                              Hủy
                            </Button>
                            <Button
                              size="sm"
                              className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                              onClick={() => void patchProposalAction(p, 'approve')}
                              disabled={proposalBusy}
                            >
                              {approving ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Đồng ý
                            </Button>
                          </div>
                        </Card>
                      )
                    })
                  )}
                </TabsContent>

                {/* ==================== TAB 2: Lịch sử ==================== */}
                <TabsContent value="history" className="space-y-3">
                  {/* Filter */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-stone-500">
                      {historyProposals.length} đề xuất
                    </span>
                    <Select
                      value={historyFilter}
                      onValueChange={(v) => setHistoryFilter(v as HistoryFilter)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-8 w-[150px] text-xs border-stone-700 bg-slate-950/60 text-stone-300"
                      >
                        <SelectValue placeholder="Lọc" />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-950 border-stone-700 text-stone-200">
                        <SelectItem value="all" className="text-xs">Tất cả</SelectItem>
                        <SelectItem value="approved" className="text-xs">Đã duyệt</SelectItem>
                        <SelectItem value="rejected" className="text-xs">Không duyệt</SelectItem>
                        <SelectItem value="failed" className="text-xs">Thất bại</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {historyProposals.length === 0 ? (
                    <Card className="border-dashed border-stone-700/60 bg-slate-950/20 p-6">
                      <p className="text-xs text-stone-500 text-center">
                        Chưa có đề xuất nào trong lịch sử
                      </p>
                    </Card>
                  ) : (
                    historyProposals.map((p) => {
                      const deploying = !!busy[`deploy:${p.id}`]
                      return (
                        <Card key={p.id} className="border-stone-800/80 bg-slate-950/40 p-3.5 gap-2.5">
                          {/* Hàng đầu: status + reviewer + updatedAt + Mở đề xuất */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge status={p.status} />
                            {p.reviewer && <ReviewerBadge reviewer={p.reviewer} />}
                            <span className="text-[10px] text-stone-500 ml-auto hidden sm:inline">
                              {fmtDateTime(p.updatedAt)}
                            </span>
                            {/* USER REQUEST 2026-10-15: nút "Mở đề xuất" nổi bật —
                                bấm vào đề xuất trong Lịch sử mở dialog chi tiết
                                (trước đây chỉ có nút ghost Chi tiết nhỏ, khó thấy) */}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2.5 text-[11px] border-amber-500/40 text-amber-300 hover:bg-amber-950/30 hover:text-amber-200"
                              onClick={() => openDetail(p)}
                            >
                              <ExternalLink className="h-3.5 w-3.5" /> Mở đề xuất
                            </Button>
                          </div>

                          {/* Tiêu đề (CLICKABLE — mở dialog chi tiết) + category + priority */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              className="text-xs font-semibold text-stone-100 flex-1 min-w-[160px] truncate text-left hover:text-amber-200 focus-visible:text-amber-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/50 cursor-pointer transition-colors"
                              title={`Mở chi tiết: ${p.title}`}
                              onClick={() => openDetail(p)}
                            >
                              {p.title}
                            </button>
                            {p.executionMode === 'code-workflow' && <CodeWorkflowBadge compact />}
                            <CategoryBadge category={p.category} compact />
                            <PriorityBadge priority={p.priority} compact />
                          </div>

                          {/* Lý do quyết định */}
                          {p.decisionReason && (
                            <p className="text-xs text-stone-400 italic break-words">
                              Lý do: {p.decisionReason}
                            </p>
                          )}

                          {/* Đang lập kế hoạch / triển khai → progress */}
                          {(p.status === 'planning' || p.status === 'executing') && (
                            <div className="space-y-1">
                              <Progress
                                value={p.stepCount > 0 ? Math.round((p.doneSteps / p.stepCount) * 100) : 0}
                                className="h-1.5"
                              />
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-stone-400 flex-shrink-0">
                                  Bước {p.doneSteps}/{p.stepCount}
                                </span>
                                {p.planSummary && (
                                  <span
                                    className="text-[10px] text-stone-500 truncate min-w-0"
                                    title={p.planSummary}
                                  >
                                    {p.planSummary}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Đã duyệt + hẹn lịch tương lai */}
                          {p.status === 'approved' && isFuture(p.scheduleAt) && (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs text-stone-400">
                                Sẽ triển khai: {fmtDateTime(p.scheduleAt)}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2.5 text-[11px] text-amber-300 hover:text-amber-200 hover:bg-amber-950/30"
                                onClick={() => void deployProposal(p)}
                                disabled={deploying}
                              >
                                {deploying ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                                Triển khai ngay
                              </Button>
                            </div>
                          )}

                          {/* Đến hạn triển khai */}
                          {p.status === 'ready' && (
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                className="h-7 px-2.5 text-[11px] bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                                onClick={() => void deployProposal(p)}
                                disabled={deploying}
                              >
                                {deploying ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                                Triển khai ngay
                              </Button>
                            </div>
                          )}

                          {/* Thất bại → lý do + thử lại */}
                          {p.status === 'failed' && (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs text-red-400 min-w-0 flex-1 truncate" title={p.decisionReason ?? ''}>
                                {p.decisionReason || 'Triển khai thất bại'}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2.5 text-[11px] border-red-500/40 text-red-300 hover:bg-red-950/30"
                                onClick={() => void deployProposal(p)}
                                disabled={deploying}
                              >
                                {deploying ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5" />
                                )}
                                Thử lại
                              </Button>
                            </div>
                          )}

                          {/* Hoàn tất / thất bại → snippet báo cáo + xem full
                              FIX 2026-09-02 (Omega audit #3): hiển thị báo cáo
                              cả khi proposal FAILED — writeFinalReport vẫn viết
                              phân tích thất bại có giá trị (nguyên nhân, bước
                              hỏng, đề xuất khắc phục); trước đây chỉ status
                              'completed' mới hiện → user mất thông tin. */}
                          {(p.status === 'completed' || p.status === 'failed') && p.omegaReport && (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p
                                className={`text-[11px] truncate flex-1 min-w-0 ${p.status === 'failed' ? 'text-red-400/90' : 'text-stone-400'}`}
                                title={firstLine(p.omegaReport)}
                              >
                                {firstLine(p.omegaReport)}
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className={`h-7 px-2.5 text-[11px] ${
                                  p.status === 'failed'
                                    ? 'border-red-500/40 text-red-300 hover:bg-red-950/30'
                                    : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/30'
                                }`}
                                onClick={() => openDetail(p)}
                              >
                                <BookOpen className="h-3.5 w-3.5" /> Xem báo cáo
                              </Button>
                            </div>
                          )}
                        </Card>
                      )
                    })
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}

          {/* Footer — poll status */}
          <div className="flex items-center justify-between text-[10px] text-stone-500 px-1">
            <span>Nguồn: /api/self-direction/* • Poll 4s</span>
            <span>
              {pendingProposals.length} chờ duyệt • {historyProposals.length} lịch sử
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ==================== DETAIL DIALOG (dùng chung) ==================== */}
      <Dialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail()
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto bg-slate-950 border-amber-400/35 text-stone-200 custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="text-stone-100 flex flex-wrap items-center gap-2 pr-6">
              <span className="min-w-0 break-words flex-1">
                {detailHeader?.title ?? 'Chi tiết đề xuất'}
              </span>
              {detailHeader && <StatusBadge status={detailHeader.status} />}
            </DialogTitle>
            <DialogDescription className="text-xs text-stone-400 flex flex-wrap items-center gap-1.5">
              {detailHeader && <CategoryBadge category={detailHeader.category} compact />}
              {detailHeader && <PriorityBadge priority={detailHeader.priority} compact />}
              {detailHeader?.executionMode === 'code-workflow' && <CodeWorkflowBadge compact />}
              {detailHeader?.reviewer && <ReviewerBadge reviewer={detailHeader.reviewer} />}
              {detailHeader?.reviewedAt && (
                <span>• Duyệt lúc {fmtDateTime(detailHeader.reviewedAt)}</span>
              )}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center gap-2 py-12">
              <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
              <span className="text-sm text-stone-400">Đang tải chi tiết...</span>
            </div>
          ) : detailError ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="p-3 rounded-xl bg-red-950/30 border border-red-500/40 mb-3">
                <AlertTriangle className="h-7 w-7 text-red-400/70" />
              </div>
              <p className="text-sm text-red-400 font-medium mb-1">Không tải được chi tiết</p>
              <p className="text-xs text-stone-500 max-w-md mb-3">{detailError}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-4 text-xs border-amber-400/35 text-amber-400 hover:bg-amber-950/30"
                onClick={retryDetail}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Thử lại
              </Button>
            </div>
          ) : detail ? (
            <div className="space-y-5">
              {/* 1. Kế hoạch của Omega */}
              {detail.proposal.planSummary && (
                <section className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-violet-300/80">
                    Kế hoạch của Omega
                  </p>
                  <div className="border border-violet-500/30 bg-violet-950/20 p-3 rounded text-xs text-stone-300 whitespace-pre-wrap break-words">
                    {detail.proposal.planSummary}
                  </div>
                </section>
              )}

              {/* 2. Các bước triển khai */}
              <section className="space-y-2.5">
                <p className="text-[10px] uppercase tracking-wider text-stone-500">
                  Các bước triển khai
                </p>
                {sortedSteps.length === 0 ? (
                  <p className="text-xs text-stone-500">
                    Chưa có bước nào — Omega sẽ lập kế hoạch chi tiết khi bắt đầu triển khai.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {sortedSteps.map((step) => (
                      <StepItem
                        key={step.id}
                        step={step}
                        outputOpen={!!openOutputs[step.id]}
                        onToggleOutput={toggleOutput}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* 3. Báo cáo hoàn thiện — hiện cho CẢ completed lẫn failed
                  (FIX 2026-09-02, Omega audit #3: báo cáo thất bại chứa phân
                  tích nguyên nhân + đề xuất khắc phục có giá trị; tác giả của
                  báo cáo ghi ngay dòng đầu prefix "**Báo cáo của Opus**" khi
                  ủy quyền bật — title giữ trung tính). */}
              {(detail.proposal.status === 'completed' || detail.proposal.status === 'failed') && detail.proposal.omegaReport && (
                <section className="space-y-1.5">
                  <p
                    className={`text-[10px] uppercase tracking-wider flex items-center gap-1.5 ${
                      detail.proposal.status === 'failed'
                        ? 'text-red-300/80'
                        : 'text-emerald-300/80'
                    }`}
                  >
                    <BookOpen className={`h-3.5 w-3.5 ${detail.proposal.status === 'failed' ? 'text-red-400' : 'text-emerald-400'}`} />
                    Báo cáo hoàn thiện
                  </p>
                  <div
                    className={`border p-4 rounded max-h-96 overflow-y-auto custom-scrollbar ${
                      detail.proposal.status === 'failed'
                        ? 'border-red-500/30 bg-red-950/10'
                        : 'border-emerald-500/30 bg-emerald-950/10'
                    }`}
                  >
                    <p className="text-xs text-stone-200 whitespace-pre-wrap break-words">
                      {detail.proposal.omegaReport}
                    </p>
                  </div>
                </section>
              )}

              {/* 4. Thông tin đề xuất gốc */}
              <section className="space-y-3 border-t border-stone-800/70 pt-4">
                <p className="text-[10px] uppercase tracking-wider text-stone-500">
                  Thông tin đề xuất gốc
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                  <InfoBlock label="VẤN ĐỀ LÀ GÌ?" content={detail.proposal.problem} />
                  <InfoBlock label="GIẢI QUYẾT NHƯ THẾ NÀO?" content={detail.proposal.solution} />
                  <InfoBlock label="TRIỂN KHAI NHƯ THẾ NÀO?" content={detail.proposal.implementation} />
                  <InfoBlock
                    label="THỜI ĐIỂM TRIỂN KHAI?"
                    content={
                      detail.proposal.scheduleAt
                        ? fmtDateTime(detail.proposal.scheduleAt)
                        : 'Ngay khi được duyệt'
                    }
                  />
                  {detail.proposal.impact && (
                    <InfoBlock label="TÁC ĐỘNG KỲ VỌNG" content={detail.proposal.impact} />
                  )}
                  {detail.proposal.userNotes && (
                    <InfoBlock label="GHI CHÚ CỦA MR. ARCHITECT" content={detail.proposal.userNotes} />
                  )}
                </div>
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
