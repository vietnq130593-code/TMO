'use client'

/**
 * BRAIN-LIVE v2 (chỉ thị user 2026-10-12) — SÂN KHẤU NÃO "ĐÀI QUAN SÁT THẬT"
 * ============================================================================
 *
 * Nâng cấp từ BRAIN-UX §9.4 (UX-3). Chỉ thị user (trích ngắn): "mỗi lớp có
 * bao nhiêu nơ-ron thì phải hiển thị đúng số điểm nơ-ron đấy, cơ chế lan
 * truyền tiến bằng các đường màu xanh, lan truyền ngược là các đường màu
 * vàng và các đường này có hiệu ứng chuyển động theo hướng, khi agent vận
 * hành, tư duy thì có các điểm sáng tương ứng với các nơ-ron hoạt động...
 * không gian thể hiện... có thu to phóng nhỏ".
 *
 *  - HIỂN THỰC TỪNG NƠ-RON: display = min(units, STAGE_LIMITS
 *    .maxDisplayNeurons = 256) — spec 10→16→1 vẽ đủ 27 nơ-ron thật; nhãn ×N
 *    + note "nơ-ron đại diện" CHỈ khi units > 256 (nén đại diện). Cột input
 *    planned-fallback có activity.inputVector → dùng đúng length đó làm số
 *    nơ-ron input THẬT (thay '?'/'1-hot cfg' mù).
 *  - TIẾN = XANH (emerald, gradient bs-fwd 0.10→0.85), NGƯỢC = VÀNG
 *    (yellow, gradient bs-bwd 0.10→0.80) — nét đứt chạy theo hướng (class
 *    bs-flow / bs-flow-bwd trong globals.css — GIỮ NGUYÊN, debt chấp nhận).
 *  - ĐIỂM SÁNG ACTIVATION THẬT (prop activity — contract GET
 *    /api/brain/activity của 15-a): nơ-ron fill emerald theo |a|/max từng
 *    lớp; cạnh strokeOpacity theo |a_from × W(col+1)[to][from]| chuẩn hóa
 *    per cặp cột (0.22–0.90); dormant chỉ sáng cột input (one-hot thật) +
 *    chú thích nguồn; chip Agent đang chạy (emerald pulse) / Agent nghỉ.
 *  - ZOOM/PAN: state view {x,y,w,h} (null = fit về base layout.width×height+pad) —
 *    nút overlay −/%/+ /⤢ Vừa (bước 1.25×, zoom ∈ [0.5×, 12×]) · wheel zoom
 *    1.1×/event về TÂM CON TRỎ (passive:false — vùng quan sát chuyên dụng) ·
 *    kéo chuột pan khi zoomed (nuốt click sau kéo >3px — pattern P3-B1) ·
 *    đúp chuột = vừa khung. Hit-test getScreenCTM phản ánh viewBox hiện tại.
 *
 * BRAIN-TAB-3PHAN v3 (chỉ thị user 2026-10-12, trích ngắn: "sau đó là đến
 * giao diện lớp có thể chỉnh to nhỏ để xem từ tổng quan đến chi tiết được.
 * Nếu số nơ rọn nhiều thì các điểm nơ ron chỉnh kích thước nhỏ lại, vị trí
 * các lớp chỉnh căn giữa thay vì căn trên như hiện tại"):
 *  - GEOMETRY v3 (stage-geometry.ts): cột CENTER-ALIGN dọc (cột ngắn lơ
 *    lửng giữa cột cao nhất — không kéo về top); rowStep thích ứng từng
 *    cột (cột dày đặc co còn sàn 2 — 256 nơ-ron span 510 thay 4404);
 *    radius nơ-ron theo cột (clamp rowStep×0.36 vào [0.7, 6.5] — cột 256
 *    chấm 0.72); width ĐỘNG clamp(n×130, 340, 900) thay hằng 340.
 *  - Render theo geometry v3: circle r = layout.radius[col] (selected phóng
 *    nhẹ min(neuronRMax, r×1.6+1.2)); cạnh né lõi bằng R1/R2 theo 2 cột;
 *    hit-test nơ-ron ngưỡng max(4, r_c+3) thích ứng cột dày đặc.
 *  - Container full-width fit-height (tab BRAIN layout 3 phần — đài quan
 *    sát là section GIỮA): tall → stageBox cao xác định h-[440px] md:520
 *    xl:600 + flex center; ResizeObserver đo box → setSize SVG THỦ CÔNG
 *    giữ aspect (scale = min(boxW/viewW, boxH/viewH)) — element rect ≡
 *    viewBox rect cho MỌI phép ratio zoom/pan/hit-test (code zoom tính theo
 *    getBoundingClientRect của element — KHÔNG dùng preserveAspectRatio
 *    meet để letterbox). !tall giữ h-auto w-full cũ (không đo).
 *
 * Giữ nguyên từ UX-3/§9.4: bấm nhãn cột → editor (UX-1); nơ-ron → inspector
 * bias/|w| vào-ra · cạnh → |w| đúng cặp (từ trọng số THẬT /api/brain/weights
 * — refreshNonce đổi giá trị → refetch, vd sau train); nút Tiến/Ngược bật
 * ngược CHỈ khi có |gradient| thật; LOD ≤ 300 cạnh + IntersectionObserver
 * dừng animation ngoài viewport; prefers-reduced-motion → bản tĩnh; touch
 * target ≥ 44px; surrogate head tabs; accent nơ-ron lifecycle amber.
 * Toán hình học thuần ở stage-geometry.ts (test r90). Thu thập dữ liệu
 * READ-ONLY — KHÔNG đụng pipeline/runtime.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrainActivity, BrainStatusEntry } from '@/lib/brain/registry'
import type { BrainDraftSpec } from '@/lib/brain/spec-schema'
import {
  buildStageLayout,
  bezierControls,
  edgePhaseSec,
  hitEdge,
  isAnimated,
  lodEdges,
  strokeWidthForGrad,
  STAGE_LIMITS,
  type StageColumn,
  type StageEdge,
} from '@/lib/brain/stage-geometry'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 1 MLP đã serialize từ BrainModel.weightsJson (envelope numpy — audit A6). */
interface MlpSerializedLike {
  spec: { layers: Array<{ units: number; activation: string }> }
  tensors: Array<{
    kind: 'W' | 'b'
    layer: number
    envelope: { shape: number[]; data: number[] }
  }>
}

interface WeightsResponse {
  brain: string
  head: string | null
  version: number
  active: boolean
  trainedAt: string
  spec: { layers: Array<{ units: number; activation: string }> } | MlpSerializedLike['spec']
  mlp: MlpSerializedLike
  gradAbsMean: number[] | null
}

