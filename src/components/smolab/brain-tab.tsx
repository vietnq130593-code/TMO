'use client'

// ========================================================================
// brain-tab — Tab "BRAIN" (module Smolab) — BRAIN-LIVE 15-d → TASK 26 (đài quan sát v2)
// ========================================================================
//
// CHỈ THỊ USER (2026-10-12, nguyên văn): "Đúng ra nên chia 3 phần, Phần
// trên cùng là nút chọn Brain cũng như thông tin liên quan brain, Có thể
// thêm lớp cũng như chỉnh số nơ ron mỗi lớp, sau đó là đến giao diện lớp
// có thể chỉnh to nhỏ để xem từ tổng quan đến chi tiết được... Cuối cùng
// là phần chứa các bản thông số có thể chỉnh sửa và thiết lập được."
//
// CHỈ THỊ USER (2026-10-13, Task 26, nguyên văn): "tab Quan sát trong Bảng
// thông số nên tích hợp vào ô Chọn não và kiến trúc — chọn xong não nào
// có thể xem ngay dưới đài quan sát não, và chọn quan sát cái gì ở trên
// thì xem được ở đài bên dưới."
// → Task 26: Quan sát chuyển từ tab console SECTION 3 (Task 25) LÊN selector
//   "Chế độ quan sát" 4 nút ở SECTION 1 (ngay dưới Brain Studio, cùng Card,
//   ngăn border-t) — nội dung hiển thị bằng PANEL riêng NGAY DƯỚI đài quan
//   sát SECTION 2 (4 panel của observation-tab.tsx; mỗi panel tự mount/unmount
//   theo obsMode → poll tự dừng khi không hiển thị).
//
// LAYOUT 3 SECTION DỌC (18-c — mỗi section 1 Card riêng, space-y-4 — thay
// grid 3 CỘT cũ [280-320px | 1fr | 340-420px] bị user chê "nhét ép"):
//   1 · CHỌN NÃO & KIẾN TRÚC — BrainStudio (18-b rewrite thanh ngang —
//       render nguyên, props KHÔNG đổi) + khối "Thức tỉnh khi đủ mẫu" +
//       hàng badge phase/flag/inputMode (2 khối sau DI CHUYỂN nguyên vẹn
//       markup từ cột trái cũ) + badge tổng nhãn + ● sống + KHỐI "CHẾ ĐỘ
//       QUAN SÁT" 4 nút (Task 26 — "Hoạt động nơ-ron" mặc định).
//   2 · ĐÀI QUAN SÁT NÃO — thanh Live (poll thích ứng Task 26: 1.5s nóng /
//       ~10s yên — B5) + BrainStage tall (Task 26: nơ-ron tím tỏa sáng +
//       cạnh thẳng + đường ngược vàng per-edge thật + hạt tín hiệu thật
//       canvas 60fps) + PANEL QUAN SÁT theo obsMode (Task 26) + chú thích
//       bất biến A1.
//   3 · BẢNG THÔNG SỐ — 4 tab (Task 26: bỏ tab Quan sát — chuyển lên
//       SECTION 1 selector + panel dưới đài SECTION 2 theo chỉ thị user):
//       Training Console · Tham số runtime · Nhật ký tinh chỉnh · Hàm &
//       công thức (BrainReference — 18-c). ConsolePanel render INLINE ở
//       MỌI viewport — BỎ hẳn hộp console trượt dưới đáy mobile + nút nổi
//       ⚙ Console + state sheet + effect Esc + toàn bộ máy breakpoint
//       desktop (media query hook + biến nhánh viewport — không còn
//       layout 2 nhánh).
//
// Giữ nguyên từ BRAIN-LIVE (15-d): state machine draft 3 brain (controlled
// — BrainStudio + TrainingConsole + BrainStage cùng MỘT nguồn) · poll 15s
// fail-open · train POST /api/brain/train · spec-draft GET/PUT · LIVE POLL
// /api/brain/activity READ-ONLY (visibilitychange dừng/kẹp lại;
// response 400 bỏ qua lặng lẽ; lỗi mạng giữ activity cũ — fail-open) ·
// TuningParamDialog chỉnh tại chỗ (15-b). Chuỗi pin r92-E GIỮ NGUYÊN khi tái
// cấu trúc: fetch template activity · POLL_ACTIVITY_MS = 2_500 (giữ làm nhịp
// bootstrap; nhịp thật Task 26 là thích ứng 1.5s/10s — hình thức poll đời
// 15-d là setInterval(() => { void fetchActivity() }, POLL_ACTIVITY_MS),
// đã đổi sang chuỗi setTimeout — B5; pin r92-E hiệu chỉnh ở vòng sau) ·
// &head= · selectedBrainKey === 'surrogate' ·
// &head=${activityHead} · initialHead/onHeadChange · activity/refreshNonce
// · tall · <TuningParamDialog · 'ui_synapse_fx'.
//
// [fetch-retry 429] (user report 2026-11-05 — console error "HTTP 429" tại
// fetchBrainData/fetchFeed): MỌI fetch poll tự động của tab này (feed /
// brain / activity / spec-draft GET) bọc fetchWithTransientRetry — preview
// proxy ngoài chặn burst khi nhiều poller cùng bắn (request chưa tới app,
// dev.log chỉ thấy 200) → 429 được retry backoff jitter ~1-4s thay vì ném
// console error; template URL giữ nguyên chuỗi pin (chỉ đổi tên hàm bọc).
//
// ĐỌC TƯƠNG THÍCH (từ 15-b): TuningStateEntry/TuningSpec import thẳng
// '@/lib/learning/neural-types' (client-safe) — KHÔNG import barrel
// '@/lib/learning' vì barrel re-export tuning-store (Prisma) vào client
// bundle.
// ========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, BrainCircuit, Eye, History, Pencil, Radio, RotateCcw, SlidersHorizontal, Tags, Zap } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
// BRAIN-UX §9.5 (UX-4): 3 component studio (UX-1/UX-2/UX-3) — state draft
// nâng lên đây (controlled, single source) như panel cũ.
import { BrainStudio } from '@/components/database/brain-studio'
import { BrainStage, type SurrogateHead, type StageBackprop, type StageTraining } from '@/components/database/brain-stage'
import { TrainingConsole, type TrainOutcomeUi } from '@/components/database/training-console'
// BRAIN-LIVE (15-b): dialog chỉnh tham số runtime tại chỗ — hết cuộn lên.
import { TuningParamDialog, SOURCE_BADGE } from '@/components/smolab/tuning-param-dialog'
// BRAIN-TAB-3PHAN (18-c): tab "Hàm & công thức" — bảng tham chiếu trình
// bày thuần (client-safe: ACTIVATION_MENU spec-schema + hằng optimizers).
import { BrainReference } from '@/components/smolab/brain-reference'
// R25-c (§5): tab console "Tiến hoá" — HyperNAS/EVO U1–U5 (cờ brain_evolve).
import { EvolveTab } from '@/components/database/evolve-tab'
// OBS-P3 (Task 25) → TASK 26: tab Quan sát chuyển LÊN SECTION 1 selector
// "Chế độ quan sát" + PANEL dưới đài SECTION 2 (chỉ thị user 2026-10-13) —
// 4 panel của observation-tab.tsx tự mount/unmount theo obsMode (poll dừng
// khi không hiển thị); OBS_MODES là single-source nhãn 4 nút selector.
import {
  OBS_MODES,
  ObsNeuronsPanel,
  ObsTimelinePanel,
  ObsTracesPanel,
  ObsGoldenPanel,
  type ObsMode,
} from '@/components/smolab/observation-tab'
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
// [fetch-retry 429] poll GET bọc retry 429/502/503/504 — xem ghi chú đầu file
import { fetchWithTransientRetry } from '@/lib/fetch-retry'

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
/** Nhịp poll live activity (BRAIN-LIVE 15-d) — di sản đời 15-d (pin r92-E);
 *  Task 26 B5 giữ làm NHỊP BOOTSTRAP cho tới phản hồi đầu. */
