/**
 * ROUND-90 TESTS — BRAIN-UX §9.4 (UX-3) · HÌNH HỌC SÂN KHẤU NÃO (THUẦN)
 * (blueprint v0.10 §9.4 — stage-geometry.ts, mọi công thức trình bày của
 * BrainStage: cạnh THẲNG (PIN UPDATE Task 26 — chỉ thị user 2026-10-13
 * "Đường kết nối dạng THẲNG (hiện hơi cong — bỏ cong)" — thay bezier cong
 * của UX-3) · LOD · hit-target point-to-segment CHÍNH XÁC · lệch pha
 * animation · độ dày |gradient| · mũi tên bản tĩnh)
 *
 * Đo lường (THUẦN — không DB, không React, không env):
 *   A. distToEdge cạnh THẲNG (PIN UPDATE Task 26 — thay A bezierControls +
 *      B sampleBezier của UX-3): điểm TRÊN đoạn (đầu/giữa/cuối) → 0 CHÍNH
 *      XÁC (không còn sai số rời rạc hóa 24 đoạn) · lệch vuông góc → đúng
 *      khoảng cách Euclid · ngoài 2 đầu → khoảng cách tới ĐẦU segment gần
 *      nhất (không kẹp giả) · degenerate (đoạn dài 0) → Euclid an toàn.
 *   B. (đã gộp vào A — Task 26 bỏ sampleBezier cùng bezierControls)
 *   C. distToEdge điểm xa → khoảng cách lớn (giữ vỏ bọc chống hồi quy).
 *   D. hitEdge: 2 cạnh thẳng tách biệt → query trả đúng cạnh · ngoài radius
 *      → null · điểm TRÊN đoạn luôn hit kể cả radius ép hẹp (cạnh thẳng cho
 *      hit chính xác — trước-fix (60,45) miss 5.5 do cong lệch khỏi đoạn).
 *   E. lodEdges: 300 phần tử nguyên vẹn (bản sao) · 1000 → cap 300 · id tăng
 *      nghiêm ngặt · giữ [0] gốc · 2 lần chạy RA GIỐNG HỆT.
 *   F. edgePhaseSec: mọi giá trị ∈ [-2.4, 0) · 8 id liên tiếp ≥ 6 giá trị
 *      khác nhau (không đồng loạt nhấp nháy).
 *   G. isAnimated bảng chân trị 4 tổ hợp (fx ∧ ¬reduced-motion).
 *   H. strokeWidthForGrad: null → 1.1 trung tính · [] → 1.1 (không dữ liệu
 *      không giả tín hiệu) · min-max map [0.7, 3.2] · đơn điệu theo giá trị
 *      · toàn 0 → 1.1 / flat non-zero → trung vị 1.95 (PIN UPDATE
 *      FB-BRAIN-UX-R1-07 — nguồn đã sửa theo doc).
 *   I. (ĐÃ BỎ Task 26 — bezierTangentDeg bỏ cùng bezier; marker SVG
 *      orient="auto" tự lo góc mũi tên trên đoạn thẳng.)
 *   J. buildStageLayout (PIN UPDATE BRAIN-TAB-3PHAN — center-align +
 *      rowStep thích ứng + radius cột; chỉ thị user 2026-10-12 "vị trí các
 *      lớp chỉnh căn giữa thay vì căn trên như hiện tại" + "nơ ron nhiều
 *      thì các điểm nơ ron chỉnh kích thước nhỏ lại"): đủ cột · vẽ ĐÚNG
 *      units (10/16/1 → tổng 27, KHÔNG nén) · CENTER-ALIGN [10,16,1] yStart
 *      77/26/153.5 + height 331 · [256,8] rowStep [2,17] + height 586 (thay
 *      4404) + cột 8 center y=221.5 + radius [0.72, 6.12] · realIndex thẳng
 *      ≤ 256 / nén đơn điệu > 256 · rowStep/radius đơn điệu theo display ·
 *      width động clamp(n×130, 340, 900).
 *
 * Ghi nhận nguồn (ĐÃ SỬA đợt fixbug FB-BRAIN-UX-R1-07):
 *   strokeWidthForGrad(0, [0,0]) TRƯỚC đây 1.95 (trung vị [0.7,3.2]) trái
 *   JSDoc "Toàn 0 → 1.1" — nguồn stage-geometry.ts giờ phân biệt 2 trường
 *   hợp suy biến (toàn 0 → fallback 1.1 trung tính; flat non-zero → trung
 *   vị); pin H4 cập nhật kèm assert (2,[2,2]) → 1.95.
 */

