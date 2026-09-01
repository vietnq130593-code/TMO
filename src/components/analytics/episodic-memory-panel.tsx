'use client'

/**
 * Episodic Memory Panel — Task A6-API-UI
 *
 * Panel xem/quản lý Episodic Memory (mount trong tab Analytics, ngay sau
 * RuntimeMetricsPanel): agents ghi "episode" (task + outcome + errors +
 * lessons) vào Neo4j + Qdrant + SQLite mirror sau mỗi chat run — panel này
 * là cửa sổ nhìn vào kho trải nghiệm đó.
 *
 *   - Stats: episodes / lessons (kèm cần review) / Qdrant points / escalations
 *   - Q5 Dashboard: bảng lỗi hay gặp (category × rootCause, resolve-rate bar)
 *   - Lessons (quan trọng nhất): confidence badge, ✓validated/✗failed, source,
 *     flag needsReview + nút "Đã xử lý" (PATCH), form "Dạy bài học" (POST)
 *   - Recent episodes: outcome badge, click → expand fetch detail
 *     (actions ✓/✗ + errors kèm rootCause badge) — max-h-96 scroll
 *   - Escalations: pattern lỗi lặp ≥ 3 → đề xuất cải tiến hệ thống
 *   - Toolbar: "Chạy decay" (POST /decay) + refresh thủ công
 *   - Collapsible Taxonomy R1-R6 (playbook phản ứng đúng vs anti-pattern)
 *
 * Poll GET /api/episodic/overview mỗi 15s (cleanup khi unmount). Fail-open
 * toàn bộ: lỗi fetch → giữ dữ liệu cũ + flag error, KHÔNG crash panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from 'sonner'
import {
  Loader2, RefreshCw, Activity, Brain, BookMarked, Database, AlertTriangle,
  Hourglass, Plus, CheckCircle2, XCircle, ChevronDown, ChevronRight, Check,
  GraduationCap, ListChecks, Layers, ShieldCheck, Calendar as CalendarIcon, X,
  History,
} from 'lucide-react'
import { format } from 'date-fns'
import type { DateRange } from 'react-day-picker'

// ==================== Types (mirror /api/episodic/*) ====================

interface EpisodicStats {
  episodes: number
  lessons: number
  qdrantPoints: number
  lessonsNeedReview: number
  error: string | null
}

interface ErrorDashboardRow {
  category: string
  rootCause: string
  occurrences: number
  resolved: number
}

interface EscalationCandidate {
  rootCause: string
  occurrences: number
  resolved: number
  recentErrors: string[]
}

interface EpisodeRow {
  id: string
  title?: string | null
  goal?: string | null
  outcome?: string | null
  agent?: string | null
  confidence?: number | null
  cycles?: number | null
  tokensUsed?: number | null
  toolCalls?: number | null
  toolFailures?: number | null
  stopReason?: string | null
  startedAt?: string | null
  endedAt?: string | null
  createdAt?: string | null
  actionCount?: number | null
  source?: string
}

interface LessonRow {
  id: string
  statement: string
  triggerCondition: string | null
  rootCause: string | null
  appliesTo: string[]
  source: string
  confidence: number
  timesApplied: number
  timesValidated: number
  timesFailed: number
  needsReview: boolean
  createdAt: string
}

interface TaxonomyItem {
  code: string
  label: string
  correctResponse: string
  antiPattern: string
  manifestations: Array<{ code: string; description: string }>
}

interface OverviewData {
  generatedAt: string
  stats: EpisodicStats
  errorDashboard: { rows: ErrorDashboardRow[]; error: string | null }
  escalations: { rows: EscalationCandidate[]; error: string | null }
  recentEpisodes: { rows: EpisodeRow[]; source: 'neo4j' | 'sqlite-mirror'; error: string | null }
  lessons: { rows: LessonRow[]; error: string | null }
  taxonomy: TaxonomyItem[]
}

interface EpisodeDetailData {
  id: string
  episode: Record<string, unknown> | null
  actions: Array<Record<string, unknown>>
  errors: Array<Record<string, unknown>>
  lessons: Array<Record<string, unknown>>
  error: string | null
}

// ==================== Helpers ====================

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('vi-VN')
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    })
  } catch {
    return '—'
  }
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Badge màu root cause — KHÔNG dùng indigo/blue */
function rootCauseBadge(rootCause: string | null | undefined): { label: string; className: string } {
  switch (rootCause) {
    case 'INPUT_INVALID':
      return { label: 'R1 INPUT_INVALID', className: 'bg-stone-900/70 text-stone-300 border-stone-500/50' }
    case 'ASSUMPTION_WRONG':
      return { label: 'R2 ASSUMPTION_WRONG', className: 'bg-amber-950/60 text-amber-400 border-amber-500/50' }
    case 'KNOWLEDGE_GAP':
      return { label: 'R3 KNOWLEDGE_GAP', className: 'bg-teal-950/60 text-teal-400 border-teal-500/50' }
    case 'TOOL_FAILURE':
      return { label: 'R4 TOOL_FAILURE', className: 'bg-orange-950/60 text-orange-400 border-orange-500/50' }
    case 'REASONING_ERROR':
      return { label: 'R5 REASONING_ERROR', className: 'bg-rose-950/60 text-rose-400 border-rose-500/50' }
    case 'ENV_DRIFT':
      return { label: 'R6 ENV_DRIFT', className: 'bg-violet-950/60 text-violet-400 border-violet-500/50' }
    default:
      return { label: rootCause || '—', className: 'bg-stone-900/70 text-stone-400 border-stone-600/50' }
  }
}