export type SurrogateHead = 'success' | 'tokens' | 'durationMs'

interface InspectorState {
  kind: 'neuron' | 'edge'
  col: number
  row: number
  /** edge: hàng nơ-ron bên phải */
  toRow?: number
}

// ==================== ZOOM/PAN (BRAIN-LIVE) ====================

/** Cửa sổ nhìn hiện tại của viewBox — null = fit (về base). */
interface StageView {
  x: number
  y: number
  w: number
  h: number
}

/** Pad dưới cho thoáng khi pan. (BRAIN-TAB-3PHAN: width động theo layout —
 *  clamp(n×130, 340, 900) — bỏ hằng STAGE_WIDTH 340 cứng của UX-3/BRAIN-LIVE;
 *  zoomAt clamp theo base.w nên tự thích ứng mọi width.) */
const VIEW_PAD = 14
/** Mức zoom (base.w / view.w) ∈ [ZOOM_MIN, ZOOM_MAX] — clamped mọi thao tác. */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 12
const ZOOM_STEP = 1.25
const WHEEL_STEP = 1.1

/**
 * Zoom thuần về điểm neo (ratio 0..1 trong viewport hiện tại): giữ điểm world
 * dưới neo cố định khi đổi w/h tỉ lệ đều; clamp w vào [base.w/ZOOM_MAX,
 * base.w/ZOOM_MIN]. rX/rY = 0.5 → zoom về tâm (nút overlay).
 */
function zoomAt(cur: StageView, factor: number, base: StageView, rX: number, rY: number): StageView {
  const minW = base.w / ZOOM_MAX
  const maxW = base.w / ZOOM_MIN
  const w = Math.min(maxW, Math.max(minW, cur.w / factor))
  const h = cur.h * (w / cur.w)
  const wx = cur.x + rX * cur.w
  const wy = cur.y + rY * cur.h
  return { x: wx - rX * w, y: wy - rY * h, w, h }
}

/**
 * Nhãn số nơ-ron một lớp (BRAIN-LIVE): vẽ ĐÚNG từng unit khi units ≤ 256 →
 * hiển thị số thẳng (`16`); CHỈ khi bị nén đại diện (units > 256) mới dùng ký
 * hiệu ×N (`×300`) — cùng lúc mới có note "nơ-ron đại diện" trong inspector.
 */
function unitCountLabel(units: number): string {
  return units > STAGE_LIMITS.maxDisplayNeurons ? `×${units}` : `${units}`
}