import { describe, test, expect } from 'bun:test'
import {
  distToEdge,
  hitEdge,
  lodEdges,
  edgePhaseSec,
  isAnimated,
  strokeWidthForGrad,
  buildStageLayout,
  STAGE_LIMITS,
  type StageColumn,
  type StageEdge,
} from '@/lib/brain/stage-geometry'

/**
 * Cạnh ngang chuẩn (10,50)→(110,50) — Task 26 THẲNG: không còn control
 * point. Object literal KHÔNG truyền cx1… là pin compile-time: StageEdge
 * không còn field control (nếu nguồn thêm lại thì dư thuộc tính → TS2353).
 */
const H_EDGE: StageEdge = {
  id: 1, fromCol: 0, toCol: 1, fromRow: 0, toRow: 0,
  x1: 10, y1: 50, x2: 110, y2: 50,
}

/** Dựng StageEdge hoàn chỉnh từ 2 điểm (id + toạ độ — THẲNG, không bezier). */
function makeEdge(id: number, x1: number, y1: number, x2: number, y2: number): StageEdge {
  return { id, fromCol: 0, toCol: 1, fromRow: 0, toRow: 0, x1, y1, x2, y2 }
}

// ==================== A. distToEdge cạnh THẲNG (PIN UPDATE Task 26) ====================

describe('r90 · A distToEdge — cạnh THẲNG, khoảng cách CHÍNH XÁC (Task 26 bỏ cong)', () => {
  test('điểm TRÊN đoạn (đầu/giữa/cuối) → 0 chính xác — không còn sai số rời rạc hóa 24 đoạn', () => {
    expect(distToEdge(60, 50, H_EDGE)).toBe(0) // giữa đoạn — chiếu trúng
    expect(distToEdge(10, 50, H_EDGE)).toBe(0) // đầu đoạn
    expect(distToEdge(110, 50, H_EDGE)).toBe(0) // cuối đoạn
  })

  test('điểm lệch vuông góc → đúng khoảng cách Euclid (đoạn y=50: (60,62) → 12)', () => {
    // Chiếu vuông góc của (60,62) lên đoạn y=50 là (60,50) → d = 12 chính xác
    expect(distToEdge(60, 62, H_EDGE)).toBeCloseTo(12, 12)
    expect(distToEdge(60, 50 - 7.5, H_EDGE)).toBeCloseTo(7.5, 12)
  })

  test('điểm NGOÀI 2 đầu → khoảng cách tới ĐẦU gần nhất (chiếu bị kẹp t∈[0,1])', () => {
    // (200, 80): chiếu t>1 → kẹp t=1 → cuối đoạn (110,50): d = √(90²+30²)
    expect(distToEdge(200, 80, H_EDGE)).toBeCloseTo(Math.hypot(90, 30), 12)
    // (-40, 50): chiếu t<0 → kẹp t=0 → đầu đoạn (10,50): d = 50
    expect(distToEdge(-40, 50, H_EDGE)).toBeCloseTo(50, 12)
  })

  test('đoạn degenerate (dài 0) → khoảng cách Euclid tới chính điểm đó (lenSq=0 an toàn)', () => {
    const dot = makeEdge(9, 30, 40, 30, 40)
    expect(distToEdge(34, 48, dot)).toBeCloseTo(Math.hypot(4, 8), 12) // √80
    expect(distToEdge(30, 40, dot)).toBe(0)
  })
})

