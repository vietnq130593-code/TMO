/**
 * NEURAL-LAYOUT — HÌNH HỌC + THU PHÓNG + STYLE CẠNH cho tab Kiến trúc Neural
 * (P1 review 2026-10-11 — tách khỏi component thành module THUẦN để pin test)
 * ============================================================================
 *
 * Module THUẦN DỮ LIỆU (giống neural-types): KHÔNG import gì ngoài type từ
 * './neural-types' — an toàn client bundle lẫn bun:test. Bốn khối:
 *
 *   1. NEURAL_GEO + NEURAL_FONTS — kích thước node/cột/biến cỡ chữ SVG.
 *      P1-1: font thiết kế nhỏ nhất 8.5px (trước-fix 7.5px ở viewBox 1712
 *      render 1180px → ~5.2px thực tế — dưới mọi ngưỡng đọc). Sàn 8.5 được
 *      pin bằng test r82 (neuralFontFloor) — hạ xuống là FAIL gate.
 *   2. computeNeuralLayout(graph) — auto-layout 6 cột + bezier + offset cặp
 *      cạnh 2 chiều (dời nguyên vẹn từ component; node mất layer bị bỏ qua).
 *   3. NEURAL_EDGE_KINDS + edgeVisual(kind, active) — style 4 loại dòng chảy
 *      (data/reward/feedback/read) kèm biến thể "active" khi cạnh nối với
 *      node đang chọn (P1-2: cạnh liên quan sáng + đậm, còn lại mờ 0.16 —
 *      người dùng thấy ngay dòng chảy vào/ra node đang xem).
 *   4. NEURAL_ZOOM + clampNeuralZoom — thanh thu phóng (fit = width 100%
 *      với sàn FIT_FLOOR_PX giữ hành vi cũ; số = pixel width = viewBox×zoom).
 */

import type { NeuralEdge, NeuralGraph, NeuralNode } from './neural-types'

// ==================== 1. HÌNH HỌC + CỠ CHỮ (P1-1) ====================

/** Kích thước hình học đồ thị — đơn vị toạ độ viewBox (không phải px màn hình). */
export const NEURAL_GEO = {
  /** Bề rộng cột lớp (≥ NODE_W để node nằm gọn cột) */
  LAYER_W: 220,
  /** Bề rộng node */
  NODE_W: 220,
  /** Chiều cao node (64 → 80: thêm khoảng thở dòng cho cỡ chữ mới) */
  NODE_H: 80,
  /** Khoảng giãn giữa 2 node cùng lớp */
  NODE_GAP: 18,
  /** Khoảng giãn giữa 2 cột lớp (92 → 72: bù diện tích cho node to hơn) */
  LAYER_GAP: 72,
  /** Đệm viền đồ thị */
  PAD: 26,
  /** Vùng đầu cột cho tiêu đề lớp (46 → 52: cỡ chữ lớp tăng) */
  HEADER_H: 52,
} as const

/**
 * Cỡ chữ thiết kế (đơn vị viewBox). Quy ước: giá trị chính là px hiển thị
 * khi zoom 100% (render width = viewBox width). SÀN 8.5 — pin test r82.
 */
export const NEURAL_FONTS = {
  /** Tiêu đề node (11 → 12.5) */
  title: 12.5,
  /** Dòng phụ đề node (8 → 9) */
  subtitle: 9,
  /** Dòng số liệu sống trong node (7.5 → 8.5) */
  live: 8.5,
  /** Con đếm ⚙ tham số góc phải node (7.5 → 8.5) */
  gear: 8.5,
  /** Tiêu đề cột lớp (10 → 11.5) */
  layerTitle: 11.5,
  /** Phụ đề cột lớp (7.5 → 8.5) */
  layerSub: 8.5,
} as const

/** Sàn cỡ chữ thiết kế — mọi mục NEURAL_FONTS phải ≥ sàn này (test pin). */
export const NEURAL_FONT_FLOOR = 8.5

