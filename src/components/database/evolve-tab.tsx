'use client'

// ========================================================================
// evolve-tab — EVO UI U1–U5 (BLUEPRINT-EVO-NAO-P1-P5 §5 — R25-c)
// ========================================================================
//
// Tab console "Tiến hoá" của SECTION 3 (tab BRAIN) — phòng thí nghiệm tiến
// hoá kiến trúc HyperNAS/EVO. Backend EVO-P0..P4 (R24-c) đã sống: GET/POST
// /api/brain/evolve + /api/brain/evolve/cancel, cờ tuning #35 brain_evolve
// (tab này CHỈ được render khi cờ on — brain-tab lo) + #36 brain_search_global.
//
// NGUYÊN TẮC CHẮN (§5.1):
//  1. Đề xuất ≠ quyết định (H1/H2) — mọi copy nói "đề xuất — bạn duyệt";
//     KHÔNG đụng BrainModel/active; áp dụng chỉ ghi NHÁP (draft SECTION 1).
//  2. Single-source state — não đích + nháp tái dùng state brain-tab (props),
//     không nhân bản.
//  3. Tab ẩn hoàn toàn khi cờ brain_evolve off (brain-tab lo — §5.1-3).
//  4. Mobile-first: nút min-h-[44px] md:min-h-[32px] + text-[10px]; bảng bọc
//     overflow-x-auto max-h-96 overflow-y-auto.
//  5. A11y: role=tab/tabpanel do tablist console lo · progress aria-live
//     "polite" · nút icon có sr-only · bảng caption sr-only.
//  6. Poll thích ứng: đang chạy 2.5s (POLL_ACTIVITY_MS precedent) · idle 15s
//     (POLL_NEURAL_MS) · tab console không active → unmount (brain-tab) →
//     poll dừng hẳn · tab trình duyệt ẩn → pause (visibilitychange).
//     GET 404 → E1 "CHƯA SẴN SÀNG" (KHÔNG phải mất kết nối); 5xx/mạng →
//     GIỮ dữ liệu cũ + chip "mất kết nối" (không toast spam).
//  7. Không dependency mới — SVG thuần + Tailwind tokens; hiệu ứng duy nhất
//     animate-pulse bọc motion-safe (tôn trọng prefers-reduced-motion).
//
// Logic thuần test được tách sang `@/lib/brain/evo/ui-helpers` (r115 pin).
// ========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dna, FlaskConical, Play, ShieldAlert, Square, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { BRAIN_REGISTRY, BRAIN_TRAINABLE_KEYS, type BrainKey } from '@/lib/brain/registry'
import { getTuningSpec, type TuningChangeLogEntry } from '@/lib/learning/neural-types'
import { fetchWithTransientRetry } from '@/lib/fetch-retry'
import {
  deriveEvoState,
  formatCandidateLog,
  formatParamsBudget,
  formatViDecimal,
  formatViNum,
  hiddenFromSpec,
  isPureMlpCandidate,
  paretoFront,
  sortCandidates,
  splitEncodingZones,
  EVO_PARAMS_BUDGET,
  type EvoCandidateRowUi,
  type EvoGetResponseUi,
  type EvoZoneId,
} from '@/lib/brain/evo/ui-helpers'

// ==================== HẰNG SỐ (§5.1-6/§5.2) ====================

/** Đang chạy vòng → GET mỗi 2.5s (precedent POLL_ACTIVITY_MS). */
const POLL_RUN_MS = 2_500
/** Idle → GET mỗi 15s (precedent POLL_NEURAL_MS). */
const POLL_IDLE_MS = 15_000
/** Stepper ứng viên (§5.2 E2 — H3 ≤ 24, bước 4). */
const CANDIDATES_MIN = 4
const CANDIDATES_MAX = 24
const CANDIDATES_STEP = 4
const CANDIDATES_DEFAULT = 8
/** Bảng U2 hiển thị ≤ 60 hàng mới nhất mỗi vòng (DB giữ toàn bộ — H5). */
const MAX_TABLE_ROWS = 60
/** Rolling log E3 giữ N dòng gần nhất. */
const ROLLING_LOG_ROWS = 8
/** Seed người dùng đè (H4) — nguyên 0..2^31−1 (SEED_MAX server). */
const SEED_MAX_UI = 2_147_483_647

/** Copy pin §5.7 — client hiển thị đúng từng lỗi 400. */
const START_REASON_COPY: Record<string, string> = {
  flag_off: 'Cờ brain_evolve đang off (hoặc kill-switch toàn cục brain_search_global đang off) — bật ở bảng kill-switch cuối tab này.',
  already_running: 'Một vòng tiến hoá của não này đang chạy — chờ xong hoặc bấm Dừng.',
  invalid_brain: 'Não đích ngoài menu A/B/C — chọn nhanh Brain-A/B/C ở trên (Brain-D chưa vào search space).',
  invalid_candidates: 'Số ứng viên phải nguyên 4–24, bước 4.',
  invalid_seed: 'Seed phải là số nguyên 0..2147483647.',
}