// ==================== B. (đã gộp vào A — Task 26 bỏ sampleBezier) ====================

// ==================== C. distToEdge — điểm xa (chống kẹp giả) ====================

describe('r90 · C distToEdge — điểm cách xa → khoảng cách lớn', () => {
  test('(60,300) cách đoạn y=50 → 250; (200,50) ngoài cuối đoạn → 90', () => {
    expect(distToEdge(60, 300, H_EDGE)).toBeCloseTo(250, 12)
    expect(distToEdge(200, 50, H_EDGE)).toBeCloseTo(90, 12)
    expect(distToEdge(60, 300, H_EDGE)).toBeGreaterThan(200)
  })
})

// ==================== D. hitEdge ====================

describe('r90 · D hitEdge — chọn cạnh trong ngưỡng bấm (cạnh THẲNG)', () => {
  // 2 cạnh thẳng tách biệt: e1 y=50, e2 y=200 — hit CHÍNH XÁC trên đoạn
  const e1 = makeEdge(1, 10, 50, 110, 50)
  const e2 = makeEdge(2, 10, 200, 110, 200)

  test('query sát cạnh 1 → trả đúng cạnh 1; sát cạnh 2 → đúng cạnh 2', () => {
    expect(hitEdge(10, 50, [e1, e2])?.id).toBe(1) // đầu cạnh 1
    expect(hitEdge(60, 50, [e1, e2])?.id).toBe(1) // GIỮA cạnh 1 — điểm TRÊN đoạn → d=0
    expect(hitEdge(60, 200, [e1, e2])?.id).toBe(2) // giữa cạnh 2
    expect(hitEdge(110, 200, [e1, e2])?.id).toBe(2) // cuối cạnh 2
  })

  test('ngoài radius (12 đơn vị viewBox — PIN UPDATE FB-BRAIN-UX-R1-06: 7 → 12 cho touch target) → null (không bấm nhầm)', () => {
    // (60,120): cách e1 = 70, cách e2 = 80 — ngoài STAGE_LIMITS.edgeHitRadius
    // (PIN UPDATE FB-BRAIN-UX-R1-06: nâng 7 → 12 đơn vị viewBox ≈ 12-18px CSS —
    // cạnh SVG nhỏ hơn nút 44px vì phải tách biệt giữa các cạnh kề nhau)
    expect(hitEdge(60, 120, [e1, e2])).toBeNull()
  })

  test('PIN UPDATE Task 26: điểm TRÊN đoạn luôn hit kể cả radius ép hẹp (d=0 — cạnh thẳng chính xác)', () => {
    // Trước-fix (60,45) cách đường CONG ≈ 5.5 → miss radius 2; cạnh thẳng
    // thì (60,50) nằm TRÊN đoạn → d=0 → hit ngay cả radius 0.5
    expect(hitEdge(60, 50, [e1], 0.5)?.id).toBe(1)
    // Còn (60,45) cách đoạn THẲNG y=50 đúng 5 đơn vị → miss radius 2
    expect(hitEdge(60, 45, [e1], 2)).toBeNull()
    expect(hitEdge(60, 45, [e1], 5)?.id).toBe(1) // radius 5 chạm đúng ngưỡng
  })
})

// ==================== E. lodEdges (LOD budget §9.4) ====================