// ==================== 2. AUTO-LAYOUT (đời từ component) ====================

export interface PlacedNode extends NeuralNode {
  x: number
  y: number
}

export interface LaidOutEdge extends NeuralEdge {
  /** Đường bezier `M … C …` dựng sẵn cho <path d> */
  d: string
}

export interface NeuralLayout {
  nodes: PlacedNode[]
  nodeById: Map<string, PlacedNode>
  edges: LaidOutEdge[]
  width: number
  height: number
}

/**
 * Auto-layout đồ thị 6 cột: node xếp dọc trong cột lớp của nó (thứ tự khai
 * báo), cạnh bezier ngang mép-phải-nguồn → mép-trái-đích. Cặp 2 chiều
 * (from↔to, vd llm-call ↔ softmax-policy) tự lệch dọc ±PAIR_OFFSET để 2
 * đường không đè nhau (lần gặp thứ 2 của cặp lệch +16, lần thứ 3 −16…).
 *
 * Thuần + quyết định: không đụng DOM — mọi giá trị test pin được trực tiếp.
 */
export function computeNeuralLayout(graph: NeuralGraph): NeuralLayout {
  const nodes: PlacedNode[] = []
  const nodeById = new Map<string, PlacedNode>()
  const layerById = new Map(graph.layers.map(l => [l.id, l]))
  const perLayerCount = new Map<string, number>()

  for (const n of graph.nodes) {
    const layer = layerById.get(n.layer)
    if (!layer) continue // node khai sai layer → bỏ qua (r81 pin graph sạch)
    const col = layer.index - 1
    const idx = perLayerCount.get(n.layer) ?? 0
    perLayerCount.set(n.layer, idx + 1)
    const x = NEURAL_GEO.PAD + col * (NEURAL_GEO.LAYER_W + NEURAL_GEO.LAYER_GAP)
    const y = NEURAL_GEO.HEADER_H + idx * (NEURAL_GEO.NODE_H + NEURAL_GEO.NODE_GAP)
    const placed = { ...n, x, y }
    nodes.push(placed)
    nodeById.set(n.id, placed)
  }

  const maxRows = Math.max(1, ...Array.from(perLayerCount.values()))
  const nLayers = Math.max(0, ...graph.layers.map(l => l.index))
  const width = NEURAL_GEO.PAD * 2 + nLayers * NEURAL_GEO.LAYER_W + Math.max(0, nLayers - 1) * NEURAL_GEO.LAYER_GAP
  const height = NEURAL_GEO.HEADER_H + maxRows * (NEURAL_GEO.NODE_H + NEURAL_GEO.NODE_GAP) + NEURAL_GEO.PAD

  const pairSeen = new Map<string, number>()
  const PAIR_OFFSET = 16
  const edges: LaidOutEdge[] = []
  for (const e of graph.edges) {
    const from = nodeById.get(e.from)
    const to = nodeById.get(e.to)
    if (!from || !to) continue
    const pairKey = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`
    const seen = pairSeen.get(pairKey) ?? 0
    pairSeen.set(pairKey, seen + 1)
    const yOffset = seen === 0 ? 0 : (seen % 2 === 1 ? PAIR_OFFSET : -PAIR_OFFSET)
    const x1 = from.x + NEURAL_GEO.NODE_W
    const y1 = from.y + NEURAL_GEO.NODE_H / 2 + yOffset
    const x2 = to.x
    const y2 = to.y + NEURAL_GEO.NODE_H / 2 + yOffset
    // Kéo dài điểm kiểm theo hướng đi (lùi cũng được — bezier cong mượt;
    // dx ≥ 48 giữ cong rõ ngay cả khi 2 cột sát nhau).
    // FB-P1-R1-05: KẸP ĐIỂM KIỂM VÀO VIEWBOX — 5 cạnh reverse/đường dài
    // (e13/e21/e24/e28/e36) có control point đâm xuyên viền (sampler độc
    // lập: maxX 1761.9 > 1732, minX −70.5) → thân cong bị clip mép. Kẹp
    // từng điểm với margin 4 — giữ trật tự điểm kiểm (U-turn vẫn mượt)
    // nhưng toàn bộ đường cong nằm trong khung.
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.45)
    const CP_MARGIN = 4
    const cp1x = Math.min(x1 + dx, width - CP_MARGIN)
    const cp2x = Math.max(x2 - dx, CP_MARGIN)
    const d = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`
    edges.push({ ...e, d })
  }

  return { nodes, nodeById, edges, width, height }
}

