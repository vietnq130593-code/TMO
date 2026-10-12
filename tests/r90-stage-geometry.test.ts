/**
 * ROUND-90 TESTS — BRAIN-UX §9.4 (UX-3) · HÌNH HỌC SÂN KHẤU NÃO (THUẦN)
 * (blueprint v0.10 §9.4 — stage-geometry.ts, mọi công thức trình bày của
 * BrainStage: bezier cạnh · LOD · hit-target · lệch pha · độ dày |gradient| ·
 * mũi tên bản tĩnh)
 *
 * Đo lường (THUẦN — không DB, không React, không env):
 *   A. bezierControls: cạnh ngang cong LÊN (cả 2 control cy < y) · đối xứng
 *      quanh trung điểm (offset vuông góc) · cạnh dọc → control lệch ngang.
 *   B. sampleBezier: t=0 = điểm đầu · t=1 = điểm cuối · t=0.5 trong bao.
 *   C. distToEdge: điểm TRÙNG đầu cạnh → 0 · điểm trên đường cong (chính
 *      sampleBezier t=0.5) → ≤ 0.5 (rời rạc hóa 24 đoạn) · điểm xa → lớn.
 *   D. hitEdge: 2 cạnh tách biệt → query trả đúng cạnh · ngoài radius → null.
 *   E. lodEdges: 300 phần tử nguyên vẹn (bản sao) · 1000 → cap 300 · id tăng
 *      nghiêm ngặt · giữ [0] gốc · 2 lần chạy RA GIỐNG HỆT.
 *   F. edgePhaseSec: mọi giá trị ∈ [-2.4, 0) · 8 id liên tiếp ≥ 6 giá trị
 *      khác nhau (không đồng loạt nhấp nháy).
 *   G. isAnimated bảng chân trị 4 tổ hợp (fx ∧ ¬reduced-motion).
 *   H. strokeWidthForGrad: null → 1.1 trung tính · [] → 1.1 (không dữ liệu
 *      không giả tín hiệu) · min-max map [0.7, 3.2] · đơn điệu theo giá trị
 *      · toàn 0 → 1.1 / flat non-zero → trung vị 1.95 (PIN UPDATE
 *      FB-BRAIN-UX-R1-07 — nguồn đã sửa theo doc).
 *   I. bezierTangentDeg: tiếp tuyến ngang trái→phải ≈ 0° · phải→trái ≈ 180° ·
 *      dọc xuống ≈ 90° (mũi tên bản tĩnh reduced-motion).
 *   J. buildStageLayout: đủ cột · nơ-ron/cột ≤ 8 · units ≤ 8 ánh xạ thẳng
 *      realIndex = row · units > 8 nén đều (đầu 0, cuối units-1, đơn điệu) ·
 *      colX đều nhau.
 *
 * Ghi nhận nguồn (ĐÃ SỬA đợt fixbug FB-BRAIN-UX-R1-07):
 *   strokeWidthForGrad(0, [0,0]) TRƯỚC đây 1.95 (trung vị [0.7,3.2]) trái
 *   JSDoc "Toàn 0 → 1.1" — nguồn stage-geometry.ts giờ phân biệt 2 trường
 *   hợp suy biến (toàn 0 → fallback 1.1 trung tính; flat non-zero → trung
 *   vị); pin H4 cập nhật kèm assert (2,[2,2]) → 1.95.
 */

import { describe, test, expect } from 'bun:test'
import {
  bezierControls,
  sampleBezier,
  distToEdge,
  hitEdge,
  lodEdges,
  edgePhaseSec,
  isAnimated,
  strokeWidthForGrad,
  bezierTangentDeg,
  buildStageLayout,
  STAGE_LIMITS,
  type StageColumn,
  type StageEdge,
} from '@/lib/brain/stage-geometry'

/** Cạnh ngang chuẩn (10,50)→(110,50): dy=0, dx=100 → offset vuông góc (0,-14). */
const H_EDGE = (() => {
  const c = bezierControls(10, 50, 110, 50)
  return { x1: 10, y1: 50, cx1: c.cx1, cy1: c.cy1, cx2: c.cx2, cy2: c.cy2, x2: 110, y2: 50 }
})()

