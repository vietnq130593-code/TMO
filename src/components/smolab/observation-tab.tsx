'use client'

/**
 * OBS-P3 (BLUEPRINT-OBSERVATION §C.5) → TASK 26 REFACTOR 4 PANEL
 * ============================================================================
 *
 * Task 26 (chỉ thị user 2026-10-13, nguyên văn): "tab Quan sát trong Bảng
 * thông số nên tích hợp vào ô Chọn não và kiến trúc — chọn xong não nào có
 * thể xem ngay dưới đài quan sát não, và chọn quan sát cái gì ở trên thì xem
 * được ở đài bên dưới."
 *
 * Task 26: Quan sát chuyển từ tab console SECTION 3 (Task 25) LÊN selector
 * "Chế độ quan sát" ở SECTION 1 (dưới Brain Studio) — nội dung hiển thị bằng
 * PANEL riêng NGAY DƯỚI đài quan sát SECTION 2. File này tách thành 4 panel
 * component (giữ 1 file, tái dùng tối đa hooks/logic Task 25 — KHÔNG viết lại
 * logic polling từ đầu); mỗi panel tự mount/unmount theo obsMode ở brain-tab
 * → poll tự dừng khi không hiển thị:
 *
 *   1 · neurons — "Hoạt động nơ-ron" (MẶC ĐỊNH): bảng activation THẬT từ
 *       CÙNG activity fetch của đài (brain-tab truyền xuống — 1 poller duy
 *       nhất); mỗi lớp 1 hàng (nhãn + units + min/max/mean |a| + thanh cường
 *       độ); lớp input hiện tên đặc trưng của top nơ-ron sáng nhất
 *       (featureNames); header: sourceLabel + chip "Agent đang chạy" +
 *       chip "ĐANG TRAIN" (training.status==='running' đúng não đang chọn)
 *       + dòng trạng thái backprop trung thực (có/không gradient mẫu thật).
 *   2 · timeline — "Timeline sự kiện": nguyên logic timeline Task 25 (filter
 *       kind/actor/since + danh sách + live poll THÍCH ỨNG 2,5s/15s +
 *       chi tiết event drill-down) + badge alerts24h (hợp đồng 26-BE —
 *       thiếu thì coi như 0).
 *   3 · traces — "Vết suy luận": danh sách BrainInferenceTrace từ
 *       data.traces của timeline route (lọc theo não đang chọn qua ?brain=),
 *       chip cờ obs_brain_trace + trạng thái trống trung thực.
 *   4 · golden — "Kim tuyến runId": input runId + Theo dõi/Xóa + tóm tắt run
 *       (đang chạy/kết thúc, thời lượng, nhóm sự kiện) + luồng sự kiện lọc
 *       theo runId + vết suy luận não của run (join trace C.4).
 *
 * Cờ ui_observation (off mặc định): CẢ 4 panel tôn trọng — off → trạng thái
 * tối giản + nút bật tại chỗ (POST /api/neural-architecture precedent
 * hitech-toggle); neurons panel đọc cờ bằng 1 fetch nhẹ (limit=1, không poll).
 * Cờ obs_ledger/obs_brain_trace/obs_impact hiển thị chip trạng thái.
 *
 * Read-only TUYỆT ĐỐI — toàn bộ dữ liệu từ GET /api/observation/timeline.
 * KHÔNG ghi gì (trừ nút bật cờ — đi đúng tuning-store audit).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Activity, Filter, X, RefreshCw, GitBranch, BrainCircuit, ChevronDown, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { OBS_GROUP_CLASSES, obsActorClass, obsKindDef, type ObsKindDef } from '@/lib/observation/kinds'
import type { BrainActivity } from '@/lib/brain/registry'
import type { StageBackprop, StageTraining } from '@/components/database/brain-stage'
// [fetch-retry 429] (user report 2026-11-05): poll timeline bọc retry 429
// (preview proxy ngoài chặn burst — request chưa tới app) — AbortError vẫn
// ném lại ngay trong wrapper nên logic abort ở đây KHÔNG đổi.
import { fetchWithTransientRetry } from '@/lib/fetch-retry'

// ==================== HẰNG SỐ (precedent brain-tab POLL_*) ====================

/** Poll nhanh khi có sự kiện mới (tiền lệ POLL_ACTIVITY_MS = 2_500). */
const POLL_ACTIVE_MS = 2_500
/** Poll chậm khi idle (tiền lệ POLL_NEURAL_MS = 15_000). */
const POLL_IDLE_MS = 15_000
/** Số sự kiện mỗi trang. */
const PAGE_LIMIT = 50
/** traces panel chỉ cần response (traces + flags) — sự kiện lấy tối thiểu. */
const TRACES_EVENTS_LIMIT = 1

// ==================== TYPES (đối chiếu route.ts — pin r97 source-scan) ====================

interface ObsEventRow {
  seq: number
  ts: string
  actor: string
  kind: string
  runId: string | null
  sessionId: string | null
  table: string | null
  rowKey: string | null
  summary: string
  payload: Record<string, unknown>
}

/** Trace suy luận não — hợp đồng 26-BE thêm head? (phòng thủ: organ/head đều có thể thiếu). */
interface ObsTraceRow {
  id: string
  ts: string
  brain: string
  modelVersion: number
  organ: string | null
  head?: string | null
  runId: string | null
  inputHash: string
  latencyMs: number
  input: string | null
  output: string | null
}

