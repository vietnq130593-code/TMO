/**
 * r115 — EVO UI (BLUEPRINT-EVO-NAO-P1-P5 §5 — R25-c) — TAB "TIẾN HOÁ" HELPERS
 * ============================================================================
 *
 * Pin logic thuần của tab Tiến hoá (src/lib/brain/evo/ui-helpers.ts — 0 import
 * server/React nên test trực tiếp):
 *  - splitEncodingZones: biên vùng encoding BẰNG SỐ LITERAL (95/96/113/114/
 *    131/132/135/136/143 — đồng bộ pin r105 ở search-space.ts) + compat F4
 *    (96-dim legacy → chỉ vùng HN-P1).
 *  - isPureMlpCandidate: encoding có block (attention/ssm/moe/gated/mlp) →
 *    false; mọi block identity → true; 96-dim → LUÔN true.
 *  - paretoFront: front TOÀN BỔ ứng viên không dominated (params↓, cvScore↑)
 *    — R27 bỏ lọc beatActive theo user bỏ phần đối chứng active.
 *  - sortCandidates (cvScore desc), formatCandidateLog (copy E3), hiddenFromSpec.
 *  - deriveEvoState: state machine E1–E4 (404→E1 · run null→E2 · running→E3 ·
 *    done/failed/cancelled→E4 + cờ E5 hasBlockedH7).
 */

import { describe, expect, test } from 'bun:test'
import {
  cvBarTone,
  deriveEvoState,
  formatCandidateLog,
  formatParamsBudget,
  formatViNum,
  hiddenFromSpec,
  isPureMlpCandidate,
  isPureMlpEncoding,
  padDomain,
  paretoFront,
  sortCandidates,
  splitEncodingZones,
  type EvoCandidateRowUi,
  type EvoRunStateUi,
} from '../src/lib/brain/evo/ui-helpers'

// ==================== FIXTURES ====================

/**
 * Dựng encoding 144 chuẩn: blockTypes là index EVO_BLOCK_TYPES của từng block
 * (0 identity · 1 mlp · 2 attention · 3 ssm · 4 moe · 5 gated — pin r105).
 */
function makeEncoding144(blockTypes: readonly [number, number, number] = [0, 0, 0]): number[] {
  const v = new Array<number>(144).fill(0)
  for (let b = 0; b < 3; b++) v[96 + b * 6 + blockTypes[b]!] = 1
  return v
}

function makeRun(over: Partial<EvoRunStateUi> = {}): EvoRunStateUi {
  return {
    id: 'evo_test_1',
    brain: 'policy',
    status: 'done',
    seed: 42,
    candidatesMax: 8,
    progress: { done: 8, total: 8, elapsedMs: 12_345, wallMsMax: 600_000 },
    ...over,
  }
}

function makeCand(over: Partial<EvoCandidateRowUi> = {}): EvoCandidateRowUi {
  return {
    idx: 0,
    archSummary: 'MLP[128,64]',
    cvScore: 0.5,
    ciLow: 0.45,
    ciHigh: 0.55,
    params: 10_000,
    trainMs: 2_000,
    p95LatencyMs: 0.2,
    beatActive: true,
    blockedH7: false,
    encoding: makeEncoding144(),
    spec: null,
    moeSkipped: false,
    ...over,
  }
}

// ==================== U3 — SPLIT ENCODING ZONES (biên literal pin) ====================

