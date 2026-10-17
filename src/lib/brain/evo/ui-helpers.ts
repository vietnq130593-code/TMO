/**
 * EVO UI (BLUEPRINT-EVO-NAO-P1-P5 §5 — R25-c) — HELPER THUẦN cho tab "Tiến hoá"
 * ============================================================================
 *
 * Toàn bộ logic trình bày có thể test độc lập (0 import server, 0 import
 * React — doctrine #9 single-source cho client + bun:test). Nguồn contract:
 * `EvolveCandidateRow/EvolveRunState/EvolveGetResponse` pin §5.7 trong
 * `src/lib/brain/evolve.ts` (r108) — file ĐÓ import db (server-only) nên UI
 * định nghĩa type structural mirror tại đây (giữ đồng bộ theo r108) thay vì
 * kéo server code vào client bundle.
 *
 * Bản vẽ vùng encoding (§4.2 — pin r105, search-space.ts dòng 543-581):
 *   [0..95]   HN-P1 legacy (nLayers · units · act one-hot · α/β · loss ·
 *             headWeight · δ · 9 hyper · inputDim · brain one-hot)
 *   [96..113] layer-type: 3 block × 6 one-hot — EVO_BLOCK_TYPES
 *             ['identity','mlp','attention','ssm','moe','gated'], block b
 *             bắt đầu 96 + b*6
 *   [114..131] block-param: 3 block × 6 (headDim · ssmN · expansion · moeK ·
 *             dropout · residualScale)
 *   [132..135] MoE toàn cục (kExperts · routerTemp · auxWeight · gatingTop2)
 *   [136..143] dự phòng — luôn 0
 *
 * Compat F4: encoding 96-dim (legacy HN-P1) = LUÔN ứng viên thuần MLP
 * (padEvo96to144 → mọi block identity).
 */

// ==================== CONTRACT MIRROR (§5.7 — đồng bộ r108, KHÔNG import server) ====================

/** Ứng viên 1 vòng evolve — mirror EvolveCandidateRow (cvScore HIGHER-BETTER). */
export interface EvoCandidateRowUi {
  idx: number
  /** Chuỗi compact single-source server (formatArchSummary evo/blocks.ts). */
  archSummary: string
  cvScore: number
  ciLow: number
  ciHigh: number
  params: number
  trainMs: number
  p95LatencyMs: number
  beatActive: boolean
  blockedH7: boolean
  /** 144-dim EVO (hoặc 96-dim legacy HN-P1 — compat F4). */
  encoding: number[]
  spec: unknown
  moeSkipped: boolean
  note?: string
}

/** Trạng thái 1 vòng — mirror EvolveRunState. */
export interface EvoRunStateUi {
  id: string
  brain: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  seed: number
  candidatesMax: number
  progress: { done: number; total: number; elapsedMs: number; wallMsMax: number }
  summary?: {
    bestCandidateIdx: number | null
    nBeatActive: number
    nBlockedH7: number
    durationMs: number
    note?: string
  }
  error?: string
}

/** GET /api/brain/evolve — mirror EvolveGetResponse (run=null + candidates=[] khi chưa có vòng). */
export interface EvoGetResponseUi {
  ok: true
  run: EvoRunStateUi | null
  candidates: EvoCandidateRowUi[]
}

/** Trần tham số mọi ứng viên (mirror EVO_MAX_PARAMS evolve.ts — BRAIN_MAX_PARAMS precedent). */
export const EVO_PARAMS_BUDGET = 250_000

// ==================== U1 — STATE MACHINE (E1..E4 + cờ E5) ====================

/**
 * Kết quả HTTP của GET evolve — phân biệt 3 trường hợp (§5.1-6/F3):
 *  - 'ok'        : 200 — dữ liệu tươi.
 *  - 'not_found' : 404 — route CHƯA deploy → E1 "CHƯA SẴN SÀNG" (không phải
 *                  mất kết nối).
 *  - 'error'     : 5xx/mạng — caller GIỮ dữ liệu cũ + chip "mất kết nối";
 *                  hàm nhận run stale (cũ) và suy diễn tiếp như 'ok'.
 */
export type EvoHttpStatus = 'ok' | 'not_found' | 'error'

export type EvoBodyState = 'e1' | 'e2' | 'e3' | 'e4'

export interface EvoDerivedState {
  /** E1 chưa đủ điều kiện · E2 sẵn sàng · E3 đang chạy · E4 xong (done/failed/cancelled). */
  state: EvoBodyState
  /**
   * E5 KHÔNG phải trạng thái riêng của run — là KHU VÙNG hiển thị khi có
   * ứng viên blockedH7 (§5.2); component dùng cờ này để render khu vực riêng.
   */
  hasBlockedH7: boolean
}

