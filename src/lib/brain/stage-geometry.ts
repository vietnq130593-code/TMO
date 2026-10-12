/**
 * BRAIN-UX §9.4 (UX-3) — HÌNH HỌC SÂN KHẤU NÃO (THUẦN, test r90)
 * ============================================================================
 *
 * Toàn bộ toán trình bày của BrainStage (đường dây ánh sáng): bezier cạnh,
 * LOD cắt cạnh, hit-target point-to-bezier, lệch pha animation, độ dày cạnh
 * theo |gradient| thật, mũi tên bản tĩnh reduced-motion.
 *
 * Thuần — KHÔNG import React/db (bun:test chấm trực tiếp từng công thức).
 * Đơn vị toạ độ: viewBox SVG (không phải px CSS).
 */

// ==================== TYPES ====================

export interface StageColumn {
  /** Số unit THẬT của lớp (label ×N khi bị nén hiển thị) */
  units: number
  /** Số nơ-ron VẼ (≤ maxDisplayNeurons) */
  display: number
  /** Nhãn lớp (vd '×32' hoặc '1-hot cfg') */
  label: string
  /** Tên activation hiển thị dưới cột */
  activation: string
  /** Có phải cột khóa (input/output — không chỉnh được) */
  locked: boolean
}

export interface StageNeuron {
  col: number
  row: number
  x: number
  y: number
  /** Chỉ số unit THẬT khi bị nén (null = đại diện trung tâm) */
  realIndex: number | null
}

export interface StageEdge {
  id: number
  /** Cột trái/phải (index trong columns) */
  fromCol: number
  toCol: number
  fromRow: number
  toRow: number
  x1: number
  y1: number
  x2: number
  y2: number
  /** Toạ độ điều khiển bezier (vuông góc lệch tại trung điểm) */
  cx1: number
  cy1: number
  cx2: number
  cy2: number
}

// ==================== LIMITS (§9.4 — LOD budget) ====================

export const STAGE_LIMITS = {
  /**
   * Tối đa nơ-ron VẼ mỗi cột. BRAIN-LIVE (chỉ thị user 2026-10-12 — "mỗi
   * lớp có bao nhiêu nơ-ron thì hiển thị đúng số điểm nơ-ron đấy"): vẽ
   * ĐÚNG từng unit của lớp (10→16→1 giờ vẽ đủ 27 nơ-ron thay vì 8+8+1
   * tượng trưng như bản UX-3). Nén đại diện CHỈ khi vượt 256 — trường hợp
   * hiếm ngoài khoảng editor 1–256 (stepper Brain Studio §9.2); quá thì
   * nén đều + label ×N (giữ cơ chế tiền lệ BrainArchDiagram P2).
   */
  maxDisplayNeurons: 256,
  /** Tối đa cạnh VẼ (§9.4 LOD ~300) — quá thì sampling đại diện tất định */
  maxEdges: 300,
  /** Số đoạn rời rạc hóa bezier để hit-test (đủ mịn cho touch 44px) */
  bezierSegments: 24,
  /** Chu kỳ animation nét đứt (giây) — §9.4: 2.4s linear infinite */
  flowPeriodSec: 2.4,
  /**
   * Ngưỡng bấm cạnh — 12 đơn vị viewBox (~12-18px CSS tùy scale); kết hợp
   * padding cảm ứng của trình duyệt; các NÚT UI đạt 44px thật (min-h-44
   * mobile) — cạnh SVG nhỏ hơn vì phải tách biệt giữa các cạnh kề nhau
   * (đánh đổi độ chính xác bấm). (FB-BRAIN-UX-R1-06: 7 → 12)
   */
  edgeHitRadius: 12,
} as const

// ==================== LAYOUT ====================

/**
 * Dựng toạ độ cột + nơ-ron. viewBox width cố định 340 (đúng tiền lệ
 * BrainArchDiagram 300 — nới chút cho 6 lớp ẩn), chiều cao theo cột cao nhất.
 * Tất định, thuần — cùng input luôn ra cùng output.
 *
 * BRAIN-LIVE (chỉ thị user 2026-10-12 — "hiển thị thực"): vẽ ĐÚNG units
 * từng lớp (display = min(units, maxDisplayNeurons) với cap 256 — vd spec
 * 10→16→1 giờ vẽ đủ 10+16+1 = 27 nơ-ron, KHÔNG còn nén tượng trưng 8+8+1
 * như bản UX-3). Cột 256 nơ-ron → height ≈ 4404 viewBox — ĐÚNG thiết kế:
 * zoom/pan viewBox do component BrainStage v2 lo phần xem. Nén đại diện
 * (units > 256) giữ nguyên thuật toán cũ: đầu 0, cuối units−1, đơn điệu.
 */
