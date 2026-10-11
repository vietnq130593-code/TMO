/**
 * r82 — NEURAL-LAYOUT (P1 review 2026-10-11): hình học + cỡ chữ + thu phóng
 * + style cạnh của tab Kiến trúc Neural — pin toàn bộ logic tách từ
 * component ra module thuần.
 * ============================================================================
 * Phủ 5 nhóm:
 *   1. FONT FLOOR (P1-1): mọi cỡ chữ thiết kế ≥ NEURAL_FONT_FLOOR 8.5 —
 *      trước-fix nhỏ nhất 7.5 (viewBox 1712 render 1180px → ~5.2px thực tế,
 *      dưới mọi ngưỡng đọc). Hạ sàn về sau = FAIL gate ngay.
 *   2. computeNeuralLayout trên NEURAL_GRAPH THẬT: 23 node/37 cạnh, toạ độ
 *      hữu hạn, node nằm gọn cột lớp + trong viewBox, công thức width/height
 *      chốt số, offset cặp cạnh 2 chiều (llm-call ↔ softmax-policy).
 *   3. edgeVisual (P1-2): active = nét sáng + dày + hạt to + opacity 1;
 *      inactive mờ 0.16; kind lạ rơi về read.
 *   4. Zoom (P1-1): clamp [0.6, 1.6], NaN/∞ → 1; svg width theo chế độ;
 *      nhãn % đúng; zoomStepFrom neo theo tỉ lệ render thật (FB-P1-R1-03).
 *   5. Barrel (C7): import từ '@/lib/learning' thấy đủ tên mới.
 *   6. FB-P1-R1 regression (vòng fixbug): zoomStepFrom semantics + nhánh
 *      phòng thủ computeNeuralLayout (node sai layer / cạnh lửng / graph
 *      rỗng / self-loop / cặp 3 cạnh) + sampler bezier độc lập chứng minh
 *      toàn bộ 37 đường cong nằm trong viewBox (FB-P1-R1-05 — trước-fix 5
 *      cạnh reverse đâm xuyên viền, maxX 1761.9 > 1732, minX −70.5).
 */

import { describe, test, expect } from 'bun:test'
import {
  NEURAL_GEO,
  NEURAL_FONTS,
  NEURAL_FONT_FLOOR,
  NEURAL_EDGE_KINDS,
  NEURAL_EDGE_DIM_OPACITY,
  NEURAL_EDGE_DOT_R,
  NEURAL_ZOOM,
  computeNeuralLayout,
  edgeVisual,
  edgeIsActive,
  clampNeuralZoom,
  neuralSvgWidth,
  neuralZoomLabel,
  zoomStepFrom,
} from '@/lib/learning/neural-layout'
// C7 — import smoke từ barrel (consumer thứ 2 ngoài component)
import { computeNeuralLayout as fromBarrel, NEURAL_FONTS as fontsFromBarrel } from '@/lib/learning'
import { NEURAL_GRAPH, NEURAL_NODES, NEURAL_EDGES } from '@/lib/learning/neural-types'

// ==================== 1. FONT FLOOR (P1-1) ====================

describe('r82 · font floor — mọi cỡ chữ thiết kế ≥ sàn đọc được', () => {
  test('6 mục NEURAL_FONTS đều ≥ NEURAL_FONT_FLOOR 8.5 (trước-fix min 7.5)', () => {
    const entries = Object.entries(NEURAL_FONTS) as Array<[string, number]>
    expect(entries.length).toBe(6)
    for (const [name, px] of entries) {
      expect(px).toBeGreaterThanOrEqual(NEURAL_FONT_FLOOR)
      expect(Number.isFinite(px)).toBe(true)
    }
  })

  test('sàn 8.5 là con số thiết kế (zoom 100% = px thật — không nhỏ hơn 8.5)', () => {
    expect(NEURAL_FONT_FLOOR).toBe(8.5)
    expect(NEURAL_FONTS.live).toBeGreaterThanOrEqual(8.5)
    expect(NEURAL_FONTS.layerSub).toBeGreaterThanOrEqual(8.5)
  })

  test('hình học: node nằm gọn cột (NODE_W ≤ LAYER_W), đủ khoảng thở', () => {
    expect(NEURAL_GEO.NODE_W).toBeLessThanOrEqual(NEURAL_GEO.LAYER_W)
    expect(NEURAL_GEO.NODE_H).toBeGreaterThanOrEqual(70) // 64 → 80 (P1-1)
    expect(NEURAL_GEO.LAYER_GAP).toBeGreaterThanOrEqual(48) // dx bezier ≥ 48 vẫn cong mượt
    // Tiêu đề lớp (baseline PAD+6) + phụ đề (baseline PAD+19) không đè node
    // đầu cột: HEADER_H phải nhỉnh hơn vùng 2 baseline đó (clearance ≥ 5px)
    expect(NEURAL_GEO.HEADER_H).toBeGreaterThan(NEURAL_GEO.PAD + 20)
  })
})

