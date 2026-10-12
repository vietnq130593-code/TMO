/**
 * ROUND-89 TESTS — BRAIN-UX §9.3 (UX-2) · TRAINING CONSOLE: Σλ + CHUỖI HIỆU LỰC + AUDIT
 * (blueprint v0.10 §9 — TrainingConsole nhóm A/B/C, tuning-store chuỗi
 * STORE › ENV › DEFAULT, audit TuningChangeLog §9.3-C)
 *
 * Đo lường:
 *   A. normalizeLossWeights (§9.3 nhóm B — thuần): [1,1,1]→[⅓×3] · [0.5,0.5,0]
 *      giữ nguyên 0 · [2,2,2]→[⅓×3] · [0,0,0]→chia đều · NaN/âm → 0 · []→[]
 *      · Σ kết quả luôn = 1 (hoặc 0 với []).
 *   B. lossScalePerHead (PIN HỒI QUY default = hành vi trước UX-2): [1,1,1]
 *      → [1,1,1] (đều 1.0/head) · [0.9,0.05,0.05]→[2.7,0.15,0.15] · Σ=n ·
 *      2 đầu [0,1]→[0,2].
 *   C. surrogateDraftFitOpts (§9.3): không override → nguyên gốc 500/32/50,
 *      holdOutRatio/clipNorm/lossScale undefined (mlp.ts tự mặc định) ·
 *      default draft → holdOut 0.15 + clip 5 + scale 1/head · draft λ riêng
 *      → lossScale đúng thứ tự head 0/1/2.
 *   D. resolveRewardWeightsFromTuning (UX-2 nhóm C): mặc định SO SÁNH BẰNG
 *      REWARD_WEIGHTS (pin UX-2 không đổi hành vi) · override store · ENV
 *      fallback (process.env đọc TRỰC TIẾP trong resolveTuning — không cache
 *      env, chỉ snapshot STORE cần refresh) · STORE thắng ENV.
 *   E. Chuỗi hiệu lực 3 cờ UI (ui_brain_edit/ui_synapse_fx/ui_hitech):
 *      BRAIN-LIVE (chỉ thị user 2026-10-12) tách kỳ vọng — ui_brain_edit
 *      + ui_hitech default 'off' (fail-open trình bày) nhưng ui_synapse_fx
 *      default 'on' (tab BRAIN module Smolab là "đài quan sát não" — hiệu
 *      ứng lan truyền là nội dung chính; reduced-motion vẫn tắt animation).
 *      Lifecycle set/reset pin trên ui_brain_edit (off→on→off).
 *   F. AUDIT TRAIL §9.3-C: set → TuningChangeLog row action='set'
 *      toStoreValue='0.7' · reset → row action='reset' toStoreValue=null —
 *      log append-only (KHÔNG xóa rows), chỉ đưa store value về default.
 *
 * Nguyên tắc test (bài học r83/r81 — bun test 1 process, thứ tự tùy ý):
 * - MỌI setTuningValue/process.env dọn trong finally/afterAll — không để
 *   state tuning/env rò ra file khác.
 * - DB-cô-lập (preload); file KHÔNG đụng BrainModel/AgentRunRecord.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  normalizeLossWeights,
  lossScalePerHead,
  defaultDraftFor,
} from '@/lib/brain/spec-schema'
import { surrogateDraftFitOpts } from '@/lib/brain/brains/surrogate'
import { REWARD_WEIGHTS, resolveRewardWeightsFromTuning } from '@/lib/brain/reward'
import {
  getTuningEnum,
  resolveTuning,
  setTuningValue,
  resetTuningValue,
  refreshTuningSnapshot,
} from '@/lib/learning/tuning-store'

/** 6 key UX-1/2 (bản r89 đụng tới) — dọn sạch 1 chỗ, dùng many nơi. */
const UX2_KEYS = [
  'reward_w_outcome',
  'reward_w_efficiency',
  'reward_w_quality',
  'ui_brain_edit',
  'ui_synapse_fx',
  'ui_hitech',
] as const

const UX2_ENV_KEYS = [
  'REWARD_W_OUTCOME',
  'REWARD_W_EFFICIENCY',
  'REWARD_W_QUALITY',
  'UI_BRAIN_EDIT',
  'UI_SYNAPSE_FX',
  'UI_HITECH',
] as const

/** Dọn TOÀN BỘ state 6 key UX-2 (store + env + snapshot) — dùng before/after. */
async function wipeUx2State(): Promise<void> {
  for (const key of UX2_KEYS) await resetTuningValue(key).catch(() => {})
  for (const env of UX2_ENV_KEYS) delete process.env[env]
  await refreshTuningSnapshot()
}

// ==================== A. normalizeLossWeights (§9.3 nhóm B — thuần) ====================