export function buildStageLayout(columns: readonly StageColumn[]): {
  neurons: StageNeuron[]
  colX: number[]
  height: number
} {
  const n = columns.length
  if (n === 0) return { neurons: [], colX: [], height: 100 }
  const width = 340
  const marginX = 34
  const stepX = n > 1 ? (width - 2 * marginX) / (n - 1) : 0
  const colX = Array.from({ length: n }, (_, i) => marginX + i * stepX)

  const rowStep = 17
  const topY = 26
  const neurons: StageNeuron[] = []
  let maxDisplay = 1
  for (let c = 0; c < n; c++) {
    const col = columns[c]
    const display = Math.min(col.units, STAGE_LIMITS.maxDisplayNeurons)
    maxDisplay = Math.max(maxDisplay, display)
    for (let r = 0; r < display; r++) {
      // realIndex: nén đều đại diện (đầu/cuối/giữa) — nơ-ron VẼ gắn chỉ số
      // thật gần nhất để inspector tra bias/|w| đúng unit (units ≤ display:
      // map thẳng 1-1 — với cap 256 BRAIN-LIVE, mọi cột trong khoảng editor
      // 1–256 đều map thẳng, KHÔNG nén)
      const realIndex = col.units <= STAGE_LIMITS.maxDisplayNeurons
        ? r
        : Math.round((r / Math.max(display - 1, 1)) * (col.units - 1))
      neurons.push({
        col: c,
        row: r,
        x: colX[c],
        y: topY + r * rowStep,
        realIndex,
      })
    }
  }
  const height = topY + maxDisplay * rowStep + 26
  return { neurons, colX, height }
}

// ==================== BEZIER (§9.4 "uyển chuyển") ====================

/**
 * Control points bezier cạnh: lệch vuông góc tại trung điểm — cong nhẹ
 * "uyển chuyển" thay đường thẳng. Hướng lệch cố định theo cột (đi lên nhẹ)
 * để mọi cạnh cùng cột uốn nhất quán — đọc được dòng chảy.
 */
export function bezierControls(x1: number, y1: number, x2: number, y2: number): {
  cx1: number; cy1: number; cx2: number; cy2: number
} {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  // Vector đơn vuông góc với (dx, dy) — luôn hướng LÊN (âm y) cho tới 30% dài cạnh
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy)
  const k = len > 0 ? Math.min(0.3 * len, 14) / len : 0
  // vuông góc (dy, -dx) chuẩn hóa — với cạnh ngang (dy=0) cho (0, -1): cong lên
  const px = dy * k
  const py = -dx * k
  const t = 0.32 // đặt control gần đầu/cuối hơn trung điểm — cong mềm
  return {
    cx1: x1 + (mx - x1) * t + px,
    cy1: y1 + (my - y1) * t + py,
    cx2: x2 - (x2 - mx) * t + px,
    cy2: y2 - (y2 - my) * t + py,
  }
}

/** Điểm trên bezier cubic tại t ∈ [0,1] (de Casteljau trực tiếp). */
export function sampleBezier(
  x1: number, y1: number, cx1: number, cy1: number,
  cx2: number, cy2: number, x2: number, y2: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  return {
    x: b0 * x1 + b1 * cx1 + b2 * cx2 + b3 * x2,
    y: b0 * y1 + b1 * cy1 + b2 * cy2 + b3 * y2,
  }
}

/**
 * Khoảng cách điểm→cạnh bezier: rời rạc hóa STAGE_LIMITS.bezierSegments đoạn
 * rồi chấm point-to-segment — hit-target bấm cạnh (r90 pin chính xác).
 */
export function distToEdge(
  px: number,
  py: number,
  e: Pick<StageEdge, 'x1' | 'y1' | 'cx1' | 'cy1' | 'cx2' | 'cy2' | 'x2' | 'y2'>,
  segments: number = STAGE_LIMITS.bezierSegments,
): number {
  let min = Infinity
  let prev = { x: e.x1, y: e.y1 }
  for (let s = 1; s <= segments; s++) {
    const cur = sampleBezier(e.x1, e.y1, e.cx1, e.cy1, e.cx2, e.cy2, e.x2, e.y2, s / segments)
    const d = distPointToSegment(px, py, prev.x, prev.y, cur.x, cur.y)
    if (d < min) min = d
    prev = cur
  }
  return min
}

function distPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = 0
  if (lenSq > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}