describe('r90 · E lodEdges — sampling đại diện tất định', () => {
  test('300 phần tử (= cap) → giữ NGUYÊN 300 (bản sao, cùng thứ tự)', () => {
    const src = Array.from({ length: 300 }, (_, i) => ({ id: i }))
    const out = lodEdges(src, STAGE_LIMITS.maxEdges)
    expect(out).toHaveLength(300)
    expect(out.every((e, i) => e.id === i)).toBe(true) // cùng thứ tự
    expect(out).not.toBe(src) // bản sao — không cùng tham chiếu
  })

  test('1000 → cap 300: id tăng NGHIÊM NGẶT, [0] = gốc[0], 2 lần RA GIỐNG HỆT', () => {
    const src = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
    const out1 = lodEdges(src, STAGE_LIMITS.maxEdges)
    const out2 = lodEdges(src, STAGE_LIMITS.maxEdges)
    expect(out1).toHaveLength(300)
    expect(out1[0].id).toBe(0) // giữ cạnh ĐẦU (spec §9.4 pin)
    // Sampling theo stride floor(i×1000/300): mẫu cuối = floor(299×3.33) = 996
    // (stride đều — KHÔNG đảm bảo giữ đúng cạnh cuối nguồn; pin trung thực)
    expect(out1[out1.length - 1].id).toBe(996)
    // Tăng nghiêm ngặt (mọi cạnh thứ k — không trùng lặp)
    expect(out1.every((e, i) => i === 0 || e.id > out1[i - 1].id)).toBe(true)
    // Tất định — 2 lần chạy deep-equal (r90 pin spec §9.4)
    expect(out1).toEqual(out2)
  })
})

// ==================== F. edgePhaseSec (lệch pha animation) ====================

describe('r90 · F edgePhaseSec — lệch pha KHÔNG đều đặn', () => {
  test('mọi giá trị ∈ [-2.4, 0) — âm = bắt giữa chu kỳ 2.4s', () => {
    // id ≥ 1 (id=0 → -0 là biên đại diện trung tính); quét 60 id đầu
    for (let id = 1; id <= 60; id++) {
      const p = edgePhaseSec(id)
      expect(p).toBeGreaterThanOrEqual(-STAGE_LIMITS.flowPeriodSec)
      expect(p).toBeLessThan(0)
    }
  })

  test('8 id liên tiếp có ≥ 6 giá trị khác nhau (không đồng loạt)', () => {
    const phases = Array.from({ length: 8 }, (_, i) => edgePhaseSec(i + 1))
    // Bước 0.37s không phải ước của chu kỳ 2.4s → hầu như không trùng pha
    expect(new Set(phases).size).toBeGreaterThanOrEqual(6)
  })
})

// ==================== G. isAnimated (bảng chân trị) ====================

describe('r90 · G isAnimated — bảng chân trị 4 tổ hợp', () => {
  test('CHỈ (fx bật, không reduced-motion) → động; 3 tổ hợp còn lại tĩnh', () => {
    expect(isAnimated(true, false)).toBe(true) // fx ON + motion OK → động
    expect(isAnimated(true, true)).toBe(false) // fx ON + reduced-motion → tĩnh (§9.1-5)
    expect(isAnimated(false, false)).toBe(false) // fx OFF → tĩnh như trước UX-3
    expect(isAnimated(false, true)).toBe(false)
  })
})

// ==================== H. strokeWidthForGrad (độ dày |gradient| thật) ====================