// ==================== 3. STYLE CẠNH + PHÂN BIỆT LOẠI DÒNG CHẢY ====================

export interface EdgeKindStyle {
  /** Màu nét thường (node liên quan không được chọn) */
  stroke: string
  /** Màu nét sáng — cạnh nối với node đang chọn (P1-2) */
  hiStroke: string
  /** Độ dày nét thường */
  width: number
  /** Độ dày cộng thêm khi active (P1-2) */
  hiWidthDelta: number
  /** Kiểu đứt nét theo kind */
  dash: string
  /** Class CSS animation (na-edge-data/na-edge-reward — keyframes globals.css) */
  className?: string
  /** Màu hạt animateMotion chạy trên cạnh (không có = không hạt) */
  dot?: string
  /** Màu sáng của hạt khi active */
  hiDot?: string
  /** id marker arrowhead (defs trong component) */
  marker: string
}

export const NEURAL_EDGE_KINDS: Record<string, EdgeKindStyle> = {
  data: {
    stroke: 'rgba(34,211,238,0.55)',
    hiStroke: 'rgba(34,211,238,0.95)',
    width: 1.6,
    hiWidthDelta: 0.6,
    dash: '6 4',
    className: 'na-edge-data',
    dot: 'rgba(34,211,238,0.95)',
    hiDot: 'rgba(34,211,238,1)',
    marker: 'na-arrow-cyan',
  },
  reward: {
    stroke: 'rgba(251,191,36,0.7)',
    hiStroke: 'rgba(251,191,36,1)',
    width: 1.8,
    hiWidthDelta: 0.6,
    dash: '3 4',
    className: 'na-edge-reward',
    dot: 'rgba(251,191,36,0.95)',
    hiDot: 'rgba(251,191,36,1)',
    marker: 'na-arrow-amber',
  },
  feedback: {
    stroke: 'rgba(232,121,249,0.55)',
    hiStroke: 'rgba(232,121,249,0.95)',
    width: 1.4,
    hiWidthDelta: 0.6,
    dash: '7 5',
    marker: 'na-arrow-fuchsia',
  },
  read: {
    stroke: 'rgba(168,162,158,0.35)',
    hiStroke: 'rgba(214,211,209,0.85)',
    width: 1,
    hiWidthDelta: 0.7,
    dash: '2 4',
    marker: 'na-arrow-stone',
  },
}

/** Độ mờ nhóm cạnh khi KHÔNG nối với node đang chọn (P1-2). */
export const NEURAL_EDGE_DIM_OPACITY = 0.16

/** Bán kính hạt animateMotion thường / active (2.6 → 3.2 khi nổi bật). */
export const NEURAL_EDGE_DOT_R = { normal: 2.6, active: 3.2 } as const

/** Kiểu render hoàn chỉnh của một cạnh theo trạng thái active. */
export interface EdgeRenderStyle {
  stroke: string
  strokeWidth: number
  dash: string
  className: string | undefined
  dot: string | undefined
  dotRadius: number
  marker: string
  opacity: number
}

/**
 * Quyết style render một cạnh (P1-2). active = cạnh nối với node đang chọn
 * → nét sáng + dày hơn + hạt to; ngược lại mờ NEURAL_EDGE_DIM_OPACITY để
 * dòng chảy của node đang chọn nổi bật hẳn trên nền. Kind lạ rơi về 'read'
 * (đúng hành vi fallback bản cũ).
 */
