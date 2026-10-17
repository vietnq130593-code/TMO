'use client'

/**
 * ĐÀI QUAN SÁT NÃO v3 (Task 26 — chỉ thị user 2026-10-13) — SÂN KHẤU NÃO
 * ============================================================================
 *
 * Task 26 (chỉ thị user, nguyên văn những điểm chốt): "Nơ-ron: QUẢ CẦU MÀU
 * TÍM TỎA SÁNG. Đường lan truyền TIẾN màu xanh — GIỮ NGUYÊN như hiện tại
 * (emerald). THÊM đường lan truyền NGƯỢC màu VÀNG. Khi agent hoạt động thật
 * + não hoạt động thật: tín hiệu đi từ nơ-ron này tới nơ-ron kia phải HIỂN
 * THỊ THẬT — hạt XANH đi trái→phải (tiến), hạt VÀNG đi phải→trái (ngược);
 * tín hiệu đi từ nơ-ron nào tới nơ-ron nào thì hiển thị đúng nơ-ron đó,
 * chạy trên đường đó — TUYỆT ĐỐI KHÔNG tượng trưng" + "Đường kết nối dạng
 * THẲNG (hiện hơi cong — bỏ cong)" + "Hiệu năng realtime toàn diện: kể cả
 * tốc độ thu phóng nhỏ, bấm giữ di chuyển (drag), tốc độ load dữ liệu chung".
 *
 *  - CẠNH THẲNG (B1): bỏ bezierControls — cạnh = đoạn thẳng giữa 2 nơ-ron
 *    (lùi đầu/cuối theo bán kính R1/R2 như trước). Hit-test point-to-segment
 *    CHÍNH XÁC (stage-geometry.ts Task 26).
 *  - NƠ-RON TÍM TỎA SÁNG (B2): HALO radial-gradient #c084fc (r ≈ rC×2.2,
 *    opacity 0.10 + 0.45×inten) + CORE fill rgba(168,85,247, 0.18 + 0.75×inten),
 *    stroke violet nhạt (selected giữ amber phóng to). inten = |a|/max từng
 *    cột — GIỮ NGUYÊN phép tính (BRAIN-LIVE). Không dữ liệu (não dormant) →
 *    tím NHẠT cố định (core 0.14 + halo 0.05) — tím là phong cách quả cầu,
 *    độ sáng mới là tín hiệu thật (coordinator 26: không phát sáng giả).
 *  - ĐƯỜNG TIẾN (B2): GIỮ NGUYÊN gradient emerald bs-fwd + strokeOpacity theo
 *    edgeSignal |a×w| chuẩn hóa per cặp cột (0.22–0.90) như BRAIN-LIVE.
 *  - ĐƯỜNG NGƯỢC VÀNG PER-EDGE THẬT (B3): khi có backprop.deltas (gradient
 *    THẬT 1 mẫu thật qua bản active — hợp đồng 26-BE) mỗi cạnh vẽ THÊM 1 đường
 *    thẳng song song lệch vuông góc 3 đơn vị (tiến −3, ngược +3 — 2 đường
 *    phân biệt rõ), stroke gradient bs-bwd VÀNG, độ dày + opacity theo
 *    |δ_j × a_i| per-edge chuẩn hóa per cặp lớp. KHÔNG có gradient thật →
 *    KHÔNG có đường vàng (nguyên tắc THẬT — không trang trí suông). Bỏ toggle
 *    backMode theo lớp cũ — hiển thị tự động theo dữ liệu thật.
 *  - HẠT TÍN HIỆU THẬT — CANVAS 60FPS (B4): <canvas> overlay absolute inset-0
 *    (pointer-events-none, DPR-scaled) nằm TRÊN SVG; vòng rAF đọc REF (không
 *    setState trong loop). Hạt XANH (tiến, trái→phải) spawn trên cạnh có tín
 *    hiệu thật s = |a_i × w_ji| ≥ 0.5% max cặp lớp VÀ |a_i| > 1e-9; hạt VÀNG
 *    (ngược, phải→trái) theo |δ_j × a_i| — CHỈ khi backprop ≠ null; xác suất
 *    spawn mỗi frame ∝ s/max (chuẩn hóa từng cặp lớp); speed ~300px/s ±20%;
 *    bán kính 1.6–2.6px ∝ s; sprite radial pre-render + globalCompositeOperation
 *    'lighter' (KHÔNG shadowBlur mỗi hạt). CAP toàn cục 500 hạt. Tắt khi
 *    !inView || document.hidden || prefers-reduced-motion (SVG tĩnh vẫn đẹp).
 *    Khi training?.status === 'running' (đúng não đang xem): mật độ ×2.
 *  - REALTIME (B5): wheel gom deltaY → áp 1 lần/frame qua rAF (zoomAt + anchor
 *    con trỏ giữ nguyên); pointermove pan gom → 1 lần/frame (justPannedRef giữ);
 *    layer cạnh/nơ-ron/nhãn useMemo theo layout — pan/zoom chỉ đổi viewBox, KHÔNG
 *    tính lại chuỗi toạ độ; weights fetch cache theo brain+head trong ref +
 *    AbortController khi unmount/đổi não.

 * BRAIN-LIVE v2 (2026-10-12) giữ: HIỂN THỰC TỪNG NƠ-RON (display = min(units,
 * 256), cột input planned-fallback dùng đúng length inputVector); zoom/pan
 * state view {x,y,w,h} (null = fit) + nút overlay −/%/+ /⤢ + wheel về TÂM CON
 * TRỎ + kéo pan clamp quanh vùng base (FB-BRAIN-LIVE-R1-02) + đúp chuột vừa
 * khung; hit-test getScreenCTM; chip Agent đang chạy/nghỉ.
 *
 * BRAIN-TAB-3PHAN v3 giữ: geometry v3 (center-align + rowStep/radius thích ứng
 * từng cột + width động); container tall full-width fit-height (ResizeObserver
 * đo stageBox → setSize SVG thủ công giữ aspect — element rect ≡ viewBox rect).
 *
 * Giữ nguyên từ UX-3/§9.4: bấm nhãn cột → editor (UX-1); nơ-ron → inspector
 * bias/|w| vào-ra · cạnh → |w| đúng cặp (từ trọng số THẬT /api/brain/weights —
 * refreshNonce đổi → refetch); LOD ≤ 300 cạnh + IntersectionObserver dừng
 * animation ngoài viewport; prefers-reduced-motion → bản tĩnh; touch target
 * ≥ 44px; surrogate head tabs. Toán hình học thuần ở stage-geometry.ts (test
 * r90). Thu thập dữ liệu READ-ONLY — KHÔNG đụng pipeline/runtime.
 *
 * R24-b (BLUEPRINT-EVO-NAO §8.5 mốc a — ghost UI Brain-D "Tri Thức"): não
 * thứ 4 hiển thị topology DỰ KIẾN từ registry NGAY từ D1 (chưa có model):
 *  - 3 CỤM ĐẦU RA ĐỒNG THỜI (KHÔNG tab như SurrogateHead của Brain-B — vì
 *    3 tầng action space là MỘT quyết định, một forward pass — §8.3/§8.5.2):
 *    mode=amber · retrieval=cyan · meta=fuchsia — vạch accent + label xoay
 *    dọc giữa khe nhóm (geometry headGroup additive, r90 giữ nguyên cho A/B/C);
 *  - tooltip hover cụm = giải thích tầng (copy §8.3) · hover nơ-ron đầu ra =
 *    tên chế độ/tham số (map TĨNH KNOWLEDGE_UNIT_NAMES — không API mới);
 *  - chip "DỰ KIẾN — CHƯA HỌC" + dòng mixture λ Brain-C precedent
 *    (λ = 1 − min(n/200, WilsonLB), bắt đầu 100% heuristic);
 *  - mobile <NEURAL_DESKTOP_BREAKPOINT: 3 cụm đầu ra XẾP DỌC (§8.5.4) —
 *    band compact KnowledgeGhostBand thay SVG 6 cột ngang (cuộn native).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrainActivity, BrainStatusEntry } from '@/lib/brain/registry'
import type { BrainDraftSpec } from '@/lib/brain/spec-schema'
import {
  buildStageLayout,
  edgePhaseSec,
  hitEdge,
  isAnimated,
  lodEdges,
  STAGE_LIMITS,
  type StageColumn,
  type StageEdge,
} from '@/lib/brain/stage-geometry'
// R24-b §8.5.4 — breakpoint responsive của đồ thị neural (single-source
// neural-layout — thuần hằng số, client-safe) dùng làm ngưỡng mobile cho
// ghost topology Brain-D: <1024px → 3 cụm đầu ra XẾP DỌC.
import { NEURAL_DESKTOP_BREAKPOINT } from '@/lib/learning/neural-layout'

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

/**
 * R24-b §8.5.4 — matchMedia hook cho ghost mobile (pattern y hệt
 * usePrefersReducedMotion): <NEURAL_DESKTOP_BREAKPOINT → 3 cụm đầu ra Brain-D
 * XẾP DỌC (stage co theo NEURAL_DESKTOP_BREAKPOINT — blueprint §8.5.4).
 * SSR/an toàn: mặc định false (desktop layout) tới khi đo được.
 */
