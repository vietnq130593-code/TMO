'use client'

// ========================================================================
// brain-tab — Tab "BRAIN" (module Smolab) — BRAIN-LIVE 15-d → BRAIN-TAB-3PHAN 18-c
// ========================================================================
//
// CHỈ THỊ USER (2026-10-12, nguyên văn): "Đúng ra nên chia 3 phần, Phần
// trên cùng là nút chọn Brain cũng như thông tin liên quan brain, Có thể
// thêm lớp cũng như chỉnh số nơ ron mỗi lớp, sau đó là đến giao diện lớp
// có thể chỉnh to nhỏ để xem từ tổng quan đến chi tiết được... Cuối cùng
// là phần chứa các bản thông số có thể chỉnh sửa và thiết lập được."
//
// LAYOUT 3 SECTION DỌC (18-c — mỗi section 1 Card riêng, space-y-4 — thay
// grid 3 CỘT cũ [280-320px | 1fr | 340-420px] bị user chê "nhét ép"):
//   1 · CHỌN NÃO & KIẾN TRÚC — BrainStudio (18-b rewrite thanh ngang —
//       render nguyên, props KHÔNG đổi) + khối "Thức tỉnh khi đủ mẫu" +
//       hàng badge phase/flag/inputMode (2 khối sau DI CHUYỂN nguyên vẹn
//       markup từ cột trái cũ) + badge tổng nhãn + ● sống.
//   2 · ĐÀI QUAN SÁT NÃO — thanh Live (poll 2.5s) + BrainStage tall
//       (full-width fit-height — geometry v3 của 18-a tự lo) + chú thích
//       bất biến A1.
//   3 · BẢNG THÔNG SỐ — 4 tab: Training Console · Tham số runtime · Nhật
//       ký tinh chỉnh · Hàm & công thức (BrainReference — 18-c, bảng tham
//       chiếu activation/loss/reward/lan truyền, trả lời câu hỏi user
//       "đã có thông tin đầy đủ chưa"). ConsolePanel render INLINE ở
//       MỌI viewport — BỎ hẳn hộp console trượt dưới đáy mobile + nút nổi
//       ⚙ Console + state sheet + effect Esc + toàn bộ máy breakpoint
//       desktop (media query hook + biến nhánh viewport — không còn
//       layout 2 nhánh).
//
// Giữ nguyên từ BRAIN-LIVE (15-d): state machine draft 3 brain (controlled
// — BrainStudio + TrainingConsole + BrainStage cùng MỘT nguồn) · poll 15s
// fail-open · train POST /api/brain/train · spec-draft GET/PUT · LIVE POLL
// 2.5s GET /api/brain/activity READ-ONLY (visibilitychange dừng/kẹp lại;
// response 400 bỏ qua lặng lẽ; lỗi mạng giữ activity cũ — fail-open) ·
// TuningParamDialog chỉnh tại chỗ (15-b). Chuỗi pin r92-E GIỮ NGUYÊN NGUYÊN
// VĂN khi tái cấu trúc: fetch template activity · POLL_ACTIVITY_MS = 2_500
// · setInterval poll · &head= · selectedBrainKey === 'surrogate' ·
// &head=${activityHead} · initialHead/onHeadChange · activity/refreshNonce
// · tall · <TuningParamDialog · 'ui_synapse_fx'.
//
// ĐỌC TƯƠNG THÍCH (từ 15-b): TuningStateEntry/TuningSpec import thẳng
// '@/lib/learning/neural-types' (client-safe) — KHÔNG import barrel
// '@/lib/learning' vì barrel re-export tuning-store (Prisma) vào client
// bundle.
// ========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, BrainCircuit, History, Pencil, Radio, RotateCcw, SlidersHorizontal, Tags, Zap } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
// BRAIN-UX §9.5 (UX-4): 3 component studio (UX-1/UX-2/UX-3) — state draft
// nâng lên đây (controlled, single source) như panel cũ.
import { BrainStudio } from '@/components/database/brain-studio'
import { BrainStage, type SurrogateHead } from '@/components/database/brain-stage'
import { TrainingConsole, type TrainOutcomeUi } from '@/components/database/training-console'
// BRAIN-LIVE (15-b): dialog chỉnh tham số runtime tại chỗ — hết cuộn lên.
import { TuningParamDialog, SOURCE_BADGE } from '@/components/smolab/tuning-param-dialog'
// BRAIN-TAB-3PHAN (18-c): tab "Hàm & công thức" — bảng tham chiếu trình
// bày thuần (client-safe: ACTIVATION_MENU spec-schema + hằng optimizers).
import { BrainReference } from '@/components/smolab/brain-reference'
// BRAIN-P1 registry single-source (thuần hằng số — client-safe).
import {
  BRAIN_REGISTRY,
  BRAIN_TRAINABLE_KEYS,
  computeLabelTotal,
  type BrainActivity, type BrainApiResponse, type BrainStatusEntry, type BrainKey,
} from '@/lib/brain/registry'
// BRAIN-UX §9.2: schema nháp single-source — client + server cùng rule
// (validateBrainDraft/defaultDraftFor import chung với route PUT/train).
import { defaultDraftFor, validateBrainDraft, type BrainDraftSpec } from '@/lib/brain/spec-schema'
import { getTuningSpec, NEURAL_NODES, TUNING_CHANGE_LOG_CAP } from '@/lib/learning/neural-types'
import type { TuningStateEntry, TuningChangeLogEntry } from '@/lib/learning/neural-types'