// ==================== 2. COMPUTE NEURAL LAYOUT (đồ thị thật) ====================

describe('r82 · computeNeuralLayout trên NEURAL_GRAPH thật', () => {
  const layout = computeNeuralLayout(NEURAL_GRAPH)

  test('đủ 23 node + 37 cạnh, toạ độ hữu hạn', () => {
    expect(layout.nodes.length).toBe(NEURAL_NODES.length)
    expect(layout.edges.length).toBe(NEURAL_EDGES.length)
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    for (const e of layout.edges) {
      expect(typeof e.d).toBe('string')
      expect(e.d.startsWith('M ')).toBe(true)
      expect(e.d.includes(' C ')).toBe(true)
    }
  })

  test('công thức width/height chốt số (6 lớp, cột dài nhất 5 node lớp Học)', () => {
    expect(layout.width).toBe(NEURAL_GEO.PAD * 2 + 6 * NEURAL_GEO.LAYER_W + 5 * NEURAL_GEO.LAYER_GAP)
    expect(layout.width).toBe(1732)
    expect(layout.height).toBe(NEURAL_GEO.HEADER_H + 5 * (NEURAL_GEO.NODE_H + NEURAL_GEO.NODE_GAP) + NEURAL_GEO.PAD)
    expect(layout.height).toBe(568)
  })

  test('node xếp dọc trong cột lớp: cùng x, y tăng đúng bước, không chồng lấn', () => {
    const byLayer = new Map<string, typeof layout.nodes>()
    for (const n of layout.nodes) {
      const list = byLayer.get(n.layer) ?? []
      list.push(n)
      byLayer.set(n.layer, list)
    }
    for (const [layerId, nodes] of byLayer) {
      const layer = NEURAL_GRAPH.layers.find(l => l.id === layerId)!
      const expectX = NEURAL_GEO.PAD + (layer.index - 1) * (NEURAL_GEO.LAYER_W + NEURAL_GEO.LAYER_GAP)
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i].x).toBe(nodes[0].x)
        expect(nodes[0].x).toBe(expectX)
        // cùng lớp: hàng sau thấp hơn hàng trước đúng 1 bước (không đè nhau)
        expect(nodes[i].y - nodes[i - 1].y).toBe(NEURAL_GEO.NODE_H + NEURAL_GEO.NODE_GAP)
      }
    }
  })

  test('mọi node nằm trọn trong viewBox (không bị cắt mép)', () => {
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.x + NEURAL_GEO.NODE_W).toBeLessThanOrEqual(layout.width)
      expect(n.y + NEURAL_GEO.NODE_H).toBeLessThanOrEqual(layout.height)
    }
  })

  test('cạnh xuất phát từ mép phải nguồn: e01 doc-upload → doc-dedup đúng toạ độ', () => {
    const e01 = layout.edges.find(e => e.id === 'e01')!
    const docUpload = layout.nodeById.get('doc-upload')!
    // doc-upload: cột 1, hàng đầu → x=PAD, y=HEADER_H
    const x1 = docUpload.x + NEURAL_GEO.NODE_W
    const y1 = docUpload.y + NEURAL_GEO.NODE_H / 2
    expect(e01.d.startsWith(`M ${x1} ${y1} C`)).toBe(true)
  })

  test('cặp 2 chiều llm-call ↔ softmax-policy (e13/e14) lệch dọc nhau — không đè', () => {
    const e13 = layout.edges.find(e => e.id === 'e13')!
    const e14 = layout.edges.find(e => e.id === 'e14')!
    expect(e13.d).not.toBe(e14.d)
    // e13 gặp cặp trước → offset 0; e14 → +PAIR_OFFSET 16 từ mép node
    const softmax = layout.nodeById.get('softmax-policy')!
    const y14 = softmax.y + NEURAL_GEO.NODE_H / 2 + 16
    expect(e14.d.startsWith(`M ${softmax.x + NEURAL_GEO.NODE_W} ${y14} C`)).toBe(true)
  })
})