describe('r89 · A normalizeLossWeights — chuẩn hoá Σλ=1 (thuần)', () => {
  test('[1,1,1]→[⅓×3]; [0.5,0.5,0] giữ nguyên 0; [2,2,2]→[⅓×3]; [0,0,0]→chia đều', () => {
    expect(normalizeLossWeights([1, 1, 1])).toEqual([1 / 3, 1 / 3, 1 / 3])
    // weight 0 giữ nguyên 0 (head bị loại khỏi Σλ khi APPLY — Σ chuẩn hoá
    // bằng giá trị DƯƠNG, 0 không nhân lên)
    expect(normalizeLossWeights([0.5, 0.5, 0])).toEqual([0.5, 0.5, 0])
    // Cùng tỉ lệ → cùng kết quả (bất biến theo scale)
    expect(normalizeLossWeights([2, 2, 2])).toEqual([1 / 3, 1 / 3, 1 / 3])
    // Σ=0 → chia đều (fail-open về default 1/n)
    expect(normalizeLossWeights([0, 0, 0])).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  test('NaN / âm → 0 (vô hiệu bị loại); [] → []', () => {
    expect(normalizeLossWeights([NaN, 1])).toEqual([0, 1])
    expect(normalizeLossWeights([-1, 1])).toEqual([0, 1])
    expect(normalizeLossWeights([])).toEqual([])
  })

  test('Σ kết quả luôn = 1 (hoặc 0 với []) — mọi đầu vào ở trên', () => {
    const inputs = [[1, 1, 1], [0.5, 0.5, 0], [2, 2, 2], [0, 0, 0], [NaN, 1], [-1, 1], [0.9, 0.05, 0.05]]
    for (const w of inputs) {
      const out = normalizeLossWeights(w)
      const sum = out.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1, 12)
    }
    expect(normalizeLossWeights([]).reduce((a, b) => a + b, 0)).toBe(0)
  })
})

// ==================== B. lossScalePerHead (PIN HỒI QUY trước UX-2) ====================

describe('r89 · B lossScalePerHead — scaleᵢ = λᵢ × n (§9.3)', () => {
  test('[1,1,1]→[1,1,1] — PIN HỒI QUY: default draft = hành vi trước UX-2', () => {
    // Chia đều 1/n mỗi đầu → scale 1.0/head: đúng bằng chứng hồi quy mà
    // spec-schema.lossScalePerHead JSDoc cam kết (draft mặc định train ra
    // kết quả Y HỆT không draft)
    expect(lossScalePerHead([1, 1, 1])).toEqual([1, 1, 1])
  })

  test('[0.9,0.05,0.05]→[2.7,0.15,0.15]; Σ scale = n; 2 đầu [0,1]→[0,2]; []→[]', () => {
    // 0.05×3 = 0.15000000000000002 trong float — so từng phần tử BY TOLERANCE
    // (0.15 decimal không representable chính xác)
    const scales = lossScalePerHead([0.9, 0.05, 0.05])
    expect(scales[0]).toBeCloseTo(2.7, 12)
    expect(scales[1]).toBeCloseTo(0.15, 12)
    expect(scales[2]).toBeCloseTo(0.15, 12)
    // Σ = n cho mọi đầu vào (sau nhân n)
    expect(lossScalePerHead([0.9, 0.05, 0.05]).reduce((a, b) => a + b, 0)).toBeCloseTo(3, 12)
    expect(lossScalePerHead([1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(3, 12)
    // 2 đầu: head bị loại scale 0, đầu còn lại gánh đôi
    expect(lossScalePerHead([0, 1])).toEqual([0, 2])
    expect(lossScalePerHead([])).toEqual([])
  })
})

// ==================== C. surrogateDraftFitOpts (§9.3 — FitOptions từng head) ====================

describe('r89 · C surrogateDraftFitOpts — head 0=success · 1=tokens · 2=durationMs', () => {
  test('không override → {epochs:500, batchSize:32, patience:50} + 3 trường rơi mặc định mlp.ts', () => {
    const opts = surrogateDraftFitOpts(undefined, 0)
    // Nguyên gốc surrogate.ts:100-113 — trước UX-2 không có holdOutRatio/
    // clipNorm/lossScale trong FitOptions (mlp.ts tự mặc định 0.15/5/không scale)
    expect(opts).toEqual({ epochs: 500, batchSize: 32, patience: 50 })
    expect(opts.holdOutRatio).toBeUndefined()
    expect(opts.clipNorm).toBeUndefined()
    expect(opts.lossScale).toBeUndefined()
    // 3 head dùng chung options gốc (không phân biệt head khi không draft)
    expect(surrogateDraftFitOpts(undefined, 1)).toEqual(surrogateDraftFitOpts(undefined, 2))
  })

  test("default draft → holdOutRatio 0.15 + clipNorm 5 + lossScale 1 MỖI head (hồi quy)", () => {
    const draft = defaultDraftFor('surrogate')
    for (const headIdx of [0, 1, 2] as const) {
      const opts = surrogateDraftFitOpts(draft, headIdx)
      expect(opts.holdOutRatio).toBe(0.15)
      expect(opts.clipNorm).toBe(5)
      // λ đều ⅓ → scale ⅓×3 = 1 mỗi head — đúng hành vi trước UX-2
      expect(opts.lossScale).toBe(1)
      expect(opts.epochs).toBe(500)
      expect(opts.batchSize).toBe(32)
      expect(opts.patience).toBe(50)
    }
  })

  test('draft λ [0.6,0.2,0.2] → lossScale [1.8,0.6,0.6] ĐÚNG THỨ TỰ head 0/1/2', () => {
    const draft: ReturnType<typeof defaultDraftFor> = {
      ...defaultDraftFor('surrogate'),
      lossPerHead: [
        { type: 'bce', weight: 0.6 },
        { type: 'huber', weight: 0.2 },
        { type: 'mse', weight: 0.2 },
      ],
      // hyper khác default để chốt override thật sự truyền qua (không trùng
      // giá trị mặc định — tránh pass giả do 2 bên cùng 500/32/50)
      hyper: { ...defaultDraftFor('surrogate').hyper, epochs: 300, batch: 16, patience: 25, holdout: 0.2, clip: 3 },
    }
    expect(surrogateDraftFitOpts(draft, 0).lossScale).toBeCloseTo(1.8, 12) // 0.6×3
    expect(surrogateDraftFitOpts(draft, 1).lossScale).toBeCloseTo(0.6, 12) // 0.2×3
    expect(surrogateDraftFitOpts(draft, 2).lossScale).toBeCloseTo(0.6, 12)
    // Hyper override truyền đúng từng head
    const o1 = surrogateDraftFitOpts(draft, 1)
    expect(o1.epochs).toBe(300)
    expect(o1.batchSize).toBe(16)
    expect(o1.patience).toBe(25)
    expect(o1.holdOutRatio).toBe(0.2)
    expect(o1.clipNorm).toBe(3)
  })
})

// ==================== D. resolveRewardWeightsFromTuning (UX-2 nhóm C) ====================

describe('r89 · D resolveRewardWeightsFromTuning — STORE › ENV › DEFAULT=REWARD_WEIGHTS', () => {
  beforeAll(wipeUx2State)
  afterAll(wipeUx2State)

  test('mặc định → SO SÁNH BẰNG từng trường REWARD_WEIGHTS (pin: UX-2 không đổi hành vi)', async () => {
    // Dọn lại trong test (bất kể file khác chạy trước để lại gì)
    await wipeUx2State()
    const w = resolveRewardWeightsFromTuning()
    // Bằng từng trường (toBe — cùng literal 1/3 của spec default; UX-2 chỉ
    // thêm đường override, default phải Y HỆT hằng số nguồn REWARD_WEIGHTS)
    expect(w.outcome).toBe(REWARD_WEIGHTS.outcome)
    expect(w.efficiency).toBe(REWARD_WEIGHTS.efficiency)
    expect(w.quality).toBe(REWARD_WEIGHTS.quality)
    expect(resolveTuning('reward_w_outcome').source).toBe('default')
  })

  test("setTuningValue('reward_w_outcome','0.5') → {0.5, ⅓, ⅓} — dọn trong finally", async () => {
    try {
      await setTuningValue('reward_w_outcome', '0.5')
      const w = resolveRewardWeightsFromTuning()
      expect(w.outcome).toBe(0.5)
      expect(w.efficiency).toBe(1 / 3) // 2 key còn lại vẫn default
      expect(w.quality).toBe(1 / 3)
      expect(resolveTuning('reward_w_outcome').source).toBe('store')
    } finally {
      await resetTuningValue('reward_w_outcome').catch(() => {})
      await refreshTuningSnapshot()
    }
    // Sau dọn: về lại default (không rò sang test khác trong file)
    expect(resolveRewardWeightsFromTuning().outcome).toBe(REWARD_WEIGHTS.outcome)
  })

  test('ENV fallback: REWARD_W_EFFICIENCY=0.8 (không store) → efficiency 0.8', async () => {
    try {
      // Store phải sạch key này (finally test trước đã reset + refresh)
      process.env.REWARD_W_EFFICIENCY = '0.8'
      // resolveTuning đọc process.env TRỰC TIẾP mỗi call (env KHÔNG nằm trong
      // snapshot 5s — chỉ STORE được cache) → không cần chờ TTL; refresh ở
      // đây chỉ để snapshot STORE phản ánh "không có override"
      await refreshTuningSnapshot()
      const w = resolveRewardWeightsFromTuning()
      expect(w.efficiency).toBe(0.8)
      expect(w.outcome).toBe(1 / 3)
      expect(w.quality).toBe(1 / 3)
      expect(resolveTuning('reward_w_efficiency').source).toBe('env')
    } finally {
      delete process.env.REWARD_W_EFFICIENCY
      await resetTuningValue('reward_w_efficiency').catch(() => {})
      await refreshTuningSnapshot()
    }
    expect(resolveRewardWeightsFromTuning().efficiency).toBe(REWARD_WEIGHTS.efficiency)
  })

  test('STORE thắng ENV: store 0.6 + env 0.8 → 0.6', async () => {
    try {
      process.env.REWARD_W_EFFICIENCY = '0.8'
      await setTuningValue('reward_w_efficiency', '0.6')
      // setTuningValue cập nhật snapshot NGAY (cùng process thấy tức thì)
      const w = resolveRewardWeightsFromTuning()
      expect(w.efficiency).toBe(0.6)
      expect(resolveTuning('reward_w_efficiency').source).toBe('store')
    } finally {
      delete process.env.REWARD_W_EFFICIENCY
      await resetTuningValue('reward_w_efficiency').catch(() => {})
      await refreshTuningSnapshot()
    }
  })
})

// ==================== E. CHUỖI HIỆU LỰC 3 CỜ UI (r89 phần console) ====================

describe('r89 · E chuỗi hiệu lực cờ UI — ui_brain_edit / ui_synapse_fx / ui_hitech', () => {
  beforeAll(wipeUx2State)
  afterAll(wipeUx2State)

  test("mặc định: ui_brain_edit + ui_hitech = 'off' (fail-open trình bày) — CÒN ui_synapse_fx = 'on' (BRAIN-LIVE)", async () => {
    await wipeUx2State()
    // BRAIN-LIVE (chỉ thị user 2026-10-12): tab BRAIN module Smolab là
    // "đài quan sát não" — hiệu ứng synapse mặc định BẬT (nội dung chính,
    // không phải trang trí); editor/theme vẫn mặc định TẮT. Reduced-motion
    // vẫn tắt animation ở tầng isAnimated (r90-G pin — cờ này không đụng).
    expect(getTuningEnum('ui_brain_edit')).toBe('off')
    expect(getTuningEnum('ui_hitech')).toBe('off')
    expect(getTuningEnum('ui_synapse_fx')).toBe('on')
  })

  test("setTuningValue('ui_brain_edit','on') → 'on'; resetTuningValue → 'off' — dọn finally", async () => {
    try {
      await setTuningValue('ui_brain_edit', 'on')
      expect(getTuningEnum('ui_brain_edit')).toBe('on')
      // STORE ghi DB — sống qua refresh (không phải cache đẹt)
      await refreshTuningSnapshot()
      expect(getTuningEnum('ui_brain_edit')).toBe('on')
      await resetTuningValue('ui_brain_edit')
      expect(getTuningEnum('ui_brain_edit')).toBe('off')
    } finally {
      await resetTuningValue('ui_brain_edit').catch(() => {})
      await refreshTuningSnapshot()
    }
  })
})

// ==================== F. AUDIT TRAIL (§9.3-C — TuningChangeLog) ====================

describe('r89 · F audit trail — set/reset ghi TuningChangeLog (append-only)', () => {
  beforeAll(wipeUx2State)
  afterAll(wipeUx2State)

  test("set '0.7' → row action='set' toStoreValue='0.7'; reset → row action='reset' toStoreValue=null", async () => {
    try {
      await setTuningValue('reward_w_quality', '0.7')
      // Row MỚI NHẤT cho key này (file khác có thể đã ghi log — lọc theo key)
      const afterSet = await db.tuningChangeLog.findFirst({
        where: { key: 'reward_w_quality' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      expect(afterSet).not.toBeNull()
      expect(afterSet!.action).toBe('set')
      expect(afterSet!.toStoreValue).toBe('0.7') // validateTuningInput chuẩn hoá 6 chữ số lẻ → '0.7'
      expect(afterSet!.fromStoreValue).toBeNull() // trước đó chưa ai đặt (beforeAll dọn)

      await resetTuningValue('reward_w_quality')
      const afterReset = await db.tuningChangeLog.findFirst({
        where: { key: 'reward_w_quality' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      expect(afterReset).not.toBeNull()
      expect(afterReset!.action).toBe('reset')
      expect(afterReset!.toStoreValue).toBeNull()
      expect(afterReset!.fromStoreValue).toBe('0.7') // trước reset là 0.7
    } finally {
      // Log là append-only — KHÔNG xóa rows; chỉ đưa store value về default
      await resetTuningValue('reward_w_quality').catch(() => {})
      await refreshTuningSnapshot()
    }
    // State sạch sau finally — store value về default (log vẫn giữ 2 rows)
    expect(resolveTuning('reward_w_quality').source).toBe('default')
  })
})