/** Dựng StageEdge hoàn chỉnh từ 2 điểm (id + toạ độ + control bezier). */
function makeEdge(id: number, x1: number, y1: number, x2: number, y2: number): StageEdge {
  const c = bezierControls(x1, y1, x2, y2)
  return { id, fromCol: 0, toCol: 1, fromRow: 0, toRow: 0, x1, y1, cx1: c.cx1, cy1: c.cy1, cx2: c.cx2, cy2: c.cy2, x2, y2 }
}

// ==================== A. bezierControls ====================

describe('r90 · A bezierControls — cong "uyển chuyển" lệch vuông góc', () => {
  test('cạnh ngang (x2>x1, y bằng) → CẢ 2 control cy < y (cong LÊN)', () => {
    const c = bezierControls(10, 50, 110, 50)
    // k = min(0.3×len, 14)/len = 14/100 → py = -dx·k = -14 (hướng LÊN)
    expect(c.cy1).toBeLessThan(50)
    expect(c.cy2).toBeLessThan(50)
    // Pin chính xác (dẫn nguồn): t=0.32, cả 2 control y = 50 − 14 = 36
    expect(c.cy1).toBeCloseTo(36, 10)
    expect(c.cy2).toBeCloseTo(36, 10)
  })

  test('2 control đối xứng quanh trung điểm cạnh (cộng offset vuông góc)', () => {
    const c = bezierControls(10, 50, 110, 50)
    const mx = (10 + 110) / 2 // 60
    // Cạnh ngang: offset vuông góc thuần theo y (px=0) → trung điểm 2 control
    // nằm ĐÚNG trung điểm x của cạnh, kéo lên 14 (py)
    expect((c.cx1 + c.cx2) / 2).toBeCloseTo(mx, 10)
    expect((c.cy1 + c.cy2) / 2).toBeCloseTo(50 - 14, 10)
    // Control1 gần đầu, control2 gần cuối (không đảo chiều)
    expect(c.cx1).toBeLessThan(c.cx2)
  })

  test('cạnh dọc (x bằng, y2>y1) → control lệch NGANG (không bẹp lên)', () => {
    const c = bezierControls(50, 10, 50, 110)
    // dx=0, dy=100 → px = dy·k = +14, py = 0 → lệch +x
    expect(c.cx1).toBeGreaterThan(50)
    expect(c.cx2).toBeGreaterThan(50)
    expect(c.cx1).toBeCloseTo(64, 10) // 50 + 14
    expect(c.cx2).toBeCloseTo(64, 10)
    // y vẫn tiến dần theo chiều cạnh (10 → 110)
    expect(c.cy1).toBeGreaterThan(10)
    expect(c.cy2).toBeLessThan(110)
  })
})

// ==================== B. sampleBezier ====================

describe('r90 · B sampleBezier — de Casteljau', () => {
  test('t=0 = điểm đầu; t=1 = điểm cuối (chính xác)', () => {
    const t0 = sampleBezier(H_EDGE.x1, H_EDGE.y1, H_EDGE.cx1, H_EDGE.cy1, H_EDGE.cx2, H_EDGE.cy2, H_EDGE.x2, H_EDGE.y2, 0)
    expect(t0.x).toBeCloseTo(10, 10)
    expect(t0.y).toBeCloseTo(50, 10)
    const t1 = sampleBezier(H_EDGE.x1, H_EDGE.y1, H_EDGE.cx1, H_EDGE.cy1, H_EDGE.cx2, H_EDGE.cy2, H_EDGE.x2, H_EDGE.y2, 1)
    expect(t1.x).toBeCloseTo(110, 10)
    expect(t1.y).toBeCloseTo(50, 10)
  })

  test('t=0.5 nằm trong bao (bounding box 4 điểm control)', () => {
    const m = sampleBezier(H_EDGE.x1, H_EDGE.y1, H_EDGE.cx1, H_EDGE.cy1, H_EDGE.cx2, H_EDGE.cy2, H_EDGE.x2, H_EDGE.y2, 0.5)
    const xs = [H_EDGE.x1, H_EDGE.cx1, H_EDGE.cx2, H_EDGE.x2]
    const ys = [H_EDGE.y1, H_EDGE.cy1, H_EDGE.cy2, H_EDGE.y2]
    expect(m.x).toBeGreaterThanOrEqual(Math.min(...xs))
    expect(m.x).toBeLessThanOrEqual(Math.max(...xs))
    expect(m.y).toBeGreaterThanOrEqual(Math.min(...ys))
    expect(m.y).toBeLessThanOrEqual(Math.max(...ys))
  })
})