// ==================== API CONTRACT (rút gọn — chỉ phần tab này dùng) ====================

/**
 * /api/neural-architecture GET trả graph + tuning + live + qTop + salRecent
 * + changeLog; tab BRAIN chỉ dùng tuning (bảng Tham số runtime + cờ UI) và
 * changeLog (Nhật ký tinh chỉnh) — graph/Q/SAL là của tab Kiến trúc Database.
 */
interface TuningFeed {
  tuning: TuningStateEntry[]
  changeLog?: TuningChangeLogEntry[]
  generatedAt: string
}

/** Nhịp poll nền (số liệu mẫu/tuning) — giữ nguyên 15s như panel cũ. */
const POLL_NEURAL_MS = 15_000
/** Nhịp poll live activity (BRAIN-LIVE) — đài quan sát não cần phản ánh gần tức thời. */
const POLL_ACTIVITY_MS = 2_500

const viNum = (n: number): string => n.toLocaleString('vi-VN')

// ==================== TAB BRAIN (BRAIN-LIVE 15-d · 3 SECTION 18-c) ====================

export function BrainTabContent() {
  // ── Tuning feed (bảng Tham số runtime + cờ UI + Nhật ký tinh chỉnh) ──
  // Fail-open như panel cũ: lỗi fetch giữ dữ liệu cũ, poll 15s sẽ thử lại.
  const [feed, setFeed] = useState<TuningFeed | null>(null)
  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch('/api/neural-architecture')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as TuningFeed
      setFeed(json)
    } catch (err) {
      console.error('[BrainTab] tuning feed error:', err)
    }
  }, [])

  // ── Trạng thái 3 brain cho panel (BRAIN-P1 UI — copy nguyên panel cũ):
  //    fail-open tuyệt đối — lỗi fetch giữ dữ liệu cũ, chưa từng load thành
  //    công thì UI vẫn render được từ registry tĩnh (đếm hiển thị "—"). ──
  const [brainData, setBrainData] = useState<BrainApiResponse | null>(null)
  const [brainError, setBrainError] = useState<string | null>(null)
  const hasBrainDataRef = useRef(false)
  const fetchBrainData = useCallback(async () => {
    try {
      const res = await fetch('/api/brain')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BrainApiResponse
      setBrainData(json)
      hasBrainDataRef.current = true
      setBrainError(null)
    } catch (err) {
      console.error('[Brain] fetch error:', err)
      if (!hasBrainDataRef.current) setBrainError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Mount + poll nền 15s giữ số liệu sống (fail-open giữ dữ liệu cũ).
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect —
  // cùng pattern neural-architecture-section / auto-learn-section)
  // P2-M4: poll chỉ chạy khi tab ĐANG HIỆN — ẩn thì dừng hẳn interval;
  // hiện lại → fetch ngay một lần rồi tiếp tục nhịp 15s.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => { void fetchFeed(); void fetchBrainData() }, POLL_NEURAL_MS)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    if (document.visibilityState !== 'hidden') {
      queueMicrotask(() => {
        void fetchFeed()
        void fetchBrainData()
      })
      start()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        void fetchFeed()
        void fetchBrainData()
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchFeed, fetchBrainData])

  // ==================== STATE DASHBOARD (UX-4 — copy panel cũ; 18-c tách 3 SECTION) ====================
  // (blueprint §9.5 + chỉ thị user 2026-10-12 "chia 3 phần"): SECTION 1 =
  // Brain Studio chọn não + ngưỡng thức tỉnh + badge + editor kiến trúc;
  // SECTION 2 = đài quan sát Brain Stage (UX-3 / v2 BRAIN-LIVE, tall
  // full-width) + live + chú thích bất biến A1; SECTION 3 = 4 tab console
  // (UX-2 Training Console / Tham số runtime / Nhật ký / Hàm & công thức)
  // — inline MỌI viewport (không còn hộp console mobile riêng).

  /// Não đang chọn — mặc định 'calibration_v3'; restore từ localStorage
  /// (queueMicrotask + try/catch — fail-open giữ mặc định khi private mode).
  const [selectedBrainKey, setSelectedBrainKey] = useState<BrainKey>('calibration_v3')
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem('tmo-brain-selected')
        if (saved === 'calibration_v3' || saved === 'surrogate' || saved === 'policy') setSelectedBrainKey(saved)
      } catch { /* private mode — giữ mặc định */ }
    })
  }, [])
  const selectBrain = useCallback((key: BrainKey) => {
    setSelectedBrainKey(key)
    try { localStorage.setItem('tmo-brain-selected', key) } catch { /* bỏ qua */ }
  }, [])

  /// Bản nháp làm việc từng brain (UX-4 lift state — Studio + Training
  /// Console + Brain Stage cùng đọc MỘT nguồn)
  const [draftsByBrain, setDraftsByBrain] = useState<Partial<Record<BrainKey, BrainDraftSpec>>>({})
  /// Bản nháp đã lưu server (GET /api/brain/spec-draft) — null = chưa có nháp
  const [savedDrafts, setSavedDrafts] = useState<Partial<Record<BrainKey, BrainDraftSpec | null>>>({})
  /// Brain đang có chỉnh chưa lưu (chỉ báo "• chưa lưu")
  const [dirtyBrains, setDirtyBrains] = useState<Set<string>>(new Set())
  const [savingDraft, setSavingDraft] = useState(false)
  /// Lỗi server lần PUT cuối (hiện ở Brain Studio cùng lỗi validation cục bộ)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  /// Kết quả train gần nhất (hiển thị ở Training Console — UX-2)
  const [trainOutcome, setTrainOutcome] = useState<TrainOutcomeUi | null>(null)
  /// Brain Stage (UX-3) bấm cột lớp ẩn → Brain Studio nháy tới hàng editor
  const [focusLayerSignal, setFocusLayerSignal] = useState<{ brain: BrainKey; layer: number; nonce: number } | null>(null)
  /// Tab đang mở của SECTION 3 (18-c mở rộng 'ref' — Hàm & công thức)
  const [consoleTab, setConsoleTab] = useState<'train' | 'tuning' | 'log' | 'ref'>('train')

  // ── LIVE POLL activity (BRAIN-LIVE 15-d) ──
  // activity = dữ liệu thật từ GET /api/brain/activity (contract 15-a) —
  // truyền xuống BrainStage v2 (15-c) để điểm sáng nơ-ron/cạnh + chip Agent.
  const [activity, setActivity] = useState<BrainActivity | null>(null)
  /// Live đang bật (default ON — tab BRAIN là đài quan sát não)
  const [liveOn, setLiveOn] = useState(true)
  /// Tăng sau train (trainOutcome mới xuất hiện) → BrainStage refetch weights
  const [refreshNonce, setRefreshNonce] = useState(0)
  /// Head surrogate cho poll activity (FB-BRAIN-LIVE-R1-01): đồng bộ 2 chiều
  /// với tab head nội bộ của BrainStage — khởi tạo 'success'; user bấm tab
  /// head trong stage → onHeadChange → setState tại đây (event handler,
  /// KHÔNG trong effect) → fetchActivity đổi deps → poll kế tiếp (và lần
  /// refetch ngay sau đó) gắn &head= đúng head đang chọn — trước-fix poll
  /// luôn 'success' nên điểm sáng theo head success trong khi cạnh |a×w|/
  /// inspector theo head đang chọn (trộn 2 nguồn tín hiệu trong 1 khung).
  const [activityHead, setActivityHead] = useState<SurrogateHead>('success')

  const fetchActivity = useCallback(async () => {
    try {
      const q = selectedBrainKey === 'surrogate' ? `&head=${activityHead}` : ''
      const res = await fetch(`/api/brain/activity?brain=${selectedBrainKey}${q}`)
      // 400 (query rác) → bỏ qua lặng lẽ — poll không toast spam (15-a contract)
      if (!res.ok) return
      const json = (await res.json()) as BrainActivity & { ok: boolean }
      if (!json.ok) return
      setActivity({
        status: json.status,
        agentRunInProgress: json.agentRunInProgress,
        inputVector: json.inputVector,
        activations: json.activations,
        featureNames: json.featureNames,
        sourceLabel: json.sourceLabel,
        fetchedAt: json.fetchedAt,
      })
    } catch { /* lỗi mạng → giữ activity cũ (fail-open) */ }
  }, [selectedBrainKey, activityHead])

  // Poll 2.5s — CHỈ chạy khi liveOn && tab trình duyệt đang hiện (ẩn thì
  // dừng hẳn; hiện lại → fetch ngay + tiếp tục nhịp). liveOn tắt → dừng
  // hẳn (bấm bật lại → fetch ngay một lần rồi tiếp tục).
  useEffect(() => {
    if (!liveOn) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => { void fetchActivity() }, POLL_ACTIVITY_MS)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    if (document.visibilityState !== 'hidden') {
      queueMicrotask(() => { void fetchActivity() })
      start()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        void fetchActivity()
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchActivity, liveOn])

  // Train xong (trainOutcome mới) → bump refreshNonce (BrainStage refetch
  // /api/brain/weights bản mới) + kéo activity/brain data tươi không chờ nhịp.
  // (queueMicrotask defer — không gọi setState đồng bộ trong body effect.)
  useEffect(() => {
    if (!trainOutcome) return
    queueMicrotask(() => {
      setRefreshNonce(n => n + 1)
      void fetchActivity()
    })
  }, [trainOutcome, fetchActivity])

  // ── Dialog chỉnh tham số runtime (15-b) — mở bằng nút bút chì ở cột
  //    Hành động của bảng tuning (hết cuộn lên ô phía trên — chỉ thị user) ──
  const [dialogParam, setDialogParam] = useState<TuningStateEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Kéo nháp đã lưu 1 lần lúc mount — fail-open im lặng (lỗi/mạng mất →
  // draft làm việc = defaultDraftFor chuẩn pipeline, editor vẫn dùng được)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/brain/spec-draft')
        if (!res.ok) return
        const json = (await res.json()) as { drafts: Array<{ brain: string; spec: BrainDraftSpec | null }> }
        if (!alive) return
        const nextSaved: Partial<Record<BrainKey, BrainDraftSpec | null>> = {}
        for (const d of json.drafts) {
          if (d.brain === 'calibration_v3' || d.brain === 'surrogate' || d.brain === 'policy') {
            nextSaved[d.brain] = d.spec
          }
        }
        setSavedDrafts(nextSaved)
        // Bản làm việc = bản đã lưu nếu có (seed), ngược lại để defaultDraftFor
        setDraftsByBrain(prev => {
          const merged = { ...prev }
          for (const k of Object.keys(nextSaved) as BrainKey[]) {
            if (nextSaved[k]) merged[k] = nextSaved[k] as BrainDraftSpec
          }
          return merged
        })
      } catch { /* fail-open im lặng */ }
    })()
    return () => { alive = false }
  }, [])

  /// Bản nháp làm việc của não đang chọn (fallback default chuẩn pipeline)
  const draftForSelected = useMemo(
    () => draftsByBrain[selectedBrainKey] ?? defaultDraftFor(selectedBrainKey),
    [draftsByBrain, selectedBrainKey],
  )

  /// Mọi chỉnh sửa draft từ Studio/Console bắn về đây (đánh dấu dirty)
  const onDraftChange = useCallback((d: BrainDraftSpec) => {
    setDraftsByBrain(prev => ({ ...prev, [d.brain]: d }))
    setDirtyBrains(prev => new Set(prev).add(d.brain))
  }, [])

  /// Lưu nháp (PUT /api/brain/spec-draft) — validate local bằng single-source
  /// spec-schema trước khi PUT (server validate lại lần nữa — không tin client)
  const saveDraft = useCallback(async (key: BrainKey) => {
    const spec = draftsByBrain[key] ?? defaultDraftFor(key)
    const inputDim = brainData?.brains.find(b => b.key === key)?.inputDim ?? null
    const v = validateBrainDraft({ ...spec, brain: key }, inputDim)
    if (!v.ok) {
      setSaveErrors(v.errors)
      return
    }
    setSavingDraft(true)
    try {
      const res = await fetch('/api/brain/spec-draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brain: key, spec: v.normalized }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] }
      if (!res.ok) {
        setSaveErrors(json.errors ?? [json.error ?? `HTTP ${res.status}`])
        return
      }
      setSavedDrafts(prev => ({ ...prev, [key]: v.normalized }))
      setDraftsByBrain(prev => ({ ...prev, [key]: v.normalized }))
      setDirtyBrains(prev => { const n = new Set(prev); n.delete(key); return n })
      setSaveErrors([])
    } catch (err) {
      setSaveErrors([err instanceof Error ? err.message : String(err)])
    } finally {
      setSavingDraft(false)
    }
  }, [draftsByBrain, brainData])

  // BRAIN-P2: train xong (nút Huấn luyện) cũng fetchBrainData tươi.
  // BRAIN-UX §9.3 (UX-2): useDraft=true → POST /api/brain/train đọc bản nháp
  // ĐÃ LƯU từ DB (server validate lại — bất biến A1 §9.1-1: draft vẫn đi đủ
  // cổng train → thắng đối chứng CV → thăng cấp, không có đường tắt).
  const [trainingBrains, setTrainingBrains] = useState<Set<string>>(new Set())
  const trainBrain = useCallback(async (key: BrainKey, useDraft: boolean) => {
    setTrainingBrains(prev => new Set(prev).add(key))
    try {
      const res = await fetch('/api/brain/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brain: key, useDraft: useDraft || undefined }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string; version?: number; active?: boolean; improved?: boolean; sampleSize?: number
        cvBrier?: number; brierV2?: number
        heads?: { success?: { cvBrier?: number; brierBaseline?: number; improved?: boolean } }
        cv?: { ceMixture?: number; ceBaselineQ?: number; improved?: boolean }
        history?: Array<{ epoch: number; trainLoss: number; valLoss: number | null }> | { success?: Array<{ epoch: number; trainLoss: number; valLoss: number | null }> }
      }
      if (!res.ok) {
        toast.error('Huấn luyện Brain không chạy', { description: json.error ?? `HTTP ${res.status}` })
        return
      }
      // Chỉ số hiển thị theo brain (cùng bản chất "đối chứng CV ngặt" nhưng
      // baseline mỗi brain một tên — BRAIN-P3/P4): A so V2 (brierV2) · B so
      // base-rate (heads.success.brierBaseline) · C so π_Q (cv.ceBaselineQ)
      const cvText = key === 'policy'
        ? `CE mixture ${json.cv?.ceMixture?.toFixed(4) ?? '—'}`
        : key === 'surrogate'
          ? `Brier ${json.heads?.success?.cvBrier?.toFixed(4) ?? '—'}`
          : `Brier ${json.cvBrier?.toFixed(4) ?? '—'}`
      const baselineText = key === 'policy'
        ? `π_Q ${json.cv?.ceBaselineQ?.toFixed(4) ?? '—'}`
        : key === 'surrogate'
          ? `base-rate ${json.heads?.success?.brierBaseline?.toFixed(4) ?? '—'}`
          : `V2 ${json.brierV2?.toFixed(4) ?? '—'}`
      const brainName = key === 'surrogate' ? 'Brain-B "Vọng" (surrogate)' : key === 'policy' ? 'Brain-C "Lệnh" (policy)' : 'Brain-A "V3"'
      const flagName = key === 'surrogate' ? 'REPLAY_EVAL' : key === 'policy' ? 'RUNTIME_POLICY' : 'CALIBRATION_V3'
      const verdict = json.active
        ? `v${json.version} ACTIVE — thắng CV (cờ ${flagName} mới có tác dụng khi bật)`
        : `v${json.version} không thắng CV — giữ hành vi cũ (bản vết audit đã ghi)`
      toast.success(
        `${brainName} huấn luyện xong · ${cvText} vs ${baselineText}`,
        { description: `${verdict} · ${json.sampleSize ?? '?'} mẫu` },
      )
      setTrainOutcome({
        brain: key,
        useDraft,
        version: json.version ?? 0,
        active: Boolean(json.active),
        cvText,
        baselineText,
        history: Array.isArray(json.history) ? json.history : (json.history?.success ?? []),
        improved: Boolean(json.improved),
      })
      void fetchBrainData() // kéo trạng thái mới ngay không chờ nhịp 15s
    } catch (err) {
      toast.error('Huấn luyện Brain thất bại', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setTrainingBrains(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [fetchBrainData])

  // ==================== TUNING ACTIONS (copy panel cũ) ====================

  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const withSaving = useCallback(async (key: string, fn: () => Promise<Response>) => {
    setSavingKeys(prev => new Set(prev).add(key))
    try {
      const res = await fn()
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error('Tinh chỉnh thất bại', { description: json.error ?? `HTTP ${res.status}` })
        return false
      }
      if (json.tuning) setFeed(prev => (prev ? { ...prev, tuning: json.tuning, changeLog: json.changeLog ?? prev.changeLog } : prev))
      return true
    } catch (err) {
      toast.error('Tinh chỉnh thất bại', { description: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      setSavingKeys(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const handleSet = useCallback((key: string, value: string | number) =>
    withSaving(key, () => fetch('/api/neural-architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    })), [withSaving])

  const handleReset = useCallback((key: string) =>
    withSaving(key, () => fetch('/api/neural-architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset', key }),
    })), [withSaving])

  // ==================== DERIVED (copy panel cũ) ====================

  const tuning = feed?.tuning ?? []
  const tuningByKey = useMemo(() => new Map(tuning.map(t => [t.key, t])), [tuning])

  // Danh sách brain để render — dữ liệu thật nếu đã load, còn chưa load/lỗi
  // thì fallback registry tĩnh (đếm null → hiển thị "—", fail-open không để
  // panel trắng). useMemo chống tạo lại mỗi nhịp poll.
  const brainEntries = useMemo<BrainStatusEntry[]>(() => {
    if (brainData) return brainData.brains
    return BRAIN_REGISTRY.map(spec => ({
      ...spec,
      lifecycle: 'dormant' as const,
      signals: spec.signals.map(s => ({ ...s, current: null, ok: false })),
      models: [],
      trainable: BRAIN_TRAINABLE_KEYS.includes(spec.key),
    }))
  }, [brainData])

  // UX-1 áp dụng sớm: tổng số NHÃN VẬN HÀNH TÍCH LŨY — "nguyên liệu dạy
  // não" (logic thuần registry.computeLabelTotal, pin r84); mọi nguồn null
  // → null → ẩn badge (không phải "0 nhãn" — FB-BRAIN-P1-R1-12).
  const labelTotal = useMemo<number | null>(() => computeLabelTotal(brainData?.brains), [brainData])

  // Não đang chọn (fallback về đầu danh sách — fail-open với registry tĩnh)
  const selectedEntry = brainEntries.find(b => b.key === selectedBrainKey) ?? brainEntries[0]
  // Cờ trình bày (tuning-store STORE › ENV › DEFAULT — ui_synapse_fx mặc
  // định ON theo 15-a, ui_brain_edit mặc định off)
  const uiBrainEditOn = tuningByKey.get('ui_brain_edit')?.effectiveValue === 'on'
  const uiSynapseFxOn = tuningByKey.get('ui_synapse_fx')?.effectiveValue === 'on'
  // Trọng số composite reward hiệu lực (§9.3 nhóm C — LOG-ONLY): đọc từ
  // tuning state, NaN/Thiếu → fallback 1/3 (trùng default TUNING_SPECS)
  const rewardWeightsEffective = useMemo(() => {
    const read = (k: 'reward_w_outcome' | 'reward_w_efficiency' | 'reward_w_quality'): number => {
      const n = Number(tuningByKey.get(k)?.effectiveValue)
      return Number.isFinite(n) ? n : 0.3333333333333333
    }
    return {
      outcome: read('reward_w_outcome'),
      efficiency: read('reward_w_efficiency'),
      quality: read('reward_w_quality'),
    }
  }, [tuningByKey])
  // Nguồn hiệu lực của w₁ (cùng SOURCE_BADGE bảng tuning đang dùng)
  const rewardSourceLabel = SOURCE_BADGE[tuningByKey.get('reward_w_outcome')?.source ?? 'default']?.label ?? 'DEFAULT'
  // Giá trị cờ runtime của não đang chọn (badge SECTION 1 — kế thừa BrainCard cũ)
  const selectedFlagValue = selectedEntry.flagTuningKey !== undefined
    ? String(tuningByKey.get(selectedEntry.flagTuningKey)?.effectiveValue ?? 'off')
    : undefined

  // Map nodeId → title cho bảng tuning + dialog (tab BRAIN KHÔNG render đồ
  // thị 6 lớp — đọc tên nút từ NEURAL_NODES, nguồn single-source neural-types)
  const nodeTitleById = useMemo(() => new Map(NEURAL_NODES.map(n => [n.id, n.title])), [])

  // Entry MỚI NHẤT của param đang mở dialog (poll refresh identity — dialog
  // giữ draft user gõ dở vì chỉ reset khi param.key đổi, contract 15-b)
  const activeDialogParam = dialogParam ? tuningByKey.get(dialogParam.key) ?? dialogParam : null

  // ── UX-4: nội dung SECTION 3 (tab console — 18-c render INLINE ở MỌI
  // viewport; trước đây dùng ở 2 nơi desktop/mobile-sheet, giờ 1 nơi duy
  // nhất nên state tab không bao giờ bị remount mất). ──
  const consolePanel = (
    <div className="space-y-2.5" role="tabpanel" aria-label="Console não vận hành">
      {/* Thanh tab 4 nút (style giống tab head brain-stage UX-3; 18-c thêm
          tab "Hàm & công thức" — bảng tham chiếu trình bày) */}
      <div className="flex overflow-hidden rounded-md border border-stone-700/70" role="tablist" aria-label="Bảng điều khiển não">
        {([
          ['train', 'Training Console'],
          ['tuning', 'Tham số runtime'],
          ['log', 'Nhật ký tinh chỉnh'],
          ['ref', 'Hàm & công thức'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={consoleTab === id}
            onClick={() => setConsoleTab(id)}
            className={`min-h-[44px] md:min-h-[32px] flex-1 px-2 text-[10px] ${consoleTab === id ? 'bg-amber-500/20 text-amber-300' : 'text-stone-400 hover:text-stone-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {consoleTab === 'train' && (
        // 18-c: TrainingConsole nguyên dạng full-width 1 cột (nhóm A grid
        // 2 cột bên trong + nhóm B/C dạng hàng — đủ rộng, KHÔNG bọc grid 3).
        <TrainingConsole
          brain={selectedEntry}
          draft={draftForSelected}
          onDraftChange={onDraftChange}
          onDraftSave={() => void saveDraft(selectedBrainKey)}
          draftDirty={dirtyBrains.has(selectedBrainKey)}
          hasSavedDraft={savedDrafts[selectedBrainKey] != null}
          editorOn={uiBrainEditOn}
          onTrain={trainBrain}
          training={trainingBrains.has(selectedBrainKey)}
          outcome={trainOutcome}
          rewardWeights={rewardWeightsEffective}
          rewardSource={rewardSourceLabel}
          onSetRewardWeight={(k, v) => void handleSet(k, v)}
          onResetRewardWeight={k => void handleReset(k)}
          savingRewardKey={Array.from(savingKeys).find(k => k.startsWith('reward_w_')) ?? null}
        />
      )}

      {consoleTab === 'tuning' && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Zap className="h-3 w-3 shrink-0 text-violet-400" />
            <span className="text-[10px] text-stone-500">chuỗi hiệu lực: STORE › ENV › DEFAULT · áp dụng tức thì (không restart) · bấm ✎ để chỉnh tại chỗ</span>
          </div>
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-stone-500 border-b border-slate-800">
                  <th className="text-left py-1.5 pr-2 font-medium">Tham số</th>
                  <th className="text-left py-1.5 pr-2 font-medium">Nút</th>
                  <th className="text-left py-1.5 pr-2 font-medium">Hiệu lực</th>
                  <th className="text-left py-1.5 pr-2 font-medium">Mặc định</th>
                  <th className="text-left py-1.5 font-medium">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {tuning.length === 0 && (
                  <tr><td colSpan={5} className="py-4 text-center text-stone-600">Đang tải…</td></tr>
                )}
                {tuning.map(t => {
                  // BRAIN-LIVE (chỉ thị user 2026-10-12): tab BRAIN không có
                  // đồ thị 6 lớp — cột "Nút" là TEXT THUẦN (title nút từ
                  // NEURAL_NODES), KHÔNG bấm chọn node như bảng cũ.
                  const nodeTitle = nodeTitleById.get(t.nodeId) ?? t.nodeId
                  const src = SOURCE_BADGE[t.source] ?? SOURCE_BADGE.default
                  return (
                    <tr key={t.key} className="border-b border-slate-900/80 hover:bg-slate-950/40">
                      <td className="py-1.5 pr-2">
                        <p className="text-stone-200 font-medium">{t.label}</p>
                        <p className="font-mono text-[9px] text-stone-600">{t.key}</p>
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="text-stone-400" title={`Nút ${nodeTitle} (${t.nodeId}) — xem chi tiết nút ở Database › Kiến trúc`}>
                          {nodeTitle}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-stone-100 font-mono">
                            {String(t.effectiveValue)}{t.unit ? ` ${t.unit}` : ''}
                          </span>
                          <Badge variant="outline" className={`text-[9px] h-3.5 px-1 ${src.cls}`}>{src.label}</Badge>
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-stone-500 font-mono">
                        {String(t.default)}{t.unit ? ` ${t.unit}` : ''}
                      </td>
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1">
                          {/* BRAIN-LIVE (15-b): bút chì mở DIALOG chỉnh tại
                              chỗ — thay nút mũi tên cuộn lên ô phía trên
                              (chỉ thị user 2026-10-12). */}
                          <button
                            className="text-stone-400 hover:text-cyan-300"
                            title="Mở hộp thoại tinh chỉnh (chỉnh tại chỗ, đóng lại)"
                            aria-label={`Mở tinh chỉnh ${t.label}`}
                            onClick={() => { setDialogParam(t); setDialogOpen(true) }}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          {t.storeValue !== null && (
                            <button
                              className="text-stone-500 hover:text-amber-400 disabled:opacity-40"
                              title="Trả về mặc định (bỏ override)"
                              aria-label={`Reset ${t.label}`}
                              disabled={savingKeys.has(t.key)}
                              onClick={() => void handleReset(t.key)}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {consoleTab === 'log' && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <History className="h-3.5 w-3.5 text-teal-400" />
            <h4 className="text-xs font-semibold text-stone-100">Nhật ký tinh chỉnh runtime</h4>
            <span className="text-[10px] text-stone-500">mọi đặt / trả-mặc-định được ghi audit · giữ tối đa {TUNING_CHANGE_LOG_CAP} dòng mới nhất</span>
          </div>
          {(feed?.changeLog?.length ?? 0) === 0 ? (
            <p className="text-[11px] text-stone-500 italic">Chưa có thay đổi nào được ghi (phát sinh khi đặt hoặc trả mặc định một tham số).</p>
          ) : (
            <div className="dialog-scrollbar max-h-44 space-y-1.5 overflow-y-auto">
              {feed!.changeLog!.map(c => {
                const label = tuningByKey.get(c.key)?.label ?? c.key
                return (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                    title={`${c.key} · store: ${c.fromStoreValue ?? '—'} → ${c.toStoreValue ?? '—'}`}
                  >
                    <span className="shrink-0 tabular-nums text-stone-600">{new Date(c.createdAt).toLocaleString('vi-VN')}</span>
                    <span className="font-mono text-stone-300">{label}</span>
                    {c.action === 'set'
                      ? <Badge variant="outline" className="h-3.5 px-1 border-amber-500/45 bg-amber-950/70 text-[9px] text-amber-400">đặt</Badge>
                      : <Badge variant="outline" className="h-3.5 px-1 border-stone-600/50 bg-slate-950/70 text-[9px] text-stone-400">về mặc định</Badge>}
                    <span className="font-mono text-stone-500">{c.fromEffectiveValue}</span>
                    <span aria-hidden="true" className="text-stone-600">→</span>
                    <span className="font-mono font-medium text-stone-100">{c.toEffectiveValue}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {consoleTab === 'ref' && (
        // BRAIN-TAB-3PHAN (18-c): bảng tham chiếu hàm kích hoạt / loss /
        // reward / lan truyền tiến-ngược + đạo hàm — trả lời câu hỏi user
        // "liệu đã có thông tin để lựa chọn… có đầy đủ chưa" (audit 18-KEHOACH).
        <BrainReference />
      )}
    </div>
  )

  // ==================== RENDER — 3 SECTION DỌC (BRAIN-TAB-3PHAN 18-c) ====================
  // Chỉ thị user: phần trên = chọn não + thông tin + editor lớp/nơ-ron; phần
  // giữa = giao diện lớp xem to nhỏ tổng quan → chi tiết; phần cuối = các
  // bảng thông số chỉnh được. Mỗi section 1 Card riêng (nc-wrap nc-amber +
  // nc-panel nc-md nc-border-amber như trước) + role="region" riêng.

  return (
    <div className="space-y-4">
      {/* ── SECTION 1 — CHỌN NÃO & KIẾN TRÚC: Brain Studio (UX-1) + ngưỡng
          thức tỉnh + badge phase/flag/inputMode (di chuyển nguyên khối từ
          cột trái layout 3 cột cũ) ── */}
      <div className="nc-wrap nc-amber" role="region" aria-label="Chọn não và kiến trúc">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <h4 className="text-xs font-semibold text-stone-100">1 · Chọn não &amp; kiến trúc</h4>
              <span className="text-[10px] text-stone-500">
                3 bộ não nhỏ tự huấn luyện khi đủ mẫu · ngủ an toàn khi thiếu · thêm lớp / chỉnh nơ-ron / activation / α-β ở Editor kiến trúc
              </span>
              {brainData && (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {labelTotal !== null && (
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 bg-slate-950/60 text-[9px] text-stone-300 border-stone-600/50"
                      title="Tổng nhãn vận hành tích lũy — nguyên liệu dạy não (EvalResult + AgentRunRecord + QEntry + ArbiterVerdict, cộng theo nguồn không trùng — blueprint §2/§9.2)"
                    >
                      <Tags className="mr-0.5 h-2.5 w-2.5" aria-hidden="true" />
                      {viNum(labelTotal)} nhãn
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[9px] h-3.5 px-1 bg-amber-950/60 text-amber-400 border-amber-500/40">
                    ● sống · {new Date(brainData.generatedAt).toLocaleTimeString('vi-VN')}
                  </Badge>
                </div>
              )}
            </div>
            {brainError && !brainData && (
              <p className="mb-2 text-[11px] text-amber-500/90">
                Không tải được số liệu mẫu ({brainError}) — hiển thị spec kế hoạch (fail-open).
              </p>
            )}
            <BrainStudio
              brains={brainEntries}
              selectedKey={selectedBrainKey}
              onSelect={selectBrain}
              editorOn={uiBrainEditOn}
              draft={draftForSelected}
              onDraftChange={onDraftChange}
              onDraftSave={() => void saveDraft(selectedBrainKey)}
              savingDraft={savingDraft}
              draftDirty={dirtyBrains.has(selectedBrainKey)}
              saveErrors={saveErrors}
              focusLayerSignal={focusLayerSignal}
            />
            {/* Thức tỉnh khi đủ mẫu — di chuyển nguyên khối từ cột trái cũ,
                hiển thị signals CỦA NÃO ĐANG CHỌN (label + progress + current/min) */}
            <div className="mt-2.5 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wide text-stone-500">Thức tỉnh khi đủ mẫu</p>
              {selectedEntry.signals.map(sig => {
                const pct = sig.current === null ? 0 : Math.min(100, Math.round((sig.current / sig.min) * 100))
                return (
                  <div
                    key={sig.key} className="flex items-center gap-2 text-[11px]"
                    title={`${sig.label} — bảng ${sig.table} · ngưỡng ${sig.min} (${sig.source})`}
                  >
                    <span className="min-w-0 flex-1 truncate text-stone-300">{sig.label}</span>
                    <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-900" aria-hidden="true">
                      <div className={`h-full rounded-full ${sig.ok ? 'bg-emerald-500/80' : 'bg-amber-500/70'}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right font-mono tabular-nums text-stone-200">
                      {sig.current === null ? '—' : viNum(sig.current)}/{sig.min}
                    </span>
                  </div>
                )
              })}
            </div>
            {/* Hàng badge phase + cờ runtime + inputMode (kế thừa BrainCard cũ) */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] text-stone-500 border-stone-600/50">{selectedEntry.phase}</Badge>
              <Badge
                variant="outline"
                className={`h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] border-stone-600/50 ${selectedFlagValue === 'on' ? 'text-emerald-400' : 'text-stone-500'}`}
                title={selectedFlagValue !== undefined
                  ? 'Giá trị hiệu lực thật (STORE › ENV › DEFAULT) — đổi ở tab "Tham số runtime" (section Bảng thông số)'
                  : 'Cờ phase chưa có trong tuning store (mặc định OFF)'}
              >
                {selectedEntry.flag}={selectedFlagValue ?? 'off'}
              </Badge>
              <Badge variant="outline" className="h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] text-stone-400 border-stone-600/50">in: {selectedEntry.defaultInputMode}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── SECTION 2 — ĐÀI QUAN SÁT NÃO: sân khấu UX-3 v2 (đài quan sát
          thật) full-width fit-height (18-a geometry v3: center-align + kích
          thước điểm thích ứng) + live + chú thích bất biến ── */}
      <div className="nc-wrap nc-amber" role="region" aria-label="Đài quan sát não theo thời gian thực">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Activity className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <h4 className="text-xs font-semibold text-stone-100">2 · Đài quan sát não</h4>
              <span className="text-[10px] text-stone-500">
                điểm sáng nơ-ron thật (bản active) · zoom/pan xem từ tổng quan đến chi tiết · bấm cột lớp ẩn để nháy tới editor ở phần 1
              </span>
            </div>
            <div className="space-y-2.5">
              {/* Thanh live: bật/tắt poll 2.5s + chú thích READ-ONLY —
                  chip "Agent đang chạy/nghỉ" + tooltip nguồn/fetchedAt do
                  BrainStage v2 tự render khi có activity (15-c) */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setLiveOn(v => !v)}
                  aria-pressed={liveOn}
                  title={liveOn
                    ? 'Live ĐANG BẬT — poll /api/brain/activity mỗi 2.5s (READ-ONLY, chỉ chạy khi tab trình duyệt đang hiển thị). Bấm để tắt.'
                    : 'Live đang TẮT — bấm để bật poll hoạt động não mỗi 2.5s (READ-ONLY).'}
                  className={`min-h-[44px] md:min-h-[28px] inline-flex items-center gap-1 rounded-md border px-2 text-[10px] ${
                    liveOn
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                      : 'border-stone-700/70 text-stone-400 hover:text-stone-200'
                  }`}
                >
                  <Radio className={`h-3 w-3 ${liveOn ? 'animate-pulse' : ''}`} aria-hidden="true" />
                  {liveOn ? 'Live' : 'Live tắt'}
                </button>
                <span className="text-[9.5px] text-stone-500">
                  poll 2.5s · READ-ONLY{activity ? ` · dữ liệu ${new Date(activity.fetchedAt).toLocaleTimeString('vi-VN')}` : ''}
                </span>
              </div>
              <BrainStage
                brain={selectedEntry}
                draft={draftForSelected}
                editorOn={uiBrainEditOn}
                fxOn={uiSynapseFxOn}
                onEditLayer={layer => setFocusLayerSignal({ brain: selectedBrainKey, layer, nonce: Date.now() })}
                activity={activity}
                tall
                refreshNonce={refreshNonce}
                initialHead={activityHead}
                onHeadChange={h => setActivityHead(h)}
              />
              <p className="text-[9.5px] leading-relaxed text-stone-500">
                ⚠ Bản nháp KHÔNG tự lên runtime — chỉ qua train thắng đối chứng CV (bất biến A1); runtime chỉ
                đổi khi cờ bật (STORE › ENV › DEFAULT=off); Brain-B có POST /api/brain/replay (replay-eval
                READ-ONLY); 3 organ steering của Brain-C mỗi cái kill-switch riêng.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── SECTION 3 — BẢNG THÔNG SỐ: 4 tab (Training Console UX-2 / Tham
          số runtime / Nhật ký / Hàm & công thức) — render INLINE mọi
          viewport (18-c: bỏ hộp console mobile, console là section cuối) ── */}
      <div className="nc-wrap nc-amber" role="region" aria-label="Bảng thông số điều chỉnh">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <h4 className="text-xs font-semibold text-stone-100">3 · Bảng thông số</h4>
              <span className="text-[10px] text-stone-500">
                siêu tham số + loss + reward (Training Console) · tham số runtime · nhật ký · bảng tham chiếu hàm &amp; công thức
              </span>
            </div>
            {consolePanel}
          </CardContent>
        </Card>
      </div>

      {/* ── Dialog chỉnh tham số runtime (15-b) — bút chì cột Hành động ── */}
      <TuningParamDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        param={activeDialogParam}
        spec={activeDialogParam ? getTuningSpec(activeDialogParam.key) ?? null : null}
        nodeTitle={activeDialogParam ? nodeTitleById.get(activeDialogParam.nodeId) : undefined}
        saving={savingKeys.has(activeDialogParam?.key ?? '')}
        onSet={handleSet}
        onReset={handleReset}
      />
    </div>
  )
}