const POLL_ACTIVITY_MS = 2_500
/** Task 26 B5 (hiệu năng realtime): nhịp nóng 1.5s — khi agent đang chạy
 *  hoặc train đang chạy (đài cần phản ánh gần tức thời). */
const POLL_HOT_MS = 1_500
/** Task 26 B5: nhịp khi yên ~10s — đủ mượt cho đài quan sát, đỡ tải DB. */
const POLL_CALM_MS = 10_000

/** Activity của đài + 2 field hợp đồng 26-BE (backprop/training — phòng thủ:
 *  field chưa có trong response → coi như null). */
type ActivityLive = BrainActivity & {
  backprop: StageBackprop | null
  training: StageTraining | null
}

const viNum = (n: number): string => n.toLocaleString('vi-VN')

// ==================== TAB BRAIN (BRAIN-LIVE 15-d · 3 SECTION 18-c) ====================

export function BrainTabContent() {
  // ── Tuning feed (bảng Tham số runtime + cờ UI + Nhật ký tinh chỉnh) ──
  // Fail-open như panel cũ: lỗi fetch giữ dữ liệu cũ, poll 15s sẽ thử lại.
  const [feed, setFeed] = useState<TuningFeed | null>(null)
  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetchWithTransientRetry('/api/neural-architecture', undefined, { label: 'brain-tab feed' })
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
      const res = await fetchWithTransientRetry('/api/brain', undefined, { label: 'brain-tab status' })
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
  // full-width) + live + chú thích bất biến A1; SECTION 3 = 5 tab console
  // (UX-2 Training Console / Tham số runtime / Nhật ký / Hàm & công thức /
  // Quan sát — OBS-P3 tích hợp Task 25) — inline MỌI viewport (không còn hộp
  // console mobile riêng).

  /// Não đang chọn — mặc định 'calibration_v3'; restore từ localStorage
  /// (queueMicrotask + try/catch — fail-open giữ mặc định khi private mode).
  /// R24-b: chấp nhận cả 'knowledge' (Brain-D ghost §8.5 — nút não thứ 4).
  const [selectedBrainKey, setSelectedBrainKey] = useState<BrainKey>('calibration_v3')
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem('tmo-brain-selected')
        if (saved === 'calibration_v3' || saved === 'surrogate' || saved === 'policy' || saved === 'knowledge') setSelectedBrainKey(saved)
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
  /// Tab đang mở của SECTION 3 (18-c mở rộng 'ref' — Hàm & công thức; Task 26
  /// BỎ 'observation' — Quan sát chuyển lên SECTION 1 selector + panel dưới
  /// đài SECTION 2 theo chỉ thị user 2026-10-13; R25-c §5 thêm 'evo' — Tiến
  /// hoá, CHỈ render khi cờ brain_evolve on — xem evolveFlagOn dưới)
  const [consoleTab, setConsoleTab] = useState<'train' | 'tuning' | 'log' | 'ref' | 'evo'>('train')
  /// Task 26 (chỉ thị user 2026-10-13): chế độ quan sát — chọn ở SECTION 1,
  /// hiển thị PANEL tương ứng NGAY DƯỚI đài SECTION 2 (useState đủ — không cần
  /// localStorage: chế độ mặc định "Hoạt động nơ-ron" hợp lý mỗi lần vào tab).
  const [obsMode, setObsMode] = useState<ObsMode>('neurons')

  // ── LIVE POLL activity (BRAIN-LIVE 15-d → Task 26 adaptive) ──
  // activity = dữ liệu thật từ GET /api/brain/activity (contract 15-a +
  // hợp đồng 26-BE: += backprop/training) — truyền xuống BrainStage
  // (điểm sáng nơ-ron/cạnh + chip Agent) VÀ ObsNeuronsPanel (CÙNG một fetch —
  // MỘT poller duy nhất chia sẻ stage + panel neurons, B5).
  const [activity, setActivity] = useState<ActivityLive | null>(null)
  /// Bản mới nhất cho scheduler adaptive (đọc ref — không re-create effect)
  const activityRef = useRef<ActivityLive | null>(null)
  useEffect(() => { activityRef.current = activity }, [activity])
  /// Guard unmount + request-id chống response cũ ghi đè khi đổi não/head
  /// giữa chừng (fetch KHÔNG abort — giữ nguyên chuỗi pin r92-E; response trễ
  /// của request cũ bị loại theo id).
  const activityMountedRef = useRef(true)
  const activityReqIdRef = useRef(0)
  useEffect(() => {
    activityMountedRef.current = true
    return () => { activityMountedRef.current = false }
  }, [])
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
    // request-id chống đua: chỉ response MỚI NHẤT được ghi (fetch bọc
    // fetchWithTransientRetry từ 2026-11-05 — 429 gateway retry backoff jitter;
    // template URL giữ nguyên chuỗi pin r92-E)
    const reqId = ++activityReqIdRef.current
    try {
      const q = selectedBrainKey === 'surrogate' ? `&head=${activityHead}` : ''
      const res = await fetchWithTransientRetry(`/api/brain/activity?brain=${selectedBrainKey}${q}`, undefined, { label: 'brain-tab activity' })
      // 400 (query rác) → bỏ qua lặng lẽ — poll không toast spam (15-a contract)
      if (!res.ok) return
      const json = (await res.json()) as BrainActivity & {
        ok: boolean
        backprop?: StageBackprop | null
        training?: StageTraining | null
      }
      if (!activityMountedRef.current || reqId !== activityReqIdRef.current) return
      if (!json.ok) return
      setActivity({
        status: json.status,
        agentRunInProgress: json.agentRunInProgress,
        inputVector: json.inputVector,
        activations: json.activations,
        featureNames: json.featureNames,
        sourceLabel: json.sourceLabel,
        fetchedAt: json.fetchedAt,
        // Hợp đồng 26-BE (phòng thủ — field chưa có → null)
        backprop: json.backprop
          ? {
              deltas: json.backprop.deltas ?? null,
              yTrue: json.backprop.yTrue ?? null,
              loss: json.backprop.loss ?? null,
              label: json.backprop.label ?? null,
            }
          : null,
        training: json.training ?? null,
      })
    } catch { /* lỗi mạng/response trễ → giữ activity cũ (fail-open) */ }
  }, [selectedBrainKey, activityHead])

  // Poll THÍCH ỨNG (Task 26 B5 — thay setInterval cố định 2.5s của 15-d):
  // nhanh POLL_HOT_MS (1.5s) khi agentRunInProgress || training running,
  // chậm POLL_CALM_MS (~10s) khi yên; POLL_ACTIVITY_MS (2.5s) làm nhịp
  // bootstrap tới phản hồi đầu. CHỈ chạy khi liveOn && tab trình duyệt đang
  // hiện (ẩn thì dừng hẳn; hiện lại → fetch ngay + tiếp tục nhịp). liveOn
  // tắt → dừng hẳn (bấm bật lại → fetch ngay một lần rồi tiếp tục).
  useEffect(() => {
    if (!liveOn) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const nextDelay = () => {
      const a = activityRef.current
      if (!a) return POLL_ACTIVITY_MS
      const hot = a.agentRunInProgress || a.training?.status === 'running'
      return hot ? POLL_HOT_MS : POLL_CALM_MS
    }
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(async () => {
        await fetchActivity()
        schedule()
      }, nextDelay())
    }
    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    if (document.visibilityState !== 'hidden') {
      queueMicrotask(() => { void fetchActivity() })
      schedule()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        void fetchActivity()
        schedule()
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
        const res = await fetchWithTransientRetry('/api/brain/spec-draft', undefined, { label: 'brain-tab spec-draft' })
        if (!res.ok) return
        const json = (await res.json()) as { drafts: Array<{ brain: string; spec: BrainDraftSpec | null }> }
        if (!alive) return
        const nextSaved: Partial<Record<BrainKey, BrainDraftSpec | null>> = {}
        for (const d of json.drafts) {
          // R24-b: nhận cả 'knowledge' (rule ghost §8.5 — lưu trữ thuần, chưa train)
          if (d.brain === 'calibration_v3' || d.brain === 'surrogate' || d.brain === 'policy' || d.brain === 'knowledge') {
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

  // ==================== TRAIN (R7 — HIỆU LỰC THẬT, không còn chế độ nháp) ====================
  // BRAIN-P2: train xong (nút Huấn luyện) cũng fetchBrainData tươi.
  // BRAIN-UX §9.3 (UX-2): useDraft=true → POST /api/brain/train đọc bản nháp
  // ĐÃ LƯU từ DB (server validate lại).
  // R7 (chỉ thị user 2026-10-31 "tôi không muốn bản nháp mà muốn tất cả đều
  // hiệu lực thật và vận hành thật"): MỌI lệnh train từ tab này gửi force=true
  // → bản train active NGAY (kể cả chưa thắng CV — metrics vẫn hiển thị minh
  // bạch) + server tự bật cờ runtime tương ứng → model VẬN HÀNH thật trong
  // chuỗi runtime. Định nghĩa TRƯỚC saveDraft vì saveDraft gọi nó (auto-apply).
  const [trainingBrains, setTrainingBrains] = useState<Set<string>>(new Set())
  const trainBrain = useCallback(async (key: BrainKey, useDraft: boolean, force = true) => {
    setTrainingBrains(prev => new Set(prev).add(key))
    try {
      const res = await fetch('/api/brain/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brain: key, useDraft: useDraft || undefined, force: force || undefined }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string; version?: number; active?: boolean; improved?: boolean; sampleSize?: number
        forced?: boolean; flagOn?: boolean
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
      // R7 — verdict nói thật 3 trường hợp: thắng CV / áp dụng theo ý chỉ /
      // không áp dụng được (thiếu dữ liệu)
      const verdict = json.active
        ? (json.improved
            ? `v${json.version} ĐANG VẬN HÀNH — thắng CV${json.flagOn ? ` · cờ ${flagName} đã bật` : ''}`
            : `v${json.version} ĐANG VẬN HÀNH theo chỉ định của bạn (CV chưa thắng: ${cvText} vs ${baselineText})${json.flagOn ? ` · cờ ${flagName} đã bật` : ` · ⚠ bật cờ ${flagName} ở tab Tham số runtime`}`)
        : `v${json.version} chưa áp dụng được — ${json.error ?? 'xem lỗi'} (bản vết audit đã ghi)`
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

  /// Lưu nháp (PUT /api/brain/spec-draft) — validate local bằng single-source
  /// spec-schema trước khi PUT (server validate lại lần nữa — không tin client).
  /// R7 (chỉ thị user 2026-10-31 "không muốn bản nháp — muốn hiệu lực thật"):
  /// sau khi lưu NHÁP thành công, TỰ ĐỘNG train + ÁP DỤNG NGAY (force) — kiến
  /// trúc/hyper mới trở thành bản ACTIVE vận hành thật (kèm bật cờ runtime,
  /// server lo). Nếu thiếu dữ liệu train → toast nói rõ cần thêm mẫu (đó là
  /// giới hạn DỮ LIỆU, không phải chế độ nháp nữa).
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
      // R7 — ÁP DỤNG NGAY: train theo nháp vừa lưu + force (active thật +
      // bật cờ runtime). Toast kết quả do trainBrain lo (success lẫn lỗi
      // thiếu dữ liệu) — không lặng lẽ bỏ dở việc áp dụng.
      // R24-b §8.5: brain CHƯA có pipeline train (knowledge ghost — không
      // nằm trong BRAIN_TRAINABLE_KEYS tới D3) → KHÔNG auto-train (POST
      // /api/brain/train sẽ 400 "chưa có pipeline") — lưu nháp thuần lưu trữ,
      // toast nói thẳng tránh lỗi vô nghĩa.
      if (!BRAIN_TRAINABLE_KEYS.includes(key)) {
        toast.info('Đã lưu nháp kiến trúc Tri Thức (ghost §8.5)', {
          description: 'Brain-D chưa có pipeline train — model thật chỉ sống từ BRAIN-D3 (≥300 log KbConsultLog có Outcome*). Nháp giữ lại cho lúc ấy.',
        })
        return
      }
      toast.info('Đã lưu cấu hình — đang huấn luyện & áp dụng ngay…', {
        description: 'Hiệu chỉnh sẽ lên runtime THẬT (bản active + cờ bật) ngay khi train xong.',
      })
      await trainBrain(key, true, true)
    } catch (err) {
      setSaveErrors([err instanceof Error ? err.message : String(err)])
    } finally {
      setSavingDraft(false)
    }
  }, [draftsByBrain, brainData, trainBrain])

  /// R25-c (§5.3 — 2 cấp áp dụng): EvolveTab "Áp dụng vào nháp / Áp dụng đề
  /// xuất" — ghi hidden layers của ứng viên THUẦN MLP vào nháp não đang chọn
  /// (dirty-guard confirm khi nháp đang có chỉnh chưa lưu — precedent HN §5.3).
  /// KHÔNG đụng active — runtime chỉ lên qua train (A1/H7) như mọi chỉnh editor.
  const applyEvoHiddenToDraft = useCallback((hidden: Array<{ units: number; activation: string }>) => {
    if (!BRAIN_TRAINABLE_KEYS.includes(selectedBrainKey)) {
      toast.error('Não đích chưa vào search space', {
        description: 'Brain-D chưa vào search space (D4 §8.4) — chọn não A/B/C ở phần 1.',
      })
      return
    }
    if (dirtyBrains.has(selectedBrainKey)
      && !window.confirm('Nháp của não này đang có chỉnh chưa lưu — ghi đè kiến trúc ứng viên tiến hoá?')) {
      return
    }
    const base = draftsByBrain[selectedBrainKey] ?? defaultDraftFor(selectedBrainKey)
    const candidate: BrainDraftSpec = {
      ...base,
      hidden: hidden.map(h => ({ units: h.units, activation: h.activation as BrainDraftSpec['hidden'][number]['activation'] })),
    }
    const inputDim = brainData?.brains.find(b => b.key === selectedBrainKey)?.inputDim ?? null
    const v = validateBrainDraft({ ...candidate, brain: selectedBrainKey }, inputDim)
    if (!v.ok) {
      toast.error('Ứng viên không hợp lệ với não này', { description: v.errors.join(' · ') })
      return
    }
    onDraftChange(v.normalized)
    toast.success('Đã ghi kiến trúc ứng viên vào nháp (đề xuất — bạn duyệt)', {
      description: 'Nháp chưa lưu — bấm Lưu cấu hình ở phần 1 để train + áp dụng như mọi chỉnh editor (A1/H7).',
    })
  }, [selectedBrainKey, draftsByBrain, dirtyBrains, brainData, onDraftChange])

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
  // R25-c (§5.1-3): tab console 'Tiến hoá' CHỈ hiện khi cờ brain_evolve = on
  // (tuning #35 — mặc định off; cách đọc y hệt ui_brain_edit phía trên)
  const evolveFlagOn = tuningByKey.get('brain_evolve')?.effectiveValue === 'on'
  /// R25-c §5.1-3: cờ tắt giữa chừng khi đang mở 'evo' → hiệu lực hiển thị rơi
  /// về 'train' (nút 'Tiến hoá' không render → EvolveTab unmount → poll dừng).
  /// Derived-value pattern — KHÔNG setState trong effect (tránh cascading render:
  /// react-hooks/set-state-in-effect) — state consoleTab giữ nguyên, chỉ hiển thị.
  const consoleTabActive = consoleTab === 'evo' && !evolveFlagOn ? 'train' : consoleTab
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
  // R24-b §8.5.1 — badge cờ kill-switch PHỤ (Brain-D có 2 cờ §8.3:
  // runtime_knowledge + knowledge_organ_strategy; não A/B/C rỗng — giữ diện mạo cũ)
  const selectedExtraFlags = useMemo(() => {
    return (selectedEntry.extraFlagTuningKeys ?? []).map(fk => ({
      key: fk,
      label: getTuningSpec(fk)?.label ?? fk,
      value: String(tuningByKey.get(fk)?.effectiveValue ?? 'off'),
    }))
  }, [selectedEntry.extraFlagTuningKeys, tuningByKey])

  // Map nodeId → title cho bảng tuning + dialog (tab BRAIN KHÔNG render đồ
  // thị 6 lớp — đọc tên nút từ NEURAL_NODES, nguồn single-source neural-types)
  const nodeTitleById = useMemo(() => new Map(NEURAL_NODES.map(n => [n.id, n.title])), [])

  // Entry MỚI NHẤT của param đang mở dialog (poll refresh identity — dialog
  // giữ draft user gõ dở vì chỉ reset khi param.key đổi, contract 15-b)
  const activeDialogParam = dialogParam ? tuningByKey.get(dialogParam.key) ?? dialogParam : null

  // ── UX-4: nội dung SECTION 3 (tab console — 18-c render INLINE ở MỌI
  // viewport; trước đây dùng ở 2 nơi desktop/mobile-sheet, giờ 1 nơi duy
  // nhất nên state tab không bao giờ bị remount mất). ──
  /// Danh sách nút tab console — nút thứ 5 "Tiến hoá" (R25-c §5.1-4) CHỈ có
  /// khi cờ brain_evolve on (tuning #35 — off = tab ẩn hoàn toàn, 4 nút baseline).
  const consoleTabs: ReadonlyArray<readonly ['train' | 'tuning' | 'log' | 'ref' | 'evo', string]> = evolveFlagOn
    ? ([
      ['train', 'Training Console'],
      ['tuning', 'Tham số runtime'],
      ['log', 'Nhật ký tinh chỉnh'],
      ['ref', 'Hàm & công thức'],
      ['evo', 'Tiến hoá'],
    ] as const)
    : ([
      ['train', 'Training Console'],
      ['tuning', 'Tham số runtime'],
      ['log', 'Nhật ký tinh chỉnh'],
      ['ref', 'Hàm & công thức'],
    ] as const)
  const consolePanel = (
    <div className="space-y-2.5" role="tabpanel" aria-label="Console não vận hành">
      {/* Thanh tab 4–5 nút (Task 26: bỏ tab "Quan sát" — chuyển lên SECTION 1
          selector "Chế độ quan sát" + panel dưới đài SECTION 2 theo chỉ thị
          user 2026-10-13; style giống tablist console hiện có; R25-c thêm
          nút thứ 5 "Tiến hoá" theo cờ brain_evolve) */}
      <div className="flex overflow-hidden rounded-md border border-stone-700/70" role="tablist" aria-label="Bảng điều khiển não">
        {consoleTabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={consoleTabActive === id}
            onClick={() => setConsoleTab(id)}
            className={`min-h-[44px] md:min-h-[32px] flex-1 px-2 text-[10px] ${consoleTabActive === id ? 'bg-amber-500/20 text-amber-300' : 'text-stone-400 hover:text-stone-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {consoleTabActive === 'train' && (
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

      {consoleTabActive === 'tuning' && (
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

      {consoleTabActive === 'log' && (
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

      {consoleTabActive === 'ref' && (
        // BRAIN-TAB-3PHAN (18-c): bảng tham chiếu hàm kích hoạt / loss /
        // reward / lan truyền tiến-ngược + đạo hàm — trả lời câu hỏi user
        // "liệu đã có thông tin để lựa chọn… có đầy đủ chưa" (audit 18-KEHOACH).
        <BrainReference />
      )}

      {consoleTabActive === 'evo' && (
        // R25-c (§5): tab "Tiến hoá" — HyperNAS/EVO U1–U5 (state machine E1–E4
        // + bảng ứng viên + Pareto + kill-switch). Não đích = não đang chọn
        // SECTION 1 (single-source state — không nhân bản); poll evolve sống
        // chết theo mount/unmount của panel này (consoleActive prop) + remount
        // theo key={brain} khi đổi não đích (reset sạch state + poll).
        <EvolveTab
          key={selectedBrainKey}
          brain={selectedBrainKey}
          onSelectBrainQuick={selectBrain}
          signals={selectedEntry.signals}
          tuningByKey={tuningByKey}
          changeLog={feed?.changeLog ?? []}
          onSetTuning={(k, v) => { void handleSet(k, v) }}
          savingKeys={savingKeys}
          onApplyToDraft={applyEvoHiddenToDraft}
          editorOn={uiBrainEditOn}
          consoleActive={consoleTabActive === 'evo'}
        />
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
                4 bộ não nhỏ tự huấn luyện khi đủ mẫu (Tri Thức = ghost dự kiến §8.5 — chưa học tới D3) · ngủ an toàn khi thiếu · thêm lớp / chỉnh nơ-ron / activation / α-β ở Editor kiến trúc
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
              {/* R24-b §8.5.1 — cờ kill-switch phụ của não đang chọn (Brain-D:
                  knowledge_organ_strategy §8.3; đổi qua tab Tham số runtime —
                  audit Nhật ký tinh chỉnh precedent tuning-store) */}
              {selectedExtraFlags.map(f => (
                <Badge
                  key={f.key}
                  variant="outline"
                  className={`h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] border-stone-600/50 ${f.value === 'on' ? 'text-emerald-400' : 'text-stone-500'}`}
                  title={`Cờ kill-switch phụ (§8.3) — giá trị hiệu lực thật (STORE › ENV › DEFAULT); đổi ở tab "Tham số runtime" (section Bảng thông số)`}
                >
                  {f.label}={f.value}
                </Badge>
              ))}
              <Badge variant="outline" className="h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] text-stone-400 border-stone-600/50">in: {selectedEntry.defaultInputMode}</Badge>
            </div>

            {/* ── Task 26 (chỉ thị user 2026-10-13): khối "Chế độ quan sát" —
                chọn nội dung hiển thị dưới đài quan sát SECTION 2 ("chọn quan
                sát cái gì ở trên thì xem được ở đài bên dưới"); tab Quan sát
                cũ của SECTION 3 chuyển lên đây. Pattern tablist y hệt console
                SECTION 3: role tablist/tab + aria-selected + min-h-44 mobile. */}
            <div className="mt-3 border-t border-stone-800/70 pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Eye className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <h5 className="text-[11px] font-semibold text-stone-100">Chế độ quan sát</h5>
                <span className="text-[10px] text-stone-500">chọn chế độ — nội dung hiển thị dưới đài quan sát bên dưới</span>
              </div>
              <div className="flex overflow-hidden rounded-md border border-stone-700/70" role="tablist" aria-label="Chế độ quan sát">
                {OBS_MODES.map(m => (
                  <button
                    key={m.id}
                    role="tab"
                    aria-selected={obsMode === m.id}
                    onClick={() => setObsMode(m.id)}
                    className={`min-h-[44px] md:min-h-[32px] flex-1 px-2 text-[10px] ${obsMode === m.id ? 'bg-amber-500/20 text-amber-300' : 'text-stone-400 hover:text-stone-200'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── SECTION 2 — ĐÀI QUAN SÁT NÃO: sân khấu UX-3 v2 (đài quan sát
          thật) full-width fit-height (Task 26: nơ-ron tím + cạnh thẳng +
          đường ngược vàng per-edge + hạt tín hiệu thật canvas) + live +
          PANEL QUAN SÁT theo obsMode (Task 26 — chỉ thị user "chọn xong não
          nào có thể xem ngay dưới đài quan sát não") + chú thích bất biến ── */}
      <div className="nc-wrap nc-amber space-y-4" role="region" aria-label="Đài quan sát não theo thời gian thực">
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
                    ? 'Live ĐANG BẬT — poll /api/brain/activity thích ứng (1.5s khi agent/train đang chạy, ~10s khi yên — READ-ONLY, chỉ chạy khi tab trình duyệt đang hiển thị). Bấm để tắt.'
                    : 'Live đang TẮT — bấm để bật poll hoạt động não (READ-ONLY, thích ứng theo nhịp vận hành).'}
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
                  poll thích ứng 1.5s/10s · READ-ONLY{activity ? ` · dữ liệu ${new Date(activity.fetchedAt).toLocaleTimeString('vi-VN')}` : ''}
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
                backprop={activity?.backprop ?? null}
                training={activity?.training ?? null}
              />
              <p className="text-[9.5px] leading-relaxed text-stone-500">
                ✓ R7: hiệu chỉnh lưu ở tab này ÁP DỤNG NGAY vào runtime thật — train xong bản mới thành ACTIVE
                (kể cả khi chưa thắng đối chứng CV — theo chỉ định của bạn) và cờ runtime tương ứng tự bật;
                auto-retrain sau eval/agent run vẫn giữ cổng CV an toàn. Thiếu dữ liệu train thì chưa áp dụng
                được (cần thêm mẫu — chạy eval/agent). Brain-B có POST /api/brain/replay (replay-eval READ-ONLY);
                3 organ steering của Brain-C mỗi cái kill-switch riêng.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Task 26: PANEL QUAN SÁT NGAY DƯỚI ĐÀI — nội dung theo obsMode
            chọn ở SECTION 1 (chỉ thị user 2026-10-13: "chọn xong não nào có
            thể xem ngay dưới đài quan sát não, và chọn quan sát cái gì ở trên
            thì xem được ở đài bên dưới"). Mỗi panel tự mount/unmount theo
            obsMode → poll tự dừng khi không hiển thị (B5). neurons dùng
            CÙNG activity fetch của đài (1 poller duy nhất). */}
        <Card className="nc-panel nc-md nc-border-amber">
          <CardContent className="p-4">
            {obsMode === 'neurons' && (
              <ObsNeuronsPanel activity={activity} brainKey={selectedBrainKey} brainTitle={selectedEntry.title} />
            )}
            {obsMode === 'timeline' && <ObsTimelinePanel />}
            {obsMode === 'traces' && (
              <ObsTracesPanel brainKey={selectedBrainKey} brainTitle={selectedEntry.title} />
            )}
            {obsMode === 'golden' && <ObsGoldenPanel />}
          </CardContent>
        </Card>
      </div>

      {/* ── SECTION 3 — BẢNG THÔNG SỐ: 4 tab (Training Console UX-2 / Tham
          số runtime / Nhật ký / Hàm & công thức — Task 26: tab Quan sát đã
          chuyển lên SECTION 1 selector + panel dưới đài SECTION 2) — render
          INLINE mọi viewport (18-c: bỏ hộp console mobile, console là
          section cuối) ── */}
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