/**
 * Suy diễn trạng thái thân tab từ kết quả poll — KHÔNG optimistic update
 * (POST xong caller phải chờ GET xác nhận running rồi mới vào E3 — §5.2).
 */
export function deriveEvoState(
  run: EvoRunStateUi | null,
  http: EvoHttpStatus,
  candidates: readonly EvoCandidateRowUi[] = [],
): EvoDerivedState {
  if (http === 'not_found') return { state: 'e1', hasBlockedH7: false }
  if (!run) return { state: 'e2', hasBlockedH7: false }
  if (run.status === 'running') {
    return { state: 'e3', hasBlockedH7: candidates.some(c => c.blockedH7) }
  }
  const fromSummary = (run.summary?.nBlockedH7 ?? 0) > 0
  return { state: 'e4', hasBlockedH7: candidates.some(c => c.blockedH7) || fromSummary }
}

// ==================== U3 — ENCODING VIEWER (chia vùng 96/144) ====================

export type EvoZoneId = 'hnp1' | 'blocktype' | 'blockparam' | 'moeglobal' | 'reserved'

export interface EvoEncodingZone {
  id: EvoZoneId
  /** Nhãn tiếng Việt ngắn — tooltip U3 (tên vùng + ý nghĩa slot). */
  label: string
  start: number
  end: number
  /** Trung bình giá trị chuẩn hoá [0,1] các slot trong vùng (độ sáng U3). */
  mean: number
  /** Vùng riêng của EVO 144 (false = HN-P1 [0..95] dùng chung 2 độ dài). */
  isEvo: boolean
}

/**
 * Bảng vùng 144-dim — SỐ LITERAL biên pin r115 (không import hằng server để
 * file thuần client-safe; r105 pin cùng số ở search-space.ts).
 */
const ZONE_TABLE: ReadonlyArray<Omit<EvoEncodingZone, 'mean'>> = [
  { id: 'hnp1', label: 'HN-P1 · 96 chiều MLP (lớp ẩn · activation · loss · hyper)', start: 0, end: 95, isEvo: false },
  { id: 'blocktype', label: 'Loại block · 3 × one-hot 6 loại (identity·mlp·attention·ssm·moe·gated)', start: 96, end: 113, isEvo: true },
  { id: 'blockparam', label: 'Tham số block · headDim·ssmN·expansion·moeK·dropout·residualScale', start: 114, end: 131, isEvo: true },
  { id: 'moeglobal', label: 'MoE toàn cục · kExperts·routerTemp·auxWeight·gatingTop2', start: 132, end: 135, isEvo: true },
  { id: 'reserved', label: 'Dự phòng — luôn 0 (§8.4 mở tiếp)', start: 136, end: 143, isEvo: true },
]

export interface EvoEncodingSplit {
  /** 96 (legacy HN-P1 — chỉ vùng [0..95]) · 144 (đủ 5 vùng) · null (không nhận dạng). */
  dim: 96 | 144 | null
  zones: EvoEncodingZone[]
}

function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/**
 * Chia encoding thành các vùng cho viewer U3 (compat F4): 144-dim → 5 vùng;
 * 96-dim → chỉ vùng HN-P1 [0..95] (chip "96-dim (HN-P1 — không vùng block)");
 * độ dài lạ → dim=null + zones=[] (component hiển thị chip phòng thủ).
 */
export function splitEncodingZones(encoding: readonly number[]): EvoEncodingSplit {
  const n = encoding.length
  if (n === 96) {
    const z = ZONE_TABLE[0]!
    return { dim: 96, zones: [{ ...z, mean: meanOf(encoding, z.start, z.end) }] }
  }
  if (n === 144) {
    return {
      dim: 144,
      zones: ZONE_TABLE.map(z => ({ ...z, mean: meanOf(encoding, z.start, z.end) })),
    }
  }
  return { dim: null, zones: [] }
}

function meanOf(encoding: readonly number[], start: number, end: number): number {
  let sum = 0
  for (let i = start; i <= end; i++) sum += clamp01(encoding[i])
  return sum / (end - start + 1)
}

// ==================== PURE-MLP DETECTION (2 cấp áp dụng §5.3) ====================

/**
 * Encoding có phải ứng viên THUẦN MLP không (mọi block identity)?
 *  - 96-dim legacy → LUÔN true (F4: pad về 144 thì mọi block identity).
 *  - 144-dim → theo argmax one-hot từng block (đúng语义 decodeEvoCandidate:
 *    slot identity [base+0] không bị slot nào [base+1..5] vượt).
 *  - độ dài lạ → null (không biết).
 */