// ==================== C. distToEdge ====================

describe('r90 · C distToEdge — khoảng cách điểm→cạnh bezier (hit-target)', () => {
  test('điểm TRÙNG đầu cạnh → 0; điểm trên đường cong (t=0.5) → ≤ 0.5', () => {
    // Đầu cạnh là node chính tắc của polyline rời rạc hóa
    expect(distToEdge(10, 50, H_EDGE)).toBe(0)
    // Chính điểm trên bezier t=0.5 làm query — rời rạc 24 đoạn: t=0.5 trùng
    // đúng ranh giới đoạn 12/24 → khoảng cách 0 (assert lỏng ≤ 0.5 cho chống
    // phễ float của các t không trúng ranh giới)
    const mid = sampleBezier(H_EDGE.x1, H_EDGE.y1, H_EDGE.cx1, H_EDGE.cy1, H_EDGE.cx2, H_EDGE.cy2, H_EDGE.x2, H_EDGE.y2, 0.5)
    const d = distToEdge(mid.x, mid.y, H_EDGE)
    expect(d).toBeLessThanOrEqual(0.5)
    expect(d).toBeGreaterThanOrEqual(0)
  })

  test('điểm cách xa → khoảng cách lớn (không kẹp giả)', () => {
    // (60, 300): đường cong nằm trong dải y≈36–50 → xa hàng trăm đơn vị
    expect(distToEdge(60, 300, H_EDGE)).toBeGreaterThan(200)
    expect(distToEdge(200, 50, H_EDGE)).toBeGreaterThan(80)
  })
})

// ==================== D. hitEdge ====================