describe('r90 · H strokeWidthForGrad — map min-max [0.7, 3.2]', () => {
  test('null → 1.1 trung tính; mảng rỗng → 1.1 (không dữ liệu KHÔNG giả tín hiệu)', () => {
    expect(strokeWidthForGrad(null, [1, 2])).toBe(1.1)
    expect(strokeWidthForGrad(0, [])).toBe(1.1)
    expect(strokeWidthForGrad(Number.NaN, [1, 2])).toBe(1.1)
  })

  test('[1,2] với layer=1 → minW 0.7; layer=2 → maxW 3.2 (chạm 2 biên map)', () => {
    expect(strokeWidthForGrad(1, [1, 2])).toBeCloseTo(0.7, 12)
    expect(strokeWidthForGrad(2, [1, 2])).toBeCloseTo(3.2, 12)
  })

  test('đơn điệu TĂNG theo giá trị |gradient| lớp (chuẩn hoá min-max)', () => {
    const prev = [0.5, 1, 1.5, 2].map(v => strokeWidthForGrad(v, [0.5, 2]))
    for (let i = 1; i < prev.length; i++) expect(prev[i]).toBeGreaterThan(prev[i - 1])
  })

  test('PIN UPDATE FB-BRAIN-UX-R1-07: mảng toàn 0 giờ trả 1.1 (đúng JSDoc); flat non-zero giữ trung vị 1.95', () => {
    // PIN UPDATE FB-BRAIN-UX-R1-07 (sửa nguồn theo doc — hành vi an toàn):
    // (0,[0,0]) trước đây 1.95 (nhánh hi≤lo trả trung vị [0.7,3.2]/2, trái
    // JSDoc "Toàn 0 → 1.1"). Giờ phân biệt 2 trường hợp suy biến:
    // toàn 0 → fallback 1.1 trung tính (không có tín hiệu — không giả).
    const w = strokeWidthForGrad(0, [0, 0])
    expect(w).toBe(1.1)
    // Đầu vào hợp lệ + mảng ĐỀU > 0 (flat non-zero) vẫn trung vị — cùng nhánh
    expect(strokeWidthForGrad(1, [1, 1])).toBeCloseTo(1.95, 10)
    // Assert thêm (R1-07): (2,[2,2]) flat non-zero → 1.95 (có tín hiệu, đều nhau)
    expect(strokeWidthForGrad(2, [2, 2])).toBeCloseTo(1.95, 10)
  })
})

// ==================== I. (ĐÃ BỎ Task 26 — bezierTangentDeg bỏ cùng bezier) ====================

// ==================== J. buildStageLayout (geometry v3) ====================