export function edgeVisual(kind: string, active: boolean): EdgeRenderStyle {
  const k = NEURAL_EDGE_KINDS[kind] ?? NEURAL_EDGE_KINDS.read
  return {
    stroke: active ? k.hiStroke : k.stroke,
    strokeWidth: active ? k.width + k.hiWidthDelta : k.width,
    dash: k.dash,
    className: k.className,
    dot: active ? (k.hiDot ?? k.dot) : k.dot,
    dotRadius: active ? NEURAL_EDGE_DOT_R.active : NEURAL_EDGE_DOT_R.normal,
    marker: k.marker,
    opacity: active ? 1 : NEURAL_EDGE_DIM_OPACITY,
  }
}

/** Cạnh có nối với node đang chọn không (đầu nào khớp cũng算). */
export function edgeIsActive(e: Pick<NeuralEdge, 'from' | 'to'>, selectedNodeId: string | null): boolean {
  if (!selectedNodeId) return false
  return e.from === selectedNodeId || e.to === selectedNodeId
}

// ==================== 4. THU PHÓNG (P1-1) ====================

/**
 * Chế độ zoom: 'fit' = width 100% với sàn FIT_FLOOR_PX (giữ nguyên hành vi
 * bản trước); số = render đúng `viewBox.width × zoom` pixel (zoom 1 = 100%
 * = cỡ chữ thiết kế 1:1 — P1 mặc định desktop để chữ đọc được ngay).
 */
export type NeuralZoom = number | 'fit'

export const NEURAL_ZOOM = {
  MIN: 0.6,
  MAX: 1.6,
  STEP: 0.1,
  /** Sàn bề rộng khi mode fit (px) — container hẹp hơn thì xuất hiện scroll ngang thay vì co chữ vô hạn */
  FIT_FLOOR_PX: 1180,
} as const

/** Kẹp zoom vào [MIN, MAX] (NaN/vô hiệu → 1). */
export function clampNeuralZoom(z: number): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(NEURAL_ZOOM.MAX, Math.max(NEURAL_ZOOM.MIN, Math.round(z * 100) / 100))
}

/** Giá trị CSS width của <svg> theo chế độ zoom (fit → 100%; số → px). */
export function neuralSvgWidth(layoutWidth: number, zoom: NeuralZoom): string {
  if (zoom === 'fit') return '100%'
  return `${Math.round(layoutWidth * clampNeuralZoom(zoom))}px`
}

/** Nhãn hiển thị trên thanh zoom ("Fit" | "85%" …). */
export function neuralZoomLabel(zoom: NeuralZoom): string {
  return zoom === 'fit' ? 'Fit' : `${Math.round(clampNeuralZoom(zoom) * 100)}%`
}

/**
 * Bước zoom mới từ trạng thái hiện tại — FB-P1-R1-03: từ 'fit', neo base
 * theo TỈ LỆ RENDER THẬT (renderedWidth / viewBoxWidth — vd 1180/1732 ≈ 0.68)
 * để "Thu nhỏ 10%" thu nhỏ THẬT (0.68 − 0.1 → 0.6 ≈ 1039px) thay vì neo 1
 * nhảy về 0.9×viewBox = 1559px — PHÓNG TO trên card hẹp dù nhãn nói thu
 * nhỏ. fitScale null/≤0/NaN (svg chưa render) → neo 1 (hành vi fallback).
 */
export function zoomStepFrom(prev: NeuralZoom, fitScale: number | null, delta: number): number {
  const base = prev === 'fit'
    ? (fitScale !== null && Number.isFinite(fitScale) && fitScale > 0 ? clampNeuralZoom(fitScale) : 1)
    : prev
  return clampNeuralZoom(base + delta)
}