// ==================== 3. EDGE VISUAL (P1-2 — nổi bật dòng chảy node chọn) ====================

describe('r82 · edgeVisual — active sáng/dày, inactive mờ', () => {
  test('data active: hiStroke + width+0.6 + hạt to + opacity 1', () => {
    const v = edgeVisual('data', true)
    expect(v.stroke).toBe(NEURAL_EDGE_KINDS.data.hiStroke)
    expect(v.strokeWidth).toBe(NEURAL_EDGE_KINDS.data.width + NEURAL_EDGE_KINDS.data.hiWidthDelta)
    expect(v.opacity).toBe(1)
    expect(v.dotRadius).toBe(NEURAL_EDGE_DOT_R.active)
    expect(v.dot).toBe(NEURAL_EDGE_KINDS.data.hiDot)
    expect(v.className).toBe('na-edge-data')
  })

  test('data inactive: stroke thường + mờ NEURAL_EDGE_DIM_OPACITY + hạt nhỏ', () => {
    const v = edgeVisual('data', false)
    expect(v.stroke).toBe(NEURAL_EDGE_KINDS.data.stroke)
    expect(v.strokeWidth).toBe(NEURAL_EDGE_KINDS.data.width)
    expect(v.opacity).toBe(NEURAL_EDGE_DIM_OPACITY)
    expect(v.opacity).toBeLessThan(0.3) // phải mờ rõ rệt để dòng chảy nổi bật
    expect(v.dotRadius).toBe(NEURAL_EDGE_DOT_R.normal)
  })

  test('đủ 4 kind, mỗi kind có hiStroke khác stroke thường', () => {
    for (const kind of ['data', 'reward', 'feedback', 'read'] as const) {
      const k = NEURAL_EDGE_KINDS[kind]
      expect(k.hiStroke).not.toBe(k.stroke)
      expect(k.hiWidthDelta).toBeGreaterThan(0)
      expect(k.marker).toContain('na-arrow-')
    }
  })

  test('kind lạ rơi về read (fallback giữ hành vi bản cũ)', () => {
    const v = edgeVisual('khong-ton-tai', false)
    expect(v.stroke).toBe(NEURAL_EDGE_KINDS.read.stroke)
    expect(v.marker).toBe(NEURAL_EDGE_KINDS.read.marker)
  })

  test('feedback/read không có hạt animateMotion (chỉ data/reward có)', () => {
    expect(edgeVisual('feedback', true).dot).toBeUndefined()
    expect(edgeVisual('read', true).dot).toBeUndefined()
    expect(edgeVisual('data', false).dot).toBeDefined()
    expect(edgeVisual('reward', false).dot).toBeDefined()
  })

  test('edgeIsActive: khớp đầu nào cũng true; không khớp / chưa chọn = false', () => {
    expect(edgeIsActive({ from: 'llm-call', to: 'softmax-policy' }, 'llm-call')).toBe(true)
    expect(edgeIsActive({ from: 'llm-call', to: 'softmax-policy' }, 'softmax-policy')).toBe(true)
    expect(edgeIsActive({ from: 'llm-call', to: 'softmax-policy' }, 'q-table')).toBe(false)
    expect(edgeIsActive({ from: 'llm-call', to: 'softmax-policy' }, null)).toBe(false)
  })
})

// ==================== 4. ZOOM (P1-1) ====================