function useMediaQueryBelow(bp: number): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [bp])
  return matches
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

/**
 * Task 26 (hợp đồng API 26-BE — GET /api/brain/activity += backprop): gradient
 * THẬT của 1 mẫu thật qua bản active. deltas[k][j] = δ nơ-ron j lớp
 * activations[k+1] (k = 0..L−2) → per-edge gradient thật = |deltas[c][j] ×
 * activations[c][i]|. null = chưa có (não dormant / thiếu nhãn). Field chưa có
 * trong response → coi như null (code phòng thủ — 26-BE triển khai song song).
 */
export interface StageBackprop {
  deltas: number[][] | null
  yTrue: number[] | null
  loss: number | null
  label: string | null
}

/**
 * Task 26 (hợp đồng API 26-BE — GET /api/brain/activity += training): lần
 * train gần nhất / đang chạy (mọi nguồn kể cả auto-retrain). null = chưa có.
 */
export interface StageTraining {
  brain: string
  head: string | null
  status: 'running' | 'done' | 'failed'
  startedAt: string
  endedAt: string | null
  epochsRun: number | null
  finalLoss: number | null
  gradAbsMean: number[] | null
}

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

/** Pan clamp quanh vùng base (FB-BRAIN-LIVE-R1-02 giữ nguyên công thức): cửa
 *  sổ nhìn phải giao vùng base ≥ 10% kích thước cửa sổ theo MỖI chiều. */
function panClamped(v: StageView, dx: number, dy: number, scale: number, base: StageView): StageView {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
  return {
    x: clamp(v.x - dx * scale, base.x - 0.9 * v.w, base.x + base.w - 0.1 * v.w),
    y: clamp(v.y - dy * scale, base.y - 0.9 * v.h, base.y + base.h - 0.1 * v.h),
    w: v.w,
    h: v.h,
  }
}

/**
 * Nhãn số nơ-ron một lớp (BRAIN-LIVE): vẽ ĐÚNG từng unit khi units ≤ 256 →
 * hiển thị số thẳng (`16`); CHỈ khi bị nén đại diện (units > 256) mới dùng ký
 * hiệu ×N (`×300`) — cùng lúc mới có note "nơ-ron đại diện" trong inspector.
 */
function unitCountLabel(units: number): string {
  return units > STAGE_LIMITS.maxDisplayNeurons ? `×${units}` : `${units}`
}

// ==================== HẠT TÍN HIỆU THẬT (Task 26 B4 — canvas 60fps) ====================

/** Hạt chạy trên 1 đoạn thẳng (đÃ lệch ±EDGE_PARALLEL_OFFSET khi có 2 đường):
 *  dir 1 = tiến (trái→phải, x1→x2); dir −1 = ngược (phải→trải, x2→x1). */
interface Particle {
  x1: number
  y1: number
  x2: number
  y2: number
  dir: 1 | -1
  /** Tiến trình 0..1 dọc đoạn (điểm bắt đầu theo dir). */
  t: number
  /** Tốc độ px màn hình/giây (spawn: 300 × (0.8..1.2) jitter). */
  speedPx: number
  /** Bán kính nhân sáng px (1.6–2.6 ∝ s). */
  radius: number
  sprite: 'fwd' | 'bwd'
}

/** CAP toàn cục — đầy thì bỏ spawn (không tích tụ). */
const MAX_PARTICLES = 500
/** Tốc độ hạt trên màn hình (px/giây) — spec Task 26 "tốc độ stage ~300px/s ±20%". */
const PARTICLE_SPEED_PX = 300
/** Xác suất spawn mỗi giây trên 1 cạnh = norm × hằng này (×2 khi đang train). */
const PARTICLE_SPAWN_PER_SEC = 3.5
/** Lệch vuông góc 2 đường tiến/ngược song song (đơn vị viewBox — B3). */
const EDGE_PARALLEL_OFFSET = 3
/** Ngưỡng 0.5% max cặp lớp — tín hiệu dưới này KHÔNG hạt (nguyên tắc THẬT). */
const SIGNAL_GATE_RATIO = 0.005
/** Nơ-ron nguồn phải thật sự phát: |a| hoặc |δ| ≤ ngưỡng này = không tín hiệu. */
const SOURCE_EPS = 1e-9

/**
 * Sprite radial pre-render (64×64 offscreen): 1 lần tạo, vẽ hàng nghìn lần
 * drawImage — KHÔNG shadowBlur mỗi hạt (hiệu năng B4). lõi sáng → màu → trong
 * suốt rìa; composite 'lighter' khi vẽ cho hiệu ứng phát sáng cộng gộp.
 */
function makeGlowSprite(stops: [number, string][]): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const size = 64
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return c
}

/** entry tín hiệu per-edge cho render + hạt: norm ∈ [0,1] per cặp lớp. */
interface EdgeSignalEntry {
  /** strokeOpacity tiến (0.22 + 0.68×norm — GIỮ NGUYÊN thang BRAIN-LIVE). */
  opacity: number
  norm: number
  /** Đủ điều kiện spawn hạt (≥0.5% max cặp lớp VÀ nơ-ron nguồn thật sự phát). */
  gate: boolean
}

// ==================== R24-b — BRAIN-D "TRI THỨC" GHOST (§8.5 mốc a) ====================

/**
 * Màu accent 3 cụm đầu ra (§8.5.2 pin trong blueprint): mode=amber ·
 * retrieval=cyan · meta=fuchsia — dùng cho vạch accent + label nhóm (desktop)
 * và viền panel + chấm cụm (mobile xếp dọc).
 */
const HEAD_GROUP_ACCENT: Readonly<Record<'mode' | 'retrieval' | 'meta', string>> = {
  mode: '#fbbf24', // amber-400
  retrieval: '#22d3ee', // cyan-400
  meta: '#e879f9', // fuchsia-400
}

/**
 * Tooltip hover CỤM (copy §8.3 — nguồn BLUEPRINT-EVO-NAO, map TĨNH không API).
 */
const HEAD_GROUP_TOOLTIP: Readonly<Record<'mode' | 'retrieval' | 'meta', string>> = {
  mode:
    'Tầng 1 · Chế độ vận dụng (amber) — CÁCH KB được DÙNG để làm tác vụ (§8.3, trái tim Q7=(b)): context-block (đóng gói tri thức truy xuất thành khối context nạp thẳng — mặc định, như hôm nay) · structured-subgraph (xuất subgraph Neo4j có cấu trúc: nodes+edges+labels JSON để agent lập luận trên đồ thị) · traversal-plan (sinh kế hoạch duyệt multi-hop — bắt đầu từ node nào, mở quan hệ gì, dừng khi nào — agent TỰ đi từng bước bằng tool).',
  retrieval:
    'Tầng 2 · Tham số truy xuất (cyan) — §8.3: nguồn bật/tắt (neo4j · qdrant chunks · communities · memories) · topK · trọng số hybrid BM25+RRF · MMR λ · cross-encoder rerank on/off · độ sâu traversal.',
  meta:
    'Tầng 3 · Meta (fuchsia) — §8.3: skip (bỏ hẳn KB — task không cần) · writeback (ghi episode/lesson vào KB sau run).',
}

/**
 * Tên unit đầu ra từng cụm — map TĨNH từ spec §8.3 (hover nơ-ron + legend
 * mobile; không API mới). Tầng 2 đủ 9 tham số: 4 nguồn + topK + trọng số
 * hybrid + MMR λ + rerank + độ sâu.
 */
const KNOWLEDGE_UNIT_NAMES: Readonly<Record<'mode' | 'retrieval' | 'meta', readonly string[]>> = {
  mode: ['context-block', 'structured-subgraph', 'traversal-plan'],
  retrieval: [
    'nguồn neo4j',
    'nguồn chunks',
    'nguồn communities',
    'nguồn memories',
    'topK',
    'trọng số hybrid',
    'MMR λ',
    'rerank',
    'độ sâu traversal',
  ],
  meta: ['skip', 'writeback'],
}

/**
 * Tiêu đề band mobile theo cụm (§8.5.4 xếp dọc — header panel + aria).
 */
const HEAD_GROUP_TITLE: Readonly<Record<'mode' | 'retrieval' | 'meta', string>> = {
  mode: 'Tầng 1 · Chế độ vận dụng',
  retrieval: 'Tầng 2 · Tham số truy xuất',
  meta: 'Tầng 3 · Meta',
}

