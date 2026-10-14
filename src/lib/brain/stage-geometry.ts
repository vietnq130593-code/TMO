/**
 * BRAIN-UX §9.4 (UX-3) — HÌNH HỌC SÂN KHẤU NÃO (THUẦN, test r90)
 * ============================================================================
 *
 * Toán trình bày của BrainStage (đường dây ánh sáng): cạnh THẲNG (Task 26
 * — chỉ thị user 2026-10-13 "Đường kết nối dạng THẲNG (hiện hơi cong — bỏ
 * cong)" — thay bezier cong của UX-3), LOD cắt cạnh, hit-target
 * point-to-segment CHÍNH XÁC (không còn rời rạc hóa), lệch pha animation,
 * độ dày cạnh theo |gradient| thật, mũi tên bản tĩnh reduced-motion.
 *
 * GEOMETRY v3 (BRAIN-TAB-3PHAN — chỉ thị user 2026-10-12, trích ngắn:
 * "giao diện lớp có thể chỉnh to nhỏ để xem từ tổng quan đến chi tiết được.
 * Nếu số nơ rọn nhiều thì các điểm nơ ron chỉnh kích thước nhỏ lại, vị trí
 * các lớp chỉnh căn giữa thay vì căn trên như hiện tại"): cột nơ-ron
 * CENTER-ALIGN dọc + rowStep/radius THÍCH ỨNG TỪNG CỘT + width động —
 * xem JSDoc buildStageLayout (toán v3 gói hết ở đó, r90-J pin từng số).
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
  /** Chu kỳ animation nét đứt (giây) — §9.4: 2.4s linear infinite */
  flowPeriodSec: 2.4,
  /**
   * Ngưỡng bấm cạnh — 12 đơn vị viewBox (~12-18px CSS tùy scale); kết hợp
   * padding cảm ứng của trình duyệt; các NÚT UI đạt 44px thật (min-h-44
   * mobile) — cạnh SVG nhỏ hơn vì phải tách biệt giữa các cạnh kề nhau
   * (đánh đổi độ chính xác bấm). (FB-BRAIN-UX-R1-06: 7 → 12)
   */
  edgeHitRadius: 12,
  // MỚI v3 (BRAIN-TAB-3PHAN — chỉ thị user "nơ ron nhiều thì các điểm
  // nơ ron chỉnh kích thước nhỏ lại" + "vị trí các lớp chỉnh căn giữa thay
  // vì căn trên như hiện tại"):
  /** Khoảng cách nơ-ron cột thưa (diện mạo cũ v2) */
  rowStepMax: 17,
  /** Sàn khoảng cách cột dày đặc (256 nơ-ron → 255×2=510 thay vì 4404) */
  rowStepMin: 2,
  /** Ngân sách chiều cao nội dung cột cao nhất (viewBox units) — vượt thì co rowStep */
  targetContentSpan: 400,
  /** Bán kính nơ-ron lớn nhất (như v2) */
  neuronRMax: 6.5,
  /** Sàn bán kính nơ-ron cột dày đặc */
  neuronRMin: 0.7,
} as const

// ==================== LAYOUT ====================

/**
 * Dựng toạ độ cột + nơ-ron — GEOMETRY v3 (BRAIN-TAB-3PHAN). Tất định,
 * thuần — cùng input luôn ra cùng output (r90-J pin từng số).
 *
 * Chỉ thị user 2026-10-12 (trích ngắn): "giao diện lớp có thể chỉnh to nhỏ
 * để xem từ tổng quan đến chi tiết được. Nếu số nơ rọn nhiều thì các điểm
 * nơ ron chỉnh kích thước nhỏ lại, vị trí các lớp chỉnh căn giữa thay vì
 * căn trên như hiện tại" — tách thành 4 luật:
 *  1. CENTER-ALIGN dọc: cột ngắn lơ lửng GIỮA chiều cao cột cao nhất —
 *     yStart_c = topY + (contentSpan − colSpan_c)/2 (v2 kéo mọi cột về
 *     top: cột 1 nơ-ron dính sát y=26 — giờ nằm giữa: 26 + contentSpan/2).
 *  2. rowStep THÍCH ỨNG TỪNG CỘT: rowStep_c = clamp(targetContentSpan /
 *     max(display_c−1, 1), rowStepMin, rowStepMax) — cột thưa giữ diện mạo
 *     v2 (17 — display ≤ ~24), cột dày đặc co lại (64 → ≈6.35; 256 → sàn 2,
 *     span 510 thay vì 4404 absurd của v2).
 *  3. radius THÍCH ỨNG TỪNG CỘT ("nơ ron nhiều thì chấm nhỏ lại"):
 *     radius_c = clamp(rowStep_c × 0.36, neuronRMin, neuronRMax) — display
 *     ≤ ~24 → 6.1–6.5 (giữ diện mạo v2); 64 → ≈2.29; 256 → 0.72.
 *  4. width ĐỘNG theo số cột: clamp(n × 130, 340, 900) — tab BRAIN mới
 *     full-width (layout 3 phần BRAIN-TAB-3PHAN) thay hằng 340 cứng v2.
 *     R7 (user report "2 bên đài quan sát có 2 khoảng đen lãng phí"):
 *     widthOverride — caller truyền width khớp TỈ LỆ khung chứa (boxW/boxH)
 *     → viewBox aspect ≡ stageBox aspect → SVG lấp FULL khung, HẾT letterbox
 *     trái/phải (cột dàn trải rộng hơn — nơ-ron/cạnh to lên cùng scale).
 *     height KHÔNG phụ thuộc width nên override không đổi chiều cao nội dung.
 *
 * height = topY + contentSpan + 50 (50 = chỗ 2 dòng nhãn dưới đáy — vẽ tại
 * height−18/height−28 do component). BRAIN-LIVE (giữ): vẽ ĐÚNG units từng
 * lớp (display = min(units, 256)); nén đại diện units > 256 giữ nguyên thuật
 * toán cũ (đầu 0, cuối units−1, đơn điệu).
 */