describe('r115 · U3 splitEncodingZones — biên vùng 144/96 (F4 compat)', () => {
  test('A encoding 144 → 5 vùng, biên ĐÚNG số literal (95/96/113/114/131/132/135/136/143)', () => {
    const { dim, zones } = splitEncodingZones(makeEncoding144())
    expect(dim).toBe(144)
    expect(zones.length).toBe(5)
    const [hnp1, blocktype, blockparam, moeglobal, reserved] = zones
    expect(hnp1!.start).toBe(0)
    expect(hnp1!.end).toBe(95)
    expect(hnp1!.isEvo).toBe(false)
    expect(blocktype!.start).toBe(96)
    expect(blocktype!.end).toBe(113)
    expect(blocktype!.isEvo).toBe(true)
    expect(blockparam!.start).toBe(114)
    expect(blockparam!.end).toBe(131)
    expect(moeglobal!.start).toBe(132)
    expect(moeglobal!.end).toBe(135)
    expect(reserved!.start).toBe(136)
    expect(reserved!.end).toBe(143)
  })

  test('B encoding 96 (legacy HN-P1) → CHỈ vùng [0..95], không vùng block (F4)', () => {
    const { dim, zones } = splitEncodingZones(new Array<number>(96).fill(0.5))
    expect(dim).toBe(96)
    expect(zones.length).toBe(1)
    expect(zones[0]!.id).toBe('hnp1')
    expect(zones[0]!.start).toBe(0)
    expect(zones[0]!.end).toBe(95)
    expect(zones[0]!.isEvo).toBe(false)
  })

  test('C mean vùng = trung bình giá trị chuẩn hoá + kẹp [0,1] slot rác (NaN/âm/>1) không NaN lan', () => {
    // padEvo96to144: [0..95] giữ giá trị, [96..143] toàn 0 → ứng viên thuần MLP
    const v = new Array<number>(144).fill(0)
    for (let i = 0; i <= 95; i++) v[i] = 1
    const { zones } = splitEncodingZones(v)
    expect(zones[0]!.mean).toBe(1)
    for (let z = 1; z < zones.length; z++) expect(zones[z]!.mean).toBe(0)
    // slot rác: NaN→0, âm→0, >1→1 — mean hữu hạn
    const dirty = new Array<number>(144).fill(0)
    dirty[96] = Number.NaN
    dirty[97] = -5
    dirty[98] = 42
    const blocktype = splitEncodingZones(dirty).zones.find(z => z.id === 'blocktype')!
    expect(blocktype.mean).toBeCloseTo(1 / 18, 12)
    expect(Number.isFinite(blocktype.mean)).toBe(true)
  })

  test('D độ dài lạ (100-dim) → dim null + zones rỗng (viewer hiển thị chip phòng thủ)', () => {
    const { dim, zones } = splitEncodingZones(new Array<number>(100).fill(0))
    expect(dim).toBe(null)
    expect(zones.length).toBe(0)
  })
})

// ==================== PURE-MLP DETECTION (2 cấp áp dụng §5.3) ====================

describe('r115 · isPureMlpCandidate — phát hiện ứng viên thuần MLP', () => {
  test('E encoding 144 có block attention → KHÔNG thuần (không áp được nháp MLP)', () => {
    const enc = makeEncoding144([2, 0, 0]) // block 0 = attention
    expect(isPureMlpEncoding(enc)).toBe(false)
    expect(isPureMlpCandidate(makeCand({ encoding: enc }))).toBe(false)
  })

  test('F encoding 144 mọi block identity (one-hot identity=1) → thuần', () => {
    const enc = makeEncoding144([0, 0, 0])
    expect(isPureMlpEncoding(enc)).toBe(true)
    expect(isPureMlpCandidate(makeCand({ encoding: enc }))).toBe(true)
  })

  test('G 96-dim legacy → LUÔN thuần (F4) · pad 144 toàn 0 vùng block → thuần · độ dài lạ → null', () => {
    expect(isPureMlpEncoding(new Array<number>(96).fill(0.3))).toBe(true)
    expect(isPureMlpCandidate(makeCand({ encoding: new Array<number>(96).fill(0.3) }))).toBe(true)
    const pad = new Array<number>(144).fill(0)
    for (let i = 0; i <= 95; i++) pad[i] = 0.5
    expect(isPureMlpEncoding(pad)).toBe(true) // argmax toàn 0 = identity
    expect(isPureMlpEncoding(new Array<number>(143).fill(0))).toBe(null)
  })

  test('H fallback spec khi encoding lạ: blocks có mlp → false · mọi identity → true · không đọc được → false', () => {
    const weird = new Array<number>(143).fill(0)
    expect(isPureMlpCandidate({ encoding: weird, spec: { blocks: [{ type: 'mlp' }, { type: 'identity' }] } })).toBe(false)
    expect(isPureMlpCandidate({ encoding: weird, spec: { blocks: [{ type: 'identity' }, { type: 'identity' }] } })).toBe(true)
    expect(isPureMlpCandidate({ encoding: weird, spec: null })).toBe(false)
    // encoding argmax nghiêng về ssm khi vượt identity (语义 decode strict >)
    const enc = makeEncoding144()
    enc[96] = 0 // tắt one-hot identity block 0
    enc[98] = 1 // bật one-hot ssm — argmax thắng identity
    expect(isPureMlpEncoding(enc)).toBe(false)
  })
})

// ==================== U4 — PARETO FRONT + SORT ====================