/**
 * §8.5.4 — BAND MOBILE (compact, dùng trong ghost xếp dọc <1024px): 2
 * micro-cột [trunk N → cụm M] với cạnh thẳng mảnh + chấm tím viền accent.
 * groupId='trunk' = band trung tính (32→16 — không accent, không tên unit).
 * KHÔNG dùng buildStageLayout (geometry v3 dùng ngân sách contentSpan 400
 * cho đài lớn — quá cao cho band ~90px); đây là biến thể trình bày THUẦN
 * cho ghost mobile: vẽ ĐÚNG từng unit, tất định, thuần.
 */
function KnowledgeGhostBand({
  groupId,
  trunkUnits,
  clusterUnits,
  activation,
}: {
  groupId: 'mode' | 'retrieval' | 'meta' | 'trunk'
  trunkUnits: number
  clusterUnits: number
  activation: string
}) {
  const isTrunk = groupId === 'trunk'
  const accent = isTrunk ? 'rgba(167,139,250,0.9)' : HEAD_GROUP_ACCENT[groupId]
  const clusterNames = isTrunk ? null : KNOWLEDGE_UNIT_NAMES[groupId]
  const W = 320
  const topY = 10
  const trunkX = 46
  const clusterX = 274
  const trunkStep = Math.min(4.6, 72 / Math.max(trunkUnits - 1, 1))
  const clusterStep = Math.min(7.5, 72 / Math.max(clusterUnits - 1, 1))
  const trunkH = (trunkUnits - 1) * trunkStep
  const clusterH = (clusterUnits - 1) * clusterStep
  const trunkY0 = topY + (Math.max(trunkH, clusterH) - trunkH) / 2
  const clusterY0 = topY + (Math.max(trunkH, clusterH) - clusterH) / 2
  const H = topY + Math.max(trunkH, clusterH) + 16
  const trunkR = Math.max(1.1, trunkStep * 0.32)
  const clusterR = Math.max(1.6, clusterStep * 0.34)
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (let r1 = 0; r1 < trunkUnits; r1++) {
    for (let r2 = 0; r2 < clusterUnits; r2++) {
      edges.push({
        x1: trunkX + trunkR,
        y1: trunkY0 + r1 * trunkStep,
        x2: clusterX - clusterR,
        y2: clusterY0 + r2 * clusterStep,
      })
    }
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={isTrunk
        ? `Trunk chung: ${trunkUnits} tanh → ${clusterUnits} ${activation}`
        : `${HEAD_GROUP_TITLE[groupId]}: trunk ${trunkUnits} tanh → ${clusterUnits} ${activation}`}
    >
      {/* cạnh thẳng mảnh (ghost — không tín hiệu thật nên không phát sáng giả) */}
      {edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(168,162,158,0.20)" strokeWidth={0.55} />
      ))}
      {/* trunk — chấm tím (phong cách quả cầu, nhạt — chưa học) */}
      {Array.from({ length: trunkUnits }, (_, r) => (
        <circle
          key={`t-${r}`}
          cx={trunkX}
          cy={trunkY0 + r * trunkStep}
          r={trunkR}
          fill="rgba(168,85,247,0.14)"
          stroke="rgba(167,139,250,0.5)"
          strokeWidth={0.8}
        />
      ))}
      {/* cụm đầu ra — chấm tím lõi + viền accent nhóm (title = tên unit §8.3) */}
      {Array.from({ length: clusterUnits }, (_, r) => (
        <circle
          key={`c-${r}`}
          cx={clusterX}
          cy={clusterY0 + r * clusterStep}
          r={clusterR}
          fill="rgba(168,85,247,0.16)"
          stroke={accent}
          strokeWidth={1.0}
        >
          {clusterNames && (
            <title>{`Unit ${r + 1}/${clusterUnits}: ${clusterNames[r] ?? '—'}`}</title>
          )}
        </circle>
      ))}
      <text x={trunkX} y={H - 3} textAnchor="middle" fontSize={6.5} className="fill-stone-500" style={{ fontFamily: 'inherit' }}>
        {trunkUnits} tanh
      </text>
      <text x={clusterX} y={H - 3} textAnchor="middle" fontSize={6.5} style={{ fill: accent, fontFamily: 'inherit' }}>
        {clusterUnits} · {activation}
      </text>
    </svg>
  )
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
  backprop,
  training,
}: {
  brain: BrainStatusEntry
  /** Bản nháp hiện tại (preview kiến trúc khi editor bật) */
  draft: BrainDraftSpec | null
  /** Cờ ui_brain_edit — on: sân khấu preview DRAFT; off: hiển thị active/planned */
  editorOn: boolean
  /** Cờ ui_synapse_fx — on: hiệu ứng + inspector + điểm sáng activity; off: đường thẳng tĩnh trung tính */
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
   *  poll /api/brain/activity theo head đang chọn. Chỉ gọi trong event handler. */
  onHeadChange?: (head: SurrogateHead) => void
  /** Task 26 (hợp đồng 26-BE) — gradient THẬT 1 mẫu thật: null/undefined = chưa
   *  có → KHÔNG vẽ đường vàng, KHÔNG hạt vàng (nguyên tắc THẬT của user). */
  backprop?: StageBackprop | null
  /** Task 26 (hợp đồng 26-BE) — train gần nhất/đang chạy: status 'running' &&
   *  trùng não đang xem → chip ĐANG TRAIN + mật độ hạt ×2. */
  training?: StageTraining | null
}) {
  const reducedMotion = usePrefersReducedMotion()
  const animated = isAnimated(fxOn, reducedMotion)
  // FB-BRAIN-LIVE-R1-01: khởi tạo từ prop initialHead (default 'success' như cũ)
  const [head, setHead] = useState<SurrogateHead>(initialHead ?? 'success')
  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const [inView, setInView] = useState(true)
  const [weights, setWeights] = useState<WeightsResponse | null>(null)
  const [weightsError, setWeightsError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stageBoxRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // Task 26 B4 — canvas hạt tín hiệu thật (nằm TRÊN SVG, pointer-events-none)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const particlesRef = useRef<Particle[]>([])
  /// Hạt tín hiệu bật/tắt tại chỗ (NÚT BẬT TẮT HIỆU ỨNG hạt — B3/B4: ĐƯỜNG
  /// VÀNG tự theo dữ liệu thật, nút này chỉ điều khiển lớp hạt chuyển động).
  const [particlesOn, setParticlesOn] = useState(true)
  // ── Zoom/pan state (BRAIN-LIVE) ──
  const [view, setView] = useState<StageView | null>(null)
  const [panning, setPanning] = useState(false)
  const justPannedRef = useRef(false)
  const panTeardownRef = useRef<(() => void) | null>(null)
  // ── Task 26 B5: wheel/pan gom sự kiện → áp DUY NHẤT 1 lần mỗi frame rAF ──
  const pendingWheelRef = useRef(0)
  const wheelRafRef = useRef<number | null>(null)
  const panPendingRef = useRef({ dx: 0, dy: 0 })
  const panRafRef = useRef<number | null>(null)
  // ── BRAIN-TAB-3PHAN: client size của stageBox (ResizeObserver) — null
  //    trước khi đo / !tall / trình duyệt không có ResizeObserver → SVG giữ
  //    className cũ h-auto w-full (degrade đúng diện mạo BRAIN-LIVE). ──
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null)

  // ── R24-b §8.5 — Brain-D "Tri Thức" GHOST: chưa có model tới D3 → hiển thị
  //    topology DỰ KIẾN 100% từ registry (planned.layers precedent A/B/C
  //    dormant). knowledgeGhost = đang xem planned (không bản active, không
  //    preview draft); ghostStacked = mobile <1024px → 3 cụm đầu ra XẾP DỌC
  //    (§8.5.4) thay SVG 6 cột ngang. ──
  const isKnowledgeBrain = brain.key === 'knowledge'
  const knowledgeGhost = isKnowledgeBrain && !weights && !(editorOn && draft)
  const mobileViewport = useMediaQueryBelow(NEURAL_DESKTOP_BREAKPOINT)
  const ghostStacked = knowledgeGhost && mobileViewport

  // ── Kéo trọng số bản active (READ-ONLY, fail-open planned/draft) ──
  // Task 26 B5: cache theo brain+head trong ref — đổi tab/não quay lại không
  // refetch khi refreshNonce chưa đổi (sau train nonce đổi → refetch thật);
  // AbortController khi unmount/đổi não — không setState sau unmount.
  const weightsCacheRef = useRef(new Map<string, { nonce: number; data: WeightsResponse }>())
  const mountedRef = useRef(true)
  const weightsAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      weightsAbortRef.current?.abort()
    }
  }, [])
  const fetchWeights = useCallback(async () => {
    weightsAbortRef.current?.abort()
    const ac = new AbortController()
    weightsAbortRef.current = ac
    const key = `${brain.key}:${head}`
    const nonce = refreshNonce ?? 0
    const cached = weightsCacheRef.current.get(key)
    if (cached && cached.nonce === nonce) {
      setWeights(cached.data)
      setWeightsError(null)
      return
    }
    try {
      const q = brain.key === 'surrogate' ? `?brain=${brain.key}&head=${head}` : `?brain=${brain.key}`
      const res = await fetch(`/api/brain/weights${q}`, { signal: ac.signal })
      if (!mountedRef.current || ac.signal.aborted) return
      if (!res.ok) {
        setWeights(null)
        setWeightsError(res.status === 404 ? 'chưa có bản active' : `HTTP ${res.status}`)
        return
      }
      const json = (await res.json()) as WeightsResponse
      if (!mountedRef.current || ac.signal.aborted) return
      setWeights(json)
      setWeightsError(null)
      weightsCacheRef.current.set(key, { nonce, data: json })
    } catch (err) {
      if (ac.signal.aborted || !mountedRef.current) return
      setWeights(null)
      setWeightsError('lỗi mạng — hiển thị spec kế hoạch')
      void err
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
        // R24-b: knowledge draft preview — output 14 unit (3+9+2 một quyết định)
        { units: brain.key === 'policy' ? 3 : brain.key === 'knowledge' ? 14 : 1, display: 0, label: outLabel, activation: outAct, locked: true },
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
    // R24-b §8.5.2: giữ nguyên headGroup/groupLabel từ registry → geometry
    // chèn khe nhóm + trả headGroups cho layer accent (chỉ knowledge set).
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
        headGroup: l.headGroup,
        groupLabel: l.groupLabel,
      }
    })
    return { columns: cols, activeLayers: null }
  }, [brain, draft, editorOn, weights, activityInputUnits])

  // ── Layout + cạnh (LOD) — vẽ ĐÚNG từng unit: display = min(units, 256) ──
  // R7 (user report "trong ô Đài quan sát não, 2 bên lại có 2 khoảng không
  // gian tối... gây lãng phí không gian hiển thị"): trước đây viewBox giữ
  // aspect tự nhiên (clamp n×130) rồi fit vào khung RỘNG hơn → letterbox
  // trái/phải (2 dải đen — đồ thị không bao giờ dùng được). Giờ: khi khung
  // chứa rộng hơn tỉ lệ tự nhiên của đồ thị, DÃN width viewBox sao cho tỉ
  // lệ viewBox ≡ tỉ lệ khung → SVG lấp FULL khung — cột nơ-ron dàn trải
  // rộng hơn, mọi thứ to lên cùng scale, HẾT dải đen. height nội dung
  // KHÔNG phụ thuộc width (buildStageLayout chỉ dùng width cho colX) nên
  // việc dãn không đổi chiều cao. Mobile (khung hẹp hơn tỉ lệ đồ thị) giữ
  // width tự nhiên — letterbox đứng nhỏ như cũ (không thể né). Đệm 1 lần
  // build layout phụ (thuần, vài trăm nơ-ron — rẻ) lấy height trước.
  const layout = useMemo(() => {
    const cols = columns.map(c => ({
      ...c,
      display: Math.min(c.units, STAGE_LIMITS.maxDisplayNeurons),
    }))
    const natural = buildStageLayout(cols)
    if (tall && boxSize && boxSize.w > 0 && boxSize.h > 0) {
      const baseH = Math.max(natural.height, 96) + VIEW_PAD // ≡ baseView.h
      const fitW = Math.round((baseH * boxSize.w) / boxSize.h)
      // Chỉ dãn (fitW > natural.width); trần 3600 chống absurd ultrawide
      if (fitW > natural.width && fitW <= 3600) {
        return buildStageLayout(cols, fitW)
      }
    }
    return natural
  }, [columns, tall, boxSize])

  // Task 26 B1 — cạnh THẲNG: (x1,y1)→(x2,y2) giữa tâm 2 nơ-ron, lùi đầu/cuối
  // theo bán kính R1/R2 của 2 cột (giữ logic né lõi BRAIN-TAB-3PHAN).
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
          list.push({
            id: id++, fromCol: c, toCol: c + 1, fromRow: r1, toRow: r2,
            x1: a.x + R1, y1: a.y, x2: b.x - R2, y2: b.y,
          })
        }
      }
    }
    return list
  }, [columns, layout])

  const edges = useMemo(() => lodEdges(edgesAll), [edgesAll])

  // ── realIndex theo vị trí vẽ (dùng cho intensity cạnh — O(1) lookup) ──
  const realByPos = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of layout.neurons) {
      if (n.realIndex !== null) m.set(`${n.col}:${n.row}`, n.realIndex)
    }
    return m
  }, [layout.neurons])

  // ── INTENSITY NƠ-RON theo activation THẬT (BRAIN-LIVE — GIỮ NGUYÊN) ──
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

  // ── TÍN HIỆU TIẾN per-edge THẬT (BRAIN-LIVE — GIỮ NGUYÊN thang chuẩn hóa) ──
  // Cạnh (col→col+1): raw = |a_from × W(col+1)[to][from]| — a_from lấy từ
  // layer 0 = inputVector, layer ≥1 = activations; chuẩn hóa per CẶP CỘT
  // (max trong cặp, tính trên tập cạnh ĐANG VẼ sau LOD) → strokeOpacity =
  // 0.22 + 0.68×norm (min 0.22 giữ cấu trúc nhìn thấy). Đọc tensor PHẲNG
  // tìm MỘT lần per cặp cột — không build lại matrix; O(edges ≤ 300).
  // Task 26 B4: memo ĐỒNG THỜI trả norm + gate (spawn hạt: s ≥ 0.5% max cặp
  // lớp VÀ |a_from| > 1e-9 — nơ-ron nguồn phải thật sự phát).
  const fwdSignal = useMemo(() => {
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
    const srcA = new Array<number>(edges.length).fill(0)
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
      const a = fromActs[fromReal]
      const v = Math.abs(a * (w.data[toReal * w.cols + fromReal] ?? 0))
      raw[i] = v
      srcA[i] = Math.abs(a)
      if (v > 0) anySignal = true
      const mx = maxByPair.get(e.fromCol) ?? 0
      if (v > mx) maxByPair.set(e.fromCol, v)
    }
    if (!anySignal) return null // toàn 0 → không giả tín hiệu, giữ opacity mặc định
    const m = new Map<number, EdgeSignalEntry>()
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const mx = maxByPair.get(e.fromCol) ?? 0
      const norm = mx > 0 ? Math.min(1, raw[i] / mx) : 0
      m.set(e.id, {
        opacity: 0.22 + 0.68 * norm,
        norm,
        gate: mx > 0 && raw[i] >= SIGNAL_GATE_RATIO * mx && srcA[i] > SOURCE_EPS,
      })
    }
    return m
  }, [activity, weights, edges, columns, realByPos])

  // ── TÍN HIỆU NGƯỢC per-edge THẬT (Task 26 B3 — hợp đồng 26-BE) ──
  // backprop.deltas[k][j] = δ nơ-ron j lớp activations[k+1] → cạnh từ cột c
  // tới cột c+1 đọc deltas[c][toReal]; a_i = activation nơ-ron TRÁI (layer 0 =
  // inputVector). raw = |δ_j × a_i|, chuẩn hóa per CẶP CỘT như tín hiệu tiến
  // (cùng thang style edgeSignal). KHÔNG deltas → null → KHÔNG đường vàng.
  const bwdSignal = useMemo(() => {
    const deltas = backprop?.deltas
    if (!deltas || !Array.isArray(deltas) || deltas.length === 0) return null
    if (!activity || !activity.activations || edges.length === 0) return null
    const actOf = (col: number): readonly number[] | null =>
      col === 0 ? (activity.inputVector ?? null) : activity.activations?.[col] ?? null
    const raw = new Array<number>(edges.length).fill(0)
    const srcD = new Array<number>(edges.length).fill(0)
    const maxByPair = new Map<number, number>()
    let anySignal = false
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const acts = actOf(e.fromCol)
      const dl = deltas[e.fromCol]
      const fromReal = realByPos.get(`${e.fromCol}:${e.fromRow}`)
      const toReal = realByPos.get(`${e.toCol}:${e.toRow}`)
      if (!acts || !dl || !Array.isArray(dl) || fromReal === undefined || toReal === undefined) continue
      if (fromReal >= acts.length || toReal >= dl.length) continue
      const a = acts[fromReal]
      const d = dl[toReal]
      const v = Math.abs(d * a)
      raw[i] = v
      srcD[i] = Math.abs(d)
      if (v > 0) anySignal = true
      const mx = maxByPair.get(e.fromCol) ?? 0
      if (v > mx) maxByPair.set(e.fromCol, v)
    }
    if (!anySignal) return null // gradient toàn 0 → không vẽ đường vàng giả
    const m = new Map<number, EdgeSignalEntry>()
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const mx = maxByPair.get(e.fromCol) ?? 0
      const norm = mx > 0 ? Math.min(1, raw[i] / mx) : 0
      m.set(e.id, {
        opacity: 0.22 + 0.68 * norm,
        norm,
        gate: mx > 0 && raw[i] >= SIGNAL_GATE_RATIO * mx && srcD[i] > SOURCE_EPS,
      })
    }
    return m
  }, [backprop, activity, edges, realByPos])

  /// Gradient mẫu thật có sẵn (chip trạng thái trung thực — B3): theo hợp đồng
  /// backprop ≠ null nghĩa là BE đã tính gradient thật 1 mẫu; đường vàng còn
  /// cần activations (bwdSignal) — không có thì không vẽ (không trang trí suông).
  const backReady = backprop != null && backprop.deltas != null
  /// Task 26: train đang chạy đúng não đang xem → chip ĐANG TRAIN + hạt ×2.
  const trainingRunning = training?.status === 'running' && training.brain === brain.key

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
  //    center căn giữa — KHÔNG preserveAspectRatio). R7: layout.width đã
  //    khớp tỉ lệ khung → 2 scale BẰNG NHAU → SVG lấp FULL box (hết dải đen
  //    letterbox trái/phải; zoom/pan vẫn giữ aspect nên cũng full).
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
  // R7: thêm width vào key — resize khung (boxSize đổi → layout.width đổi)
  // cũng reset view để luôn fit khung mới (aspect đã khớp → không letterbox).
  const baseKey = `${columns.map(c => c.units).join('-')}@${baseView.w}x${baseView.h}`
  useEffect(() => { queueMicrotask(() => { setView(null) }) }, [baseKey])

  const zoomBy = (factor: number) => {
    setView(v => zoomAt(v ?? baseView, factor, baseView, 0.5, 0.5))
  }
  const fit = useCallback(() => { setView(null) }, [])

  // ── Wheel zoom về TÂM CON TRỎ (BRAIN-LIVE) — Task 26 B5: gom deltaY vào
  //    ref, áp DUY NHẤT 1 lần/mỗi frame qua rAF (toán zoomAt + anchor con trỏ
  //    giữ nguyên; trước-fix mỗi wheel event 1 setState → pan/zoom nhanh làm
  //    React re-render dồn dập). Vùng quan sát chuyên dụng — wheel thường lẫn
  //    ctrl+wheel ĐỀU zoom (preventDefault, passive:false). ──
  useEffect(() => {
    const el = stageBoxRef.current
    // R24-b: ghost xếp dọc mobile KHÔNG zoom — trả lại cuộn native cho
    // khung (khe panel dài hơn màn hình) thay vì preventDefault wheel.
    if (!el || ghostStacked) return
    let anchor = { rX: 0.5, rY: 0.5 }
    const applyWheel = () => {
      wheelRafRef.current = null
      const delta = pendingWheelRef.current
      pendingWheelRef.current = 0
      if (delta === 0) return
      const factor = delta < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
      setView(v => zoomAt(v ?? baseView, factor, baseView, anchor.rX, anchor.rY))
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      anchor = {
        rX: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
        rY: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
      }
      pendingWheelRef.current += ev.deltaY
      if (wheelRafRef.current === null) wheelRafRef.current = requestAnimationFrame(applyWheel)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
      pendingWheelRef.current = 0
    }
  }, [baseView, ghostStacked])

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

  // ── Drag pan (BRAIN-LIVE) — Task 26 B5: gom pointermove vào ref, áp 1 lần
  //    mỗi frame qua rAF (trước-fix mỗi pointermove 1 setState). Chuột chính
  //    (button 0), CHỈ khi đang zoom; delta tỉ lệ view.w/clientWidth; kéo
  //    >3px = "đã pan" → nuốt click ngay sau (setTimeout 0 dọn cờ — pattern
  //    P3-B1). Touch giữ cuộn native — mobile zoom qua nút overlay + đúp chạm;
  //    unmount giữa lúc kéo → dọn listener sống. ──
  const onStagePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return
    if (view === null) return // đang fit — không pan (cursor pointer cho hit-test)
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const startView = view
    const base = baseView
    const startX = ev.clientX
    const startY = ev.clientY
    // FB-BRAIN-LIVE-R1-05: MỘT hệ số tỉ lệ cho cả 2 trục — svg giữ đúng
    // aspect viewBox (rect.height/rect.width ≡ view.h/view.w) nên scale
    // dọc ≡ scale ngang.
    const scale = startView.w / rect.width
    let moved = false
    const step = () => {
      panRafRef.current = null
      const p = panPendingRef.current
      panPendingRef.current = { dx: 0, dy: 0 }
      if (!moved || (p.dx === 0 && p.dy === 0)) return
      setView(v => (v === null ? v : panClamped(v, p.dx, p.dy, scale, base)))
    }
    const onMove = (mv: PointerEvent) => {
      if (mv.buttons === 0) { onUp(); return }
      if (!moved && Math.hypot(mv.clientX - startX, mv.clientY - startY) > 3) {
        moved = true
        setPanning(true)
      }
      if (!moved) return
      // gom delta từ vị trí ĐÃ ÁP gần nhất — mỗi frame chỉ 1 setState
      panPendingRef.current.dx += mv.clientX - lastPos.x
      panPendingRef.current.dy += mv.clientY - lastPos.y
      lastPos = { x: mv.clientX, y: mv.clientY }
      if (panRafRef.current === null) panRafRef.current = requestAnimationFrame(step)
    }
    let lastPos = { x: startX, y: startY }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      panTeardownRef.current = null
      if (panRafRef.current !== null) {
        cancelAnimationFrame(panRafRef.current)
        panRafRef.current = null
      }
      const p = panPendingRef.current
      panPendingRef.current = { dx: 0, dy: 0 }
      if (moved && (p.dx !== 0 || p.dy !== 0)) {
        setView(v => (v === null ? v : panClamped(v, p.dx, p.dy, scale, base)))
      }
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

  // ── Task 26 B4: dữ liệu mới nhất cho vòng rAF hạt — REF cập nhật mỗi
  //    render (loop KHÔNG setState, KHÔNG re-render React vì hạt). ──
  const loopDataRef = useRef<{
    edges: StageEdge[]
    fwd: Map<number, EdgeSignalEntry> | null
    bwd: Map<number, EdgeSignalEntry> | null
    effView: StageView
    trainingRunning: boolean
  }>({ edges, fwd: fwdSignal, bwd: bwdSignal, effView, trainingRunning })
  useEffect(() => {
    loopDataRef.current = { edges, fwd: fwdSignal, bwd: bwdSignal, effView, trainingRunning }
  })

  // ── Task 26 B4: vòng rAF hạt tín hiệu thật — canvas 60fps. Tắt khi
  //    !inView || document.hidden || prefers-reduced-motion || !animated ||
  //    hạt bị tắt → hủy rAF + clear canvas (SVG tĩnh vẫn đẹp). Toạ độ: DÙNG
  //    CHUNG phép biến đổi stage→screen-px với SVG (svg.getBoundingClientRect
  //    mỗi frame — rẻ; mapping = offset svg-trong-canvas + scale rect/view). ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const spriteFwd = makeGlowSprite([
      [0, 'rgba(209,250,229,0.95)'],
      [0.25, 'rgba(52,211,153,0.9)'],
      [1, 'rgba(16,185,129,0)'],
    ])
    const spriteBwd = makeGlowSprite([
      [0, 'rgba(254,249,195,0.95)'],
      [0.25, 'rgba(250,204,21,0.9)'],
      [1, 'rgba(250,204,21,0)'],
    ])
    if (!spriteFwd || !spriteBwd) return
    const shouldRun = fxOn && animated && inView && particlesOn && !reducedMotion
    let raf = 0
    let running = false
    let last = 0

    const stop = () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      particlesRef.current = []
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    const tick = (now: number) => {
      if (!running) return
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
      last = now
      if (document.hidden) { stop(); return }
      const rect = canvas.getBoundingClientRect()
      const svg = svgRef.current
      if (rect.width <= 0 || rect.height <= 0 || !svg) {
        raf = requestAnimationFrame(tick)
        return
      }
      // DPR-scale theo kích thước thật (resize lười mỗi frame — không listener)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const wantW = Math.round(rect.width * dpr)
      const wantH = Math.round(rect.height * dpr)
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW
        canvas.height = wantH
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, rect.width, rect.height)

      const data = loopDataRef.current
      const sr = svg.getBoundingClientRect()
      const view0 = data.effView
      const sx = sr.width / view0.w
      const sy = sr.height / view0.h
      const ox = sr.left - rect.left
      const oy = sr.top - rect.top
      const toScreenX = (x: number) => ox + (x - view0.x) * sx
      const toScreenY = (y: number) => oy + (y - view0.y) * sy

      // ── SPAWN (xác suất ∝ norm, chuẩn hóa từng cặp lớp; ×2 khi train) ──
      // NGUYÊN TẮC VÀNG: chỉ cạnh có tín hiệu THẬT (gate = ≥0.5% max cặp lớp
      // VÀ nơ-ron nguồn phát |a|/|δ| > 1e-9) mới được sinh hạt — cạnh im
      // lặng KHÔNG BAO GIỜ có hạt chạy (chỉ thị user TUYỆT ĐỐI KHÔNG tượng trưng).
      const mult = data.trainingRunning ? 2 : 1
      if (particlesRef.current.length < MAX_PARTICLES && dt > 0) {
        for (const e of data.edges) {
          const f = data.fwd?.get(e.id)
          if (f && f.gate && f.norm > 0) {
            if (Math.random() < f.norm * PARTICLE_SPAWN_PER_SEC * mult * dt && particlesRef.current.length < MAX_PARTICLES) {
              spawn(e, 1, 'fwd', f.norm)
            }
          }
          const b = data.bwd?.get(e.id)
          if (b && b.gate && b.norm > 0) {
            if (Math.random() < b.norm * PARTICLE_SPAWN_PER_SEC * mult * dt && particlesRef.current.length < MAX_PARTICLES) {
              spawn(e, -1, 'bwd', b.norm)
            }
          }
        }
      }

      // hạt chạy trên ĐÚNG đường được vẽ: khi có 2 đường song song, tiến lệch
      // −3 / ngược +3 (cùng EDGE_PARALLEL_OFFSET với render SVG — B3)
      function spawn(e: StageEdge, dir: 1 | -1, sprite: 'fwd' | 'bwd', norm: number) {
        const dx = e.x2 - e.x1
        const dy = e.y2 - e.y1
        const len = Math.hypot(dx, dy)
        if (len <= 0) return
        const px = -dy / len
        const py = dx / len
        const off = data.bwd !== null
          ? (dir === 1 ? -EDGE_PARALLEL_OFFSET : EDGE_PARALLEL_OFFSET)
          : 0
        particlesRef.current.push({
          x1: e.x1 + px * off, y1: e.y1 + py * off,
          x2: e.x2 + px * off, y2: e.y2 + py * off,
          dir,
          t: 0,
          speedPx: PARTICLE_SPEED_PX * (0.8 + 0.4 * Math.random()), // ±20% jitter
          radius: 1.6 + 1.0 * Math.min(1, norm), // 1.6–2.6px ∝ s
          sprite,
        })
      }

      // ── UPDATE + DRAW (sprite pre-render + 'lighter' — không shadowBlur) ──
      const alive: Particle[] = []
      ctx.globalCompositeOperation = 'lighter'
      for (const p of particlesRef.current) {
        const ax = toScreenX(p.dir === 1 ? p.x1 : p.x2)
        const ay = toScreenY(p.dir === 1 ? p.y1 : p.y2)
        const bx = toScreenX(p.dir === 1 ? p.x2 : p.x1)
        const by = toScreenY(p.dir === 1 ? p.y2 : p.y1)
        const segLen = Math.hypot(bx - ax, by - ay)
        if (segLen > 0) p.t += (p.speedPx * dt) / segLen
        if (p.t >= 1) continue // hạt chết khi HẾT cạnh (không vòng lại giả)
        const x = ax + (bx - ax) * p.t
        const y = ay + (by - ay) * p.t
        // fade mượt 2 đầu hạt (thuần thị giác — không đổi hướng/đường)
        ctx.globalAlpha = 0.9 * Math.min(1, p.t / 0.08, (1 - p.t) / 0.08)
        const w = p.radius * 4
        ctx.drawImage(p.sprite === 'fwd' ? spriteFwd : spriteBwd, x - w / 2, y - w / 2, w, w)
        alive.push(p)
      }
      particlesRef.current = alive
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(tick)
    }
    const startLoop = () => {
      if (running || !shouldRun) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else startLoop()
    }
    if (shouldRun && !document.hidden) startLoop()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [fxOn, animated, inView, particlesOn, reducedMotion])

  // ── Task 26 B5: layer cạnh/nơ-ron/nhãn useMemo theo layout + dữ liệu —
  //    pan/zoom chỉ đổi viewBox (<svg> attr) nên các subtree element identity
  //    ổn định → React BỎ re-reconcile (không tính lại chuỗi toạ độ mỗi frame). ──
  const edgeLayer = useMemo(() => {
    if (!fxOn) {
      return edges.map(e => (
        <line
          key={e.id}
          x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="rgba(168,162,158,0.22)" strokeWidth="0.8"
          markerEnd="url(#bs-arrow)"
        />
      ))
    }
    return edges.map(e => {
      const isSel = inspector?.kind === 'edge'
        && inspector.col === e.fromCol && inspector.row === e.fromRow && inspector.toRow === e.toRow
      const sig = fwdSignal?.get(e.id)
      const bwd = bwdSignal?.get(e.id)
      const hasBwdLine = bwd !== undefined && bwd.norm > 0
      // vuông góc đơn vị của cạnh (đơn vị viewBox) — offset 2 đường song song
      const dx = e.x2 - e.x1
      const dy = e.y2 - e.y1
      const len = Math.hypot(dx, dy)
      const px = len > 0 ? -dy / len : 0
      const py = len > 0 ? dx / len : 0
      const fwdOff = bwdSignal !== null ? -EDGE_PARALLEL_OFFSET : 0
      return (
        <g key={e.id}>
          {/* TIẾN (xanh emerald — GIỮ NGUYÊN theo chỉ thị user): gradient bs-fwd
              + strokeOpacity theo |a×w| thật (0.22–0.90 per cặp cột BRAIN-LIVE) */}
          <line
            x1={e.x1 + px * fwdOff} y1={e.y1 + py * fwdOff}
            x2={e.x2 + px * fwdOff} y2={e.y2 + py * fwdOff}
            stroke="url(#bs-fwd)"
            strokeWidth={isSel ? 2.2 : 0.9}
            strokeDasharray={animated && inView ? '5 4.5' : undefined}
            markerEnd={animated && inView ? undefined : 'url(#bs-arrow)'}
            className={animated && inView ? 'bs-flow' : undefined}
            style={animated && inView ? { animationDelay: `${edgePhaseSec(e.id)}s` } : undefined}
            opacity={isSel ? 1 : sig === undefined ? 0.9 : 1}
            strokeOpacity={!isSel ? sig?.opacity : undefined}
          />
          {/* NGƯỢC (vàng — Task 26 B3): CHỈ khi có gradient THẬT per-edge
              |δ_j × a_i| > 0 (backprop mẫu gần nhất); lệch +3 vuông góc để
              phân biệt rõ với đường tiến (−3). Không gradient thật → KHÔNG vẽ. */}
          {hasBwdLine && bwd && (
            <line
              x1={e.x1 + px * EDGE_PARALLEL_OFFSET} y1={e.y1 + py * EDGE_PARALLEL_OFFSET}
              x2={e.x2 + px * EDGE_PARALLEL_OFFSET} y2={e.y2 + py * EDGE_PARALLEL_OFFSET}
              stroke="url(#bs-bwd)"
              strokeWidth={isSel ? Math.max((0.7 + 2.0 * bwd.norm) * 1.9, 2.2) : 0.7 + 2.0 * bwd.norm}
              strokeDasharray={animated && inView ? '5 4.5' : undefined}
              markerStart={animated && inView ? undefined : 'url(#bs-bwd-arrow)'}
              className={animated && inView ? 'bs-flow bs-flow-bwd' : undefined}
              style={animated && inView ? { animationDelay: `${edgePhaseSec(e.id + 0.5)}s` } : undefined}
              strokeOpacity={isSel ? 1 : bwd.opacity}
            />
          )}
        </g>
      )
    })
  }, [edges, fwdSignal, bwdSignal, inspector, animated, inView, fxOn])

  // ── Nơ-ron TÍM TỎA SÁNG (Task 26 B2): HALO radial #c084fc đặc giữa (r ≈
  //    rC×2.2, opacity 0.05 dormant / 0.10+0.45×inten khi có dữ liệu) + CORE
  //    rgba(168,85,247, 0.14 dormant / 0.18+0.75×inten khi có dữ liệu),
  //    stroke violet nhạt; selected amber phóng to như cũ. TÍM là PHONG
  //    CÁCH nơ-ron (user: "quả cầu màu tím tỏa sáng" — dormant vẫn tím nhạt);
  //    ĐỘ SÁNG/HALO mới là tín hiệu thật (não dormant → tím mờ, không phát
  //    sáng giả). transition-[fill] duration-500. ──
  const neuronLayer = useMemo(() => layout.neurons.map(n => {
    const isSel = inspector?.kind === 'neuron' && inspector.col === n.col && inspector.row === n.row
    const inten = fxOn ? neuronIntensity?.get(`${n.col}:${n.row}`) : undefined
    // R24-b §8.5.2 — hover nơ-ron đầu ra knowledge → tên chế độ/tham số tương
    // ứng (map TĨNH §8.3 — không API mới); não khác / cột thường: không title
    const hg = columns[n.col]?.headGroup
    const unitTitle = hg && n.realIndex !== null
      ? KNOWLEDGE_UNIT_NAMES[hg][n.realIndex]
      : undefined
    // BRAIN-TAB-3PHAN: r theo TỪNG CỘT (layout.radius — cột dày đặc
    // chấm nhỏ lại); selected phóng nhẹ nhưng không vượt neuronRMax
    const rC = layout.radius[n.col] ?? STAGE_LIMITS.neuronRMax
    return (
      <g key={`n-${n.col}-${n.row}`}>
        {unitTitle !== undefined && (
          <title>{`${HEAD_GROUP_TITLE[hg!]} · unit ${n.realIndex! + 1}: ${unitTitle}`}</title>
        )}
        {/* Halo tím LUÔN có (phong cách quả cầu tím) — độ sáng theo inten
            thật; dormant chỉ còn quầng mờ 0.05 (không phát sáng giả) */}
        <circle
          cx={n.x} cy={n.y} r={rC * 2.2}
          fill="url(#bs-neuron)"
          opacity={(inten !== undefined ? 0.10 + 0.45 * inten : 0.05).toFixed(3)}
          className="transition-opacity duration-500"
        />
        <circle
          cx={n.x} cy={n.y} r={isSel ? Math.min(STAGE_LIMITS.neuronRMax, rC * 1.6 + 1.2) : rC}
          fill={inten !== undefined
            ? `rgba(168,85,247,${(0.18 + 0.75 * inten).toFixed(3)})`
            : 'rgba(168,85,247,0.14)'}
          stroke={isSel ? 'rgba(251,191,36,0.95)' : 'rgba(167,139,250,0.5)'}
          strokeWidth={isSel ? 1.8 : 1.1}
          className="transition-[fill] duration-500"
        />
      </g>
    )
  }), [layout.neurons, layout.radius, inspector, neuronIntensity, fxOn, columns])

  // ── Nhãn cột: bấm được khi editor bật (cột ẩn) ──
  const labelLayer = useMemo(() => columns.map((c, ci) => {
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
  }), [columns, layout.colX, layout.height, editorOn, onEditLayer])

  // ── R24-b §8.5.2 — LỚP NHÓM ĐẦU RA (chỉ khi layout có headGroups —
  //    knowledge ghost): vạch accent DỌC giữa khe 2 nhóm + label xoay -90°
  //    (đọc từ dưới lên) + rect trong suốt NGUYÊN VÙNG CỤM mang <title>
  //    tooltip giải thích tầng (copy §8.3) — rect render TRƯỚC cạnh/nơ-ron
  //    (dưới cùng z-order) nên hover nơ-ron vẫn ra tên unit riêng của nó. ──
  const groupLayer = useMemo(() => {
    if (layout.headGroups.length === 0) return null
    return layout.headGroups.map(g => {
      const accent = HEAD_GROUP_ACCENT[g.id]
      const prevX = g.fromCol > 0 ? layout.colX[g.fromCol - 1] : null
      const lineX = prevX !== null ? (prevX + g.x1) / 2 : g.x1 - 12
      const ys = layout.neurons.filter(nn => nn.col >= g.fromCol && nn.col <= g.toCol).map(nn => nn.y)
      if (ys.length === 0) return null
      const y1 = Math.min(...ys) - 14
      const y2 = Math.max(...ys) + 14
      const cy = (y1 + y2) / 2
      return (
        <g key={`hg-${g.id}`} role="presentation">
          {/* vùng hover cả cụm — fill transparent (không che màu) nhưng vẫn
              nhận pointer cho <title> tooltip §8.3; nằm dưới lớp nơ-ron/cạnh */}
          <rect
            x={g.x1 - 30} y={y1 - 6} width={g.x2 - g.x1 + 60} height={y2 - y1 + 12}
            fill="transparent"
          >
            <title>{HEAD_GROUP_TOOLTIP[g.id]}</title>
          </rect>
          {/* vạch accent dọc giữa khe (đứt nét — đường phân nhóm) */}
          <line
            x1={lineX} y1={y1} x2={lineX} y2={y2}
            stroke={accent} strokeWidth={1.3} strokeOpacity={0.6} strokeDasharray="4 3"
          />
          {/* label nhóm xoay -90° — đọc từ dưới lên, màu accent */}
          <text
            x={lineX - 4} y={cy} fontSize={8.5} textAnchor="middle" fill={accent}
            transform={`rotate(-90 ${lineX - 4} ${cy})`}
            style={{ fontFamily: 'inherit' }}
          >
            {g.label}
          </text>
        </g>
      )
    })
  }, [layout.headGroups, layout.colX, layout.neurons])

  const lifecycleCls = brain.lifecycle === 'active' ? 'bs-glow-active' : 'bs-glow-dormant'
  const ariaLayers = columns.map(c => `${c.label} ${c.activation}`).join(' → ')
  // R24-b — aria nhóm đầu ra cho ghost knowledge (§8.5.4 a11y: mô tả 3 cụm)
  const ariaGroups = layout.headGroups.length > 0
    ? ` — 3 cụm đầu ra MỘT quyết định: ${layout.headGroups.map(g => `${g.label} (${HEAD_GROUP_TITLE[g.id]})`).join(' · ')}`
    : ''
  const chipTitle = activity
    ? `${activity.sourceLabel ?? 'không rõ nguồn dữ liệu'} · cập nhật ${new Date(activity.fetchedAt).toLocaleTimeString('vi-VN')}`
    : ''
  const backTitle = backReady
    ? `Gradient mẫu thật sẵn sàng${backprop?.label ? ` · ${backprop.label}` : ''}${typeof backprop?.loss === 'number' ? ` · loss ${backprop.loss.toFixed(4)}` : ''} — đường vàng + hạt vàng theo |δ×a| per-edge thật`
    : 'Chưa có gradient thật (não dormant / thiếu nhãn) — KHÔNG vẽ đường ngược (không trang trí suông)'
  const trainTitle = training
    ? `Train ${training.brain}${training.head ? ` head ${training.head}` : ''} · ${training.status} · bắt đầu ${new Date(training.startedAt).toLocaleTimeString('vi-VN')}${training.epochsRun !== null ? ` · ${training.epochsRun} epoch` : ''}`
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
            onClick={() => setParticlesOn(v => !v)}
            aria-pressed={particlesOn}
            title={particlesOn
              ? 'Hạt tín hiệu ĐANG BẬT — hạt xanh (tiến) chạy trái→phải theo tín hiệu thật |a×w|, hạt vàng (ngược) phải→trái theo gradient thật |δ×a|, CHỈ trên cạnh có tín hiệu thật. Bấm để tắt bớt chuyển động (đường vẫn theo dữ liệu thật).'
              : 'Hạt tín hiệu đang TẮT — đường tiến/ngược vẫn hiển thị theo dữ liệu thật. Bấm để bật hạt chạy trên cạnh.'}
            className={`min-h-[44px] md:min-h-[28px] rounded-md border px-2 text-[10px] ${particlesOn
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
              : 'border-stone-700/70 text-stone-400 hover:text-stone-200'}`}
          >
            {particlesOn ? '◉ Hạt tín hiệu' : '○ Hạt tắt'}
          </button>
        )}
        {fxOn && (
          <span
            title={backTitle}
            className={`rounded-md border px-1.5 py-0.5 text-[9.5px] ${backReady
              ? 'border-yellow-400/45 bg-yellow-400/10 text-yellow-300'
              : 'border-stone-700/70 text-stone-500'}`}
          >
            {backReady ? 'Ngược: gradient thật mẫu gần nhất' : 'Ngược: chưa có dữ liệu thật'}
          </span>
        )}
        {trainingRunning && (
          <span
            title={trainTitle}
            className="animate-pulse rounded-md border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] text-amber-300"
          >
            ● ĐANG TRAIN
          </span>
        )}
        {/* R24-b §8.5 — chip ghost Brain-D: chưa có model tới D3 (không có
            weights/activity — không giả tín hiệu) + dòng mixture λ precedent
            Brain-C (§8.3): bắt đầu 100% heuristic, nhường dần khi dữ liệu đủ */}
        {isKnowledgeBrain && !weights && (
          <span
            role="status"
            title="Ghost topology §8.5 — hiển thị spec khởi điểm NGAY từ D1 dù chưa có model; model thật chỉ sống sau BRAIN-D3 (≥300 log KbConsultLog có Outcome*). Không có weights/activity nên KHÔNG có điểm sáng/hạt giả."
            className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] text-amber-300"
          >
            DỰ KIẾN — CHƯA HỌC
          </span>
        )}
        {isKnowledgeBrain && !weights && (
          <span
            title="Mixture λ precedent Brain-C (§8.3): λ = 1 − min(n/200, WilsonLB) — bắt đầu 100% heuristic (pipeline CỨNG 4 lớp như hôm nay), não nhận quyền dần khi đủ dữ liệu; fail-open về heuristic mọi nhánh lỗi."
            className="rounded-md border border-stone-700/70 px-1.5 py-0.5 text-[9.5px] text-stone-400"
          >
            λ = 1 − min(n/200, WilsonLB) · 100% heuristic
          </span>
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
        {/* ── R24-b §8.5.4 — GHOST XẾP DỌC MOBILE (<1024px): thay SVG 6 cột
            ngang (quá chật trên ~375px) bằng 4 band dọc cuộn được: trunk
            chung + 3 cụm đầu ra (mỗi cụm 1 panel accent + legend tên unit).
            Thuần trình bày từ registry — KHÔNG dữ liệu giả (chip DỰ KIẾN ở
            thanh công cụ phía trên). ── */}
        {ghostStacked ? (
          <div
            className="dialog-scrollbar h-full w-full space-y-2 overflow-y-auto p-2"
            role="img"
            aria-label={`Kiến trúc dự kiến ${brain.title} (ghost §8.5): ${ariaLayers}${ariaGroups} — loss ${brain.planned.loss}`}
          >
            {/* Band 1 — trunk chung (input → 32 tanh → 16 tanh) */}
            <div>
              <p className="mb-0.5 text-[9px] font-semibold text-stone-300">
                Trunk chung
                <span className="ml-1 font-normal text-stone-500">emb 2048 + cfg ~30 → 32 tanh → 16 tanh (§8.5.2)</span>
              </p>
              <KnowledgeGhostBand groupId="trunk" trunkUnits={32} clusterUnits={16} activation="tanh" />
            </div>
            {/* Band 2-4 — 3 cụm đầu ra XẾP DỌC (một quyết định — §8.3) */}
            {(['mode', 'retrieval', 'meta'] as const).map(gid => {
              const accent = HEAD_GROUP_ACCENT[gid]
              const names = KNOWLEDGE_UNIT_NAMES[gid]
              const units = brain.planned.layers.find(l => l.headGroup === gid)?.units ?? names.length
              const act = brain.planned.layers.find(l => l.headGroup === gid)?.activation ?? ''
              return (
                <div
                  key={gid}
                  className="rounded-lg border bg-slate-950/50 p-1.5"
                  style={{ borderColor: `${accent}55` }}
                >
                  <p className="mb-0.5 text-[9px] font-semibold" style={{ color: accent }} title={HEAD_GROUP_TOOLTIP[gid]}>
                    {HEAD_GROUP_TITLE[gid]}
                    <span className="ml-1 font-normal text-stone-500">— {units} unit · {act} · một quyết định (§8.3)</span>
                  </p>
                  <KnowledgeGhostBand groupId={gid} trunkUnits={16} clusterUnits={units} activation={act} />
                  {/* legend tên unit (touch không hover được title SVG) */}
                  <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                    {names.map((nm, i) => (
                      <span key={nm} className="text-[8.5px]" style={{ color: accent }} title={`Unit ${i + 1}/${names.length}: ${nm}`}>
                        {i + 1}·{nm}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
        <svg
          ref={svgRef}
          viewBox={`${effView.x} ${effView.y} ${effView.w} ${effView.h}`}
          className={`${fitSize ? 'block max-w-full' : 'h-auto w-full'} ${fxOn && !zoomed ? 'cursor-pointer' : ''}`}
          style={fitSize ? { width: fitSize.w, height: fitSize.h } : undefined}
          role="img"
          aria-label={`Kiến trúc ${brain.title}: ${ariaLayers}${ariaGroups} — loss ${brain.planned.loss}`}
          onClick={fxOn ? onSvgClick : undefined}
        >
          <defs>
            {/* BRAIN-LIVE: TIẾN = XANH emerald, NGƯỢC = VÀNG yellow (chỉ thị
                user 2026-10-12 — GIỮ NGUYÊN đường tiến theo Task 26);
                fxOn=false giữ Stops xám trung tính như UX-3 */}
            <linearGradient id="bs-fwd" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={fxOn ? 'rgba(16,185,129,0.10)' : 'rgba(168,162,158,0.22)'} />
              <stop offset="1" stopColor={fxOn ? 'rgba(16,185,129,0.85)' : 'rgba(168,162,158,0.34)'} />
            </linearGradient>
            <linearGradient id="bs-bwd" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0" stopColor="rgba(250,204,21,0.10)" />
              <stop offset="1" stopColor="rgba(250,204,21,0.80)" />
            </linearGradient>
            {/* Task 26 B2 — nơ-ron TÍM tỏa sáng: halo radial #c084fc đặc giữa
                → trong suốt rìa (opacity element = 0.10 + 0.45×inten) */}
            <radialGradient id="bs-neuron">
              <stop offset="0" stopColor="#c084fc" stopOpacity="0.95" />
              <stop offset="0.35" stopColor="#c084fc" stopOpacity="0.32" />
              <stop offset="1" stopColor="#c084fc" stopOpacity="0" />
            </radialGradient>
            <marker id="bs-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,1 L7,4 L0,7 z" fill={fxOn ? 'rgba(16,185,129,0.85)' : 'rgba(168,162,158,0.55)'} />
            </marker>
            {/* Task 26 B3 — mũi tên vàng cho bản tĩnh đường ngược (markerStart +
                auto-start-reverse → chỉ VỀ PHÍA TRÁI = chiều lan truyền ngược) */}
            <marker id="bs-bwd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,1 L7,4 L0,7 z" fill="rgba(250,204,21,0.85)" />
            </marker>
          </defs>

          {/* R24-b §8.5.2 — LỚP NHÓM ĐẦU RA (render TRƯỚC cạnh/nơ-ron: rect
              hover tooltip cụm nằm dưới z-order, không chắn bấm nơ-ron) */}
          {groupLayer}

          {/* Cạnh THẲNG (Task 26 B1 — bỏ cong): đường tiến emerald GIỮ NGUYÊN
              (độ sáng theo |a×w| thật) + đường ngược VÀNG per-edge |δ×a| thật
              (song song lệch ±3, chỉ khi có gradient thật). Layer memo —
              pan/zoom không tính lại toạ độ. */}
          {edgeLayer}

          {/* Nơ-ron tím tỏa sáng (Task 26 B2) — HALO + CORE theo inten thật. */}
          {neuronLayer}

          {/* Nhãn cột: bấm được khi editor bật (cột ẩn) */}
          {labelLayer}
        </svg>
        )}

        {/* Task 26 B4 — canvas hạt tín hiệu thật: TRÊN SVG, pointer-events-none,
            DPR-scaled (resize lười trong tick theo stage box). rAF tắt khi
            ngoài viewport / tab ẩn / reduced-motion — SVG tĩnh vẫn đẹp.
            (R24-b: ẩn trong ghost xếp dọc mobile — không hạt giả cho não chưa học) */}
        {!ghostStacked && (
          <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
        )}

        {/* Nút zoom/pan overlay (BRAIN-LIVE) — touch target 44px mobile
            (R24-b: ẩn trong ghost xếp dọc mobile — không zoom, cuộn native) */}
        {!ghostStacked && (
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
        )}
      </div>

      {/* R24-b §8.5 — chú thích ghost Brain-D dưới đài (3 cụm MỘT quyết định,
          khác 3 TAB đầu Brain-B vì đó là 3 MLP riêng; ngưỡng thức tỉnh kép) */}
      {isKnowledgeBrain && !weights && (
        <p className="mt-0.5 text-[9px] leading-relaxed text-stone-600">
          Brain-D ghost (§8.5): 3 cụm đầu ra là MỘT quyết định — một forward pass ra cả 3 tầng (khác 3 TAB của Brain-B vì đó là 3 MLP riêng, 3 lần train riêng). Chưa có weights/activity tới D3 — thức tỉnh D2 ≥100 log · D3 ≥300 log có Outcome* (đếm thật KbConsultLog, xem tiến độ ở phần 1).
        </p>
      )}

      {/* Task 26 B4 — chú thích 1 dòng dưới đài (chỉ thị user: quan sát chính xác) */}
      {fxOn && (
        <p className="mt-0.5 text-[10px] leading-relaxed text-stone-500">
          <span className="text-emerald-400">●</span> tiến (xanh) — tín hiệu thật |a×w| · <span className="text-yellow-400">●</span> ngược (vàng) — gradient thật |δ×a| mẫu gần nhất · cạnh chỉ sáng khi có tín hiệu ≥0.5% max cặp lớp
        </p>
      )}

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
              {backReady && (
                <span>
                  ngược |δ×a|: <span className="font-mono">{((toRow: number) => {
                    const e = edges.find(e2 => e2.fromCol === inspect.col && e2.fromRow === inspect.row && e2.toRow === toRow)
                    const b = bwdSignal?.get(e?.id ?? -1)?.norm
                    return typeof b === 'number' && b > 0 ? `${(b * 100).toFixed(1)}% max cặp lớp` : '— (cạnh này không có gradient)'
                  })(inspect.toRow ?? 0)}</span>
                </span>
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
      {fxOn && !backReady && (
        <p className="mt-0.5 text-[9px] text-stone-600">
          Đường ngược (vàng) chỉ hiện khi có gradient thật của mẫu gần nhất — chưa có nên không vẽ (không trang trí suông).
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