/**
 * R7 — widthOverride: độ rộng viewBox mong muốn (đơn vị viewBox). > 0 thì
 * DÙNG thay cho clamp(n×130, 340, 900) — để BrainStage tính width sao cho
 * tỉ lệ viewBox ≡ tỉ lệ khung chứa (SVG fill full box, không còn 2 dải đen
 * hai bên). Thuần + backward-compatible (không truyền → đúng giá trị cũ).
 */
export function buildStageLayout(
  columns: readonly StageColumn[],
  widthOverride?: number,
): {
  neurons: StageNeuron[]
  colX: number[]
  height: number
  /** Rộng viewBox — động theo số cột: clamp(n×130, 340, 900) — hoặc widthOverride (R7) */
  width: number
  /** Khoảng cách nơ-ron dọc TỪNG CỘT (thích ứng độ dày) */
  rowStep: number[]
  /** Bán kính nơ-ron TỪNG CỘT (clamp rowStep×0.36 vào [neuronRMin, neuronRMax]) */
  radius: number[]
} {
  const n = columns.length
  if (n === 0) return { neurons: [], colX: [], height: 100, width: 340, rowStep: [], radius: [] }
  const width = typeof widthOverride === 'number' && Number.isFinite(widthOverride) && widthOverride > 0
    ? widthOverride
    : Math.min(900, Math.max(340, n * 130))
  const marginX = 34
  const stepX = n > 1 ? (width - 2 * marginX) / (n - 1) : 0
  const colX = Array.from({ length: n }, (_, i) => marginX + i * stepX)

  const topY = 26
  // Pass 1 — mỗi cột: display + rowStep thích ứng + colSpan + radius
  const rowStep: number[] = []
  const radius: number[] = []
  const colSpan: number[] = []
  for (let c = 0; c < n; c++) {
    const display = Math.min(columns[c].units, STAGE_LIMITS.maxDisplayNeurons)
    const step = Math.min(
      STAGE_LIMITS.rowStepMax,
      Math.max(STAGE_LIMITS.rowStepMin, STAGE_LIMITS.targetContentSpan / Math.max(display - 1, 1)),
    )
    rowStep.push(step)
    radius.push(Math.min(STAGE_LIMITS.neuronRMax, Math.max(STAGE_LIMITS.neuronRMin, step * 0.36)))
    colSpan.push((display - 1) * step) // display 1 → span 0 (nơ-ron đơn lơ lửng giữa)
  }
  const contentSpan = Math.max(...colSpan) // chiều cao nội dung cột CAO NHẤT
  // Pass 2 — nơ-ron: CENTER-ALIGN — yStart_c = topY + (contentSpan − colSpan_c)/2
  const neurons: StageNeuron[] = []
  for (let c = 0; c < n; c++) {
    const col = columns[c]
    const display = Math.min(col.units, STAGE_LIMITS.maxDisplayNeurons)
    const yStart = topY + (contentSpan - colSpan[c]) / 2
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
        y: yStart + r * rowStep[c],
        realIndex,
      })
    }
  }
  const height = topY + contentSpan + 50
  return { neurons, colX, height, width, rowStep, radius }
}

// ==================== CẠNH THẲNG (Task 26 — bỏ cong) ====================

/**
 * Khoảng cách điểm→cạnh THẲNG: công thức chiếu vuông góc chuẩn — CHÍNH XÁC
 * cho mọi điểm (Task 26 thay bezier: trước đây rời rạc hóa 24 đoạn rồi chấm
 * point-to-segment — sai số nhỏ nhưng thừa; cạnh thẳng cho khoảng cách đóng
 * dạng đóng, không cần mẫu). Thuần.
 */
export function distToEdge(
  px: number,
  py: number,
  e: Pick<StageEdge, 'x1' | 'y1' | 'x2' | 'y2'>,
): number {
  const dx = e.x2 - e.x1
  const dy = e.y2 - e.y1
  const lenSq = dx * dx + dy * dy
  let t = 0
  if (lenSq > 0) t = Math.max(0, Math.min(1, ((px - e.x1) * dx + (py - e.y1) * dy) / lenSq))
  const cx = e.x1 + t * dx
  const cy = e.y1 + t * dy
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
// Task 26 (cạnh thẳng): góc tiếp tuyến tại t ≡ góc đoạn thẳng — marker SVG
// orient="auto" tự lo (không còn cần hàm riêng như bezierTangentDeg của UX-3).