function outcomeBadge(outcome: string | null | undefined): { label: string; className: string } {
  switch (outcome) {
    case 'SUCCESS':
      return { label: 'SUCCESS', className: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50' }
    case 'FAILURE':
      return { label: 'FAILURE', className: 'bg-rose-950/60 text-rose-400 border-rose-500/50' }
    case 'PARTIAL':
      return { label: 'PARTIAL', className: 'bg-amber-950/60 text-amber-400 border-amber-500/50' }
    case 'ABANDONED':
      return { label: 'ABANDONED', className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
    default:
      return { label: outcome || '—', className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
  }
}

function confidenceBadge(confidence: number): { label: string; className: string } {
  const pct = Math.round(confidence * 100)
  if (confidence >= 0.7) {
    return { label: `${pct}% auto-apply`, className: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50' }
  }
  if (confidence >= 0.4) {
    return { label: `${pct}%`, className: 'bg-amber-950/60 text-amber-400 border-amber-500/50' }
  }
  return { label: `${pct}% cần review`, className: 'bg-rose-950/60 text-rose-400 border-rose-500/50' }
}

function sourceBadge(source: string): { label: string; className: string } {
  switch (source) {
    case 'USER_TAUGHT':
      return { label: 'user dạy', className: 'bg-violet-950/60 text-violet-400 border-violet-500/50' }
    case 'SELF_DERIVED':
      return { label: 'tự rút ra', className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
    case 'SUBAGENT_REPORT':
      return { label: 'sub-agent', className: 'bg-teal-950/60 text-teal-400 border-teal-500/50' }
    default:
      return { label: source, className: 'bg-stone-900/60 text-stone-400 border-stone-600/50' }
  }
}

// ==================== Component ====================

const POLL_INTERVAL_MS = 15_000

interface EpisodicMemoryPanelProps {
  /** v1.1 — ALISTA: null = poll live (default), {from,to} = chế độ lịch sử */
  analyticsRange?: { from: string; to: string } | null
  /** Callback khi owner chọn khoảng ngày (popover apply) hoặc ✕ để clear (null) */
  onAnalyticsRangeChange?: (range: { from: string; to: string } | null) => void
}

export function EpisodicMemoryPanel({ analyticsRange, onAnalyticsRangeChange }: EpisodicMemoryPanelProps = {}) {
  const rangeActive = !!analyticsRange
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  // v1.1 — ALISTA Kiểm tra toàn diện (POST /api/alista/check + poll GET)
  const [alistaRunning, setAlistaRunning] = useState(false)

  // v1.1 — Range picker draft (chưa apply khi đang chọn)
  const [rangeDraft, setRangeDraft] = useState<DateRange | undefined>(undefined)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Dạy bài học (form inline)
  const [teachOpen, setTeachOpen] = useState(false)
  const [teachSubmitting, setTeachSubmitting] = useState(false)
  const [teachForm, setTeachForm] = useState({
    statement: '',
    triggerCondition: '',
    rootCause: '',
    appliesTo: '',
  })

  // Review lesson (nút "Đã xử lý")
  const [reviewingIds, setReviewingIds] = useState<Set<string>>(new Set())

  // Decay
  const [decayRunning, setDecayRunning] = useState(false)

  // Episode detail expand
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<string | null>(null)
  const [episodeDetails, setEpisodeDetails] = useState<Record<string, EpisodeDetailData>>({})
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null)

  // Taxonomy collapsible (mặc định đóng)
  const [taxonomyOpen, setTaxonomyOpen] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      // v1.1: range mode dùng ?from=&to= thay cho poll mặc định
      const url = analyticsRange
        ? `/api/episodic/overview?from=${encodeURIComponent(analyticsRange.from)}&to=${encodeURIComponent(analyticsRange.to)}`
        : '/api/episodic/overview'
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as OverviewData
      setData(json)
      setError(false)
      setLastUpdated(new Date().toLocaleTimeString('vi-VN'))
    } catch {
      // Fail-open — giữ dữ liệu cũ (nếu có), flag error hiển thị "—"
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
    // Live mode: poll 15s như cũ.
    let interval: ReturnType<typeof setInterval> | null = null
    if (!rangeActive) {
      interval = setInterval(poll, POLL_INTERVAL_MS)
    }
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [fetchData, rangeActive])

  // ---- Dạy bài học (POST /api/episodic/lessons) ----
  const handleTeachSubmit = useCallback(async () => {
    const statement = teachForm.statement.trim()
    if (statement.length < 10) {
      toast.error('Statement quá ngắn', { description: 'Tối thiểu 10 ký tự — mô tả bài học đủ rõ để agent tái sử dụng' })
      return
    }
    setTeachSubmitting(true)
    try {
      const res = await fetch('/api/episodic/lessons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement,
          triggerCondition: teachForm.triggerCondition.trim() || undefined,
          rootCause: teachForm.rootCause || undefined,
          appliesTo: teachForm.appliesTo.trim() || undefined,
        }),
      })
      const json = await res.json() as { ok?: boolean; lesson?: LessonRow; error?: string | null }
      if (!res.ok || json.error || !json.lesson) {
        toast.error('Dạy bài học thất bại', { description: json.error || `HTTP ${res.status}` })
      } else {
        toast.success('Đã ghi bài học mới (USER_TAUGHT · 80%)', {
          description: truncate(json.lesson.statement, 110),
        })
        setTeachForm({ statement: '', triggerCondition: '', rootCause: '', appliesTo: '' })
        setTeachOpen(false)
        void fetchData()
      }
    } catch {
      toast.error('Lỗi mạng — không dạy được bài học')
    } finally {
      setTeachSubmitting(false)
    }
  }, [teachForm, fetchData])

  // ---- Đánh dấu lesson đã xử lý (PATCH) ----
  const handleMarkReviewed = useCallback(async (id: string) => {
    setReviewingIds(prev => new Set(prev).add(id))
    try {
      const res = await fetch('/api/episodic/lessons', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, needsReview: false }),
      })
      const json = await res.json() as { ok?: boolean; error?: string | null }
      if (!res.ok || json.error) {
        toast.error('Không đánh dấu được', { description: json.error || `HTTP ${res.status}` })
      } else {
        toast.success('Đã đánh dấu đã xử lý — lesson quay lại vòng lifecycle bình thường')
        void fetchData()
      }
    } catch {
      toast.error('Lỗi mạng — không cập nhật được lesson')
    } finally {
      setReviewingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [fetchData])

  // ---- Chạy decay (POST /api/episodic/decay) ----
  const handleRunDecay = useCallback(async () => {
    setDecayRunning(true)
    try {
      const res = await fetch('/api/episodic/decay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const json = await res.json() as { ok?: boolean; decayed?: number; params?: { days: number; factor: number }; error?: string | null }
      if (json.error) {
        toast.error('Decay thất bại', { description: json.error })
      } else {
        toast.success(`Decay xong — ${json.decayed ?? 0} episode bị giảm importance`, {
          description: `×${json.params?.factor ?? 0.9} cho episode không truy cập ≥ ${json.params?.days ?? 30} ngày (lesson không bao giờ decay)`,
        })
        void fetchData()
      }
    } catch {
      toast.error('Lỗi mạng — không chạy được decay')
    } finally {
      setDecayRunning(false)
    }
  }, [fetchData])

  // ---- Expand episode → fetch detail ----
  const toggleEpisode = useCallback(async (id: string) => {
    if (expandedEpisodeId === id) {
      setExpandedEpisodeId(null)
      return
    }
    setExpandedEpisodeId(id)
    if (episodeDetails[id]) return
    setDetailLoadingId(id)
    try {
      const res = await fetch(`/api/episodic/episodes?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const json = (await res.json()) as EpisodeDetailData
      setEpisodeDetails(prev => ({ ...prev, [id]: json }))
    } catch {
      setEpisodeDetails(prev => ({
        ...prev,
        [id]: { id, episode: null, actions: [], errors: [], lessons: [], error: 'Lỗi fetch chi tiết' },
      }))
    } finally {
      setDetailLoadingId(null)
    }
  }, [expandedEpisodeId, episodeDetails])

  // ---- v1.1 — ALISTA Kiểm tra toàn diện (POST + poll) ----
  const handleAlistaCheck = useCallback(async () => {
    if (alistaRunning) return
    setAlistaRunning(true)
    toast.info('ALISTA: bắt đầu kiểm tra toàn diện', {
      description: 'Pipeline 7 bước tuần tự — Tools · Runs · Escalations · Domain · 3 Layers · Self · DB+Memory+Learning',
    })
    try {
      // (1) POST /api/alista/check — fire-and-forget, returns 202 + checkId (UUID)
      // FIX: dùng checkId từ response trực tiếp (trước đây đoán qua /checks → id TaskExecution không khớp state Map)
      const postRes = await fetch('/api/alista/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      if (!postRes.ok && postRes.status !== 202) {
        const errJson = await postRes.json().catch(() => ({}))
        throw new Error(errJson.error || `HTTP ${postRes.status}`)
      }
      const postJson = (await postRes.json()) as { checkId?: string }
      const checkId = postJson.checkId
      if (!checkId) {
        throw new Error('POST không trả về checkId')
      }
      // (2) Poll GET /api/alista/check?checkId=… mỗi 2s tối đa 300s
      const deadline = Date.now() + 300_000
      let lastStatus = 'running'
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const pollRes = await fetch(`/api/alista/check?checkId=${encodeURIComponent(checkId)}`, { cache: 'no-store' })
          if (pollRes.ok) {
            const state = (await pollRes.json()) as {
              status: string
              steps?: Array<{ id: number; label: string; status: string; proposalCount?: number }>
              proposalsCreated?: Array<{ id: string; title: string }>
              durationMs?: number
              deadlineMet?: boolean
              reason?: string
              error?: string
            }
            lastStatus = state.status || 'running'
            if (state.status === 'completed' || state.status === 'failed') {
              const proposalCount = state.proposalsCreated?.length ?? 0
              const stepCount = state.steps?.length ?? 0
              const duration = state.durationMs ? Math.round(state.durationMs / 1000) : 0
              if (state.status === 'completed') {
                toast.success('Kiểm tra toàn diện hoàn tất', {
                  description: `${proposalCount} đề xuất mới gửi Self-Direction · ${stepCount} bước · ${duration}s · deadlineMet=${state.deadlineMet} · ${state.reason || ''}`,
                })
              } else {
                toast.error('Kiểm tra toàn diện gặp lỗi', {
                  description: state.error || `Trạng thái: ${state.status} · ${state.reason || ''}`,
                })
              }
              // Refresh data để thấy proposal mới
              void fetchData()
              return
            }
          }
        } catch { /* retry */ }
      }
      // Timeout 300s mà chưa xong
      toast.warning('Kiểm tra toàn diện vẫn đang chạy', {
        description: `Đã poll 300s, trạng thái cuối: ${lastStatus}. Xem Self-Direction module để xem đề xuất khi pipeline hoàn tất.`,
      })
    } catch (err) {
      toast.error('Không chạy được ALISTA check', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setAlistaRunning(false)
    }
  }, [alistaRunning, fetchData])

  // ---- v1.1 — Range picker apply / clear ----
  const applyRange = useCallback(() => {
    if (!rangeDraft?.from || !rangeDraft?.to) return
    const from = format(rangeDraft.from, 'yyyy-MM-dd')
    const to = format(rangeDraft.to, 'yyyy-MM-dd')
    onAnalyticsRangeChange?.({ from, to })
    setPopoverOpen(false)
    toast.info(`Đang xem dữ liệu lịch sử: ${format(rangeDraft.from, 'dd/MM')} → ${format(rangeDraft.to, 'dd/MM')}`, {
      description: 'Polling dừng lại — fetch 1 lần. Bấm ✕ để trở về live mode.',
    })
  }, [rangeDraft, onAnalyticsRangeChange])

  const clearRange = useCallback(() => {
    onAnalyticsRangeChange?.(null)
    setRangeDraft(undefined)
    toast.info('Trở về live mode (poll 15s)')
  }, [onAnalyticsRangeChange])

  const stats = data?.stats
  const dashboardRows = data?.errorDashboard.rows ?? []
  const escalations = data?.escalations.rows ?? []
  const episodes = data?.recentEpisodes.rows ?? []
  const episodesSource = data?.recentEpisodes.source
  const lessons = data?.lessons.rows ?? []
  const taxonomy = data?.taxonomy ?? []

  return (
    <div className="space-y-4">
      {/* ===== Toolbar ===== */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-stone-700 bg-stone-900/60 text-stone-300 hover:bg-stone-800 hover:text-stone-100"
            onClick={() => void fetchData()}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Làm mới
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-amber-700/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40 hover:text-amber-200"
            onClick={() => void handleRunDecay()}
            disabled={decayRunning}
          >
            {decayRunning ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Hourglass className="h-3.5 w-3.5 mr-1.5" />}
            Chạy decay
          </Button>
          {/* v1.1 — ALISTA: nút Kiểm tra toàn diện (chạy pipeline 7 bước ngay thay vì chờ 23h30) */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-teal-700/60 bg-teal-950/40 text-teal-300 hover:bg-teal-900/40 hover:text-teal-200"
            onClick={() => void handleAlistaCheck()}
            disabled={alistaRunning}
            title="Chạy pipeline Kiểm tra toàn diện ngay (7 nhiệm vụ tuần tự, budget 10 phút) — thay vì chờ 23h30"
          >
            {alistaRunning ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />}
            Kiểm tra toàn diện
          </Button>
          {/* v1.1 — ALISTA: bộ chọn khoảng ngày (từ ngày → đến ngày) */}
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs border-stone-700 bg-stone-900/60 text-stone-300 hover:bg-stone-800 hover:text-stone-100"
                disabled={alistaRunning}
                title="Chọn khoảng ngày để xem dữ liệu Analytics theo lịch sử (poll dừng lại, fetch 1 lần)"
              >
                <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
                {analyticsRange
                  ? `${format(new Date(analyticsRange.from + 'T00:00:00'), 'dd/MM')} → ${format(new Date(analyticsRange.to + 'T00:00:00'), 'dd/MM')}`
                  : 'Từ ngày – đến ngày'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={rangeDraft}
                onSelect={setRangeDraft}
                numberOfMonths={1}
                disabled={{ after: new Date() }}
              />
              <div className="p-2 border-t border-stone-800 flex justify-between gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setRangeDraft(undefined); onAnalyticsRangeChange?.(null); setPopoverOpen(false) }}>
                  Xóa khoảng
                </Button>
                <Button size="sm" disabled={!rangeDraft?.from || !rangeDraft?.to} onClick={applyRange}>
                  Xem dữ liệu
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          {/* Range active badge với nút ✕ để clear */}
          {rangeActive && analyticsRange && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs px-2 bg-violet-950/40 border border-violet-500/55 text-violet-300 hover:bg-violet-900/40 hover:text-violet-200"
              onClick={clearRange}
              title="Trở về live mode (poll 15s)"
            >
              <History className="h-3 w-3 mr-1.5" />
              Đang xem {format(new Date(analyticsRange.from + 'T00:00:00'), 'dd/MM')} → {format(new Date(analyticsRange.to + 'T00:00:00'), 'dd/MM')} (lịch sử)
              <X className="h-3 w-3 ml-1.5" />
            </Button>
          )}
        </div>
        <span className="text-[10px] text-stone-500 flex items-center gap-1.5">
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> đang tải…
            </>
          ) : rangeActive ? (
            <>
              <History className="h-3 w-3" />
              chế độ lịch sử · cập nhật {lastUpdated || '—'}
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3" />
              {error ? 'lỗi fetch — giữ dữ liệu cũ (fail-open)' : `cập nhật ${lastUpdated || '—'} · poll 15s`}
            </>
          )}
        </span>
      </div>

      {/* ===== Stats row (4 cards) ===== */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Layers className="h-4 w-4 text-teal-400" />}
          iconBg="bg-teal-950/50"
          label="Episodes"
          value={fmtNum(stats?.episodes)}
          hint="SQLite mirror"
        />
        <StatCard
          icon={<BookMarked className="h-4 w-4 text-emerald-400" />}
          iconBg="bg-emerald-950/50"
          label="Lessons"
          value={fmtNum(stats?.lessons)}
          hint={stats && stats.lessonsNeedReview > 0 ? `${stats.lessonsNeedReview} cần review` : 'vĩnh viễn, không decay'}
          hintTone={stats && stats.lessonsNeedReview > 0 ? 'amber' : 'stone'}
        />
        <StatCard
          icon={<Database className="h-4 w-4 text-violet-400" />}
          iconBg="bg-violet-950/50"
          label="Qdrant points"
          value={fmtNum(stats?.qdrantPoints)}
          hint="theopus_episodes"
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4 text-rose-400" />}
          iconBg="bg-rose-950/50"
          label="Escalations"
          value={fmtNum(escalations.length)}
          hint="pattern lặp ≥ 3 lần"
          hintTone={escalations.length > 0 ? 'rose' : 'stone'}
        />
      </div>

      {/* ===== Escalations (pattern lặp ≥ 3) ===== */}
      {escalations.length > 0 && (
        <div className="space-y-2">
          {escalations.map((esc, i) => {
            const rc = rootCauseBadge(esc.rootCause)
            return (
              <div
                key={`${esc.rootCause}-${i}`}
                className="p-3 rounded-xl border bg-rose-950/40 border-rose-500/55 text-rose-300"
                role="alert"
              >
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>
                    Pattern lặp {esc.occurrences} lần:{' '}
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${rc.className}`}>{rc.label}</Badge>{' '}
                    ({esc.resolved}/{esc.occurrences} đã resolve) — đề xuất cải tiến hệ thống
                  </span>
                </div>
                {esc.recentErrors && esc.recentErrors.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {esc.recentErrors.slice(0, 3).map((e, j) => (
                      <li key={j} className="text-[11px] text-rose-300/80 font-mono truncate" title={String(e)}>
                        ↳ {truncate(String(e), 140)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* ===== Bảng lỗi hay gặp (Q5 Dashboard) ===== */}
        <Card className="nc-panel nc-sm nc-border-rose p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-rose-950/50">
                <AlertTriangle className="h-4 w-4 text-rose-400" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-stone-100">Lỗi hay gặp (Q5 Dashboard)</span>
            </div>
            <span className="text-[10px] text-stone-500">Neo4j · ErrorOccurrence</span>
          </div>
          {loading ? (
            <SkeletonBlock />
          ) : dashboardRows.length === 0 ? (
            <p className="text-xs text-stone-500">
              {data?.errorDashboard.error
                ? `Không đọc được dashboard: ${data.errorDashboard.error} (fail-open)`
                : 'Chưa có lỗi nào được ghi — agents chưa ghi ErrorOccurrence'}
            </p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {dashboardRows.map((row, i) => {
                const rc = rootCauseBadge(row.rootCause)
                const resolveRate = row.occurrences > 0 ? Math.round((row.resolved / row.occurrences) * 100) : 0
                return (
                  <div key={`${row.category}-${row.rootCause}-${i}`} className="rounded-lg bg-stone-950/60 border border-stone-800/80 px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-stone-300 font-mono truncate max-w-[40%]" title={row.category}>
                        {row.category || '—'}
                      </span>
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border flex-shrink-0 ${rc.className}`}>
                        {rc.label}
                      </Badge>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Progress value={resolveRate} className="h-1.5 flex-1 bg-stone-800" />
                      <span className="text-[10px] text-stone-400 tabular-nums flex-shrink-0">
                        {row.resolved}/{row.occurrences} resolve
                      </span>
                      <span className={`text-[10px] tabular-nums flex-shrink-0 font-semibold ${resolveRate >= 80 ? 'text-emerald-400' : resolveRate >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {resolveRate}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* ===== Recent episodes ===== */}
        <Card className="nc-panel nc-sm nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-teal-950/50">
                <ListChecks className="h-4 w-4 text-teal-400" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-stone-100">Episode gần đây</span>
            </div>
            <span className="text-[10px] text-stone-500 flex items-center gap-1">
              {episodesSource === 'sqlite-mirror' && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border bg-amber-950/60 text-amber-400 border-amber-500/50">
                  mirror
                </Badge>
              )}
              Neo4j · click để xem chi tiết
            </span>
          </div>
          {loading ? (
            <SkeletonBlock />
          ) : episodes.length === 0 ? (
            <p className="text-xs text-stone-500">
              {data?.recentEpisodes.error
                ? `Không đọc được episodes: ${data.recentEpisodes.error} (fail-open)`
                : 'Chưa có episode nào — chạy 1 chat run để agent ghi trải nghiệm đầu tiên'}
            </p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {episodes.map(ep => {
                const ob = outcomeBadge(ep.outcome)
                const isExpanded = expandedEpisodeId === ep.id
                return (
                  <div key={ep.id} className="rounded-lg bg-stone-950/60 border border-stone-800/80">
                    <button
                      type="button"
                      onClick={() => void toggleEpisode(ep.id)}
                      className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-stone-900/50 transition-colors"
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 text-stone-500 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-stone-500 flex-shrink-0" />
                      )}
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border flex-shrink-0 ${ob.className}`}>
                        {ob.label}
                      </Badge>
                      <span className="text-xs text-stone-200 truncate flex-1" title={ep.goal || ep.title || ''}>
                        {truncate(ep.title || ep.goal || ep.id, 60)}
                      </span>
                      <span className="text-[10px] text-stone-500 flex-shrink-0 tabular-nums">
                        {ep.agent || '—'} · {ep.cycles ?? '—'}c · {ep.toolCalls ?? 0}/{ep.toolFailures ?? 0} tools · {fmtTime(ep.startedAt || ep.createdAt)}
                      </span>
                    </button>
                    {isExpanded && (
                      <EpisodeDetail
                        detail={episodeDetails[ep.id]}
                        loading={detailLoadingId === ep.id}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ===== Lessons (quan trọng nhất) ===== */}
      <Card className="nc-panel nc-sm nc-border-emerald p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-950/50">
              <GraduationCap className="h-4 w-4 text-emerald-400" />
            </div>
            <span className="text-xs font-semibold tracking-tight text-stone-100">Lessons — bài học rút ra</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-emerald-700/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/40 hover:text-emerald-200"
            onClick={() => setTeachOpen(prev => !prev)}
            aria-expanded={teachOpen}
          >
            {teachOpen ? <ChevronDown className="h-3.5 w-3.5 mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Dạy bài học
          </Button>
        </div>

        {/* Form dạy bài học (inline) */}
        {teachOpen && (
          <div className="mb-3 p-3 rounded-xl border border-emerald-500/40 bg-emerald-950/20 space-y-2.5">
            <div>
              <label htmlFor="teach-statement" className="text-[10px] uppercase tracking-wide text-stone-500">
                Statement — bài học (10-500 ký tự) *
              </label>
              <Textarea
                id="teach-statement"
                value={teachForm.statement}
                onChange={e => setTeachForm(prev => ({ ...prev, statement: e.target.value }))}
                placeholder="Khi sửa file TS, luôn chạy typecheck trước khi commit"
                className="mt-1 text-xs bg-stone-950/70 border-stone-700 text-stone-200 placeholder:text-stone-600 min-h-[60px]"
                maxLength={500}
              />
              <p className="text-[10px] text-stone-500 mt-0.5">{teachForm.statement.trim().length}/500 ký tự — tối thiểu 10</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="teach-trigger" className="text-[10px] uppercase tracking-wide text-stone-500">
                  Trigger condition — khi nào áp dụng
                </label>
                <Input
                  id="teach-trigger"
                  value={teachForm.triggerCondition}
                  onChange={e => setTeachForm(prev => ({ ...prev, triggerCondition: e.target.value }))}
                  placeholder="trước khi commit thay đổi type"
                  className="mt-1 text-xs bg-stone-950/70 border-stone-700 text-stone-200 placeholder:text-stone-600 h-8"
                  maxLength={300}
                />
              </div>
              <div>
                <label htmlFor="teach-rootcause" className="text-[10px] uppercase tracking-wide text-stone-500">
                  Root cause (R1-R6)
                </label>
                <Select
                  value={teachForm.rootCause || 'none'}
                  onValueChange={v => setTeachForm(prev => ({ ...prev, rootCause: v === 'none' ? '' : v }))}
                >
                  <SelectTrigger id="teach-rootcause" className="mt-1 text-xs bg-stone-950/70 border-stone-700 text-stone-200 h-8">
                    <SelectValue placeholder="— Không rõ —" />
                  </SelectTrigger>
                  <SelectContent className="bg-stone-900 border-stone-700">
                    <SelectItem value="none" className="text-xs text-stone-300">— Không rõ —</SelectItem>
                    {taxonomy.map(t => (
                      <SelectItem key={t.code} value={t.code} className="text-xs text-stone-300">
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label htmlFor="teach-appliesto" className="text-[10px] uppercase tracking-wide text-stone-500">
                Applies to — tag phạm vi (comma-separated, optional)
              </label>
              <Input
                id="teach-appliesto"
                value={teachForm.appliesTo}
                onChange={e => setTeachForm(prev => ({ ...prev, appliesTo: e.target.value }))}
                placeholder="typescript, file_edit, refactor"
                className="mt-1 text-xs bg-stone-950/70 border-stone-700 text-stone-200 placeholder:text-stone-600 h-8"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-xs bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white border-0"
                onClick={() => void handleTeachSubmit()}
                disabled={teachSubmitting}
              >
                {teachSubmitting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
                Ghi bài học (USER_TAUGHT · 80%)
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-stone-400 hover:text-stone-200"
                onClick={() => setTeachOpen(false)}
              >
                Đóng
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <SkeletonBlock />
        ) : lessons.length === 0 ? (
          <p className="text-xs text-stone-500">
            {data?.lessons.error
              ? `Không đọc được lessons: ${data.lessons.error} (fail-open)`
              : 'Chưa có bài học nào — bấm "Dạy bài học" để ghi bài đầu tiên'}
          </p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {lessons.map(lesson => {
              const cb = confidenceBadge(lesson.confidence)
              const sb = sourceBadge(lesson.source)
              const rc = lesson.rootCause ? rootCauseBadge(lesson.rootCause) : null
              const isReviewing = reviewingIds.has(lesson.id)
              return (
                <div
                  key={lesson.id}
                  className={`rounded-lg bg-stone-950/60 border px-3 py-2.5 ${
                    lesson.needsReview ? 'border-amber-500/60 ring-1 ring-amber-500/25' : 'border-stone-800/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-stone-100 leading-relaxed">{lesson.statement}</p>
                      {lesson.triggerCondition && (
                        <p className="text-[11px] text-stone-500 mt-0.5">
                          Khi: {lesson.triggerCondition}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${cb.className}`}>{cb.label}</Badge>
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${sb.className}`}>{sb.label}</Badge>
                        {rc && (
                          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${rc.className}`}>{rc.label}</Badge>
                        )}
                        <span className="text-[10px] text-stone-500 tabular-nums flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3 text-emerald-500/80" />{lesson.timesValidated}
                          <XCircle className="h-3 w-3 text-rose-500/80 ml-1" />{lesson.timesFailed}
                        </span>
                        {lesson.appliesTo.length > 0 && (
                          <span className="text-[10px] text-stone-500 truncate max-w-[180px]" title={lesson.appliesTo.join(', ')}>
                            · {lesson.appliesTo.join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                    {lesson.needsReview && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px] flex-shrink-0 border-amber-600/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40 hover:text-amber-200"
                        onClick={() => void handleMarkReviewed(lesson.id)}
                        disabled={isReviewing}
                      >
                        {isReviewing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
                        Đã xử lý
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ===== Taxonomy R1-R6 (collapsible, mặc định đóng) ===== */}
      <Collapsible open={taxonomyOpen} onOpenChange={setTaxonomyOpen}>
        <Card className="nc-panel nc-sm nc-border-violet p-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 group"
              aria-expanded={taxonomyOpen}
            >
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-violet-950/50">
                  <Brain className="h-4 w-4 text-violet-400" />
                </div>
                <span className="text-xs font-semibold tracking-tight text-stone-100">Error Taxonomy R1-R6 — playbook phản ứng</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-stone-500">6 root causes</span>
                {taxonomyOpen ? (
                  <ChevronDown className="h-4 w-4 text-stone-500 group-hover:text-stone-300" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-stone-500 group-hover:text-stone-300" />
                )}
              </div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 space-y-2">
              {taxonomy.map(t => {
                const rc = rootCauseBadge(t.code)
                return (
                  <div key={t.code} className="rounded-lg bg-stone-950/60 border border-stone-800/80 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${rc.className}`}>{rc.label}</Badge>
                      <span className="text-[10px] text-stone-500">{t.manifestations.length} manifestations</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div className="rounded-md bg-emerald-950/30 border border-emerald-500/25 px-2 py-1.5">
                        <p className="text-[9px] uppercase tracking-wide text-emerald-400 font-semibold">✓ Phản ứng đúng</p>
                        <p className="text-[11px] text-emerald-200/90 mt-0.5 leading-relaxed">{t.correctResponse}</p>
                      </div>
                      <div className="rounded-md bg-rose-950/30 border border-rose-500/25 px-2 py-1.5">
                        <p className="text-[9px] uppercase tracking-wide text-rose-400 font-semibold">✗ Anti-pattern</p>
                        <p className="text-[11px] text-rose-300/90 mt-0.5 leading-relaxed line-through decoration-rose-500/60">{t.antiPattern}</p>
                      </div>
                    </div>
                    <details className="mt-1.5">
                      <summary className="text-[10px] text-stone-500 cursor-pointer hover:text-stone-300 select-none">
                        Manifestations chi tiết (M*.n)
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {t.manifestations.map(m => (
                          <li key={m.code} className="text-[10px] text-stone-400">
                            <span className="font-mono text-stone-300">{m.code}</span> — {m.description}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )
              })}
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* ===== Footer — nguồn dữ liệu ===== */}
      <div className="flex items-center justify-between text-[10px] text-stone-500 px-1">
        <span className="flex items-center gap-1">
          <Brain className="h-3 w-3" />
          Nguồn: /api/episodic/overview (EpisodeRecord + LessonRecord + Neo4j graph + Qdrant theopus_episodes)
        </span>
        <span className="flex items-center gap-1.5">
          <Activity className="h-3 w-3" />
          fail-open từng section · lesson vĩnh viễn · episode decay ×0.9/30 ngày
        </span>
      </div>
    </div>
  )
}

// ==================== Episode detail (expand) ====================

function EpisodeDetail({ detail, loading }: { detail: EpisodeDetailData | undefined; loading: boolean }) {
  if (loading && !detail) {
    return (
      <div className="px-3 pb-2.5 pt-1">
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> đang tải chi tiết episode…
        </div>
      </div>
    )
  }
  if (!detail) return null
  if (detail.error && !detail.episode) {
    return (
      <div className="px-3 pb-2.5 pt-1">
        <p className="text-[11px] text-rose-400">Lỗi: {detail.error} (fail-open)</p>
      </div>
    )
  }

  const actions = detail.actions
  const errors = detail.errors
  const lessons = detail.lessons
  const ep = detail.episode

  return (
    <div className="px-3 pb-2.5 pt-1 border-t border-stone-800/70 mt-1">
      <div className="max-h-96 overflow-y-auto space-y-2.5 pt-2">
        {/* Meta */}
        {ep && (
          <div className="flex items-center gap-2 flex-wrap text-[10px] text-stone-500">
            <span className="font-mono text-stone-400">{String(ep.id ?? detail.id)}</span>
            {ep.goal ? <span title={String(ep.goal)}>· goal: {truncate(String(ep.goal), 80)}</span> : null}
            {ep.stopReason ? <span>· stop: {String(ep.stopReason)}</span> : null}
            {ep.confidence !== null && ep.confidence !== undefined ? (
              <span>· confidence: {Math.round(Number(ep.confidence) * 100)}%</span>
            ) : null}
            {ep.tokensUsed ? <span>· {fmtNum(Number(ep.tokensUsed))} tokens</span> : null}
          </div>
        )}

        {/* Actions */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">
            Actions ({actions.length})
          </p>
          {actions.length === 0 ? (
            <p className="text-[11px] text-stone-600">— không có action nào được ghi —</p>
          ) : (
            <div className="space-y-1">
              {actions.map((a, i) => {
                const success = String(a.result ?? '').toUpperCase() === 'SUCCESS'
                return (
                  <div key={String(a.id ?? i)} className="flex items-center gap-2 text-[11px]">
                    {success ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <XCircle className="h-3 w-3 text-rose-400 flex-shrink-0" />
                    )}
                    <span className="font-mono text-stone-500 tabular-nums w-6 flex-shrink-0">{String(a.sequence ?? i + 1)}.</span>
                    <span className="font-mono text-stone-300 w-28 flex-shrink-0 truncate" title={String(a.tool ?? '')}>{String(a.tool ?? '—')}</span>
                    <span className="text-stone-400 truncate flex-1" title={String(a.inputSummary ?? '')}>
                      {truncate(String(a.inputSummary ?? ''), 100)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Errors */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">
            Errors ({errors.length})
          </p>
          {errors.length === 0 ? (
            <p className="text-[11px] text-stone-600">— không có lỗi nào —</p>
          ) : (
            <div className="space-y-1">
              {errors.map((e, i) => {
                const rc = rootCauseBadge(String(e.rootCause ?? ''))
                const resolved = !!e.resolved
                return (
                  <div key={String(e.id ?? i)} className="rounded-md border border-stone-800/80 bg-stone-950/50 px-2 py-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${rc.className}`}>{rc.label}</Badge>
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1.5 py-0 h-4 border ${
                          resolved
                            ? 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50'
                            : 'bg-rose-950/60 text-rose-400 border-rose-500/50'
                        }`}
                      >
                        {resolved ? 'resolved' : 'unresolved'}
                      </Badge>
                      {e.manifestation ? (
                        <span className="text-[9px] font-mono text-stone-500">{String(e.manifestation)}</span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-stone-400 font-mono mt-1 leading-relaxed" title={String(e.rawMessage ?? '')}>
                      {truncate(String(e.rawMessage ?? ''), 140)}
                    </p>
                    {e.fixSummary ? (
                      <p className="text-[10px] text-emerald-400/80 mt-0.5">↳ fix: {truncate(String(e.fixSummary), 120)}</p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Lessons yielded */}
        {lessons.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">
              Lessons rút ra ({lessons.length})
            </p>
            <div className="space-y-1">
              {lessons.map((l, i) => (
                <div key={String(l.id ?? i)} className="flex items-center gap-2 text-[11px]">
                  <GraduationCap className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                  <span className="text-stone-300 truncate" title={String(l.statement ?? '')}>
                    {truncate(String(l.statement ?? ''), 110)}
                  </span>
                  {l.confidence !== undefined ? (
                    <span className="text-[10px] text-stone-500 tabular-nums flex-shrink-0">
                      {Math.round(Number(l.confidence) * 100)}%
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== Small sub-components ====================

function StatCard({
  icon, iconBg, label, value, hint, hintTone = 'stone',
}: {
  icon: React.ReactNode
  iconBg: string
  label: string
  value: string
  hint: string
  hintTone?: 'stone' | 'amber' | 'rose'
}) {
  const hintClass =
    hintTone === 'amber' ? 'text-amber-400' : hintTone === 'rose' ? 'text-rose-400' : 'text-stone-500'
  return (
    <div className="rounded-xl bg-stone-950/60 border border-stone-800/80 px-3 py-2.5 flex items-center gap-2.5">
      <div className={`p-1.5 rounded-lg flex-shrink-0 ${iconBg}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[9px] uppercase tracking-wide text-stone-500">{label}</p>
        <p className="text-base font-bold tabular-nums text-stone-100 leading-tight">{value}</p>
        <p className={`text-[9px] truncate ${hintClass}`}>{hint}</p>
      </div>
    </div>
  )
}

function SkeletonBlock() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-10 rounded-lg bg-stone-900/80" />
      <div className="h-10 rounded-lg bg-stone-900/60" />
      <div className="h-10 rounded-lg bg-stone-900/40" />
    </div>
  )
}