describe('r82 · zoom — clamp + svg width + nhãn', () => {
  test('clamp kẹp [MIN, MAX]; NaN/±∞ → 1 (giá trị rác → default, không thưởng MAX)', () => {
    expect(clampNeuralZoom(0.5)).toBe(NEURAL_ZOOM.MIN)
    expect(clampNeuralZoom(1.7)).toBe(NEURAL_ZOOM.MAX)
    expect(clampNeuralZoom(0.83)).toBe(0.83)
    expect(clampNeuralZoom(1)).toBe(1)
    expect(clampNeuralZoom(Number.NaN)).toBe(1)
    // ±∞ là giá trị rác (vd localStorage bị ghi "Infinity") — fail-open về
    // default 1, KHÔNG kẹp về MAX/MIN (không thưởng hành vi lạ cho input rác)
    expect(clampNeuralZoom(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampNeuralZoom(Number.NEGATIVE_INFINITY)).toBe(1)
  })

  test('clamp làm tròn 2 số lẻ — cộng dồn bước 0.1 không tích luỹ float-junk', () => {
    let z = 1
    for (let i = 0; i < 4; i++) z = clampNeuralZoom(z - NEURAL_ZOOM.STEP)
    expect(z).toBe(0.6)
  })

  test('neuralSvgWidth: fit → 100%; số → viewBox×zoom (px)', () => {
    expect(neuralSvgWidth(1732, 'fit')).toBe('100%')
    expect(neuralSvgWidth(1732, 1)).toBe('1732px')
    expect(neuralSvgWidth(1732, 0.85)).toBe(`${Math.round(1732 * 0.85)}px`)
    expect(neuralSvgWidth(1732, 99)).toBe(`${Math.round(1732 * NEURAL_ZOOM.MAX)}px`) // kẹp MAX
  })

  test('neuralZoomLabel: Fit / % / kẹp theo clamp', () => {
    expect(neuralZoomLabel('fit')).toBe('Fit')
    expect(neuralZoomLabel(1)).toBe('100%')
    expect(neuralZoomLabel(0.85)).toBe('85%')
    expect(neuralZoomLabel(2)).toBe('160%')
  })

  test('sàn fit ≥ 1000px (chữ không co vô hạn trên container hẹp)', () => {
    expect(NEURAL_ZOOM.FIT_FLOOR_PX).toBeGreaterThanOrEqual(1000)
    expect(NEURAL_ZOOM.MIN).toBeLessThan(1)
    expect(NEURAL_ZOOM.MAX).toBeGreaterThan(1)
  })
})

// ==================== 5. BARREL (C7) ====================

describe('r82 · barrel learning/index.ts xuất đủ tên neural-layout', () => {
  test('computeNeuralLayout + NEURAL_FONTS từ barrel trùng bản gốc', () => {
    expect(fromBarrel).toBe(computeNeuralLayout)
    expect(fontsFromBarrel).toBe(NEURAL_FONTS)
  })
})

// ==================== 6. FB-P1-R1 REGRESSION (vòng fixbug) ====================

describe('r82 · FB-P1-R1-03 — zoomStepFrom neo theo tỉ lệ render thật', () => {
  test('từ fit (tỉ lệ 0.68) bấm thu nhỏ → 0.6 — thu nhỏ THẬT (1039px < 1180px fit)', () => {
    // Trước-fix: neo 1 → 0.9×1732 = 1558.8px > 1180px fit → PHÓNG TO dù nhãn
    // "Thu nhỏ 10%" — sai semantics trên mọi card hẹp (mobile mở đầu fit)
    expect(zoomStepFrom('fit', 1180 / 1732, -0.1)).toBe(0.6)
  })

  test('từ fit trên container rộng (1.15) bấm phóng to → 1.25', () => {
    expect(zoomStepFrom('fit', 1.15, 0.1)).toBe(1.25)
  })

  test('fitScale null/NaN/âm (svg chưa render / giá trị rác) → neo 1', () => {
    expect(zoomStepFrom('fit', null, -0.1)).toBe(0.9)
    expect(zoomStepFrom('fit', Number.NaN, -0.1)).toBe(0.9)
    expect(zoomStepFrom('fit', -2, -0.1)).toBe(0.9)
  })

  test('trạng thái số: bước trực tiếp từ giá trị hiện tại', () => {
    expect(zoomStepFrom(0.85, null, 0.1)).toBe(0.95)
    expect(zoomStepFrom(1.6, 999, 0.1)).toBe(1.6) // kẹp MAX
    expect(zoomStepFrom(0.6, null, -0.1)).toBe(0.6) // kẹp MIN
  })
})

describe('r82 · FB-P1-R1-04 — nhánh phòng thủ computeNeuralLayout (graph tự dựng)', () => {
  const mkNode = (id: string, layer: string) => ({
    id, layer, title: id.toUpperCase(), subtitle: id, description: '', functions: [], paramKeys: [],
  })
  const mkLayers = () => [
    { id: 'l1', index: 1, title: 'L1', subtitle: '', accent: 'cyan' },
    { id: 'l2', index: 2, title: 'L2', subtitle: '', accent: 'teal' },
  ]
  const mkEdge = (id: string, from: string, to: string) => ({
    id, from, to, label: '', kind: 'data' as const,
  })

  test('node khai sai layer bị bỏ; cạnh thiếu đầu (from/to) bị bỏ; hợp lệ + self-loop giữ', () => {
    const layout = computeNeuralLayout({
      layers: mkLayers(),
      nodes: [mkNode('a', 'l1'), mkNode('b', 'l2'), mkNode('bad', 'khong-ton-tai')],
      edges: [
        mkEdge('ok', 'a', 'b'),
        mkEdge('dangling-to', 'a', 'missing'),
        mkEdge('dangling-from', 'ghost', 'b'),
        mkEdge('self', 'a', 'a'),
      ],
    })
    expect(layout.nodes.map(n => n.id)).toEqual(['a', 'b'])
    expect(layout.edges.map(e => e.id)).toEqual(['ok', 'self'])
    for (const e of layout.edges) {
      expect(e.d.startsWith('M ')).toBe(true)
      expect(e.d.includes(' C ')).toBe(true)
    }
  })

  test('cặp 3 cạnh cùng đôi: offset 0 / +16 / −16 — 3 đường phân biệt', () => {
    const layout = computeNeuralLayout({
      layers: mkLayers(),
      nodes: [mkNode('a', 'l1'), mkNode('b', 'l2')],
      edges: [mkEdge('p1', 'a', 'b'), mkEdge('p2', 'b', 'a'), mkEdge('p3', 'a', 'b')],
    })
    expect(layout.edges.length).toBe(3)
    const ds = layout.edges.map(e => e.d)
    expect(new Set(ds).size).toBe(3) // 3 đường không trùng nhau
  })

  test('graph rỗng không crash: width = 2×PAD, height = HEADER + 1 hàng + PAD', () => {
    const layout = computeNeuralLayout({ layers: [], nodes: [], edges: [] })
    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.width).toBe(NEURAL_GEO.PAD * 2)
    expect(layout.height).toBe(NEURAL_GEO.HEADER_H + 1 * (NEURAL_GEO.NODE_H + NEURAL_GEO.NODE_GAP) + NEURAL_GEO.PAD)
    expect(Number.isFinite(layout.width)).toBe(true)
    expect(Number.isFinite(layout.height)).toBe(true)
  })

  test('clampNeuralZoom: số âm → MIN; biên đúng 0.6/1.6 không bị đẩy', () => {
    expect(clampNeuralZoom(-5)).toBe(NEURAL_ZOOM.MIN)
    expect(clampNeuralZoom(0.6)).toBe(0.6)
    expect(clampNeuralZoom(1.6)).toBe(1.6)
  })
})