interface TimelineResponse {
  ok: boolean
  flags: { obsLedger: boolean; obsBrainTrace: boolean; obsImpact: boolean; uiObservation: boolean }
  events: ObsEventRow[]
  hasMore: boolean
  nextBefore: number | null
  total: number
  traces: ObsTraceRow[]
  kinds: ObsKindDef[]
  /** Hợp đồng 26-BE: đếm cảnh báo 24h — thiếu thì coi như 0 (phòng thủ). */
  alerts24h?: number
}

/** Activity đồng bộ với đài (brain-tab truyền xuống) + 2 field hợp đồng 26-BE. */
type ObsActivity = BrainActivity & { backprop?: StageBackprop | null; training?: StageTraining | null }

// ==================== 4 CHẾ ĐỘ QUAN SÁT (selector SECTION 1 — single-source) ====================

export type ObsMode = 'neurons' | 'timeline' | 'traces' | 'golden'

/**
 * 4 chế độ quan sát (Task 26) — brain-tab render tablist SECTION 1 từ đây
 * (single-source: đổi chế độ tại đây tự đổi cả selector + panel).
 */
export const OBS_MODES: ReadonlyArray<{ id: ObsMode; label: string }> = [
  { id: 'neurons', label: 'Hoạt động nơ-ron' },
  { id: 'timeline', label: 'Timeline sự kiện' },
  { id: 'traces', label: 'Vết suy luận' },
  { id: 'golden', label: 'Kim tuyến runId' },
]

// ==================== HELPERS ====================

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleTimeString('vi-VN', { hour12: false })
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

/**
 * Chip màu kind — tra kinds.ts single-source (obsKindDef), kind lạ rơi nhóm
 * 'db' (fail-open). FB-OBS-R1-07: bỏ bản sao map 16-kind cục bộ — thêm kind
 * mới ở kinds.ts (26-BE: obs.alert nhóm amber) tự động đúng màu.
 */
function kindClass(kind: string): string {
  return OBS_GROUP_CLASSES[obsKindDef(kind)?.group ?? 'db']
}

const fmtNum = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—')

// ==================== HOOK: BẬT CỜ ui_observation (dùng chung 4 panel) ====================

/** POST bật cờ ui_observation (precedent hitech-toggle — tuning-store ghi audit). */
async function postEnableUiObservation(): Promise<Response> {
  return fetch('/api/neural-architecture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set', key: 'ui_observation', value: 'on' }),
  })
}

/** Nút bật nhanh + trạng thái enabling (4 panel dùng chung — idempotent). */
function useEnabling(refresh: () => Promise<unknown>) {
  const [enabling, setEnabling] = useState(false)
  const enable = useCallback(async () => {
    setEnabling(true)
    try {
      const res = await postEnableUiObservation()
      if (!res.ok) throw new Error(String(res.status))
      toast.success('Đã bật quan sát (ui_observation=on) — tuning-store ghi audit')
      await refresh()
    } catch {
      toast.warning('Không bật được cờ — bật tay tại tab BRAIN › Tham số runtime › UI_OBSERVATION')
    } finally {
      setEnabling(false)
    }
  }, [refresh])
  return { enabling, enable }
}

/** Khối trạng thái tối giản khi cờ ui_observation TẮT (4 panel dùng chung). */
function ObsOffBox({ enabling, onEnable }: { enabling: boolean; onEnable: () => void }) {
  return (
    <div className="rounded-md border border-stone-700/70 bg-stone-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <EyeOff className="h-4 w-4 shrink-0 text-stone-400" />
        <span className="text-[11px] text-stone-300">
          Cờ <span className="font-mono text-stone-100">ui_observation</span> đang TẮT — panel ở
          chế độ tối giản. Bật để xem nội dung quan sát đầy đủ.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 gap-1 border-stone-600 text-[11px]"
          disabled={enabling}
          onClick={onEnable}
          aria-label="Bật cờ ui_observation"
        >
          <Eye className="h-3 w-3" />
          {enabling ? 'Đang bật…' : 'Bật ngay'}
        </Button>
      </div>
    </div>
  )
}

// ==================== HOOK: FEED TIMELINE (tái dùng logic Task 25 — 3 panel events) ====================

/**
 * Feed /api/observation/timeline cho 3 panel events (timeline/golden/traces):
 * poll THÍCH ỨNG 2,5s/15s + visibilitychange (pattern Task 25 — KHÔNG viết lại
 * từ đầu); mount/unmount theo obsMode → poll tự dừng khi không hiển thị.
 *  · timeline: filter kind/actor/since + limit PAGE_LIMIT (runId luôn tắt)
 *  · golden : lọc runId kim tuyến (không filter bar → query chỉ runId + limit)
 *  · traces : lọc ?brain= theo não đang chọn (hợp đồng 26-BE) + limit 1 —
 *    panel chỉ đọc data.traces/flags, sự kiện không cần
 */