describe('r115 · U4 paretoFront — front toàn ứng viên không dominated (params↓, cvScore↑)', () => {
  test('I 4 điểm có 1 dominated → front loại đúng điểm bị trội', () => {
    const cands = [
      makeCand({ idx: 0, params: 100_000, cvScore: 0.30, beatActive: true }),
      makeCand({ idx: 1, params: 50_000, cvScore: 0.40, beatActive: true }), // trội #0 (ít params + điểm cao hơn)
      makeCand({ idx: 2, params: 20_000, cvScore: 0.35, beatActive: true }),
      makeCand({ idx: 3, params: 10_000, cvScore: 0.20, beatActive: true }),
    ]
    const front = paretoFront(cands)
    expect(front).toContain(1)
    expect(front).toContain(2)
    expect(front).toContain(3)
    expect(front).not.toContain(0) // #0 bị #1 dominate
    expect(front.length).toBe(3)
  })

  test('J R27 — front trên TOÀN BỘ ứng viên: ứng viên beatActive=false vẫn vào front khi không bị trội (bỏ lọc cũ theo user bỏ đối chứng active)', () => {
    const cands = [
      // #0 điểm cao nhất + params thấp nhất → trội #1 hoàn toàn (dominates)
      makeCand({ idx: 0, params: 10_000, cvScore: 0.90, beatActive: false }),
      makeCand({ idx: 1, params: 20_000, cvScore: 0.40, beatActive: true }),
    ]
    expect(paretoFront(cands)).toEqual([0])
    // trùng nhau params/cvScore → không ai trội ai — cả 2 lên front
    expect(paretoFront([
      makeCand({ idx: 2, params: 10_000, cvScore: 0.90, beatActive: false }),
      makeCand({ idx: 3, params: 10_000, cvScore: 0.90, beatActive: false }),
    ]).sort()).toEqual([2, 3])
  })

  test('K 2 điểm bằng nhau (params, cvScore) → KHÔNG ai dominate ai, cả 2 trên front (kể cả blockedH7 — vẫn thắng CV)', () => {
    const cands = [
      makeCand({ idx: 0, params: 50_000, cvScore: 0.40, beatActive: true, blockedH7: true }),
      makeCand({ idx: 1, params: 50_000, cvScore: 0.40, beatActive: true }),
    ]
    expect(paretoFront(cands).sort()).toEqual([0, 1])
  })
})

describe('r115 · sortCandidates + format', () => {
  test('L sort cvScore desc, tie-break idx asc, KHÔNG mutate mảng gốc', () => {
    const src = [
      makeCand({ idx: 2, cvScore: 0.3 }),
      makeCand({ idx: 1, cvScore: 0.5 }),
      makeCand({ idx: 0, cvScore: 0.5 }),
      makeCand({ idx: 3, cvScore: 0.9 }),
    ]
    const sorted = sortCandidates(src)
    expect(sorted.map(c => c.idx)).toEqual([3, 0, 1, 2])
    expect(src.map(c => c.idx)).toEqual([2, 1, 0, 3]) // gốc nguyên vẹn
  })

  test('M format copy §5.2/§5.8 — log E3 + params vi-VN + % ngân sách 250K', () => {
    const line = formatCandidateLog({
      idx: 7,
      archSummary: '[gated·0.9] → [mlp·×3] → MLP[128,64]',
      cvScore: 0.1637,
      trainMs: 2_412,
    })
    expect(line).toBe('#7 · [gated·0.9] → [mlp·×3] → MLP[128,64] · CV 0,164 · 2,4s')
    expect(formatViNum(250_000)).toBe('250.000')
    expect(formatParamsBudget(25_000)).toBe('10%')
    expect(formatParamsBudget(300_000)).toBe('120%')
  })

  test('N hiddenFromSpec — đọc head.hidden; spec rác → null', () => {
    const spec = { head: { hidden: [{ units: 128, activation: 'tanh' }, { units: 64.4, activation: 'relu' }], hyper: {} }, blocks: [] }
    expect(hiddenFromSpec(spec)).toEqual([{ units: 128, activation: 'tanh' }, { units: 64, activation: 'relu' }])
    expect(hiddenFromSpec(null)).toBe(null)
    expect(hiddenFromSpec({ head: { hidden: [] } })).toBe(null)
    expect(hiddenFromSpec({ head: { hidden: [{ units: 0, activation: 'tanh' }] } })).toBe(null)
    expect(hiddenFromSpec({ head: { hidden: [{ units: 8, activation: 42 }] } })).toBe(null)
  })
})

// ==================== U1 — STATE MACHINE E1–E4 (+ cờ E5) ====================