export function isPureMlpEncoding(encoding: readonly number[]): boolean | null {
  const n = encoding.length
  if (n === 96) return true
  if (n !== 144) return null
  for (let b = 0; b < 3; b++) {
    const base = 96 + b * 6
    const identityV = clamp01(encoding[base])
    for (let j = 1; j < 6; j++) {
      if (clamp01(encoding[base + j]!) > identityV) return false
    }
  }
  return true
}

/**
 * Ứng viên có áp được vào NHÁP MLP (editor v1) không — encoding là nguồn chính,
 * fallback spec.blocks (mọi block identity) khi encoding lạ. Không đọc được
 * gì → false (bảo thủ: không cho ghi nháp thứ không decode được).
 */
export function isPureMlpCandidate(cand: { encoding?: unknown; spec?: unknown }): boolean {
  if (Array.isArray(cand.encoding)) {
    const r = isPureMlpEncoding(cand.encoding)
    if (r !== null) return r
  }
  const spec = cand.spec
  if (spec && typeof spec === 'object') {
    const blocks = (spec as { blocks?: unknown }).blocks
    if (Array.isArray(blocks)) {
      return blocks.every(
        b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'identity',
      )
    }
  }
  return false
}

/** Đọc hidden layers từ spec ứng viên (head.hidden) — null nếu không parse được. */
export function hiddenFromSpec(spec: unknown): Array<{ units: number; activation: string }> | null {
  if (!spec || typeof spec !== 'object') return null
  const head = (spec as { head?: unknown }).head
  if (!head || typeof head !== 'object') return null
  const hidden = (head as { hidden?: unknown }).hidden
  if (!Array.isArray(hidden) || hidden.length === 0) return null
  const out: Array<{ units: number; activation: string }> = []
  for (const h of hidden) {
    if (!h || typeof h !== 'object') return null
    const units = (h as { units?: unknown }).units
    const activation = (h as { activation?: unknown }).activation
    if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) return null
    if (typeof activation !== 'string' || activation.length === 0) return null
    out.push({ units: Math.round(units), activation })
  }
  return out
}

// ==================== U4 — PARETO FRONT + XẾP HẠNG ====================

/**
 * Pareto front trên TẬP THẮNG CV (beatActive — §5.5): tập idx KHÔNG bị
 * dominated về (params↓ thấp hơn, cvScore↑ cao hơn). A dominates B ⇔ A
 * tốt-không-kém ở cả 2 trục VÀ strictly tốt hơn ở ít nhất 1 trục.
 */
export function paretoFront(
  cands: ReadonlyArray<{ idx: number; cvScore: number; params: number; beatActive: boolean }>,
): number[] {
  const winners = cands.filter(c => c.beatActive)
  const front: number[] = []
  for (const a of winners) {
    const dominated = winners.some(b =>
      b !== a
      && b.params <= a.params
      && b.cvScore >= a.cvScore
      && (b.params < a.params || b.cvScore > a.cvScore),
    )
    if (!dominated) front.push(a.idx)
  }
  return front
}

/** Sort bảng U2 — cvScore desc (HIGHER-BETTER), tie-break idx asc tất định. */
export function sortCandidates<T extends { idx: number; cvScore: number }>(cands: readonly T[]): T[] {
  return [...cands].sort((a, b) => b.cvScore - a.cvScore || a.idx - b.idx)
}

// ==================== FORMAT (copy §5.2/§5.8) ====================

/** Số nguyên vi-VN (1.234.567 — dấu chạch nghìn). */
export function formatViNum(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('vi-VN') : '—'
}

/** Số thập phân vi-VN (dấu phẩy) — toFixed + đổi dấu chấm. */
export function formatViDecimal(n: number, digits: number): string {
  return (Number.isFinite(n) ? n.toFixed(digits) : (0).toFixed(digits)).replace('.', ',')
}

/** % ngân sách tham số so với trần 250K (làm tròn 0 chữ số). */
export function formatParamsBudget(params: number, budget = EVO_PARAMS_BUDGET): string {
  const pct = Math.round((params / budget) * 100)
  return `${pct}%`
}

/**
 * Rolling log E3 — "#7 · [gated·0.9] → MLP[128,64] · CV 0,164 · 2,4s"
 * (archSummary single-source server; CV 3 chữ số · giây 1 chữ số, vi-VN).
 */
export function formatCandidateLog(cand: { idx: number; archSummary: string; cvScore: number; trainMs: number }): string {
  const cv = formatViDecimal(cand.cvScore, 3)
  const sec = formatViDecimal(cand.trainMs / 1000, 1)
  return `#${cand.idx} · ${cand.archSummary} · CV ${cv} · ${sec}s`
}