/** Màu vùng encoding viewer U3 (§5.4 — không indigo/blue). */
const ZONE_BG: Record<EvoZoneId, string> = {
  hnp1: 'bg-stone-500',
  blocktype: 'bg-amber-500',
  blockparam: 'bg-orange-500',
  moeglobal: 'bg-yellow-400',
  reserved: 'bg-stone-300',
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const fmtCv = (n: number): string => formatViDecimal(n, 3)

// ==================== PROPS (brain-tab truyền — single-source §5.1-2) ====================

export interface EvolveTabProps {
  /** Não đang chọn SECTION 1 — não ĐÍCH của vòng evolve (chỉ A/B/C hợp lệ). */
  brain: BrainKey
  /** Chọn nhanh A/B/C khi đang ở Brain-D (knowledge chưa vào search space). */
  onSelectBrainQuick?: (k: BrainKey) => void
  /**
   * tuningByKey của brain-tab — chỉ cần đọc effectiveValue. (ReadonlyMap thay
   * vì Map<string, {…; [k: string]: unknown}>: interface TuningStateEntry
   * không có implicit index signature nên Map đầy đủ không assignable —
   * ReadonlyMap chỉ chứa vị trí hiệp biến thì OK.)
   */
  tuningByKey: ReadonlyMap<string, { effectiveValue: string | number }>
  /** Audit kill-switch U5 (§5.6) — lọc 2 key brain_evolve/brain_search_global. */
  changeLog: TuningChangeLogEntry[]
  /** Đặt tuning (POST /api/neural-architecture action 'set' — handleSet brain-tab). */
  onSetTuning: (key: string, value: string | number) => void
  savingKeys: ReadonlySet<string>
  /** Ghi hidden layers ứng viên THUẦN MLP vào nháp não đang chọn (draft SECTION 1). */
  onApplyToDraft: (hidden: Array<{ units: number; activation: string }>) => void
  /** Cờ ui_brain_edit — hiện cảnh báo khi off (editor SECTION 1 đang ẩn). */
  editorOn: boolean
  /** Tab console 'evo' đang mở — false → dừng poll (unmount cũng dừng hẳn). */
  consoleActive: boolean
}

// ==================== TAB TIẾN HOÁ (U1–U5) ====================

export function EvolveTab({
  brain, onSelectBrainQuick, tuningByKey, changeLog, onSetTuning, savingKeys,
  onApplyToDraft, editorOn, consoleActive,
}: EvolveTabProps) {
  // ── Dữ liệu poll (chỉ cập nhật khi GET 200 — không optimistic §5.2) ──
  const [resp, setResp] = useState<EvoGetResponseUi | null>(null)
  const [http, setHttp] = useState<'idle' | 'ok' | 'not_found' | 'error'>('idle')
  /// Run mới nhất cho scheduler adaptive (đọc ref — không re-create effect)
  const runRef = useRef<EvoGetResponseUi['run']>(null)
  /// Request-id chống response cũ ghi đè khi đổi não giữa chừng
  const reqIdRef = useRef(0)

  // ── Form E2 ──
  const [candidateCount, setCandidateCount] = useState(CANDIDATES_DEFAULT)
  const [seedText, setSeedText] = useState('')
  const [seedError, setSeedError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  /// R25 main: E4 mở lại form "Chạy vòng mới" (§5.2 — vòng gần nhất vẫn hiện dưới)
  const [formOpen, setFormOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  /// Dialog chi tiết U2 — idx ứng viên đang mở (null = đóng)
  const [detailIdx, setDetailIdx] = useState<number | null>(null)

  const brainTrainable = BRAIN_TRAINABLE_KEYS.includes(brain)
  const brainTitle = BRAIN_REGISTRY.find(b => b.key === brain)?.title ?? brain

  // ── GET evolve (404 → E1 · 5xx/mạng → giữ dữ liệu cũ + chip mất kết nối) ──
  const fetchEvolve = useCallback(async () => {
    const reqId = ++reqIdRef.current
    try {
      const res = await fetchWithTransientRetry(
        `/api/brain/evolve?brain=${encodeURIComponent(brain)}`,
        undefined,
        { label: 'evolve-tab' },
      )
      if (reqId !== reqIdRef.current) return
      if (res.status === 404) {
        // Route chưa deploy → E1 "CHƯA SẴN SÀNG" — KHÔNG phải mất kết nối (§5.1-6)
        setHttp('not_found')
        return
      }
      if (!res.ok) {
        setHttp('error') // 5xx — giữ resp cũ, chip "mất kết nối", poll thử lại
        return
      }
      const json = (await res.json()) as EvoGetResponseUi
      if (reqId !== reqIdRef.current) return
      setResp(json)
      runRef.current = json.run ?? null
      setHttp('ok')
    } catch {
      if (reqId !== reqIdRef.current) return
      setHttp('error') // mạng đứt — giữ dữ liệu cũ (fail-open)
    }
  }, [brain])

  // Đổi não đích → KHÔNG cần effect reset: brain-tab mount EvolveTab với
  // key={brain} (remount sạch toàn bộ state + poll khi đổi não đích).

  // ── Poll thích ứng (§5.1-6): 2.5s chạy / 15s idle · tab ẩn → pause ──
  useEffect(() => {
    if (!consoleActive) return
    let alive = true
    let paused = document.visibilityState === 'hidden'
    let timer: ReturnType<typeof setTimeout> | null = null
    const nextDelay = () => (runRef.current?.status === 'running' ? POLL_RUN_MS : POLL_IDLE_MS)
    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const schedule = () => {
      stop()
      if (paused || !alive) return
      timer = setTimeout(() => { void fetchEvolve().then(() => { if (alive) schedule() }) }, nextDelay())
    }
    const run = () => { void fetchEvolve().then(() => { if (alive) schedule() }) }
    if (!paused) queueMicrotask(run)
    const onVisibility = () => {
      paused = document.visibilityState === 'hidden'
      if (paused) stop()
      else run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [consoleActive, fetchEvolve])

  // ── Derived (state machine U1 — thuần, pin r115) ──
  const derived = useMemo(
    () => deriveEvoState(resp?.run ?? null, http === 'idle' ? 'ok' : http, resp?.candidates ?? []),
    [resp, http],
  )
  const run = resp?.run ?? null
  const candidates = resp?.candidates ?? []
  const sorted = useMemo(() => sortCandidates(candidates), [candidates])
  const tableRows = useMemo(() => sorted.slice(0, MAX_TABLE_ROWS), [sorted])
  const blocked = useMemo(() => sorted.filter(c => c.blockedH7), [sorted])
  const rollingLog = useMemo(
    () => [...candidates].sort((a, b) => b.idx - a.idx).slice(0, ROLLING_LOG_ROWS),
    [candidates],
  )
  const detailCand = useMemo(
    () => (detailIdx === null ? null : candidates.find(c => c.idx === detailIdx) ?? null),
    [candidates, detailIdx],
  )

  /// Best ứng viên — theo summary.bestCandidateIdx (server), fallback sort desc
  const bestCand = useMemo(() => {
    if (candidates.length === 0) return null
    const bi = run?.summary?.bestCandidateIdx
    if (typeof bi === 'number') {
      const byIdx = candidates.find(c => c.idx === bi)
      if (byIdx) return byIdx
    }
    return sorted[0] ?? null
  }, [candidates, run, sorted])

  /// "Áp dụng đề xuất" (§5.3): ≥1 beatActive + best không blockedH7 + best
  /// THUẦN MLP (editor v2 hiển thị block chưa sống) + không vượt trần 250K.
  const hasBeater = candidates.some(c => c.beatActive)
  const bestPure = bestCand !== null && isPureMlpCandidate(bestCand)
  const bestParamsOk = bestCand !== null && bestCand.params <= EVO_PARAMS_BUDGET
  const canApplyBest = Boolean(bestCand && hasBeater && !bestCand.blockedH7 && bestPure && bestParamsOk)
  const applyBestDisabledReason = !bestCand
    ? 'Chưa có ứng viên nào được chấm.'
    : !hasBeater
      ? 'Chưa có ứng viên nào thắng bản active — không có gì để đề xuất áp dụng.'
      : bestCand.blockedH7
        ? 'Ứng viên tốt nhất bị chặn H7 (p95 > 2× bản MLP chuỗi) — xem khu vực "Chặn H7" dưới.'
        : !bestPure
          ? 'Kiến trúc block cần editor v2 — chưa áp dụng được vào nháp (§5.3).'
          : !bestParamsOk
            ? (bestCand.note ?? `Vượt trần ${formatViNum(EVO_PARAMS_BUDGET)} tham số — không thể áp vào nháp.`)
            : null

  // ── POST start (H4: seed đè phải nguyên 0..SEED_MAX — validate local trước) ──
  const startRun = useCallback(async () => {
    if (!brainTrainable || starting) return
    const raw = seedText.trim()
    let seed: number | undefined
    if (raw !== '') {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > SEED_MAX_UI) {
        setSeedError(`Seed phải là số nguyên 0..${SEED_MAX_UI} (để trống = tự sinh theo vòng).`)
        return
      }
      seed = Number(raw)
    }
    setSeedError(null)
    setStarting(true)
    try {
      const res = await fetch('/api/brain/evolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brain, candidates: candidateCount, ...(seed !== undefined ? { seed } : {}) }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; message?: string; error?: string }
      if (!res.ok || json.ok !== true) {
        toast.error('Không bắt đầu được vòng tiến hoá', {
          description: (json.reason && START_REASON_COPY[json.reason])
            ?? json.message ?? json.error ?? `HTTP ${res.status}`,
        })
        return
      }
      setFormOpen(false) // E4 "Chạy vòng mới" → đóng form khi POST thành công
      // KHÔNG optimistic (§5.2) — đuổi GET ngắn cho tới khi thấy running rồi
      // mới vào E3 (POST fire-and-forget trả runId NGAY, registry có thể chưa kịp).
      for (const delay of [400, 1_200, 3_000]) {
        await sleep(delay)
        await fetchEvolve()
        if (runRef.current?.status === 'running') break
      }
    } catch (err) {
      toast.error('Không bắt đầu được vòng tiến hoá', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setStarting(false)
    }
  }, [brain, brainTrainable, candidateCount, fetchEvolve, seedText, starting])

  // ── POST cancel (cooperative — idempotent server-side) ──
  const cancelRun = useCallback(async () => {
    if (!run || cancelling) return
    setCancelling(true)
    try {
      await fetch('/api/brain/evolve/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id }),
      })
      await fetchEvolve() // vòng dừng ở ứng viên KẾ TIẾP — poll 2.5s sẽ bắt transition
    } catch (err) {
      toast.error('Không dừng được vòng tiến hoá', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setCancelling(false)
    }
  }, [cancelling, fetchEvolve, run])

  /// "Áp dụng vào nháp" từng hàng (dialog U2) — chỉ ứng viên THUẦN MLP
  const applyCandidate = useCallback((cand: EvoCandidateRowUi) => {
    const hidden = hiddenFromSpec(cand.spec)
    if (!hidden) {
      toast.error('Không đọc được spec ứng viên', { description: 'Spec không có head.hidden hợp lệ — không ghi được vào nháp.' })
      return
    }
    onApplyToDraft(hidden)
    setDetailIdx(null)
  }, [onApplyToDraft])

  // ── Thanh tiến độ kép E3 ──
  const progress = run?.progress
  const candPct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  const wallPct = progress ? Math.min(100, Math.round((progress.elapsedMs / Math.max(1, progress.wallMsMax)) * 100)) : 0

  return (
    <div className="space-y-3">
      {/* ── Header + mô tả (copy §5.8 NGUYÊN VĂN) ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
        <h4 className="text-xs font-semibold text-stone-100">Tiến hoá kiến trúc</h4>
        <span className="text-[10px] text-stone-500">não đích: {brainTitle} ({brain}) — đổi ở phần 1 · Chọn não &amp; kiến trúc</span>
        {http === 'error' && (
          <Badge variant="outline" className="h-3.5 border-amber-500/45 bg-amber-950/70 px-1 text-[9px] text-amber-400" title="GET /api/brain/evolve lỗi (5xx/mạng) — giữ dữ liệu cũ, poll tự thử lại">
            mất kết nối
          </Badge>
        )}
        {!editorOn && (
          <Badge variant="outline" className="h-3.5 border-stone-600/50 bg-slate-950/70 px-1 text-[9px] text-stone-400" title="Cờ ui_brain_edit=off — Editor SECTION 1 đang ẩn; nháp vẫn ghi được (bật cờ ở tab Tham số runtime để xem)">
            ui_brain_edit=off
          </Badge>
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-stone-500">
        Phòng thí nghiệm tiến hoá kiến trúc — sinh ứng viên (MLP + attention/SSM/MoE), train + kiểm định chéo thật,
        xếp hạng để bạn duyệt. Không tự thay não vận hành.
      </p>

      {http === 'idle' && <p className="py-3 text-center text-[11px] text-stone-600">Đang tải trạng thái evolve…</p>}

      {/* ── E1 — CHƯA SẴN SÀNG (GET 404 — hạ tầng chưa sống, không phải mất kết nối) ── */}
      {http !== 'idle' && derived.state === 'e1' && (
        <div className="rounded-md border border-stone-700/70 p-3">
          <Badge variant="outline" className="h-4 border-amber-500/45 bg-amber-950/70 px-1.5 text-[9px] text-amber-400">CHƯA SẴN SÀNG</Badge>
          <p className="mt-2 text-[11px] leading-relaxed text-stone-400">
            Cần hoàn thành EVO-P0→P4 (xem blueprint §4) — tab sẽ tự kích hoạt khi hạ tầng sống.
          </p>
        </div>
      )}

      {/* ── E2 — SẴN SÀNG: form khởi động ── */}
      {http !== 'idle' && (derived.state === 'e2' || (derived.state === 'e4' && formOpen)) && (
        <div className="space-y-3">
          {!brainTrainable && (
            <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-2.5">
              <p className="text-[11px] text-amber-300">Brain-D chưa vào search space (D4 §8.4) — chọn nhanh não đích:</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {BRAIN_TRAINABLE_KEYS.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onSelectBrainQuick?.(k)}
                    className="min-h-[44px] md:min-h-[32px] rounded-md border border-stone-700/70 px-2 text-[10px] text-stone-300 hover:border-amber-500/50 hover:text-amber-300"
                  >
                    {BRAIN_REGISTRY.find(b => b.key === k)?.title ?? k}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {/* Stepper số ứng viên 4–24 bước 4 (H3) */}
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-500">Số ứng viên</p>
              <div className="inline-flex items-stretch overflow-hidden rounded-md border border-stone-700/70">
                <button
                  type="button"
                  aria-label="Giảm 4 ứng viên"
                  disabled={candidateCount <= CANDIDATES_MIN}
                  onClick={() => setCandidateCount(c => Math.max(CANDIDATES_MIN, c - CANDIDATES_STEP))}
                  className="min-h-[44px] md:min-h-[32px] px-3 text-sm text-stone-300 hover:bg-slate-950/60 disabled:opacity-40"
                >
                  −
                </button>
                <span className="flex min-h-[44px] md:min-h-[32px] items-center border-x border-stone-700/70 px-3 font-mono text-[11px] tabular-nums text-stone-100">
                  {candidateCount} / {CANDIDATES_MAX}
                </span>
                <button
                  type="button"
                  aria-label="Tăng 4 ứng viên"
                  disabled={candidateCount >= CANDIDATES_MAX}
                  onClick={() => setCandidateCount(c => Math.min(CANDIDATES_MAX, c + CANDIDATES_STEP))}
                  className="min-h-[44px] md:min-h-[32px] px-3 text-sm text-stone-300 hover:bg-slate-950/60 disabled:opacity-40"
                >
                  +
                </button>
              </div>
              <p className="mt-1 text-[9.5px] text-stone-500">4–24, bước 4 (H3: ≤ 24 ứng viên / 10 phút mỗi vòng)</p>
            </div>
            {/* Seed (H4 — tất định, mặc định tự sinh theo vòng) */}
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-500">Seed</p>
              <input
                type="text"
                inputMode="numeric"
                value={seedText}
                onChange={e => { setSeedText(e.target.value); setSeedError(null) }}
                placeholder="tự sinh theo vòng (hash runId)"
                aria-label="Seed vòng tiến hoá — để trống để tự sinh theo vòng"
                className="w-full min-h-[44px] md:min-h-[32px] rounded-md border border-stone-700/70 bg-slate-950/60 px-2 font-mono text-[11px] text-stone-100 placeholder:text-stone-600 focus:border-amber-500/50 focus:outline-none"
              />
              {seedError && <p className="mt-1 text-[10px] text-amber-500">{seedError}</p>}
              <p className="mt-1 text-[9.5px] text-stone-500">
                Để trống = tự sinh theo vòng (hash runId) — nhập số nguyên 0..{SEED_MAX_UI} để chạy lại cùng seed tái hiện bit-đối-bít.
              </p>
            </div>
          </div>
          {/* E4 mở lại form → hàng đóng (E2 không cần — form là nội dung chính) */}
          {derived.state === 'e4' && (
            <div className="flex items-center gap-2">
              <p className="text-[10px] uppercase tracking-wide text-stone-500">Vòng tiến hoá mới</p>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="ml-auto min-h-[44px] md:min-h-[32px] rounded-md border border-stone-700/70 px-2 text-[10px] text-stone-400 hover:text-stone-200"
                aria-label="Đóng form chạy vòng mới"
              >Đóng ✕</button>
            </div>
          )}
          <p className="text-[10px] text-stone-500">Ngân sách: ≈ 1–3 phút · tối đa 10 phút · ≤ 24 ứng viên · ≤ 250K tham số</p>
          <button
            type="button"
            onClick={() => void startRun()}
            disabled={!brainTrainable || starting}
            className="inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
          >
            <Play className="h-3 w-3" aria-hidden="true" />
            {starting ? 'Đang khởi động…' : 'Bắt đầu tiến hoá'}
          </button>
          {derived.state === 'e2' && (
            <p className="text-[11px] italic text-stone-600">Chưa có vòng tiến hoá nào — bấm Bắt đầu tiến hoá</p>
          )}
        </div>
      )}

      {/* ── E3 — ĐANG CHẠY: tiến độ kép + rolling log + Dừng ── */}
      {http !== 'idle' && derived.state === 'e3' && run && (
        <div className="space-y-2.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="motion-safe:animate-pulse text-[11px] font-semibold text-amber-300">● Đang chạy</span>
            <span className="font-mono text-[9.5px] text-stone-500" title="Seed tất định (H4) — chạy lại cùng seed tái hiện bit-đối-bít">
              seed {run.seed} · runId {run.id}
            </span>
            <button
              type="button"
              onClick={() => void cancelRun()}
              disabled={cancelling}
              className="ml-auto inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1.5 rounded-md border border-stone-700/70 px-3 text-[11px] text-stone-300 hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-50"
            >
              <Square className="h-3 w-3" aria-hidden="true" />
              {cancelling ? 'Đang dừng…' : 'Dừng'}
            </button>
          </div>
          {/* Thanh tiến độ KÉP: ứng viên i/N + % wall-time ≤ 10 phút (H3) */}
          <div>
            <div className="mb-0.5 flex justify-between text-[10px] text-stone-400">
              <span>Ứng viên {progress?.done ?? 0}/{progress?.total ?? run.candidatesMax}</span>
              <span>{candPct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-900" aria-hidden="true">
              <div className="h-full rounded-full bg-amber-500/80 transition-[width]" style={{ width: `${candPct}%` }} />
            </div>
          </div>
          <div>
            <div className="mb-0.5 flex justify-between text-[10px] text-stone-400">
              <span>Wall-time ≤ {Math.round((progress?.wallMsMax ?? 600_000) / 60_000)} phút (H3)</span>
              <span>{wallPct}% · {Math.round((progress?.elapsedMs ?? 0) / 1000)}s</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-900" aria-hidden="true">
              <div className="h-full rounded-full bg-teal-500/70 transition-[width]" style={{ width: `${wallPct}%` }} />
            </div>
          </div>
          {/* Rolling log ứng viên gần nhất (render từ candidates đã về) */}
          <div className="dialog-scrollbar max-h-40 overflow-y-auto rounded-md border border-stone-800">
            {rollingLog.length === 0 && (
              <p className="px-2 py-2 text-[10px] text-stone-500">Đang chấm ứng viên đầu tiên…</p>
            )}
            {rollingLog.map(c => (
              <p key={c.idx} className="border-b border-slate-900/80 px-2 py-1 font-mono text-[10px] text-stone-300 last:border-0">
                {formatCandidateLog(c)}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* ── E4 — XONG (done/failed/cancelled): banner + đề xuất + U2 + U4 + E5 ── */}
      {http !== 'idle' && derived.state === 'e4' && run && (
        <div className="space-y-3">
          {/* Banner theo status (copy §5.8) */}
          {run.status === 'failed' && (
            <div className="rounded-md border border-rose-500/40 bg-rose-950/20 p-2.5">
              <p className="text-[11px] text-rose-300">
                Vòng lỗi: {run.error ?? 'không rõ lỗi'} — chạy lại cùng seed {run.seed} để tái hiện
              </p>
            </div>
          )}
          {run.status === 'cancelled' && (
            <div className="rounded-md border border-stone-600/50 bg-slate-950/60 p-2.5">
              <p className="text-[11px] text-stone-300">
                Đã dừng lúc {run.progress.done}/{run.progress.total} — giữ {candidates.length} ứng viên đã chấm
              </p>
            </div>
          )}
          {run.status === 'done' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="h-3.5 border-emerald-500/40 bg-emerald-950/50 px-1 text-[9px] text-emerald-400">xong</Badge>
              <span className="font-mono text-[9.5px] text-stone-500" title="Seed tất định (H4) + thời lượng thật của vòng">
                seed {run.seed} · {Math.round((run.summary?.durationMs ?? run.progress.elapsedMs) / 1000)}s
              </span>
              {run.summary?.note && (
                <Badge variant="outline" className="h-3.5 border-amber-500/40 bg-amber-950/60 px-1 text-[9px] text-amber-400" title={run.summary.note}>
                  dừng sớm theo ngân sách
                </Badge>
              )}
              <button
                type="button"
                onClick={() => setFormOpen(o => !o)}
                className="ml-auto inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1 rounded-md border border-stone-700/70 px-2 text-[10px] text-stone-300 hover:border-amber-500/50 hover:text-amber-300"
                aria-expanded={formOpen}
                title="Mở form chạy vòng tiến hoá mới (vòng gần nhất vẫn xem được phía dưới — không mất dữ liệu)"
              >
                <Play className="h-3 w-3" aria-hidden="true" /> {formOpen ? 'Đóng form' : 'Chạy vòng mới'}
              </button>
            </div>
          )}

          {/* Khối đề xuất (H2: đề xuất — bạn duyệt; 2 cấp áp dụng §5.3) */}
          {bestCand && (
            <div className="rounded-md border border-amber-500/40 bg-amber-950/20 p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-amber-300">Đề xuất — bạn duyệt</span>
                <span className="font-mono text-[10px] text-stone-200">
                  #{bestCand.idx} · {bestCand.archSummary}
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-stone-400">
                CV {fmtCv(bestCand.cvScore)} [{fmtCv(bestCand.ciLow)}..{fmtCv(bestCand.ciHigh)}] · {formatViNum(bestCand.params)} tham số ({formatParamsBudget(bestCand.params)}) · p95 {formatViDecimal(bestCand.p95LatencyMs, 2)} ms
                {bestCand.beatActive && <span className="ml-1 text-amber-400">· thắng active</span>}
                {bestCand.blockedH7 && <span className="ml-1 text-rose-400">· chặn H7</span>}
              </p>
              {bestCand.note && <p className="mt-0.5 text-[9.5px] text-amber-500/80">{bestCand.note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canApplyBest}
                  onClick={() => applyCandidate(bestCand)}
                  title={applyBestDisabledReason ?? 'Ghi kiến trúc ứng viên tốt nhất vào nháp não đích (draft SECTION 1 — không đụng runtime)'}
                  className="inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Áp dụng đề xuất
                </button>
                {applyBestDisabledReason && (
                  <span className="text-[9.5px] leading-relaxed text-amber-500/80">{applyBestDisabledReason}</span>
                )}
              </div>
            </div>
          )}

          {/* U2 — bảng ứng viên (sort cvScore desc · ≤ 60 hàng · click mở dialog) */}
          {candidates.length > 0 && (
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-stone-500">Ứng viên ({candidates.length})</span>
                <span className="text-[9.5px] text-stone-600">xếp theo điểm CV · bấm hàng để xem chi tiết + áp dụng vào nháp</span>
              </div>
              <div className="dialog-scrollbar max-h-96 overflow-x-auto overflow-y-auto rounded-md border border-stone-800">
                <table className="w-full text-[11px]">
                  <caption className="sr-only">Bảng ứng viên vòng tiến hoá — xếp hạng theo điểm kiểm định chéo (cao hơn tốt hơn)</caption>
                  <thead className="sticky top-0 bg-slate-950/95 text-stone-500 backdrop-blur">
                    <tr className="border-b border-slate-800">
                      <th className="py-1.5 pr-2 text-left font-medium">#</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Kiến trúc</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Điểm CV</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Tham số</th>
                      <th className="py-1.5 pr-2 text-left font-medium">p95 lat</th>
                      <th className="py-1.5 font-medium">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(c => (
                      <tr
                        key={c.idx}
                        tabIndex={0}
                        role="button"
                        aria-label={`Xem chi tiết ứng viên ${c.idx}`}
                        onClick={() => setDetailIdx(c.idx)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailIdx(c.idx) } }}
                        className="cursor-pointer border-b border-slate-900/80 hover:bg-slate-950/40 focus:bg-slate-950/60 focus:outline-none"
                      >
                        <td className="py-1.5 pr-2 font-mono text-stone-400">#{c.idx}</td>
                        <td className="py-1.5 pr-2 font-mono text-[10px] text-stone-200" title={c.note ?? c.archSummary}>{c.archSummary}</td>
                        <td className="py-1.5 pr-2 font-mono tabular-nums text-stone-100">
                          {fmtCv(c.cvScore)} <span className="text-[9px] text-stone-500">±{fmtCv((c.ciHigh - c.ciLow) / 2)}</span>
                        </td>
                        <td className="py-1.5 pr-2 font-mono tabular-nums text-stone-300">
                          {formatViNum(c.params)} <span className="text-[9px] text-stone-500">({formatParamsBudget(c.params)})</span>
                        </td>
                        <td className="py-1.5 pr-2 font-mono tabular-nums text-stone-300">{formatViDecimal(c.p95LatencyMs, 2)} ms</td>
                        <td className="py-1.5">
                          <span className="inline-flex flex-wrap gap-1">
                            {c.beatActive && (
                              <Badge variant="outline" className="h-3.5 border-amber-500/45 bg-amber-950/70 px-1 text-[9px] text-amber-400">THẮNG ACTIVE</Badge>
                            )}
                            {c.blockedH7 && (
                              <Badge variant="outline" className="h-3.5 border-rose-500/45 bg-rose-950/60 px-1 text-[9px] text-rose-400">CHẶN H7</Badge>
                            )}
                            {!c.beatActive && !c.blockedH7 && <span className="text-[9px] text-stone-600">—</span>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {candidates.length > MAX_TABLE_ROWS && (
                <p className="mt-1 text-[9.5px] text-stone-600">Hiển thị {MAX_TABLE_ROWS}/{candidates.length} hàng điểm cao nhất — DB giữ toàn bộ mọi vòng (H5).</p>
              )}
            </div>
          )}

          {/* U4 — Pareto CV × params × p95 (SVG thuần; < md thay bằng bảng) */}
          {candidates.length > 0 && <ParetoChart cands={sorted} />}

          {/* E5 — khu vực CHẶN H7 (KHÔNG trộn với đề xuất chính — §5.2) */}
          {blocked.length > 0 && (
            <div className="rounded-md border border-rose-500/30 bg-rose-950/10 p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Dna className="h-3 w-3 text-rose-400" aria-hidden="true" />
                <p className="text-[11px] font-semibold text-rose-300">Chặn H7 — {blocked.length} ứng viên</p>
                <span className="text-[9.5px] text-stone-400">Thắng điểm nhưng chậm hơn 2× bản MLP chuỗi — giữ lại để phân tích, không áp runtime</span>
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {blocked.slice(0, 8).map(c => (
                  <li key={c.idx} className="font-mono text-[10px] text-stone-400">
                    #{c.idx} · {c.archSummary} · CV {fmtCv(c.cvScore)} · p95 {formatViDecimal(c.p95LatencyMs, 2)} ms
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[9.5px] leading-relaxed text-stone-500">
                Ứng viên thắng điểm CV nhưng chậm hơn 2× bản MLP chuỗi — không đề xuất áp runtime (rào H7); dùng cho phân tích/offline.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── U5 — Kill-switch panel (2 cờ + audit — §5.6, luôn hiển thị cuối tab) ── */}
      <KillSwitchPanel
        tuningByKey={tuningByKey}
        changeLog={changeLog}
        onSetTuning={onSetTuning}
        savingKeys={savingKeys}
      />

      {/* ── Dialog chi tiết U2 (spec + so sánh active + U3 + Áp dụng vào nháp) ── */}
      <Dialog open={detailIdx !== null} onOpenChange={o => { if (!o) setDetailIdx(null) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {detailCand && (
            <>
              <DialogHeader>
                <DialogTitle className="text-sm">Ứng viên #{detailCand.idx}</DialogTitle>
                <DialogDescription className="font-mono text-[10px]">{detailCand.archSummary}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {/* Metrics + so sánh active */}
                <div className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
                  <div>
                    <p className="text-[9.5px] uppercase text-stone-500">Điểm CV</p>
                    <p className="font-mono tabular-nums text-stone-100">{fmtCv(detailCand.cvScore)}</p>
                    <p className="font-mono text-[9px] text-stone-500">CI [{fmtCv(detailCand.ciLow)}..{fmtCv(detailCand.ciHigh)}]</p>
                  </div>
                  <div>
                    <p className="text-[9.5px] uppercase text-stone-500">Tham số</p>
                    <p className="font-mono tabular-nums text-stone-100">{formatViNum(detailCand.params)}</p>
                    <p className="font-mono text-[9px] text-stone-500">{formatParamsBudget(detailCand.params)} ngân sách 250K</p>
                  </div>
                  <div>
                    <p className="text-[9.5px] uppercase text-stone-500">p95 latency</p>
                    <p className="font-mono tabular-nums text-stone-100">{formatViDecimal(detailCand.p95LatencyMs, 2)} ms</p>
                    <p className="font-mono text-[9px] text-stone-500">train {formatViDecimal(detailCand.trainMs / 1000, 1)}s</p>
                  </div>
                  <div>
                    <p className="text-[9.5px] uppercase text-stone-500">So với active</p>
                    {detailCand.beatActive
                      ? <span className="text-[10px] text-amber-400">thắng active (đối chứng cùng fixture)</span>
                      : <span className="text-[10px] text-stone-400">chưa thắng bản active</span>}
                    {detailCand.blockedH7 && <p className="mt-0.5 text-[9.5px] text-rose-400">chặn H7 — p95 &gt; 2× MLP chuỗi</p>}
                    {detailCand.moeSkipped && <p className="mt-0.5 text-[9.5px] text-stone-500">MoE bỏ qua (Q4 &lt; 2K mẫu)</p>}
                  </div>
                </div>
                {detailCand.note && <p className="text-[10px] text-amber-500/80">{detailCand.note}</p>}

                {/* U3 — Encoding viewer 144 thanh phân vùng */}
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-500">Encoding (U3 — hover từng vùng)</p>
                  <EncodingStrip encoding={detailCand.encoding} />
                </div>

                {/* Spec đầy đủ (JSON pretty đọc được) */}
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-500">Spec đầy đủ</p>
                  <pre className="dialog-scrollbar max-h-56 overflow-auto rounded-md border border-stone-800 bg-slate-950/70 p-2 font-mono text-[9.5px] leading-relaxed text-stone-300">
                    {JSON.stringify(detailCand.spec, null, 2)}
                  </pre>
                </div>
              </div>
              <DialogFooter className="items-start gap-2 sm:flex-col">
                {isPureMlpCandidate(detailCand) && detailCand.params <= EVO_PARAMS_BUDGET ? (
                  <button
                    type="button"
                    onClick={() => applyCandidate(detailCand)}
                    className="inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25"
                  >
                    Áp dụng vào nháp
                  </button>
                ) : (
                  <p className="text-[10px] leading-relaxed text-amber-500/80">
                    {isPureMlpCandidate(detailCand)
                      ? (detailCand.note ?? 'Vượt trần 250K tham số — không thể áp vào nháp.')
                      : 'Kiến trúc block cần editor v2 (kèm EVO-P4) — spec ở trên đọc-only, chưa ghi được vào nháp MLP.'}
                  </p>
                )}
                <p className="text-[9.5px] text-stone-500">Nháp = không gian tự do — runtime chỉ lên qua train (A1 + H7), không tự thay não vận hành.</p>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== U3 — ENCODING VIEWER (thanh phân vùng 96/144) ====================

function EncodingStrip({ encoding }: { encoding: readonly number[] }) {
  const { dim, zones } = useMemo(() => splitEncodingZones(encoding), [encoding])
  const pure = dim === 96 || (dim === 144 && zones.every(z => !z.isEvo || z.mean <= 0.001))
  if (zones.length === 0) {
    return <p className="text-[10px] text-stone-500">encoding {encoding.length}-dim — không nhận dạng được (hỗ trợ 96/144)</p>
  }
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 w-full overflow-hidden rounded-sm border border-stone-800 bg-slate-950">
        {zones.map(z => (
          <div
            key={z.id}
            className={`${ZONE_BG[z.id]} h-full`}
            style={{ flexGrow: z.end - z.start + 1, opacity: 0.15 + 0.85 * Math.min(1, Math.max(0, z.mean)) }}
            title={`${z.label} · slot [${z.start}..${z.end}] · mức kích hoạt trung bình ${Math.round(Math.min(1, Math.max(0, z.mean)) * 100)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {zones.map(z => (
          <span key={z.id} className="inline-flex items-center gap-1 text-[9px] text-stone-500">
            <span className={`inline-block h-2 w-2 rounded-sm ${ZONE_BG[z.id]}`} aria-hidden="true" />
            {z.id === 'hnp1' ? 'HN-P1' : z.id === 'blocktype' ? 'loại block' : z.id === 'blockparam' ? 'tham số block' : z.id === 'moeglobal' ? 'MoE' : 'dự phòng'}
          </span>
        ))}
        {dim === 96 && (
          <Badge variant="outline" className="h-3.5 border-stone-600/50 bg-slate-950/70 px-1 text-[9px] text-stone-400">
            96-dim (HN-P1 — không vùng block)
          </Badge>
        )}
        {dim === 144 && pure && (
          <Badge variant="outline" className="h-3.5 border-stone-600/50 bg-slate-950/70 px-1 text-[9px] text-stone-400">
            thuần MLP (tương thích HN-P1)
          </Badge>
        )}
      </div>
    </div>
  )
}

// ==================== U4 — PARETO CHART (SVG thuần — không lib) ====================

function ParetoChart({ cands }: { cands: readonly EvoCandidateRowUi[] }) {
  const frontIdx = useMemo(() => paretoFront(cands), [cands])
  const frontPts = useMemo(
    () => cands.filter(c => frontIdx.includes(c.idx)).sort((a, b) => a.params - b.params || b.cvScore - a.cvScore),
    [cands, frontIdx],
  )

  if (cands.length === 0) return null

  // Trục X = params (log10 — clamp 10 để tránh log(0)), trục Y = cvScore
  const W = 340
  const H = 210
  const pad = { l: 46, r: 14, t: 14, b: 32 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const lx = (p: number) => Math.log10(Math.max(10, p))
  const xs = cands.map(c => lx(c.params))
  const ys = cands.map(c => c.cvScore)
  const xmin = Math.min(...xs)
  const xmax = Math.max(...xs)
  const ymin = Math.min(...ys)
  const ymax = Math.max(...ys)
  const xSpan = xmax - xmin || 1
  const ySpan = ymax - ymin || 1
  const px = (c: EvoCandidateRowUi) => pad.l + ((lx(c.params) - xmin) / xSpan) * iw
  const py = (c: EvoCandidateRowUi) => pad.t + ih - ((c.cvScore - ymin) / ySpan) * ih
  const maxP95 = Math.max(...cands.map(c => c.p95LatencyMs), 0.001)
  // Kích thước điểm ∝ p95 latency — bán kính 4..12px (§5.5)
  const radius = (c: EvoCandidateRowUi) => 4 + 8 * Math.min(1, c.p95LatencyMs / maxP95)

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <TrendingUp className="h-3 w-3 text-amber-400" aria-hidden="true" />
        <span className="text-[10px] uppercase tracking-wide text-stone-500">Pareto — điểm CV × tham số × p95</span>
        <span className="text-[9.5px] text-stone-600">đường đứt amber = Pareto front (tập thắng CV) · to hơn = chậm hơn (p95)</span>
      </div>
      {/* Desktop: SVG scatter · < md: bảng 3 cột top front (§5.5) */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="hidden w-full rounded-md border border-stone-800 bg-slate-950/50 md:block"
        role="img"
        aria-label="Biểu đồ Pareto: trục ngang số tham số (thang log), trục dọc điểm kiểm định chéo, kích thước điểm theo p95 latency"
      >
        {/* Trục */}
        <line x1={pad.l} y1={pad.t + ih} x2={pad.l + iw} y2={pad.t + ih} className="stroke-stone-700" strokeWidth={1} />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} className="stroke-stone-700" strokeWidth={1} />
        <text x={pad.l + iw / 2} y={H - 6} textAnchor="middle" className="fill-stone-500" fontSize={9}>tham số (log₁₀)</text>
        <text x={10} y={pad.t + ih / 2} textAnchor="middle" transform={`rotate(-90 10 ${pad.t + ih / 2})`} className="fill-stone-500" fontSize={9}>điểm CV</text>
        {/* Nhãn biên trục */}
        <text x={pad.l} y={pad.t + ih + 11} textAnchor="middle" className="fill-stone-600" fontSize={8}>{formatViNum(Math.round(10 ** xmin))}</text>
        <text x={pad.l + iw} y={pad.t + ih + 11} textAnchor="middle" className="fill-stone-600" fontSize={8}>{formatViNum(Math.round(10 ** xmax))}</text>
        <text x={pad.l - 4} y={pad.t + ih + 3} textAnchor="end" className="fill-stone-600" fontSize={8}>{fmtCv(ymin)}</text>
        <text x={pad.l - 4} y={pad.t + 4} textAnchor="end" className="fill-stone-600" fontSize={8}>{fmtCv(ymax)}</text>
        {/* Pareto front — nét đứt amber trên tập thắng CV */}
        {frontPts.length >= 2 && (
          <polyline
            points={frontPts.map(c => `${px(c)},${py(c)}`).join(' ')}
            fill="none"
            className="stroke-amber-400"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}
        {/* Điểm ứng viên */}
        {cands.map(c => (
          <circle
            key={c.idx}
            cx={px(c)}
            cy={py(c)}
            r={radius(c)}
            className={
              c.blockedH7
                ? 'fill-rose-400/30 stroke-rose-400'
                : c.beatActive
                  ? 'fill-amber-400'
                  : 'fill-stone-500'
            }
            strokeWidth={c.blockedH7 ? 1.5 : 1}
          >
            <title>{`#${c.idx} · ${c.archSummary} · CV ${fmtCv(c.cvScore)} · ${formatViNum(c.params)} tham số · p95 ${formatViDecimal(c.p95LatencyMs, 2)}ms${c.blockedH7 ? ' · CHẶN H7' : c.beatActive ? ' · thắng active' : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div className="md:hidden">
        <table className="w-full text-[11px]">
          <caption className="sr-only">Top Pareto front — bản bảng cho màn hình hẹp</caption>
          <thead>
            <tr className="border-b border-slate-800 text-stone-500">
              <th className="py-1 pr-2 text-left font-medium">#</th>
              <th className="py-1 pr-2 text-left font-medium">Tham số</th>
              <th className="py-1 text-left font-medium">Điểm CV</th>
            </tr>
          </thead>
          <tbody>
            {frontPts.slice(0, 8).map(c => (
              <tr key={c.idx} className="border-b border-slate-900/80">
                <td className="py-1 pr-2 font-mono text-stone-400">#{c.idx}</td>
                <td className="py-1 pr-2 font-mono tabular-nums text-stone-300">{formatViNum(c.params)}</td>
                <td className="py-1 font-mono tabular-nums text-stone-100">{fmtCv(c.cvScore)}</td>
              </tr>
            ))}
            {frontPts.length === 0 && (
              <tr><td colSpan={3} className="py-2 text-center text-stone-600">Chưa có ứng viên thắng active — chưa có Pareto front.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Chú giải */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[9px] text-stone-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-stone-500" aria-hidden="true" />thua active</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />thắng CV</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full border border-rose-400 bg-rose-400/30" aria-hidden="true" />chặn H7</span>
        <span>kích thước điểm ∝ p95 latency</span>
      </div>
    </div>
  )
}

// ==================== U5 — KILL-SWITCH PANEL (§5.6) ====================

function KillSwitchPanel({
  tuningByKey, changeLog, onSetTuning, savingKeys,
}: {
  tuningByKey: ReadonlyMap<string, { effectiveValue: string | number }>
  changeLog: readonly TuningChangeLogEntry[]
  onSetTuning: (key: string, value: string | number) => void
  savingKeys: ReadonlySet<string>
}) {
  const evoOn = String(tuningByKey.get('brain_evolve')?.effectiveValue ?? 'off') === 'on'
  /// 'off' = KILL mọi não search (default on — nghĩa đảo với brain_evolve)
  const globalOn = String(tuningByKey.get('brain_search_global')?.effectiveValue ?? 'on') === 'on'
  const audit = useMemo(
    () => changeLog.filter(c => c.key === 'brain_evolve' || c.key === 'brain_search_global').slice(0, 5),
    [changeLog],
  )

  return (
    <div className="space-y-2 rounded-md border border-stone-700/70 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ShieldAlert className="h-3 w-3 shrink-0 text-amber-400" aria-hidden="true" />
        <p className="text-[11px] font-semibold text-stone-100">Kill-switch tiến hoá</p>
        <span className="text-[9.5px] text-stone-500">Tắt evolve không mất dữ liệu đã chấm — bảng ứng viên vẫn xem được.</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex items-center justify-between gap-2 rounded-md border border-stone-800 p-2">
          <div className="min-w-0">
            <p className="text-[11px] text-stone-200">Bật/tắt evolve</p>
            <p className="font-mono text-[9px] text-stone-500">brain_evolve = {evoOn ? 'on' : 'off'} (STORE › ENV › DEFAULT)</p>
          </div>
          <Switch
            checked={evoOn}
            onCheckedChange={v => onSetTuning('brain_evolve', v ? 'on' : 'off')}
            disabled={savingKeys.has('brain_evolve')}
            aria-label="Bật hoặc tắt tiến hoá kiến trúc (brain_evolve)"
          />
        </div>
        <div className="flex items-center justify-between gap-2 rounded-md border border-stone-800 p-2">
          <div className="min-w-0">
            <p className="text-[11px] text-stone-200">Kill-switch toàn cục mọi não search</p>
            <p className="font-mono text-[9px] text-stone-500">brain_search_global = {globalOn ? 'on' : 'off (= kill mọi search)'}</p>
          </div>
          <Switch
            checked={globalOn}
            onCheckedChange={v => onSetTuning('brain_search_global', v ? 'on' : 'off')}
            disabled={savingKeys.has('brain_search_global')}
            aria-label="Kill-switch toàn cục mọi não search (brain_search_global)"
          />
        </div>
      </div>
      {/* 5 dòng audit mới nhất của 2 cờ (ai đổi, khi nào, cũ → mới) */}
      <div className="space-y-1">
        {audit.length === 0 && (
          <p className="text-[9.5px] italic text-stone-600">Chưa có thay đổi nào của 2 cờ này được ghi audit.</p>
        )}
        {audit.map(c => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]" title={`${c.key} · store: ${c.fromStoreValue ?? '—'} → ${c.toStoreValue ?? '—'}`}>
            <span className="shrink-0 tabular-nums text-stone-600">{new Date(c.createdAt).toLocaleString('vi-VN')}</span>
            <span className="font-mono text-stone-300">{getTuningSpec(c.key)?.label ?? c.key}</span>
            {c.action === 'set'
              ? <Badge variant="outline" className="h-3.5 border-amber-500/45 bg-amber-950/70 px-1 text-[9px] text-amber-400">đặt</Badge>
              : <Badge variant="outline" className="h-3.5 border-stone-600/50 bg-slate-950/70 px-1 text-[9px] text-stone-400">về mặc định</Badge>}
            <span className="font-mono text-stone-500">{c.fromEffectiveValue}</span>
            <span aria-hidden="true" className="text-stone-600">→</span>
            <span className="font-mono font-medium text-stone-100">{c.toEffectiveValue}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