describe('r115 · U1 deriveEvoState — state machine theo GET poll (không optimistic)', () => {
  test('O HTTP 404 → E1 CHƯA SẴN SÀNG — kể cả khi có run cũ trong tay (F3 §5.1-6)', () => {
    const r = deriveEvoState(makeRun({ status: 'running' }), 'not_found')
    expect(r.state).toBe('e1')
    expect(r.hasBlockedH7).toBe(false)
  })

  test('P run=null (chưa có vòng nào) → E2 sẵn sàng', () => {
    expect(deriveEvoState(null, 'ok').state).toBe('e2')
    // 'error' (5xx/mạng) + chưa từng có dữ liệu → vẫn E2 (caller giữ rỗng)
    expect(deriveEvoState(null, 'error').state).toBe('e2')
  })

  test('Q status=running → E3; hasBlockedH7 bật khi có ứng viên chặn giữa chừng', () => {
    const cands = [makeCand({ idx: 0 }), makeCand({ idx: 1, blockedH7: true })]
    expect(deriveEvoState(makeRun({ status: 'running' }), 'ok', cands)).toEqual({ state: 'e3', hasBlockedH7: true })
    expect(deriveEvoState(makeRun({ status: 'running' }), 'ok', cands.slice(0, 1))).toEqual({ state: 'e3', hasBlockedH7: false })
  })

  test('R done/failed/cancelled → E4; hasBlockedH7 từ candidates HOẶC summary.nBlockedH7', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      expect(deriveEvoState(makeRun({ status }), 'ok', []).state).toBe('e4')
    }
    // candidates rỗng nhưng summary ghi nhận blocked → E5 vẫn hiện
    const fromSummary = deriveEvoState(
      makeRun({ status: 'done', summary: { bestCandidateIdx: 1, nBeatActive: 2, nBlockedH7: 1, durationMs: 1 } }),
      'ok',
      [],
    )
    expect(fromSummary).toEqual({ state: 'e4', hasBlockedH7: true })
    // 'error' giữ run stale → suy diễn tiếp như 'ok' (chip mất kết nối do UI)
    expect(deriveEvoState(makeRun({ status: 'failed' }), 'error', []).state).toBe('e4')
  })
})

// ==================== R26 — padDomain + cvBarTone (Pareto/Điểm CV nâng cấp) ====================

describe('r115 · R26 padDomain — miền trục Y Pareto sau đệm', () => {
  test('S span bình thường: đệm 18% 2 đầu, kẹp [0..1]', () => {
    // CV 0,40..0,48 → span 0,08 → pad 0,0144 → [0,3856 .. 0,4944]
    const d = padDomain(0.4, 0.48, 0, 1)
    expect(d.from).toBeCloseTo(0.3856, 4)
    expect(d.to).toBeCloseTo(0.4944, 4)
    // CV 0..1 → pad 0,18 → bị kẹp về đúng [0..1]
    expect(padDomain(0, 1, 0, 1)).toEqual({ from: 0, to: 1 })
  })

  test('T span nhỏ hơn sàn 0,08 → nở quanh tâm (tránh "mọi điểm nhìn như nhau")', () => {
    // 1 điểm duy nhất 0,5 → span 0 → nở sàn 0,08 quanh tâm [0,46..0,54] → pad 18% · 0,08 = 0,0144
    const d1 = padDomain(0.5, 0.5, 0, 1)
    expect(d1.from).toBeCloseTo(0.4456, 4)
    expect(d1.to).toBeCloseTo(0.5544, 4)
    // 2 điểm sát nhau 0,30..0,33 (span 0,03 < 0,08) → nở tâm 0,315 [0,275..0,355] → pad 0,0144
    const d2 = padDomain(0.3, 0.33, 0, 1)
    expect(d2.from).toBeCloseTo(0.2606, 4)
    expect(d2.to).toBeCloseTo(0.3694, 4)
    // span cuối ≥ sàn × 1,36 — không bao giờ hẹp hơn 0,08
    expect(d2.to - d2.from).toBeGreaterThanOrEqual(0.08)
  })

  test('U kẹp biên cứng: không bao giờ vượt [lo..hi]', () => {
    expect(padDomain(0.01, 0.02, 0, 1).from).toBeGreaterThanOrEqual(0)
    expect(padDomain(0.98, 0.99, 0, 1).to).toBeLessThanOrEqual(1)
    // nở sàn nhưng tâm sát biên 0 → from kẹp 0, to = 0,055 + pad 0,0144
    const d = padDomain(0.01, 0.02, 0, 1)
    expect(d.from).toBe(0)
    expect(d.to).toBeCloseTo(0.0694, 3)
    // tâm sát biên 1 → to kẹp 1
    const hi = padDomain(0.98, 0.99, 0, 1)
    expect(hi.to).toBe(1)
    expect(hi.from).toBeCloseTo(0.9306, 3)
  })
})

describe('r115 · cvBarTone — tone thanh điểm CV (R27: 2 tầng)', () => {
  test('V R27 — best vòng = emerald · còn lại stone (bỏ tầng amber "thắng active" theo user bỏ đối chứng active)', () => {
    expect(cvBarTone({ idx: 3 }, 3)).toBe('emerald')
    expect(cvBarTone({ idx: 1 }, 3)).toBe('stone')
    expect(cvBarTone({ idx: 2 }, 3)).toBe('stone')
    // bestIdx null (chưa có best) → mọi ô stone
    expect(cvBarTone({ idx: 0 }, null)).toBe('stone')
  })
})