function useObsFeed(kind: 'timeline' | 'golden' | 'traces', brainKey?: string) {
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /// Seq mới nhất đã thấy — quyết định nhịp poll (2,5s có mới / 15s idle)
  const lastSeqRef = useRef<number | null>(null)
  /// Cooldown poll nhanh: sau khi có dữ liệu mới, giữ nhịp nhanh VÒNG KẾ
  const fastUntilRef = useRef<number>(0)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // ── State filter (C.5-2 — chỉ timeline dùng; golden/traces bỏ qua) ──
  const [kindFilter, setKindFilter] = useState<string>('')
  const [actorFilter, setActorFilter] = useState('')
  const [sinceFilter, setSinceFilter] = useState<string>('')
  /// runId đang theo dõi kim tuyến (chỉ golden; chuỗi rỗng = tắt)
  const [runIdInput, setRunIdInput] = useState('')
  const [runIdActive, setRunIdActive] = useState<string | null>(null)

  // ── Drill-down (dialog precedent tuning-param-dialog — timeline + golden) ──
  const [detail, setDetail] = useState<ObsEventRow | null>(null)

  const sinceIso = useMemo(() => {
    if (!sinceFilter) return ''
    const minutes = Number(sinceFilter)
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }, [sinceFilter])

  // ── Fetch timeline (mọi filter → query; READ-ONLY) ──
  const fetchFeed = useCallback(async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const q = new URLSearchParams()
      if (kind === 'timeline') {
        if (kindFilter) q.set('kind', kindFilter)
        if (actorFilter.trim()) q.set('actor', actorFilter.trim())
        if (sinceIso) q.set('since', sinceIso)
        q.set('limit', String(PAGE_LIMIT))
      } else if (kind === 'golden') {
        if (runIdActive) q.set('runId', runIdActive)
        q.set('limit', String(PAGE_LIMIT))
      } else {
        // traces: hợp đồng 26-BE — ?brain= lọc traces theo não đang chọn
        if (brainKey) q.set('brain', brainKey)
        q.set('limit', String(TRACES_EVENTS_LIMIT))
      }
      const res = await fetchWithTransientRetry(`/api/observation/timeline?${q.toString()}`, { signal: ac.signal }, { label: 'obs-timeline' })
      if (!mountedRef.current || ac.signal.aborted) return
      if (!res.ok) {
        // 400 (query rác) → bỏ lặng lẽ — poll không toast spam (contract 15-a)
        setLoadError(res.status === 400 ? 'Tham số lọc không hợp lệ' : 'Lỗi tải timeline')
        return
      }
      const json = (await res.json()) as TimelineResponse
      if (!mountedRef.current || ac.signal.aborted) return
      if (!json.ok) return
      setData(json)
      setLoadError(null)
      // nhịp thích ứng: có sự kiện mới hơn seq đã thấy → giữ nhanh 1 vòng
      const top = json.events[0]?.seq ?? null
      if (top !== null && (lastSeqRef.current === null || top > lastSeqRef.current)) {
        fastUntilRef.current = Date.now() + POLL_ACTIVE_MS * 4
      }
      if (top !== null) lastSeqRef.current = Math.max(lastSeqRef.current ?? 0, top)
    } catch (err) {
      if (ac.signal.aborted || !mountedRef.current) return
      setLoadError('Mất kết nối — giữ dữ liệu cũ') // fail-open giữ dữ liệu (FB-OBS-LIVE-01)
      void err
    }
  }, [kind, brainKey, kindFilter, actorFilter, runIdActive, sinceIso])

  // ── Poll thích ứng + visibilitychange (pattern Task 25 — giữ nguyên) ──
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      const delay = Date.now() < fastUntilRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS
      timer = setTimeout(async () => {
        await fetchFeed()
        schedule()
      }, delay)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) { clearTimeout(timer); timer = null }
      } else {
        void fetchFeed()
        schedule()
      }
    }
    if (document.visibilityState !== 'hidden') {
      // queueMicrotask — pattern brain-tab 15-d: KHÔNG gọi fetch (chứa
      // setState) trực tiếp trong effect body (react-hooks/set-state-in-effect)
      queueMicrotask(() => { void fetchFeed() })
      schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchFeed])

  const refetchNow = useCallback(async () => {
    await fetchFeed()
  }, [fetchFeed])

  // ── Kim tuyến (chỉ golden): start/clear + tóm tắt run ──
  const startGoldenThread = useCallback(() => {
    const v = runIdInput.trim()
    setRunIdActive(v !== '' ? v : null)
    lastSeqRef.current = null
  }, [runIdInput])

  const clearGoldenThread = useCallback(() => {
    setRunIdInput('')
    setRunIdActive(null)
    lastSeqRef.current = null
  }, [])

  const runSummary = useMemo(() => {
    if (kind !== 'golden' || !runIdActive || !data) return null
    const evs = data.events
    const start = evs.find(e => e.kind === 'run.start')
    const end = [...evs].reverse().find(e => e.kind === 'run.end')
    const byGroup = new Map<string, number>()
    for (const e of evs) {
      const g = e.kind.split('.')[0]
      byGroup.set(g, (byGroup.get(g) ?? 0) + 1)
    }
    const durationMs =
      start && end ? new Date(end.ts).getTime() - new Date(start.ts).getTime() : null
    return {
      total: data.total,
      loaded: evs.length,
      durationMs,
      running: !end,
      byGroup,
      nTraces: data.traces.length,
    }
  }, [kind, runIdActive, data])

  return {
    data, loadError, refetchNow,
    kindFilter, setKindFilter, actorFilter, setActorFilter, sinceFilter, setSinceFilter,
    kindOptions: data?.kinds ?? [],
    flagUiOn: data?.flags.uiObservation ?? false,
    initialLoading: data === null,
    runIdInput, setRunIdInput, runIdActive, startGoldenThread, clearGoldenThread, runSummary,
    detail, setDetail,
  }
}