describe('r90 · D hitEdge — chọn cạnh trong ngưỡng bấm', () => {
  // 2 cạnh tách biệt: e1 quanh y≈36–50, e2 quanh y≈186–200
  const e1 = makeEdge(1, 10, 50, 110, 50)
  const e2 = makeEdge(2, 10, 200, 110, 200)

  test('query sát cạnh 1 → trả đúng cạnh 1; sát cạnh 2 → đúng cạnh 2', () => {
    expect(hitEdge(10, 50, [e1, e2])?.id).toBe(1) // đầu cạnh 1
    expect(hitEdge(60, 39.5, [e1, e2])?.id).toBe(1) // giữa đường cong 1 (t=0.5)
    expect(hitEdge(60, 189.5, [e1, e2])?.id).toBe(2) // giữa đường cong 2
    expect(hitEdge(110, 200, [e1, e2])?.id).toBe(2) // cuối cạnh 2
  })

  test('ngoài radius (12 đơn vị viewBox — PIN UPDATE FB-BRAIN-UX-R1-06: 7 → 12 cho touch target) → null (không bấm nhầm)', () => {
    // (60,120): cách e1 ≈ 80, cách e2 ≈ 69 — ngoài STAGE_LIMITS.edgeHitRadius
    // (PIN UPDATE FB-BRAIN-UX-R1-06: nâng 7 → 12 đơn vị viewBox ≈ 12-18px CSS —
    // cạnh SVG nhỏ hơn nút 44px vì phải tách biệt giữa các cạnh kề nhau)
    expect(hitEdge(60, 120, [e1, e2])).toBeNull()
    // Điểm trên đường cong nhưng radius bị ép hẹp → miss
    expect(hitEdge(60, 45, [e1], 2)).toBeNull() // cách cong 1 ≈ 5.5 > 2
    expect(hitEdge(60, 39.5, [e1], 2)?.id).toBe(1) // ngay trên cong → hit
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

// ==================== I. bezierTangentDeg (mũi tên bản tĩnh) ====================

describe('r90 · I bezierTangentDeg — góc tiếp tuyến (đầu mũi tên chỉ chiều lan truyền)', () => {
  // Control THẲNG HÀNG trên đường thẳng → bezier suy biến thành đoạn thẳng:
  // chấm góc thuần không lẫn độ cong
  test('ngang trái→phải ≈ 0°; phải→trái ≈ 180°; dọc xuống ≈ 90°', () => {
    expect(bezierTangentDeg(0, 0, 33, 0, 66, 0, 100, 0, 0.5)).toBeCloseTo(0, 10)
    expect(bezierTangentDeg(100, 0, 66, 0, 33, 0, 0, 0, 0.5)).toBeCloseTo(180, 10)
    expect(bezierTangentDeg(0, 0, 0, 33, 0, 66, 0, 100, 0.5)).toBeCloseTo(90, 10)
    // atan2 đối xứng: dọc lên = -90°
    expect(bezierTangentDeg(0, 100, 0, 66, 0, 33, 0, 0, 0.5)).toBeCloseTo(-90, 10)
  })
})

// ==================== J. buildStageLayout ====================

describe('r90 · J buildStageLayout — toạ độ cột + nơ-ron (tất định)', () => {
  const columns: StageColumn[] = [
    { units: 10, display: 0, label: '1-hot cfg', activation: 'linear', locked: true },
    { units: 16, display: 0, label: '×16', activation: 'tanh', locked: false },
    { units: 1, display: 0, label: 'sigmoid', activation: 'sigmoid', locked: true },
  ]

  test('đủ cột + colX đều nhau (viewBox 340, margin 34)', () => {
    const lay = buildStageLayout(columns)
    expect(lay.colX).toHaveLength(3)
    // Bước đều: colX[i+1] − colX[i] hằng số (340 − 2×34) / 2 = 136
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(lay.colX[2] - lay.colX[1], 10)
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(136, 10)
  })

  test('nơ-ron VẼ mỗi cột ≤ 8 (maxDisplayNeurons — quá thì nén + label ×N)', () => {
    const lay = buildStageLayout(columns)
    for (let c = 0; c < 3; c++) {
      const inCol = lay.neurons.filter(n => n.col === c)
      expect(inCol.length).toBeLessThanOrEqual(STAGE_LIMITS.maxDisplayNeurons)
      // Cột input 10 units → VẼ đúng 8; 16 → 8; output 1 → 1
      expect(inCol.length).toBe(Math.min(columns[c].units, STAGE_LIMITS.maxDisplayNeurons))
    }
  })

  test('units ≤ 8 → realIndex = row (ánh xạ thẳng 1-1 cho inspector)', () => {
    const lay = buildStageLayout([{ ...columns[0], units: 3 }, columns[1], columns[2]])
    const col0 = lay.neurons.filter(n => n.col === 0)
    expect(col0.map(n => n.realIndex)).toEqual([0, 1, 2]) // = row
    // Output 1 unit cũng ánh xạ thẳng
    expect(lay.neurons.filter(n => n.col === 2).map(n => n.realIndex)).toEqual([0])
  })

  test('units > 8 → nén đều: đầu = 0, cuối = units-1, đơn điệu không giảm', () => {
    const lay = buildStageLayout(columns)
    const col0 = lay.neurons.filter(n => n.col === 0) // units 10, vẽ 8
    const idx = col0.map(n => n.realIndex) as number[]
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(9) // units − 1
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1])).toBe(true)
    // Cột 16 units nén tương tự: đầu 0, cuối 15
    const col1 = lay.neurons.filter(n => n.col === 1).map(n => n.realIndex) as number[]
    expect(col1[0]).toBe(0)
    expect(col1[col1.length - 1]).toBe(15)
    // Tất định: 2 lần dựng deep-equal
    expect(buildStageLayout(columns)).toEqual(buildStageLayout(columns))
  })
})