/** Tìm cạnh gần nhất trong ngưỡng bấm — null khi không cạnh nào trúng. */
export function hitEdge(
  px: number,
  py: number,
  edges: readonly StageEdge[],
  radius: number = STAGE_LIMITS.edgeHitRadius,
): StageEdge | null {
  let best: StageEdge | null = null
  let bestD = Infinity
  for (const e of edges) {
    const d = distToEdge(px, py, e)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return bestD <= radius ? best : null
}

// ==================== LOD (§9.4 — cắt cạnh đúng) ====================

/**
 * Sampling đại diện TẤT ĐỊNH khi số cạnh vượt maxEdges: giữ đều theo stride
 * (mọi cạnh thứ k) — r90 pin: đúng cap, thứ tự ổn định, không lệch chạy lại.
 * ≤ maxEdges → trả nguyên mảng (bản sao).
 */
export function lodEdges<T extends { id: number }>(edges: readonly T[], cap: number = STAGE_LIMITS.maxEdges): T[] {
  if (edges.length <= cap) return [...edges]
  const stride = edges.length / cap
  const out: T[] = []
  for (let i = 0; i < cap; i++) {
    out.push(edges[Math.floor(i * stride)])
  }
  return out
}

// ==================== LỆCH PHA ANIMATION (§9.4) ====================

/**
 * Độ trễ animation từng cạnh (giây, âm = bắt giữa chu kỳ): lệch pha KHÔNG
 * đều đặn theo id (0.37s bước — không cộng chu kỳ 2.4s nên không bao giờ
 * đồng loạt) — cảm giác dòng chảy chứ không nhấp nháy đồng bộ.
 */
export function edgePhaseSec(id: number, periodSec: number = STAGE_LIMITS.flowPeriodSec): number {
  return -((id * 0.37) % periodSec)
}

/**
 * Bản tĩnh hay động: động CHỈ khi hiệu ứng BẬT VÀ user không bật giảm
 * chuyển động (§9.4 + §9.1-5 — SMIL/CSS animation không tuân media query
 * tự động trong SVG → tự quản qua hook usePrefersReducedMotion).
 */
export function isAnimated(fxEnabled: boolean, prefersReducedMotion: boolean): boolean {
  return fxEnabled && !prefersReducedMotion
}

// ==================== ĐỘ DÀY CẠNH THEO |GRADIENT| (chế độ ngược) ====================

/**
 * Độ dày cạnh chế độ lan truyền NGƯỢC theo |gradient| trung bình lớp (dữ liệu
 * thật từ trainMeta.gradAbsMean): chuẩn hóa min-max qua các lớp rồi map
 * [minW, maxW] = [0.7, 3.2]. Hai trường hợp suy biến được PHÂN BIỆT
 * (FB-BRAIN-UX-R1-07 — trước đây mảng toàn 0 rơi vào nhánh trung vị 1.95,
 * trái JSDoc "Toàn 0 → 1.1"):
 *  - mảng TOÀN 0 (hoặc gradAbsMeanLayer === 0) → fallback 1.1 trung tính —
 *    KHÔNG có tín hiệu thì không giả;
 *  - vals ĐỀU NHAU nhưng > 0 (flat non-zero) → trung vị (minW+maxW)/2 —
 *    CÓ tín hiệu, chỉ là các lớp đều nhau. Thuần.
 */
export function strokeWidthForGrad(
  gradAbsMeanLayer: number | null,
  allLayerGrads: readonly number[],
  minW = 0.7,
  maxW = 3.2,
  fallbackW = 1.1,
): number {
  const vals = allLayerGrads.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  if (gradAbsMeanLayer === null || !Number.isFinite(gradAbsMeanLayer) || vals.length === 0) return fallbackW
  // Toàn 0 = không tín hiệu → trung tính, không giả (FB-BRAIN-UX-R1-07)
  if (vals.every(v => v === 0) || gradAbsMeanLayer === 0) return fallbackW
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  if (hi <= lo) return (minW + maxW) / 2 // đều nhau NHƯNG > 0 — có tín hiệu thật
  const t = Math.max(0, Math.min(1, (gradAbsMeanLayer - lo) / (hi - lo)))
  return minW + t * (maxW - minW)
}

// ==================== MŨI TÊN BẢN TĨNH (reduced-motion) ====================

/**
 * Góc (độ) của tiếp tuyến bezier tại t — đặt mũi tên cho bản tĩnh reduced-
 * motion + lưng cạnh khi động (đầu mũi tên luôn chỉ chiều lan truyền).
 * t=1 là cuối cạnh (điểm đến). Thuần.
 */
export function bezierTangentDeg(
  x1: number, y1: number, cx1: number, cy1: number,
  cx2: number, cy2: number, x2: number, y2: number,
  t: number,
): number {
  const u = 1 - t
  // Đạo hàm bezier cubic: 3u²(P1−P0) + 6ut(P2−P1) + 3t²(P3−P2)
  const dx = 3 * u * u * (cx1 - x1) + 6 * u * t * (cx2 - cx1) + 3 * t * t * (x2 - cx2)
  const dy = 3 * u * u * (cy1 - y1) + 6 * u * t * (cy2 - cy1) + 3 * t * t * (y2 - cy2)
  return (Math.atan2(dy, dx) * 180) / Math.PI
}