export function BrainStage({
  brain,
  draft,
  editorOn,
  fxOn,
  onEditLayer,
  activity,
  tall,
  refreshNonce,
  initialHead,
  onHeadChange,
}: {
  brain: BrainStatusEntry
  /** Bản nháp hiện tại (preview kiến trúc khi editor bật) */
  draft: BrainDraftSpec | null
  /** Cờ ui_brain_edit — on: sân khấu preview DRAFT; off: hiển thị active/planned */
  editorOn: boolean
  /** Cờ ui_synapse_fx — on: bezier + animation + inspector + điểm sáng activity; off: đường thẳng tĩnh trung tính */
  fxOn: boolean
  /** Bấm nhãn cột lớp ẩn → editor UX-1 nhảy tới lớp đó */
  onEditLayer?: (layerIdx: number) => void
  /** BRAIN-LIVE — hoạt động thật từ GET /api/brain/activity (contract 15-a):
   *  điểm sáng nơ-ron theo activation thật, one-hot input khi dormant, chip
   *  Agent đang chạy. null/undefined = không có dữ liệu (giữ hiển thị nền tối). */
  activity?: BrainActivity | null
  /** BRAIN-LIVE — true khi ở tab BRAIN Smolab: container cao lớn (chiếm chỗ) */
  tall?: boolean
  /** BRAIN-LIVE — đổi giá trị → refetch /api/brain/weights (vd sau train lên version mới) */
  refreshNonce?: number
  /** FB-BRAIN-LIVE-R1-01 — head khởi tạo cho tab head nội bộ (default
   *  'success'); caller (brain-tab) đồng bộ head của activity poll qua
   *  giá trị này lúc mount để 2 nguồn tín hiệu (điểm sáng poll + |w|/inspector
   *  fetchWeights) cùng một head ngay từ đầu. */
  initialHead?: SurrogateHead
  /** FB-BRAIN-LIVE-R1-01 — user bấm tab head → caller (brain-tab) đổi head
   *  poll /api/brain/activity theo head đang chọn (trước-fix poll luôn
   *  'success' → trộn 2 head trong 1 khung: nơ-ron sáng theo head poll,
   *  cạnh |a×w|/inspector theo head chọn). Chỉ gọi trong event handler. */
  onHeadChange?: (head: SurrogateHead) => void
}) {
  const reducedMotion = usePrefersReducedMotion()
  const animated = isAnimated(fxOn, reducedMotion)
  const [backMode, setBackMode] = useState(false)
  // FB-BRAIN-LIVE-R1-01: khởi tạo từ prop initialHead (default 'success' như cũ)
  const [head, setHead] = useState<SurrogateHead>(initialHead ?? 'success')
  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const [inView, setInView] = useState(true)
  const [weights, setWeights] = useState<WeightsResponse | null>(null)
  const [weightsError, setWeightsError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stageBoxRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // ── Zoom/pan state (BRAIN-LIVE) ──
  const [view, setView] = useState<StageView | null>(null)
  const [panning, setPanning] = useState(false)
  const justPannedRef = useRef(false)
  const panTeardownRef = useRef<(() => void) | null>(null)
  // ── BRAIN-TAB-3PHAN: client size của stageBox (ResizeObserver) — null
  //    trước khi đo / !tall / trình duyệt không có ResizeObserver → SVG giữ
  //    className cũ h-auto w-full (degrade đúng diện mạo BRAIN-LIVE). ──
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null)

  // ── Kéo trọng số bản active (READ-ONLY, fail-open planned/draft);
  //    refreshNonce đổi → refetch (sau train, version mới) ──
  const fetchWeights = useCallback(async () => {
    try {
      const q = brain.key === 'surrogate' ? `?brain=${brain.key}&head=${head}` : `?brain=${brain.key}`
      const res = await fetch(`/api/brain/weights${q}`)
      if (!res.ok) {
        setWeights(null)
        setWeightsError(res.status === 404 ? 'chưa có bản active' : `HTTP ${res.status}`)
        return
      }
      setWeights((await res.json()) as WeightsResponse)
      setWeightsError(null)
    } catch {
      setWeights(null)
      setWeightsError('lỗi mạng — hiển thị spec kế hoạch')
    }
  }, [brain.key, head, refreshNonce])
  // (queueMicrotask defer: không gọi setState đồng bộ trong body effect —
  // react-hooks/set-state-in-effect, cùng pattern neural-architecture-section)
  useEffect(() => { queueMicrotask(() => { void fetchWeights() }) }, [fetchWeights])

  // ── IntersectionObserver: ngoài viewport → dừng animation (§9.4) ──
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      setInView(entries.some(e => e.isIntersecting))
    }, { threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // ── Cột hiển thị: DRAFT (editor on) > active spec > planned registry ──
  // BRAIN-LIVE: planned-fallback có activity.inputVector → cột input dùng
  // ĐÚNG length đó (số nơ-ron input THẬT theo vocab/FEATURE_NAMES — thay
  // '?'/'1-hot cfg' mù). Tách primitive activityInputUnits để memo không
  // recomputes mỗi lần poll activity (identity đổi 2.5s/poll).
  const activityInputUnits = useMemo(() => {
    const v = activity?.inputVector
    return v && v.length > 0 ? v.length : 0
  }, [activity])

  const { columns, activeLayers } = useMemo(() => {
    const inLabel = brain.inputDim !== null && brain.inputDim !== undefined
      ? `${brain.inputDim}${brain.inputDimExact === false ? ' (≈)' : ''}`
      : (brain.planned.layers[0]?.unitsLabel ?? '?')
    const outLayer = brain.planned.layers[brain.planned.layers.length - 1]
    const outLabel = outLayer?.unitsLabel ?? unitCountLabel(outLayer?.units ?? 1)
    const outAct = outLayer?.activation || 'sigmoid/linear ×3'

    if (editorOn && draft) {
      const cols: StageColumn[] = [
        { units: brain.inputDim ?? 8, display: 0, label: inLabel, activation: 'input', locked: true },
        ...draft.hidden.map(h => ({ units: h.units, display: 0, label: unitCountLabel(h.units), activation: h.activation, locked: false })),
        { units: brain.key === 'policy' ? 3 : 1, display: 0, label: outLabel, activation: outAct, locked: true },
      ]
      return { columns: cols, activeLayers: null }
    }
    if (weights?.spec?.layers?.length) {
      const layers = weights.spec.layers
      const cols: StageColumn[] = layers.map((l, i) => ({
        units: l.units,
        display: 0,
        label: i === 0 ? inLabel : i === layers.length - 1 ? outLabel : unitCountLabel(l.units),
        activation: i === 0 ? 'input' : l.activation,
        locked: i === 0 || i === layers.length - 1,
      }))
      return { columns: cols, activeLayers: layers }
    }
    // planned registry (đúng BrainArchDiagram cũ — fail-open)
    const cols: StageColumn[] = brain.planned.layers.map((l, i) => {
      const useActivityInput = i === 0 && activityInputUnits > 0
      const units = useActivityInput
        ? activityInputUnits
        : l.units === 0 ? (i === 0 ? (brain.inputDim ?? 8) : 3) : l.units
      const label = useActivityInput
        ? `${activityInputUnits}`
        : l.unitsLabel ?? (l.units === 0 ? (i === 0 ? inLabel : outLabel) : unitCountLabel(l.units))
      return {
        units,
        display: 0,
        label,
        activation: l.activation || 'input',
        locked: true,
      }
    })
    return { columns: cols, activeLayers: null }
  }, [brain, draft, editorOn, weights, activityInputUnits])

  // ── Layout + cạnh (LOD) — vẽ ĐÚNG từng unit: display = min(units, 256) ──
  const layout = useMemo(() => buildStageLayout(columns.map(c => ({
    ...c,
    display: Math.min(c.units, STAGE_LIMITS.maxDisplayNeurons),
  }))), [columns])

  const edgesAll = useMemo(() => {
    const byColRow = new Map<string, { x: number; y: number; realIndex: number | null }>()
    for (const n of layout.neurons) byColRow.set(`${n.col}:${n.row}`, { x: n.x, y: n.y, realIndex: n.realIndex })
    const list: StageEdge[] = []
    let id = 0
    for (let c = 0; c < columns.length - 1; c++) {
      for (let r1 = 0; r1 < Math.min(columns[c].units, STAGE_LIMITS.maxDisplayNeurons); r1++) {
        for (let r2 = 0; r2 < Math.min(columns[c + 1].units, STAGE_LIMITS.maxDisplayNeurons); r2++) {
          const a = byColRow.get(`${c}:${r1}`)
          const b = byColRow.get(`${c + 1}:${r2}`)
          if (!a || !b) continue
          // BRAIN-TAB-3PHAN: cạnh né lõi theo radius TỪNG CỘT (cột dày đặc
          // chấm nhỏ → cạnh loe gần lõi hơn — R1/R2 thay hằng 6.5 cứng)
          const R1 = layout.radius[c] ?? STAGE_LIMITS.neuronRMax
          const R2 = layout.radius[c + 1] ?? STAGE_LIMITS.neuronRMax
          const { cx1, cy1, cx2, cy2 } = bezierControls(a.x + R1, a.y, b.x - R2, b.y)
          list.push({
            id: id++, fromCol: c, toCol: c + 1, fromRow: r1, toRow: r2,
            x1: a.x + R1, y1: a.y, x2: b.x - R2, y2: b.y, cx1, cy1, cx2, cy2,
          })
        }
      }
    }
    return list
  }, [columns, layout.neurons, layout.radius])

  const edges = useMemo(() => lodEdges(edgesAll), [edgesAll])

  // ── |gradient| từng lớp (chế độ ngược — dữ liệu thật, có mới bật được) ──
  const gradByCol = useMemo(() => {
    if (!weights?.gradAbsMean || !Array.isArray(weights.gradAbsMean)) return null
    // gradAbsMean[i] (0-based) = |gradient| TB của LỚP TRỌNG SỐ nối cột i → cột i+1
    // (tensor W(i+1)); cạnh từ cột fromCol đọc g[fromCol] — mapping ĐÚNG theo
    // cột TRÁI của cạnh (FB-BRAIN-UX-R1-09a: trước đây comment ghi sai i+1→i+2)
    const g = weights.gradAbsMean
    return (col: number): number | null => (col < g.length ? g[col] : null)
  }, [weights])
  const hasBackData = gradByCol !== null && weights?.gradAbsMean?.some(v => v > 0) === true

  // ── realIndex theo vị trí vẽ (dùng cho intensity cạnh — O(1) lookup) ──
  const realByPos = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of layout.neurons) {
      if (n.realIndex !== null) m.set(`${n.col}:${n.row}`, n.realIndex)
    }
    return m
  }, [layout.neurons])

  // ── INTENSITY NƠ-RON theo activation THẬT (BRAIN-LIVE) ──
  // layer 0 = activity.inputVector (kể cả dormant — one-hot thật); layer ≥1 =
  // activity.activations[layer] CHỈ khi status='active'. Chuẩn hóa per lớp:
  // intensity = |a_i| / max|a| (max=0 → 0). Key `${col}:${row}` theo nơ-ron VẼ
  // (nén > 256 vẫn tra đúng unit thật qua realIndex). O(neurons).
  const neuronIntensity = useMemo(() => {
    if (!activity || columns.length === 0) return null
    const actByCol: (readonly number[] | null)[] = columns.map((_, ci) =>
      ci === 0
        ? (activity.inputVector ?? null)
        : activity.status === 'active' ? activity.activations?.[ci] ?? null : null)
    const maxByCol = actByCol.map(acts => {
      if (!acts) return 0
      let mx = 0
      for (let i = 0; i < acts.length; i++) {
        const v = Math.abs(acts[i])
        if (v > mx) mx = v
      }
      return mx
    })
    const m = new Map<string, number>()
    for (const n of layout.neurons) {
      const acts = actByCol[n.col]
      if (!acts) continue
      const real = n.realIndex
      if (real === null || real >= acts.length) continue
      const mx = maxByCol[n.col]
      m.set(`${n.col}:${n.row}`, mx > 0 ? Math.abs(acts[real]) / mx : 0)
    }
    return m.size > 0 ? m : null
  }, [activity, columns, layout.neurons])

  // ── INTENSITY CẠNH theo tín hiệu THẬT (BRAIN-LIVE) ──
  // Cạnh (col→col+1): raw = |a_from × W(col+1)[to][from]| — a_from lấy từ
  // layer 0 = inputVector, layer ≥1 = activations; chuẩn hóa per CẶP CỘT
  // (max trong cặp, tính trên tập cạnh ĐANG VẼ sau LOD) → strokeOpacity =
  // 0.22 + 0.68×norm (min 0.22 giữ cấu trúc nhìn thấy). Đọc tensor PHẲNG
  // tìm MỘT lần per cặp cột — không build lại matrix; O(edges ≤ 300).
  // Chỉ áp cho lan truyền TIẾN; backMode giữ độ dày |gradient| như UX-3.
  const edgeSignal = useMemo(() => {
    if (!activity || activity.status !== 'active' || !activity.activations) return null
    const tensors = weights?.mlp?.tensors
    if (!tensors || edges.length === 0) return null
    const actOf = (col: number): readonly number[] | null =>
      col === 0 ? (activity.inputVector ?? null) : activity.activations?.[col] ?? null
    const wByCol = new Map<number, { data: number[]; rows: number; cols: number } | null>()
    for (let c = 0; c < columns.length - 1; c++) {
      const t = tensors.find(x => x.kind === 'W' && x.layer === c + 1)
      wByCol.set(c, t
        ? { data: t.envelope.data, rows: t.envelope.shape[0] ?? 0, cols: t.envelope.shape[1] ?? 0 }
        : null)
    }
    const raw = new Array<number>(edges.length).fill(0)
    const maxByPair = new Map<number, number>()
    let anySignal = false
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const fromActs = actOf(e.fromCol)
      const w = wByCol.get(e.fromCol) ?? null
      const fromReal = realByPos.get(`${e.fromCol}:${e.fromRow}`)
      const toReal = realByPos.get(`${e.toCol}:${e.toRow}`)
      if (!fromActs || !w || fromReal === undefined || toReal === undefined) continue
      if (fromReal >= fromActs.length || fromReal >= w.cols || toReal >= w.rows) continue
      const v = Math.abs(fromActs[fromReal] * (w.data[toReal * w.cols + fromReal] ?? 0))
      raw[i] = v
      if (v > 0) anySignal = true
      const mx = maxByPair.get(e.fromCol) ?? 0
      if (v > mx) maxByPair.set(e.fromCol, v)
    }
    if (!anySignal) return null // toàn 0 → không giả tín hiệu, giữ opacity mặc định
    const m = new Map<number, number>()
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const mx = maxByPair.get(e.fromCol) ?? 0
      const norm = mx > 0 ? Math.min(1, raw[i] / mx) : 0
      m.set(e.id, 0.22 + 0.68 * norm)
    }
    return m
  }, [activity, weights, edges, columns, realByPos])

  // ── Inspector: tra bias/|w| từ tensor thật ──
  const inspect = useMemo(() => {
    if (!inspector || !weights?.mlp?.tensors) return null
    const tensors = weights.mlp.tensors
    const W = (layer: number): { data: number[]; rows: number; cols: number } | null => {
      const t = tensors.find(x => x.kind === 'W' && x.layer === layer)
      if (!t) return null
      const rows = t.envelope.shape[0] ?? 0
      const cols = t.envelope.shape[1] ?? 0
      return { data: t.envelope.data, rows, cols }
    }
    const B = (layer: number): number[] | null => {
      const t = tensors.find(x => x.kind === 'b' && x.layer === layer)
      return t ? t.envelope.data : null
    }
    const neuronReal = (col: number, row: number): number | null => {
      const n = layout.neurons.find(x => x.col === col && x.row === row)
      return n?.realIndex ?? null
    }
    if (inspector.kind === 'neuron') {
      const col = inspector.col
      const real = neuronReal(col, inspector.row)
      const units = columns[col]?.units ?? 0
      if (real === null) return { kind: 'neuron' as const, col, row: inspector.row, real, note: units > STAGE_LIMITS.maxDisplayNeurons ? 'nơ-ron đại diện (đã nén ×N)' : null }
      // Convention serialize mlp.ts (tensor layer 1..L−1): W(l) nối cột l−1 →
      // cột l, với W(l)[j][i] = trọng số từ unit i (cột l−1) sang unit j (cột l);
      // b(l) = bias CỘT l. Nơ-ron (col, real) thuộc cột col nên đọc:
      //  - bias       = b(col) — chỉ cột ≥ 1 có bias (cột input 0 không có)
      //  - |w| vào TB = mean |W(col)[real][i]| theo i (hàng real của W(col)) — col ≥ 1
      //  - |w| ra TB  = mean |W(col+1)[j][real]| theo j (cột real của W(col+1)) — không phải cột cuối
      // (FB-BRAIN-UX-R1-01: trước đây đọc B(col+1)/W(col+1)/W(col+2) — lệch hẳn
      // sang nơ-ron cột kế cùng unit index, sai cột một bậc.)
      const biasArr = col >= 1 ? B(col) : null
      const bias = biasArr && real < biasArr.length ? biasArr[real] : null
      const wIn = col >= 1 ? W(col) : null
      let absWIn: number | null = null
      if (wIn && wIn.cols > 0 && real < wIn.rows) {
        let s = 0
        for (let i = 0; i < wIn.cols; i++) s += Math.abs(wIn.data[real * wIn.cols + i] ?? 0)
        absWIn = s / wIn.cols
      }
      const isLastCol = col >= columns.length - 1
      const wOut = !isLastCol ? W(col + 1) : null
      let absWOut: number | null = null
      if (wOut && wOut.cols > 0 && real < wOut.cols) {
        let s = 0
        for (let j = 0; j < wOut.rows; j++) s += Math.abs(wOut.data[j * wOut.cols + real] ?? 0)
        absWOut = s / wOut.rows
      }
      return { kind: 'neuron' as const, col, row: inspector.row, real, bias, absWIn, absWOut, note: units > STAGE_LIMITS.maxDisplayNeurons ? 'nơ-ron đại diện (đã nén ×N)' : null }
    }
    // edge — ĐÚNG convention: W(fromCol+1)[toReal][fromReal] = từ unit
    // fromReal (cột fromCol) sang unit toReal (cột fromCol+1) — giữ nguyên.
    const fromReal = neuronReal(inspector.col, inspector.row)
    const toReal = neuronReal(inspector.col + 1, inspector.toRow ?? 0)
    const w = W(inspector.col + 1)
    let weight: number | null = null
    if (w && fromReal !== null && toReal !== null && fromReal < w.cols && toReal < w.rows) {
      weight = w.data[toReal * w.cols + fromReal] ?? null
    }
    return { kind: 'edge' as const, col: inspector.col, fromRow: inspector.row, toRow: inspector.toRow ?? 0, fromReal, toReal, weight }
  }, [inspector, weights, layout.neurons, columns])

  // ── Base view + cửa sổ hiệu quả (BRAIN-LIVE zoom/pan) ──
  // BRAIN-TAB-3PHAN: w ĐỘNG theo layout.width (clamp(n×130, 340, 900)) —
  // zoomAt clamp theo base.w nên mọi chỗ dùng base tự thích ứng.
  const baseView = useMemo<StageView>(() => ({
    x: 0,
    y: 0,
    w: layout.width,
    h: Math.max(layout.height, 96) + VIEW_PAD,
  }), [layout.width, layout.height])
  const effView = view ?? baseView
  const zoomed = view !== null
  const zoomPct = Math.round((baseView.w / effView.w) * 100)

  // ── Kích thước SVG fit container giữ aspect (BRAIN-TAB-3PHAN): scale =
  //    min(boxW/viewW, boxH/viewH) → SVG luôn nằm GỌN trong stageBox (flex
  //    center căn giữa — letterbox quanh SVG, KHÔNG preserveAspectRatio).
  //    Đơn vị px — element rect ≡ viewBox rect nên mọi phép ratio zoom/pan
  //    (onWheel rX/rY, pan scale=startView.w/rect.width) vẫn ĐÚNG. boxSize
  //    null (chưa đo / !tall) → null → className cũ h-auto w-full. ──
  const fitSize = useMemo(() => {
    if (!tall || !boxSize || boxSize.w <= 0 || boxSize.h <= 0) return null
    const scale = Math.min(boxSize.w / effView.w, boxSize.h / effView.h)
    return { w: effView.w * scale, h: effView.h * scale }
  }, [tall, boxSize, effView])

  // Cấu trúc layout đổi (đổi brain/head/draft/train/units) → về vừa khung.
  // (queueMicrotask defer — không setState đồng bộ trong body effect.)
  const baseKey = `${columns.map(c => c.units).join('-')}@${baseView.h}`
  useEffect(() => { queueMicrotask(() => { setView(null) }) }, [baseKey])

  const zoomBy = (factor: number) => {
    setView(v => zoomAt(v ?? baseView, factor, baseView, 0.5, 0.5))
  }
  const fit = useCallback(() => { setView(null) }, [])

  // ── Wheel zoom về TÂM CON TRỎ (BRAIN-LIVE): vùng quan sát chuyên dụng —
  // wheel thường lẫn ctrl+wheel ĐỀU zoom (preventDefault, passive:false).
  // Toạ độ world tại điểm chuột: world = view.xy + ratio × view.wh — giữ
  // điểm đó cố định khi đổi w/h (công thức chuẩn, ratio theo rect SVG). ──
  useEffect(() => {
    const el = stageBoxRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const rX = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      const rY = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))
      const factor = ev.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
      setView(v => zoomAt(v ?? baseView, factor, baseView, rX, rY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [baseView])

  // ── ResizeObserver đo stageBox (BRAIN-TAB-3PHAN): chỉ chạy khi tall —
  //    stageBox cao xác định (h-[440px] md:520 xl:600) nên cần setSize SVG
  //    thủ công giữ aspect cho đủ cao/đủ rộng trong full-width. contentRect
  //    = client size (stageBox không padding/border-content sai lệch 0).
  //    Cleanup disconnect khi unmount/đổi tall. ──
  useEffect(() => {
    if (!tall) return
    const el = stageBoxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const en = entries[entries.length - 1]
      if (en) setBoxSize({ w: en.contentRect.width, h: en.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [tall])

  // ── Drag pan (BRAIN-LIVE): chuột chính (button 0), CHỈ khi đang zoom;
  // delta tỉ lệ view.w/clientWidth (dọc theo view.h/svgHeight). Kéo >3px =
  // "đã pan" → nuốt click ngay sau (setTimeout 0 dọn cờ — pattern P3-B1
  // neural-architecture-section). Touch giữ cuộn native — mobile zoom qua
  // nút overlay + đúp chạm; unmount giữa lúc kéo → dọn listener sống. ──
  const onStagePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return
    if (view === null) return // đang fit — không pan (cursor pointer cho hit-test)
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const startView = view
    const startX = ev.clientX
    const startY = ev.clientY
    // FB-BRAIN-LIVE-R1-05: MỘT hệ số tỉ lệ cho cả 2 trục — svg `h-auto w-full`
    // giữ đúng aspect viewBox (rect.height/rect.width ≡ view.h/view.w) nên
    // scale dọc ≡ scale ngang; trước-fix có biến scaleV tính rồi không dùng.
    const scale = startView.w / rect.width
    let moved = false
    const onMove = (mv: PointerEvent) => {
      if (mv.buttons === 0) { onUp(); return }
      const dx = mv.clientX - startX
      const dy = mv.clientY - startY
      if (!moved && Math.hypot(dx, dy) > 3) { moved = true; setPanning(true) }
      if (!moved) return
      // FB-BRAIN-LIVE-R1-02 — clamp pan quanh vùng base: cửa sổ nhìn
      // [x, x+w]×[y, y+h] phải giao vùng base [bx, bx+bw]×[by, by+bh]
      // CHIỀU DÀI ≥ 10% kích thước cửa sổ — kéo quá xa dừng ở clamp, đồ
      // thị không bao giờ mất hẳn khỏi màn (trước-fix kéo thoải mái mất
      // trắng, chỉ ⤢ Vừa/đúp chấm hồi phục). Công thức đối xứng 2 biên:
      //   x ∈ [bx − 0.9·w, bx + bw − 0.1·w]   (y tương tự với by/bh)
      //   · biên TRÁI  x = bx − 0.9·w    → mép phải cửa sổ = bx + 0.1·w
      //     (10% CUỐI cửa sổ nằm trong base)
      //   · biên PHẢI x = bx + bw − 0.1·w → mép trái cửa sổ = bx + bw − 0.1·w
      //     (10% ĐẦU cửa sổ nằm trong base)
      // → mọi vị trí giữa 2 biên đều giao base ≥ 0.1·w (liên tục, đảo dấu
      // tại tâm base). w/h cố định trong 1 lần kéo (startView) nên chỉ cần
      // kẹp x/y sau khi trừ delta.
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
      setView({
        x: clamp(
          startView.x - dx * scale,
          baseView.x - 0.9 * startView.w,
          baseView.x + baseView.w - 0.1 * startView.w,
        ),
        y: clamp(
          startView.y - dy * scale,
          baseView.y - 0.9 * startView.h,
          baseView.y + baseView.h - 0.1 * startView.h,
        ),
        w: startView.w,
        h: startView.h,
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      panTeardownRef.current = null
      setPanning(false)
      if (moved) {
        justPannedRef.current = true
        setTimeout(() => { justPannedRef.current = false }, 0)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    panTeardownRef.current = onUp
  }
  useEffect(() => () => { panTeardownRef.current?.() }, [])

  // ── Bấm SVG → hit-test cạnh / nơ-ron (getScreenCTM phản ánh viewBox
  //    hiện tại — vẫn đúng khi zoom/pan); nơ-ron TRƯỚC cạnh. ──
  const onSvgClick = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    if (justPannedRef.current) return // vừa pan xong — nuốt click (P3-B1)
    const svg = ev.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = ev.clientX
    pt.y = ev.clientY
    const loc = pt.matrixTransform(svg.getScreenCTM()?.inverse() ?? svg.getCTM()?.inverse())
    if (!loc) return
    // nơ-ron trước — ngưỡng thích ứng THEO CỘT (BRAIN-TAB-3PHAN): cột dày
    // đặc chấm 0.72 → ngưỡng sàn 4 (max(4, r_c+3)); cột thưa 6.12 → 9.12
    // ≈ diện mạo cũ (9) — không bấm nhầm khi zoom chi tiết cột dày.
    const neuron = layout.neurons.find(n => {
      const rC = layout.radius[n.col] ?? STAGE_LIMITS.neuronRMax
      return Math.hypot(n.x - loc.x, n.y - loc.y) <= Math.max(4, rC + 3)
    })
    if (neuron) {
      setInspector({ kind: 'neuron', col: neuron.col, row: neuron.row })
      return
    }
    const edge = hitEdge(loc.x, loc.y, edges)
    if (edge) {
      setInspector({ kind: 'edge', col: edge.fromCol, row: edge.fromRow, toRow: edge.toRow })
      return
    }
    setInspector(null)
  }, [edges, layout.neurons, layout.radius])

  const lifecycleCls = brain.lifecycle === 'active' ? 'bs-glow-active' : 'bs-glow-dormant'
  const accent = brain.lifecycle === 'active' ? 'rgba(251,191,36,0.85)' : 'rgba(251,191,36,0.38)'
  const ariaLayers = columns.map(c => `${c.label} ${c.activation}`).join(' → ')
  const chipTitle = activity
    ? `${activity.sourceLabel ?? 'không rõ nguồn dữ liệu'} · cập nhật ${new Date(activity.fetchedAt).toLocaleTimeString('vi-VN')}`
    : ''

  return (
    <div
      ref={wrapRef}
      className={`relative ${tall ? 'flex flex-col' : ''}`}
      role="group"
      aria-label={`Sân khấu não ${brain.title}`}
    >
      {/* Thanh công cụ sân khấu */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {brain.key === 'surrogate' && weights && (
          <div className="flex overflow-hidden rounded-md border border-stone-700/70" role="tablist" aria-label="Chọn đầu ra surrogate">
            {(['success', 'tokens', 'durationMs'] as const).map(h => (
              <button
                key={h}
                role="tab"
                aria-selected={head === h}
                onClick={() => {
                  // FB-BRAIN-LIVE-R1-01: báo head mới cho caller (brain-tab đổi
                  // head poll activity) — cùng chỗ setHead cũ, event handler.
                  setHead(h)
                  setInspector(null)
                  onHeadChange?.(h)
                }}
                className={`min-h-[44px] md:min-h-[28px] px-2 text-[10px] ${head === h ? 'bg-amber-500/20 text-amber-300' : 'text-stone-400 hover:text-stone-200'}`}
              >
                {h === 'success' ? 'success' : h === 'tokens' ? 'tokens' : 'duration'}
              </button>
            ))}
          </div>
        )}
        {fxOn && (
          <button
            onClick={() => setBackMode(b => !b)}
            disabled={!hasBackData}
            title={hasBackData
              ? backMode ? 'Đang xem lan truyền NGƯỢC (tông vàng, độ dày theo |gradient| thật từ train) — bấm về TIẾN' : 'Xem lan truyền NGƯỢC (tông vàng) — đảo chiều + độ dày theo |gradient| trung bình từng lớp (dữ liệu thật từ train)'
              : 'Chưa có dữ liệu |gradient| (train lần đầu để bật — không trang trí suông)'}
            className={`min-h-[44px] md:min-h-[28px] rounded-md border px-2 text-[10px] ${backMode && hasBackData ? 'border-yellow-400/60 bg-yellow-400/15 text-yellow-300' : 'border-stone-700/70 text-stone-400 hover:text-stone-200'} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {backMode && hasBackData ? '↺ Ngược (|grad| thật)' : '→ Tiến'}
          </button>
        )}
        {activity && (
          <span
            title={chipTitle}
            className={`rounded-md border px-1.5 py-0.5 text-[9.5px] ${activity.agentRunInProgress
              ? 'animate-pulse border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-stone-700/70 text-stone-400'}`}
          >
            {activity.agentRunInProgress
              ? '● Agent đang chạy'
              : `Agent nghỉ${activity.sourceLabel ? ` · ${activity.sourceLabel}` : ''}`}
          </span>
        )}
        <span className="ml-auto text-[9.5px] text-stone-500">
          {weights
            ? `bản v${weights.version}${weights.active ? ' ★active' : ''} · ${new Date(weights.trainedAt).toLocaleDateString('vi-VN')}`
            : weightsError ?? 'đang tải…'}
        </span>
      </div>

      <div
        ref={stageBoxRef}
        onPointerDown={onStagePointerDown}
        onDoubleClick={() => { setView(null) }}
        className={`relative overflow-hidden rounded-xl border ${fxOn ? 'border-stone-700/60' : 'border-slate-800/80'} bg-slate-950/60 ${fxOn ? lifecycleCls : ''} ${tall ? 'flex h-[440px] items-center justify-center md:h-[520px] xl:h-[600px]' : ''} ${zoomed ? (panning ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
      >
        <svg
          ref={svgRef}
          viewBox={`${effView.x} ${effView.y} ${effView.w} ${effView.h}`}
          className={`${fitSize ? 'block max-w-full' : 'h-auto w-full'} ${fxOn && !zoomed ? 'cursor-pointer' : ''}`}
          style={fitSize ? { width: fitSize.w, height: fitSize.h } : undefined}
          role="img"
          aria-label={`Kiến trúc ${brain.title}: ${ariaLayers} — loss ${brain.planned.loss}`}
          onClick={fxOn ? onSvgClick : undefined}
        >
          <defs>
            {/* BRAIN-LIVE: TIẾN = XANH emerald, NGƯỢC = VÀNG yellow (chỉ thị
                user 2026-10-12); fxOn=false giữ Stops xám trung tính như UX-3 */}
            <linearGradient id="bs-fwd" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={fxOn ? 'rgba(16,185,129,0.10)' : 'rgba(168,162,158,0.22)'} />
              <stop offset="1" stopColor={fxOn ? 'rgba(16,185,129,0.85)' : 'rgba(168,162,158,0.34)'} />
            </linearGradient>
            <linearGradient id="bs-bwd" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0" stopColor="rgba(250,204,21,0.10)" />
              <stop offset="1" stopColor="rgba(250,204,21,0.80)" />
            </linearGradient>
            <marker id="bs-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path
                d="M0,1 L7,4 L0,7 z"
                fill={fxOn
                  ? backMode && hasBackData ? 'rgba(250,204,21,0.85)' : 'rgba(16,185,129,0.85)'
                  : 'rgba(168,162,158,0.55)'}
              />
            </marker>
          </defs>

          {/* Cạnh: bezier gradient + nét đứt chạy (động) hoặc thẳng tĩnh có mũi tên (off).
              BRAIN-LIVE: khi có activation + weights → strokeOpacity theo
              |a_from × W[to][from]| chuẩn hóa per cặp cột (0.22–0.90, chỉ TIẾN);
              không có dữ liệu → opacity 0.9 như cũ. */}
          {edges.map(e => {
            const gradVal = backMode && hasBackData && gradByCol ? gradByCol(e.fromCol) : null
            const strokeW = backMode && hasBackData
              ? strokeWidthForGrad(gradVal, weights?.gradAbsMean ?? [])
              : 0.9
            if (!fxOn) {
              return (
                <line
                  key={e.id}
                  x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="rgba(168,162,158,0.22)" strokeWidth="0.8"
                  markerEnd="url(#bs-arrow)"
                />
              )
            }
            const path = `M ${e.x1} ${e.y1} C ${e.cx1} ${e.cy1}, ${e.cx2} ${e.cy2}, ${e.x2} ${e.y2}`
            const isSel = inspector?.kind === 'edge'
              && inspector.col === e.fromCol && inspector.row === e.fromRow && inspector.toRow === e.toRow
            const sig = !backMode ? edgeSignal?.get(e.id) : undefined
            return (
              <path
                key={e.id}
                d={path}
                fill="none"
                stroke={backMode && hasBackData ? 'url(#bs-bwd)' : 'url(#bs-fwd)'}
                strokeWidth={isSel ? Math.max(strokeW * 1.9, 2.2) : strokeW}
                strokeDasharray={animated && inView ? '5 4.5' : undefined}
                markerEnd={backMode && hasBackData ? 'url(#bs-arrow)' : animated && inView ? undefined : 'url(#bs-arrow)'}
                className={animated && inView ? (backMode && hasBackData ? 'bs-flow bs-flow-bwd' : 'bs-flow') : undefined}
                style={animated && inView ? { animationDelay: `${edgePhaseSec(e.id)}s` } : undefined}
                opacity={isSel ? 1 : sig === undefined ? 0.9 : 1}
                strokeOpacity={!isSel ? sig : undefined}
              />
            )
          })}

          {/* Nơ-ron — BRAIN-LIVE: có dữ liệu activity → fill emerald theo
              cường độ |a|/max (transition-[fill] đổi mượt giữa các lần poll);
              không có dữ liệu → nền tối như cũ. Stroke accent lifecycle amber giữ. */}
          {layout.neurons.map(n => {
            const isSel = inspector?.kind === 'neuron' && inspector.col === n.col && inspector.row === n.row
            const inten = fxOn ? neuronIntensity?.get(`${n.col}:${n.row}`) : undefined
            // BRAIN-TAB-3PHAN: r theo TỪNG CỘT (layout.radius — cột dày đặc
            // chấm nhỏ lại); selected phóng nhẹ nhưng không vượt neuronRMax
            const rC = layout.radius[n.col] ?? STAGE_LIMITS.neuronRMax
            return (
              <circle
                key={`n-${n.col}-${n.row}`}
                cx={n.x} cy={n.y} r={isSel ? Math.min(STAGE_LIMITS.neuronRMax, rC * 1.6 + 1.2) : rC}
                fill={inten !== undefined
                  ? `rgba(16,185,129,${(0.12 + 0.75 * inten).toFixed(3)})`
                  : 'rgba(2,6,23,0.95)'}
                stroke={isSel ? 'rgba(251,191,36,0.95)' : accent}
                strokeWidth={isSel ? 1.8 : 1.1}
                className="transition-[fill] duration-500"
              />
            )
          })}

          {/* Nhãn cột: bấm được khi editor bật (cột ẩn) */}
          {columns.map((c, ci) => {
            const x = layout.colX[ci] ?? 0
            const yBase = Math.max(layout.height - 18, 72)
            const isHiddenEditable = editorOn && !c.locked
            return (
              <g key={`l-${ci}`}>
                {isHiddenEditable ? (
                  <text
                    x={x} y={yBase - 10} textAnchor="middle"
                    fontSize={8} className="cursor-pointer fill-amber-400 underline decoration-dotted"
                    style={{ fontFamily: 'inherit' }}
                    role="button"
                    onClick={ev => { ev.stopPropagation(); onEditLayer?.(ci - 1) }}
                  >
                    {c.label} ✎
                  </text>
                ) : (
                  <text x={x} y={yBase - 10} textAnchor="middle" fontSize={8} className="fill-stone-300" style={{ fontFamily: 'inherit' }}>
                    {c.label}
                  </text>
                )}
                <text x={x} y={yBase} textAnchor="middle" fontSize={7} className="fill-stone-500" style={{ fontFamily: 'inherit' }}>
                  {c.activation}
                </text>
                {c.locked && (
                  <title>{`Lớp ${ci === 0 ? 'đầu vào' : 'đầu ra'} KHÓA theo hợp đồng pipeline (§9.1-2)`}</title>
                )}
              </g>
            )
          })}
        </svg>

        {/* Nút zoom/pan overlay (BRAIN-LIVE) — touch target 44px mobile */}
        <div
          className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-stone-700/70 bg-slate-950/80 p-0.5"
          role="group"
          aria-label="Thu phóng sân khấu não"
          onPointerDown={ev => ev.stopPropagation()}
          onDoubleClick={ev => ev.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { zoomBy(1 / ZOOM_STEP) }}
            aria-label="Thu nhỏ sân khấu"
            title="Thu nhỏ (bước 1.25×, tối thiểu 0.5×)"
            className="min-h-[44px] md:min-h-[28px] min-w-7 px-1 text-[12px] leading-none text-stone-300 hover:text-amber-300"
          >
            −
          </button>
          <span className="min-w-[3.4em] text-center text-[9.5px] tabular-nums text-stone-400" title="Mức thu phóng hiện tại (đúp chuột để vừa khung)">
            {zoomPct}%
          </span>
          <button
            type="button"
            onClick={() => { zoomBy(ZOOM_STEP) }}
            aria-label="Phóng to sân khấu"
            title="Phóng to (bước 1.25×, tối đa 12×)"
            className="min-h-[44px] md:min-h-[28px] min-w-7 px-1 text-[12px] leading-none text-stone-300 hover:text-amber-300"
          >
            +
          </button>
          <button
            type="button"
            onClick={fit}
            title="Vừa khung (hoặc đúp chuột vào sân khấu)"
            className="min-h-[44px] md:min-h-[28px] px-1.5 text-[9.5px] text-stone-300 hover:text-amber-300"
          >
            ⤢ Vừa
          </button>
        </div>
      </div>

      {/* Inspector nơ-ron/cạnh */}
      {fxOn && inspector && inspect && (
        <div className="mt-1.5 rounded-lg border border-stone-700/60 bg-slate-950/80 p-2 text-[10.5px] text-stone-300" role="status">
          {inspect.kind === 'neuron' ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-semibold text-amber-400">
                Nơ-ron cột {inspect.col + 1} · hàng {inspect.row + 1}{inspect.real !== null ? ` (unit #${inspect.real + 1})` : ''}
              </span>
              <span>activation: <span className="font-mono">{columns[inspect.col]?.activation || '—'}</span></span>
              {weights ? (
                <>
                  <span>bias: <span className="font-mono">{inspect.bias !== null && inspect.bias !== undefined ? inspect.bias.toFixed(4) : '—'}</span></span>
                  <span>|w| vào TB: <span className="font-mono">{inspect.absWIn !== null && inspect.absWIn !== undefined ? inspect.absWIn.toFixed(4) : '—'}</span></span>
                  <span>|w| ra TB: <span className="font-mono">{inspect.absWOut !== null && inspect.absWOut !== undefined ? inspect.absWOut.toFixed(4) : '—'}</span></span>
                </>
              ) : (
                <span className="italic text-stone-500">chưa train — không có bias/|w| (không trang trí suông)</span>
              )}
              {inspect.note && <span className="italic text-stone-500">({inspect.note})</span>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-semibold text-amber-400">
                Cạnh {inspect.col + 1}→{inspect.col + 2} · hàng {inspect.fromRow + 1}→{(inspect.toRow ?? 0) + 1}
              </span>
              {weights ? (
                <span>|w|: <span className="font-mono">{inspect.weight !== null && inspect.weight !== undefined ? Math.abs(inspect.weight).toFixed(4) : '—'}</span></span>
              ) : (
                <span className="italic text-stone-500">chưa train — không có trọng số</span>
              )}
              {editorOn && !columns[inspect.col]?.locked && (
                <button
                  className="min-h-[44px] md:min-h-[28px] rounded border border-stone-700 px-1.5 text-[9.5px] text-stone-300 hover:text-amber-300"
                  onClick={() => onEditLayer?.(inspect.col - 1)}
                >
                  Sửa 2 lớp hai đầu
                </button>
              )}
            </div>
          )}
          <button
            className="ml-2 min-h-[44px] md:min-h-[28px] text-[9.5px] text-stone-500 hover:text-stone-300"
            onClick={() => setInspector(null)}
            aria-label="Đóng inspector"
          >
            ✕ đóng
          </button>
        </div>
      )}
      {!fxOn && (
        <p className="mt-1 text-[9px] text-stone-600">
          Hiệu ứng synapse đang TẮT (cờ UI_SYNAPSE_FX — bảng tinh chỉnh): đường thẳng tĩnh như trước. Bật để thấy hướng lan truyền + điểm sáng activation thật + bấm sửa nơ-ron/cạnh.
        </p>
      )}
      {fxOn && !hasBackData && (
        <p className="mt-0.5 text-[9px] text-stone-600">
          Chế độ lan truyền ngược cần |gradient| thật từ lần train đầu (không trang trí suông — §9.4).
        </p>
      )}
      {fxOn && activity?.status === 'dormant' && activity.inputVector && (
        <p className="mt-0.5 text-[9px] text-stone-600">
          não đang ngủ — hiển thị đặc trưng đầu vào THẬT (one-hot) từ {activity.sourceLabel ?? 'nguồn chưa ghi nhận'}
        </p>
      )}
      {edgesAll.length > STAGE_LIMITS.maxEdges && (
        <p className="mt-0.5 text-[9px] text-stone-600">
          hiển thị {edges.length}/{edgesAll.length} cạnh (sampling tất định)
        </p>
      )}
    </div>
  )
}