/** Chip 4 cờ trạng thái (dùng chung timeline/golden/traces header). */
function ObsFlagChips({ data }: { data: TimelineResponse | null }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1">
      {([
        ['obs_ledger', data?.flags.obsLedger],
        ['obs_brain_trace', data?.flags.obsBrainTrace],
        ['obs_impact', data?.flags.obsImpact],
        ['ui_observation', data?.flags.uiObservation],
      ] as const).map(([k, on]) => (
        <span
          key={k}
          className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
            on ? 'bg-teal-500/15 text-teal-300 border-teal-500/30' : 'bg-stone-500/10 text-stone-500 border-stone-500/25'
          }`}
        >
          {k}={on ? 'on' : 'off'}
        </span>
      ))}
    </div>
  )
}

// ==================== PANEL 1 · neurons — "Hoạt động nơ-ron" ====================

/**
 * Bảng activation THẬT — dữ liệu từ CÙNG activity fetch của đài quan sát
 * (brain-tab truyền xuống; 1 poller duy nhất chia sẻ stage + panel — B5).
 * Cờ ui_observation đọc bằng 1 fetch nhẹ (limit=1) — KHÔNG poll riêng.
 */
export function ObsNeuronsPanel({
  activity,
  brainKey,
  brainTitle,
}: {
  activity: ObsActivity | null
  brainKey: string
  brainTitle: string
}) {
  // ── Đọc cờ ui_observation 1 lần lúc mount (fetch nhẹ limit=1, không poll) ──
  const [flag, setFlag] = useState<boolean | null>(null)
  const [flagError, setFlagError] = useState<string | null>(null)
  const flagAbortRef = useRef<AbortController | null>(null)
  const flagMountedRef = useRef(true)
  useEffect(() => {
    flagMountedRef.current = true
    return () => {
      flagMountedRef.current = false
      flagAbortRef.current?.abort()
    }
  }, [])
  const fetchFlag = useCallback(async () => {
    flagAbortRef.current?.abort()
    const ac = new AbortController()
    flagAbortRef.current = ac
    try {
      const res = await fetchWithTransientRetry(`/api/observation/timeline?limit=${TRACES_EVENTS_LIMIT}`, { signal: ac.signal }, { label: 'obs-flag' })
      if (!flagMountedRef.current || ac.signal.aborted) return
      if (!res.ok) { setFlag(null); setFlagError(`HTTP ${res.status}`); return }
      const json = (await res.json()) as TimelineResponse
      if (!flagMountedRef.current || ac.signal.aborted) return
      setFlag(json.flags?.uiObservation ?? false)
      setFlagError(null)
    } catch (err) {
      if (ac.signal.aborted || !flagMountedRef.current) return
      setFlag(null)
      setFlagError('lỗi mạng')
      void err
    }
  }, [])
  useEffect(() => { queueMicrotask(() => { void fetchFlag() }) }, [fetchFlag])
  const { enabling, enable } = useEnabling(async () => { await fetchFlag() })

  // ── Hàng dữ liệu: mỗi lớp 1 hàng theo activity THẬT (input luôn có khi dormant) ──
  const rows = useMemo(() => {
    if (!activity) return null
    const list: Array<{ label: string; isInput: boolean; acts: number[] | null }> = [
      { label: 'Đầu vào', isInput: true, acts: activity.inputVector ?? null },
    ]
    if (activity.status === 'active' && activity.activations) {
      for (let c = 1; c < activity.activations.length; c++) {
        const last = c === activity.activations.length - 1
        list.push({ label: last ? 'Đầu ra' : `Ẩn ${c}`, isInput: false, acts: activity.activations[c] ?? null })
      }
    }
    return list
  }, [activity])

  // min/max/mean |a| mỗi hàng + thanh cường độ chuẩn hóa theo mean lớn nhất
  const stats = useMemo(() => {
    if (!rows) return null
    const computed = rows.map(r => {
      const a = r.acts
      if (!a || a.length === 0) return { ...r, units: 0, min: null as number | null, max: null as number | null, mean: null as number | null }
      let mn = Infinity
      let mx = 0
      let sum = 0
      for (const v of a) {
        const abs = Math.abs(v)
        if (abs < mn) mn = abs
        if (abs > mx) mx = abs
        sum += abs
      }
      return { ...r, units: a.length, min: mn, max: mx, mean: sum / a.length }
    })
    const maxMean = Math.max(...computed.map(c => c.mean ?? 0), 1e-12)
    return computed.map(c => ({ ...c, bar: c.mean !== null ? Math.min(100, Math.round((c.mean / maxMean) * 100)) : 0 }))
  }, [rows])

  /// Lớp input: top nơ-ron sáng nhất kèm tên đặc trưng (featureNames có sẵn)
  const topInputFeatures = useMemo(() => {
    const a = activity?.inputVector
    if (!a || a.length === 0) return []
    const names = activity?.featureNames ?? null
    return a
      .map((v, i) => ({ i, abs: Math.abs(v), name: names?.[i] ?? `#${i + 1}`, v }))
      .sort((x, y) => y.abs - x.abs)
      .slice(0, 3)
  }, [activity])

  const trainingRunning = activity?.training?.status === 'running' && activity.training.brain === brainKey
  const backReady = activity?.backprop != null && activity.backprop.deltas != null
  const backLabel = activity?.backprop?.label ?? null
  const backLoss = typeof activity?.backprop?.loss === 'number' ? activity.backprop.loss : null

  // ==================== RENDER ====================
  return (
    <div className="space-y-2.5" role="region" aria-label="Quan sát hoạt động nơ-ron">
      <div className="flex flex-wrap items-center gap-2">
        <Zap className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <h4 className="text-xs font-semibold text-stone-100">Hoạt động nơ-ron — {brainTitle}</h4>
        <span className="text-[10px] text-stone-500">
          activation thật từng lớp (bản active) · nguồn: activity poll của đài — không fetch riêng
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {activity && (
            <span
              className={`rounded border px-1.5 py-0.5 text-[9px] ${activity.agentRunInProgress
                ? 'animate-pulse border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-stone-700/70 text-stone-500'}`}
              title={activity.sourceLabel ?? 'không rõ nguồn dữ liệu'}
            >
              {activity.agentRunInProgress ? '● Agent đang chạy' : 'Agent nghỉ'}
            </span>
          )}
          {trainingRunning && (
            <span
              className="animate-pulse rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300"
              title={`Train ${activity?.training?.brain ?? ''}${activity?.training?.head ? ` · head ${activity.training.head}` : ''} — bắt đầu ${activity?.training ? new Date(activity.training.startedAt).toLocaleTimeString('vi-VN') : '—'}`}
            >
              ● ĐANG TRAIN
            </span>
          )}
        </div>
      </div>

      {/* ── Trạng thái tắt (cờ ui_observation off) — nút bật tại chỗ ── */}
      {flag === false && (
        <ObsOffBox enabling={enabling} onEnable={() => { void enable() }} />
      )}
      {flag === null && (
        <div className="flex flex-wrap items-center gap-2 py-2 text-[11px] text-stone-500" aria-live="polite">
          <RefreshCw className={`h-3.5 w-3.5 ${flagError ? '' : 'animate-spin'}`} />
          {flagError
            ? <span className="text-amber-400">Không đọc được cờ ui_observation ({flagError}) — hiển thị đầy đủ (fail-open)</span>
            : 'Đang đọc cờ ui_observation…'}
        </div>
      )}

      {flag !== false && (
        <>
          {/* Dòng trạng thái backprop — TRUNG THỰC (không bịa gradient) */}
          <div
            className={`rounded-md border px-2.5 py-1.5 text-[10px] ${backReady
              ? 'border-yellow-400/40 bg-yellow-400/10 text-yellow-300'
              : 'border-stone-700/70 bg-stone-900/40 text-stone-400'}`}
            title={backReady
              ? `Gradient THẬT 1 mẫu thật qua bản active${backLabel ? ` · ${backLabel}` : ''}${backLoss !== null ? ` · loss ${backLoss.toFixed(4)}` : ''} — đường/hạt vàng trên đài theo |δ×a| per-edge`
              : 'Chưa có gradient thật — đường ngược không hiển thị trên đài (nguyên tắc THẬT)'}
          >
            {backReady
              ? <>Gradient mẫu thật sẵn sàng{backLabel ? <> · <span className="font-mono">{backLabel}</span></> : null}{backLoss !== null ? <> · loss <span className="font-mono">{backLoss.toFixed(4)}</span></> : null}</>
              : 'Chưa có gradient thật (não dormant / thiếu nhãn)'}
          </div>

          {!activity && (
            <p className="py-3 text-center text-[11px] text-stone-500 italic">
              Chưa có dữ liệu hoạt động — bật Live phía trên đài (poll /api/brain/activity).
            </p>
          )}

          {activity && stats && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-stone-500 border-b border-slate-800">
                    <th className="text-left py-1.5 pr-2 font-medium">Lớp</th>
                    <th className="text-left py-1.5 pr-2 font-medium">Units</th>
                    <th className="text-right py-1.5 pr-2 font-medium">min |a|</th>
                    <th className="text-right py-1.5 pr-2 font-medium">max |a|</th>
                    <th className="text-right py-1.5 pr-2 font-medium">mean |a|</th>
                    <th className="text-left py-1.5 font-medium">Cường độ</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((r, idx) => (
                    <tr key={`${r.label}-${idx}`} className="border-b border-slate-900/80">
                      <td className="py-1.5 pr-2 text-stone-200">{r.label}{r.isInput ? <span className="ml-1 text-[9px] text-stone-600">(đặc trưng thật)</span> : null}</td>
                      <td className="py-1.5 pr-2 font-mono tabular-nums text-stone-300">{r.units > 0 ? r.units : '—'}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-stone-400">{r.min === null ? '—' : fmtNum(r.min)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-stone-400">{r.max === null ? '—' : fmtNum(r.max)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-stone-200">{r.mean === null ? '—' : fmtNum(r.mean)}</td>
                      <td className="py-1.5">
                        <div className="flex items-center gap-2" aria-hidden="true">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-900">
                            <div
                              className={`h-full rounded-full ${r.isInput ? 'bg-violet-500/70' : 'bg-amber-500/70'}`}
                              style={{ width: `${r.bar}%` }}
                            />
                          </div>
                          <span className="text-[9px] tabular-nums text-stone-500">{r.bar}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activity.status === 'dormant' && (
                <p className="mt-1.5 text-[10px] text-stone-600">
                  não đang ngủ — chỉ lớp đầu vào có dữ liệu thật (one-hot từ {activity.sourceLabel ?? 'nguồn chưa ghi nhận'});
                  activation lớp ẩn/ra chỉ có khi não ACTIVE (không bịa).
                </p>
              )}
            </div>
          )}

          {/* Lớp input: tên đặc trưng của top nơ-ron sáng nhất */}
          {activity && topInputFeatures.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-stone-500">Nơ-ron input sáng nhất:</span>
              {topInputFeatures.map(f => (
                <span
                  key={f.i}
                  className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300"
                  title={`Đặc trưng #${f.i + 1} — giá trị thật ${f.v.toFixed(4)} (featureNames từ activity)`}
                >
                  <span className="font-mono">{f.name}</span>
                  <span className="ml-1 font-mono text-violet-400/80">{f.v.toFixed(3)}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ==================== PANEL 2 · timeline — "Timeline sự kiện" ====================

export function ObsTimelinePanel() {
  const {
    data, loadError, refetchNow,
    kindFilter, setKindFilter, actorFilter, setActorFilter, sinceFilter, setSinceFilter,
    kindOptions, flagUiOn, initialLoading, detail, setDetail,
  } = useObsFeed('timeline')
  const { enabling, enable } = useEnabling(refetchNow)

  return (
    <div className="space-y-2.5" role="region" aria-label="Quan sát vận hành — timeline sự kiện">
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <h4 className="text-xs font-semibold text-stone-100">Timeline sự kiện</h4>
        <span className="text-[10px] text-stone-500">bảng bệnh án toàn thân · read-only</span>
        {(data?.alerts24h ?? 0) > 0 && (
          <span
            className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300"
            title="Số cảnh báo quan sát 24 giờ gần nhất (hợp đồng 26-BE — alerts24h)"
          >
            ⚠ {data?.alerts24h} cảnh báo 24h
          </span>
        )}
        <ObsFlagChips data={data} />
      </div>

      {initialLoading === false && !flagUiOn && (
        <ObsOffBox enabling={enabling} onEnable={() => { void enable() }} />
      )}

      {initialLoading && (
        <div className="flex items-center gap-2 py-6 text-[11px] text-stone-500" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {loadError ? (
            <span className="text-amber-400">{loadError} — thử lại</span>
          ) : (
            'Đang tải timeline quan sát…'
          )}
        </div>
      )}

      {initialLoading === false && flagUiOn && (
        <>
          {/* ── Filter bar (C.5-2) ── */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-3 w-3 shrink-0 text-stone-500" />
            <div className="relative">
              <select
                value={kindFilter}
                onChange={e => setKindFilter(e.target.value)}
                aria-label="Lọc theo loại sự kiện"
                className="min-h-[36px] appearance-none rounded border border-stone-700 bg-stone-900/60 py-1 pl-2 pr-7 text-[11px] text-stone-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">Mọi loại</option>
                {kindOptions.map(k => (
                  <option key={k.kind} value={k.kind}>{k.label} ({k.kind})</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-500" />
            </div>
            <input
              value={actorFilter}
              onChange={e => setActorFilter(e.target.value)}
              placeholder="actor (vd agent:opus)"
              aria-label="Lọc theo actor"
              className="min-h-[36px] w-40 rounded border border-stone-700 bg-stone-900/60 px-2 text-[11px] text-stone-200 placeholder:text-stone-600 focus:border-cyan-600 focus:outline-none"
            />
            <div className="relative">
              <select
                value={sinceFilter}
                onChange={e => setSinceFilter(e.target.value)}
                aria-label="Lọc theo khoảng thời gian"
                className="min-h-[36px] appearance-none rounded border border-stone-700 bg-stone-900/60 py-1 pl-2 pr-7 text-[11px] text-stone-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">Mọi thời gian</option>
                <option value="15">15 phút</option>
                <option value="60">1 giờ</option>
                <option value="360">6 giờ</option>
                <option value="1440">24 giờ</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-500" />
            </div>
            <span className="ml-auto text-[10px] text-stone-500" aria-live="polite">
              {loadError ? <span className="text-amber-400">{loadError}</span> : `${data?.total ?? 0} sự kiện`}
            </span>
          </div>

          {/* ── Cảnh báo obs_ledger off (dữ liệu ngừng ghi mới) ── */}
          {data && !data.flags.obsLedger && (
            <div className="rounded border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-[10px] text-amber-300">
              Cờ <span className="font-mono">obs_ledger</span> đang tắt — không có sự kiện MỚI được
              ghi (lịch sử cũ vẫn hiển thị). Bật tại tab BRAIN › Tham số runtime › OBS_LEDGER.
            </div>
          )}

          {/* ── Timeline dọc (C.5-1) — max-h scroll + scrollbar mảnh ── */}
          <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-md border border-stone-800 [scrollbar-width:thin]">
            {data && data.events.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-stone-500">
                Chưa có sự kiện nào — bật obs_ledger rồi vận hành agents, sự kiện sẽ chảy vào đây
              </div>
            )}
            <ul className="divide-y divide-stone-800/60">
              {data?.events.map(e => (
                <li key={e.seq}>
                  <button
                    onClick={() => setDetail(e)}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-stone-800/30 min-h-[44px] md:min-h-[36px]"
                    aria-label={`Sự kiện ${e.kind} — ${e.summary}`}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-[9px] text-stone-500">
                      {fmtDate(e.ts)} {fmtTime(e.ts)}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${obsActorClass(e.actor)}`}>
                      {e.actor.length > 18 ? `${e.actor.slice(0, 16)}…` : e.actor}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${kindClass(e.kind)}`}>
                      {e.kind}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-stone-300">{e.summary}</span>
                    {e.runId && (
                      <span className="shrink-0 font-mono text-[9px] text-cyan-500/80" title={e.runId}>
                        ◈ {e.runId.slice(0, 12)}…
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {data?.hasMore && (
              <div className="px-3 py-2 text-center text-[10px] text-stone-500">
                Còn {Math.max(0, data.total - data.events.length)} sự kiện cũ hơn — thu hẹp filter
                hoặc xem tại DB (prune giữ 50K/30 ngày)
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Drill-down payload (dialog precedent tuning-param-dialog) ── */}
      <Dialog open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-lg border-stone-700 bg-stone-950">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] ${detail ? kindClass(detail.kind) : ''}`}>
                {detail?.kind}
              </span>
              <span className="font-mono text-[10px] text-stone-500">seq {detail?.seq}</span>
            </DialogTitle>
            <DialogDescription className="text-left text-[11px] text-stone-300">
              {detail?.summary}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto [scrollbar-width:thin]">
            {detail && (
              <>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-stone-500">
                  <span>thời điểm: {fmtDate(detail.ts)} {fmtTime(detail.ts)}</span>
                  <span className="truncate">actor: {detail.actor}</span>
                  <span className="truncate">runId: {detail.runId ?? '—'}</span>
                  <span className="truncate">bảng: {detail.table ?? '—'}{detail.rowKey ? ` · ${detail.rowKey.slice(0, 18)}` : ''}</span>
                </div>
                <pre className="overflow-x-auto rounded border border-stone-800 bg-stone-900/60 p-2 text-[10px] leading-relaxed text-stone-300">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== PANEL 3 · traces — "Vết suy luận" ====================

/**
 * Danh sách BrainInferenceTrace từ data.traces của timeline route — lọc theo
 * não đang chọn (?brain= — hợp đồng 26-BE). Phòng thủ: route đời cũ chỉ join
 * traces khi có runId → data.traces rỗng → trạng thái trống TRUNG THỰC.
 */
export function ObsTracesPanel({ brainKey, brainTitle }: { brainKey: string; brainTitle: string }) {
  const { data, loadError, refetchNow, flagUiOn, initialLoading } = useObsFeed('traces', brainKey)
  const { enabling, enable } = useEnabling(refetchNow)
  const traces = data?.traces ?? []

  return (
    <div className="space-y-2.5" role="region" aria-label="Quan sát vết suy luận não">
      <div className="flex flex-wrap items-center gap-2">
        <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-violet-400" />
        <h4 className="text-xs font-semibold text-stone-100">Vết suy luận — {brainTitle}</h4>
        <span className="text-[10px] text-stone-500">
          BrainInferenceTrace khi não suy luận thật (lọc ?brain= theo não đang chọn)
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span
            className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${data?.flags.obsBrainTrace
              ? 'bg-teal-500/15 text-teal-300 border-teal-500/30'
              : 'bg-stone-500/10 text-stone-500 border-stone-500/25'}`}
            title="Cờ obs_brain_trace — bật tại tab BRAIN › Tham số runtime (cờ này quyết định trace có lưu vector vào/ra hay chỉ hash)"
          >
            obs_brain_trace={data?.flags.obsBrainTrace ? 'on' : 'off'}
          </span>
        </div>
      </div>

      {initialLoading === false && !flagUiOn && (
        <ObsOffBox enabling={enabling} onEnable={() => { void enable() }} />
      )}

      {initialLoading && (
        <div className="flex items-center gap-2 py-6 text-[11px] text-stone-500" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {loadError ? (
            <span className="text-amber-400">{loadError} — thử lại</span>
          ) : (
            'Đang tải vết suy luận…'
          )}
        </div>
      )}

      {initialLoading === false && flagUiOn && (
        <div className="max-h-96 overflow-y-auto rounded-md border border-stone-800 [scrollbar-width:thin]">
          {traces.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-stone-500">
              Chưa có vết suy luận nào cho não này — não suy luận thật (agent vận hành) sẽ ghi
              BrainInferenceTrace (cờ obs_brain_trace tắt thì chỉ lưu hash, không lưu vector).
            </div>
          )}
          {traces.length > 0 && (
            <ul className="divide-y divide-stone-800/60">
              {traces.map(t => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[10px] text-stone-400 min-h-[44px] md:min-h-[36px]"
                  title={`Trace ${t.brain}${t.head ? ` head ${t.head}` : ''} · v${t.modelVersion} · ${t.latencyMs}ms${t.runId ? ` · run ${t.runId}` : ''}`}
                >
                  <span className="font-mono text-[9px] text-stone-500">{fmtDate(t.ts)} {fmtTime(t.ts)}</span>
                  <span className="text-violet-300">{t.brain}</span>
                  <span>· {t.organ ?? t.head ?? '?'} · v{t.modelVersion} · {t.latencyMs}ms</span>
                  <span className="truncate font-mono text-[9px] text-stone-600" title={t.inputHash}>
                    sha {t.inputHash.slice(0, 12)}…
                  </span>
                  {t.input === null && t.output === null && (
                    <span className="text-stone-600">(hash-only — bật obs_brain_trace để xem vector)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ==================== PANEL 4 · golden — "Kim tuyến runId" ====================

export function ObsGoldenPanel() {
  const {
    data, loadError, refetchNow, flagUiOn, initialLoading,
    runIdInput, setRunIdInput, runIdActive, startGoldenThread, clearGoldenThread, runSummary,
    detail, setDetail,
  } = useObsFeed('golden')
  const { enabling, enable } = useEnabling(refetchNow)

  return (
    <div className="space-y-2.5" role="region" aria-label="Quan sát kim tuyến runId">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <h4 className="text-xs font-semibold text-stone-100">Kim tuyến runId</h4>
        <span className="text-[10px] text-stone-500">
          toàn cảnh 1 run agent — sự kiện + vết suy luận não cùng 1 luồng
        </span>
        <ObsFlagChips data={data} />
      </div>

      {initialLoading === false && !flagUiOn && (
        <ObsOffBox enabling={enabling} onEnable={() => { void enable() }} />
      )}

      {initialLoading && (
        <div className="flex items-center gap-2 py-6 text-[11px] text-stone-500" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {loadError ? (
            <span className="text-amber-400">{loadError} — thử lại</span>
          ) : (
            'Đang tải kim tuyến…'
          )}
        </div>
      )}

      {initialLoading === false && flagUiOn && (
        <>
          {/* ── Kim tuyến (golden thread — C.5-3): input + Theo dõi/Thoát ── */}
          <div className="rounded-md border border-cyan-900/50 bg-cyan-950/20 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium text-cyan-300">runId</span>
              <input
                value={runIdInput}
                onChange={e => setRunIdInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') startGoldenThread() }}
                placeholder="run_xxx… — xem toàn cảnh 1 run agent"
                aria-label="runId cần theo dõi kim tuyến"
                className="min-h-[36px] flex-1 min-w-[180px] rounded border border-stone-700 bg-stone-900/60 px-2 text-[11px] text-stone-200 placeholder:text-stone-600 focus:border-cyan-600 focus:outline-none"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 border-cyan-800 text-[11px] text-cyan-300 hover:text-cyan-200"
                onClick={startGoldenThread}
                aria-label="Theo dõi runId"
              >
                Theo dõi
              </Button>
              {runIdActive && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-1 text-[11px] text-stone-400"
                  onClick={clearGoldenThread}
                  aria-label="Xóa kim tuyến"
                >
                  <X className="h-3 w-3" /> Xóa
                </Button>
              )}
            </div>
            {runIdActive && runSummary && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400" aria-live="polite">
                <span className="font-mono text-cyan-300">{runIdActive}</span>
                <span>{runSummary.total} sự kiện</span>
                {runSummary.durationMs !== null && <span>thời lượng {(runSummary.durationMs / 1000).toFixed(1)}s</span>}
                <span className={runSummary.running ? 'text-teal-300' : 'text-stone-400'}>
                  {runSummary.running ? '● đang chạy' : '■ đã kết thúc'}
                </span>
                {runSummary.nTraces > 0 && <span>{runSummary.nTraces} vết suy diễn não</span>}
                <span className="text-stone-500">
                  {[...runSummary.byGroup.entries()].map(([g, n]) => `${g}:${n}`).join(' · ') || 'chưa có sự kiện'}
                </span>
              </div>
            )}
          </div>

          {/* ── Luồng sự kiện lọc theo runId ── */}
          <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-md border border-stone-800 [scrollbar-width:thin]">
            {data && data.events.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-stone-500">
                {runIdActive
                  ? 'Chưa có sự kiện nào cho runId này (run chưa chạy khi cờ obs_ledger bật?)'
                  : 'Nhập runId rồi bấm Theo dõi — toàn cảnh run sẽ chảy vào đây'}
              </div>
            )}
            <ul className="divide-y divide-stone-800/60">
              {data?.events.map(e => (
                <li key={e.seq}>
                  <button
                    onClick={() => setDetail(e)}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-stone-800/30 min-h-[44px] md:min-h-[36px]"
                    aria-label={`Sự kiện ${e.kind} — ${e.summary}`}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-[9px] text-stone-500">
                      {fmtDate(e.ts)} {fmtTime(e.ts)}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${obsActorClass(e.actor)}`}>
                      {e.actor.length > 18 ? `${e.actor.slice(0, 16)}…` : e.actor}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${kindClass(e.kind)}`}>
                      {e.kind}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-stone-300">{e.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Vết suy diễn não của run (kim tuyến — join trace C.4) ── */}
          {runIdActive && data && data.traces.length > 0 && (
            <div className="rounded-md border border-violet-900/40 bg-violet-950/10 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <BrainCircuit className="h-3 w-3 shrink-0 text-violet-400" />
                <span className="text-[10px] font-medium text-violet-300">
                  {data.traces.length} vết suy diễn não của run (mới → cũ)
                </span>
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto [scrollbar-width:thin]">
                {data.traces.map(t => (
                  <li
                    key={t.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-stone-800/60 bg-stone-900/40 px-2 py-1 text-[10px] text-stone-400"
                  >
                    <span className="font-mono text-[9px] text-stone-500">{fmtTime(t.ts)}</span>
                    <span className="text-violet-300">{t.brain}</span>
                    <span>· {t.organ ?? t.head ?? '?'} · v{t.modelVersion} · {t.latencyMs}ms</span>
                    <span className="truncate font-mono text-[9px] text-stone-600" title={t.inputHash}>
                      sha {t.inputHash.slice(0, 12)}…
                    </span>
                    {t.input === null && t.output === null && (
                      <span className="text-stone-600">(hash-only — bật obs_brain_trace để xem vector)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* ── Drill-down payload (dialog precedent tuning-param-dialog) ── */}
      <Dialog open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-lg border-stone-700 bg-stone-950">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] ${detail ? kindClass(detail.kind) : ''}`}>
                {detail?.kind}
              </span>
              <span className="font-mono text-[10px] text-stone-500">seq {detail?.seq}</span>
            </DialogTitle>
            <DialogDescription className="text-left text-[11px] text-stone-300">
              {detail?.summary}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto [scrollbar-width:thin]">
            {detail && (
              <>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-stone-500">
                  <span>thời điểm: {fmtDate(detail.ts)} {fmtTime(detail.ts)}</span>
                  <span className="truncate">actor: {detail.actor}</span>
                  <span className="truncate">runId: {detail.runId ?? '—'}</span>
                  <span className="truncate">bảng: {detail.table ?? '—'}{detail.rowKey ? ` · ${detail.rowKey.slice(0, 18)}` : ''}</span>
                </div>
                <pre className="overflow-x-auto rounded border border-stone-800 bg-stone-900/60 p-2 text-[10px] leading-relaxed text-stone-300">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