describe('r82 · FB-P1-R1-05 — sampler bezier độc lập: 37 đường cong nằm trong viewBox', () => {
  // Công thức bezier lập ĐỘC LẬP trong test (không dùng code nguồn):
  // B(t) = (1−t)³P0 + 3(1−t)²t·P1 + 3(1−t)t²·P2 + t³·P3
  const sampleBezier = (d: string, steps = 81): Array<[number, number]> => {
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    expect(nums.length).toBe(8) // M x1 y1 C cp1x y1, cp2x y2, x2 y2
    const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = nums
    const pts: Array<[number, number]> = []
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      const u = 1 - t
      pts.push([
        u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2,
        u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2,
      ])
    }
    return pts
  }

  test('mọi cạnh: toàn bộ điểm sample nằm trong [0..width] × [0..height]', () => {
    const layout = computeNeuralLayout(NEURAL_GRAPH)
    let sampled = 0
    for (const e of layout.edges) {
      for (const [x, y] of sampleBezier(e.d)) {
        sampled++
        expect(x).toBeGreaterThanOrEqual(-0.5)
        expect(x).toBeLessThanOrEqual(layout.width + 0.5)
        expect(y).toBeGreaterThanOrEqual(-0.5)
        expect(y).toBeLessThanOrEqual(layout.height + 0.5)
      }
    }
    expect(sampled).toBeGreaterThan(37 * 40) // thật sự quét đủ 81 bước/cạnh
  })

  test('5 cạnh từng vi phạm (e13/e21/e24/e28/e36 — trước-fix maxX 1761.9, minX −70.5) giờ trong khung', () => {
    const layout = computeNeuralLayout(NEURAL_GRAPH)
    const offenders = ['e13', 'e21', 'e24', 'e28', 'e36']
    for (const id of offenders) {
      const e = layout.edges.find(x => x.id === id)
      expect(e).toBeDefined()
      for (const [x, y] of sampleBezier(e!.d)) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(layout.width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(layout.height)
      }
    }
  })
})