describe('r90 · J buildStageLayout — geometry v3 center-align + rowStep/radius thích ứng (PIN UPDATE BRAIN-TAB-3PHAN)', () => {
  // Spec thật Brain-A (registry planned 10→16→1) — BRAIN-LIVE vẽ đủ 27 nơ-ron
  const columns: StageColumn[] = [
    { units: 10, display: 0, label: '1-hot cfg', activation: 'linear', locked: true },
    { units: 16, display: 0, label: '×16', activation: 'tanh', locked: false },
    { units: 1, display: 0, label: 'sigmoid', activation: 'sigmoid', locked: true },
  ]

  test('width ĐỘNG + colX đều nhau: 3 cột → width 390 (clamp 3×130), bước 161, margin 34', () => {
    const lay = buildStageLayout(columns)
    expect(lay.colX).toHaveLength(3)
    // Bước đều: colX[i+1] − colX[i] hằng số (390 − 2×34) / 2 = 161
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(lay.colX[2] - lay.colX[1], 10)
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(161, 10)
    expect(lay.colX[0]).toBeCloseTo(34, 10)
    expect(lay.colX[2]).toBeCloseTo(356, 10)
  })

  test('PIN UPDATE BRAIN-TAB-3PHAN: vẽ ĐÚNG units + CENTER-ALIGN + rowStep 17 + radius 6.12 + height 331', () => {
    const lay = buildStageLayout(columns)
    // Chỉ thị user 2026-10-12 "mỗi lớp có bao nhiêu nơ-ron thì hiển thị đúng
    // số điểm nơ-ron đấy" — cap 256 giữ từ BRAIN-LIVE
    expect(lay.neurons).toHaveLength(27) // 10 + 16 + 1
    for (let c = 0; c < 3; c++) {
      const inCol = lay.neurons.filter(n => n.col === c)
      expect(inCol.length).toBe(columns[c].units)
      expect(inCol.length).toBe(Math.min(columns[c].units, STAGE_LIMITS.maxDisplayNeurons))
    }
    // rowStep cột thưa giữ diện mạo v2 (17) — mỗi cột MỘT entry (thích ứng)
    expect(lay.rowStep).toEqual([17, 17, 17])
    // radius = clamp(17×0.36, 0.7, 6.5) = 6.12 (cả 3 cột thưa)
    expect(lay.radius[0]).toBeCloseTo(6.12, 10)
    expect(lay.radius[2]).toBeCloseTo(6.12, 10)
    // colSpan [153, 255, 0] → contentSpan 255 → CENTER yStart = 26 + (255−colSpan)/2
    // (chỉ thị user "vị trí các lớp chỉnh căn giữa thay vì căn trên"):
    //   c0 = 26+(255−153)/2 = 77 · c1 = 26 · c2 = 26+127.5 = 153.5
    const yOf = (c: number, r: number) => lay.neurons.find(n => n.col === c && n.row === r)!.y
    expect(yOf(0, 0)).toBeCloseTo(77, 10)
    expect(yOf(0, 9)).toBeCloseTo(77 + 9 * 17, 10) // 230
    expect(yOf(1, 0)).toBeCloseTo(26, 10)
    expect(yOf(1, 15)).toBeCloseTo(26 + 15 * 17, 10) // 281
    // LINH HỒN center-align: cột 1 nơ-ron y = 26 + contentSpan/2 = 153.5
    expect(yOf(2, 0)).toBeCloseTo(153.5, 10)
    // height = 26 + contentSpan(255) + 50 = 331 (thay 324 v2 — 50 chỗ nhãn)
    expect(lay.height).toBe(26 + 255 + 50)
    expect(lay.height).toBe(331)
  })

  test('units ≤ 256 → realIndex = row (ánh xạ thẳng 1-1 cho inspector)', () => {
    const lay = buildStageLayout(columns)
    for (let c = 0; c < 3; c++) {
      const inCol = lay.neurons.filter(n => n.col === c)
      // Mọi cột trong khoảng editor 1–256 đều map thẳng (10 → [0..9], 16 → [0..15], 1 → [0])
      expect(inCol.map(n => n.realIndex)).toEqual(inCol.map((_, r) => r))
    }
    // Biên đúng cap: 256 units → vẽ đủ 256, vẫn ánh xạ thẳng (256 ≤ 256)
    const lay2 = buildStageLayout([{ ...columns[1], units: 256 }, columns[2]])
    const col0 = lay2.neurons.filter(n => n.col === 0)
    expect(col0.length).toBe(256)
    expect(col0[255].realIndex).toBe(255)
    // rowStep sàn 2 (dày đặc) → span 255×2 = 510 → height 586 thay 4404 cũ
    expect(lay2.height).toBe(26 + 510 + 50) // 586 — cột 256 KHÔNG kéo stage cao absurd
  })

  test('PIN [256, 8]: rowStep [2, 17] + height 586 (thay 4404) + cột 8 CENTER y=221.5 + radius [0.72, 6.12]', () => {
    const lay = buildStageLayout([
      { units: 256, display: 0, label: '×256', activation: 'tanh', locked: false },
      { units: 8, display: 0, label: '8', activation: 'tanh', locked: false },
    ])
    expect(lay.width).toBe(340) // clamp(2×130 = 260, 340, 900) — kẹp dưới
    expect(lay.colX).toEqual([34, 306]) // bước (340−68)/1 = 272
    // rowStep thích ứng: 400/255 ≈ 1.57 → SÀN 2; cột 8 thưa → 17
    expect(lay.rowStep).toEqual([2, 17])
    // radius: cột dày đặc chấm NHỎ lại 2×0.36 = 0.72; cột thưa 6.12
    expect(lay.radius[0]).toBeCloseTo(0.72, 10)
    expect(lay.radius[1]).toBeCloseTo(6.12, 10)
    // colSpan [510, 119] → contentSpan 510 → height = 26 + 510 + 50 = 586
    expect(lay.height).toBe(586)
    // Cột cao nhất top tự nhiên: y = 26 + row×2
    const c0 = lay.neurons.filter(n => n.col === 0)
    expect(c0[0].y).toBeCloseTo(26, 10)
    expect(c0[255].y).toBeCloseTo(26 + 255 * 2, 10) // 536
    // CENTER-ALIGN: cột 8 (row 0) y = 26 + (510−119)/2 = 221.5 ≠ 26 (v2 top)
    const c1 = lay.neurons.filter(n => n.col === 1)
    expect(c1[0].y).toBeCloseTo(221.5, 10)
    expect(c1[7].y).toBeCloseTo(221.5 + 7 * 17, 10) // 340.5
    // Tất định — 2 lần dựng deep-equal
    expect(buildStageLayout(columns)).toEqual(buildStageLayout(columns))
  })

  test('PIN UPDATE BRAIN-LIVE: units > 256 (300) → vẽ 256 + nén đều: đầu 0, cuối units−1, đơn điệu không giảm', () => {
    const lay = buildStageLayout([{ ...columns[1], units: 300 }, columns[2]])
    const col0 = lay.neurons.filter(n => n.col === 0) // units 300, vẽ 256
    expect(col0.length).toBe(256)
    expect(col0.length).toBeLessThanOrEqual(STAGE_LIMITS.maxDisplayNeurons)
    const idx = col0.map(n => n.realIndex) as number[]
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(299) // units − 1
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1])).toBe(true)
  })

  test('rowStep + radius ĐƠN ĐIỆU theo display (nhiều nơ-ron → thưa nhỏ + chấm nhỏ)', () => {
    // Chỉ thị user "nơ ron nhiều thì các điểm nơ ron chỉnh kích thước nhỏ lại"
    const layOf = (units: number) => buildStageLayout([
      { units, display: 0, label: 'x', activation: 'tanh', locked: false },
      { units: 3, display: 0, label: 'x', activation: 'tanh', locked: false },
    ])
    // Pin điểm: 16 → 17 (giữ diện mạo v2); 64 → 400/63 ≈ 6.349; 256 → sàn 2
    expect(layOf(16).rowStep[0]).toBe(17)
    expect(layOf(64).rowStep[0]).toBeCloseTo(400 / 63, 10)
    expect(layOf(256).rowStep[0]).toBe(2)
    // Sweep đơn điệu KHÔNG TĂNG theo display (8/16/24 đều kẹp 17 — bằng nhau)
    const displays = [8, 16, 24, 64, 100, 200, 256]
    const steps = displays.map(d => layOf(d).rowStep[0])
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1])
    // radius cùng chiều: clamp(rowStep×0.36, 0.7, 6.5)
    expect(layOf(16).radius[0]).toBeCloseTo(6.12, 10)
    expect(layOf(64).radius[0]).toBeCloseTo((400 / 63) * 0.36, 10) // ≈ 2.286
    expect(layOf(256).radius[0]).toBeCloseTo(0.72, 10)
    const radii = displays.map(d => layOf(d).radius[0])
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThanOrEqual(radii[i - 1])
  })

  test('width động clamp(n×130, 340, 900): 1→340 · 2→340 · 3→390 · 4→520 · 6→780 · 7/8→900', () => {
    const widthOf = (n: number) => buildStageLayout(
      Array.from({ length: n }, () => ({ units: 3, display: 0, label: 'x', activation: 'tanh', locked: false }) as StageColumn),
    ).width
    expect(widthOf(1)).toBe(340) // 130 → kẹp dưới
    expect(widthOf(2)).toBe(340) // 260 → kẹp dưới
    expect(widthOf(3)).toBe(390)
    expect(widthOf(4)).toBe(520)
    expect(widthOf(6)).toBe(780)
    expect(widthOf(7)).toBe(900) // 910 → kẹp trên
    expect(widthOf(8)).toBe(900) // 1040 → kẹp trên
  })
})
