/**
 * R24-c (EVO-P0 — blueprint EVO-NAO §4/§10 Q1): build 3 benchmark fixtures
 * từ DỮ LIỆU THẬT trong backup R2 (SQLite trước reset) dùng feature builder
 * THẬT của từng pipeline (single-source — import, không copy công thức).
 *
 * Nguồn: backups R2 `backups/sqlite/custom-2026-10-11T23-48-24-048Z.db`
 * (EvalResult 4 row — bản giàu eval nhất) + `custom-2026-10-15T05-59-22-820Z.db`
 * (AgentRunRecord 84 / ArbiterVerdict 108 — bản giàu run nhất).
 *
 * Chạy: cd /home/z/tmo-app && bun scratch/r24c-build-fixtures.ts
 * (script đọc scratch/r24c-*.db đã tải sẵn — xem r24c-r2-fetch*.ts)
 */
import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
// Feature builder THẬT (single-source doctrine #9)
import { buildFeatureVector, FAITHFULNESS_THRESHOLD } from '../src/lib/calibration-multifeature'
import {
  buildSurrogateVocab,
  buildSurrogateFeatureRow,
  surrogateFeatureNames,
  toLogSpace,
  type SurrogateFeatureCtx,
} from '../src/lib/brain/brains/surrogate'
import {
  buildPolicyVocab,
  buildPolicyFeatureRow,
  policyFeatureNames,
  buildPolicyActionVocab,
  type PolicyFeatureCtx,
} from '../src/lib/brain/brains/policy'

// ==================== Fixture contract (khớp evo/benchmark.ts EvoFixture) ====================

interface FixtureJson {
  brain: string
  version: 1
  nSamples: number
  inputDim: number
  outputDim: number
  featureNames: string[]
  outputNames: string[]
  lossHeads: Array<{ type: string; weight: number }>
  /** Số unit MỖI loss head chiếm (tổng = outputDim; CE head spans nhiều unit — softmax nhóm). */
  headSpans: number[]
  X: (number | null)[][]
  y: number[][]
  dataFingerprint: string
  sourceLabel: string
  builtFrom: string
  builtAt: string
}

function fingerprint(brain: string, X: (number | null)[][], y: number[][]): string {
  const round = (v: number | null) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 'n')
  const payload = JSON.stringify({
    brain,
    X: X.map(r => r.map(round)),
    y: y.map(r => r.map(round)),
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

const DB_A = 'scratch/r24c-custom-2026-10-11T23-48-24-048Z.db'
const DB_BC = 'scratch/r24c-custom-2026-10-15T05-59-22-820Z.db'
const OUT_DIR = 'src/lib/brain/evo/fixtures'
mkdirSync(OUT_DIR, { recursive: true })

// ==================== A · calibration_v3 — EvalResult thật (features-10) ====================

function buildA(): FixtureJson {
  const db = new Database(DB_A, { readonly: true })
  const evals: Array<Record<string, unknown>> = db
    .query('SELECT * FROM EvalResult ORDER BY createdAt ASC, id ASC')
    .all() as Record<string, unknown>[]
  const cases: Array<Record<string, unknown>> = db.query('SELECT * FROM EvalCase').all() as Record<string, unknown>[]
  const caseById = new Map(cases.map(c => [c.id as string, c]))
  const X: (number | null)[][] = []
  const y: number[][] = []
  for (const r of evals) {
    const c = caseById.get(r.caseId as string)
    // FeatureCtx thật của V2/V3: rawConfidence/coverage/answered/retrievedChunks/
    // extractionF1/hallucinationDetected từ EvalResult + difficulty/category từ EvalCase
    const feat = buildFeatureVector({
      rawConfidence: (r.rawConfidence as number | null) ?? undefined,
      coverage: (r.coverage as number | null) ?? undefined,
      answered: r.answered === 1 || r.answered === true,
      retrievedChunks: (r.retrievedChunks as number | null) ?? undefined,
      extractionF1: (r.extractionF1 as number | null) ?? undefined,
      hallucinationDetected: r.hallucinationDetected === 1 || r.hallucinationDetected === true,
      difficulty: (c?.difficulty as string | undefined) ?? undefined,
      category: (c?.category as string | undefined) ?? undefined,
    })
    X.push(feat)
    // Nhãn THẬT đúng semantics V2/V3: faithfulnessMedian > FAITHFULNESS_THRESHOLD
    y.push([(r.faithfulnessMedian as number) > FAITHFULNESS_THRESHOLD ? 1 : 0])
  }
  const inputDim = X[0]?.length ?? 0
  return {
    brain: 'calibration_v3',
    version: 1,
    nSamples: X.length,
    inputDim,
    outputDim: 1,
    featureNames: [
      'rawConfidence', 'coverage', 'answered', 'retrievedChunksLog1p', 'extractionF1',
      'hallucinationDetected', 'difficulty', 'categoryProgramming', 'categoryMl', 'categorySecurity',
    ],
    outputNames: ['faithful(>0.7)'],
    lossHeads: [{ type: 'bce', weight: 1 }],
    headSpans: [1],
    X,
    y,
    dataFingerprint: fingerprint('calibration_v3', X, y),
    sourceLabel:
      'EvalResult THẬT (4 row — toàn bộ nhãn eval KB còn sống trên mọi backup R2) + EvalCase difficulty/category, backup 2026-10-11T23:48Z. MỎNG (n=4 < ngưỡng train 30): chỉ đủ làm benchmark quy mô nhỏ — refresh trên máy USER (DB local có nhãn thật đầy đủ) bằng cùng script này.',
    builtFrom: 'R2 backups/sqlite/custom-2026-10-11T23-48-24-048Z.db',
    builtAt: new Date().toISOString(),
  }
}

// ==================== B · surrogate — AgentRunRecord thật (runs-features) ====================

function buildB(): FixtureJson {
  const db = new Database(DB_BC, { readonly: true })
  const rows: Array<Record<string, unknown>> = db
    .query('SELECT * FROM AgentRunRecord ORDER BY createdAt ASC, id ASC')
    .all() as Record<string, unknown>[]
  // Usable = ĐÚNG filter pipeline thật (surrogate.ts:630): model biết +
  // complete chốt + tokens/duration hữu hạn ≥ 0
  const usable = rows.filter(
    (r): r is Record<string, unknown> =>
      typeof r.model === 'string' && (r.model as string) !== ''
      && (typeof r.complete === 'number' || typeof r.complete === 'boolean')
      && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && (r.tokensUsed as number) >= 0
      && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && (r.durationMs as number) >= 0,
  )
  const ctxs: SurrogateFeatureCtx[] = usable.map(r => ({
    model: r.model as string,
    agent: (r.agentName as string | null) ?? null,
    delegated: r.parentRunId !== null && r.parentRunId !== undefined,
  }))
  const vocab = buildSurrogateVocab(ctxs)
  const X = ctxs.map(c => buildSurrogateFeatureRow(c, vocab))
  const y = usable.map(r => [
    (r.complete === 1 || r.complete === true) ? 1 : 0,
    toLogSpace(r.tokensUsed as number),
    toLogSpace(r.durationMs as number),
  ])
  return {
    brain: 'surrogate',
    version: 1,
    nSamples: X.length,
    inputDim: X[0]?.length ?? 0,
    outputDim: 3,
    featureNames: surrogateFeatureNames(vocab),
    outputNames: ['success', 'tokensLog1p', 'durationLog1p'],
    lossHeads: [
      { type: 'bce', weight: 0.5 },
      { type: 'huber', weight: 0.25 },
      { type: 'huber', weight: 0.25 },
    ],
    headSpans: [1, 1, 1],
    X,
    y,
    dataFingerprint: fingerprint('surrogate', X, y),
    sourceLabel:
      `AgentRunRecord THẬT usable (${usable.length}/${rows.length} row — model biết + complete chốt; 53/84 run cũ không ghi model) — backup 2026-10-15T05:59Z (bản giàu run nhất trước reset). Đặc trưng + nhãn ĐÚNG pipeline surrogate.ts (vocab one-hot + delegated; success=complete, tokens/duration log1p). Mỏng so ngưỡng train thật (60): benchmark quy mô nhỏ — refresh trên máy USER (DB local đầy run có model) bằng cùng script.`,
    builtFrom: 'R2 backups/sqlite/custom-2026-10-15T05-59-22-820Z.db',
    builtAt: new Date().toISOString(),
  }
}

// ==================== C · policy — AgentRunRecord thật (task-features → model) ====================

function buildC(): FixtureJson {
  const db = new Database(DB_BC, { readonly: true })
  const rows: Array<Record<string, unknown>> = db
    .query('SELECT * FROM AgentRunRecord ORDER BY createdAt ASC, id ASC')
    .all() as Record<string, unknown>[]
  // Hành động = model ĐÃ CHỌN thật (imitation — không reward-weight: bản đầy đủ
  // của pipeline policy.ts cần QEntry/ArbiterVerdict join; fixture là proxy
  // trung thực từ lựa chọn thật, CÙNG dữ liệu cho mọi ứng viên + baseline)
  const withModel = rows.filter(r => typeof r.model === 'string' && (r.model as string) !== '')
  const ctxs: PolicyFeatureCtx[] = withModel.map(r => ({
    agent: (r.agentName as string | null) ?? null,
    delegated: r.parentRunId !== null && r.parentRunId !== undefined,
  }))
  const vocab = buildPolicyVocab(ctxs)
  const actionVocab = buildPolicyActionVocab(withModel.map(r => r.model as string))
  const X = ctxs.map(c => buildPolicyFeatureRow(c, vocab))
  const y = withModel.map(r =>
    actionVocab.models.map(m => ((r.model as string) === m ? 1 : 0)),
  )
  return {
    brain: 'policy',
    version: 1,
    nSamples: X.length,
    inputDim: X[0]?.length ?? 0,
    outputDim: actionVocab.models.length,
    featureNames: policyFeatureNames(vocab),
    outputNames: actionVocab.models.map(m => `model:${m}`),
    lossHeads: [{ type: 'crossEntropy', weight: 1 }],
    headSpans: [actionVocab.models.length],
    X,
    y,
    dataFingerprint: fingerprint('policy', X, y),
    sourceLabel:
      'Imitation trên lựa chọn model THẬT (31 run có model, 7 hành động) — backup 2026-10-15T05:59Z. Proxy trung thực: bản reward-weighted đầy đủ (QEntry/verdict join) sống trong pipeline policy.ts thật; benchmark chỉ cần CÙNG dữ liệu cho mọi ứng viên + baseline (blueprint §0.1 EVO-P0).',
    builtFrom: 'R2 backups/sqlite/custom-2026-10-15T05-59-22-820Z.db',
    builtAt: new Date().toISOString(),
  }
}

// ==================== GHI RA ====================

for (const [name, fx] of [
  ['calibration_v3', buildA()],
  ['surrogate', buildB()],
  ['policy', buildC()],
] as Array<[string, FixtureJson]>) {
  const path = `${OUT_DIR}/${name}.json`
  writeFileSync(path, JSON.stringify(fx))
  console.log(
    `[fixture] ${path} — n=${fx.nSamples} in=${fx.inputDim} out=${fx.outputDim} fp=${fx.dataFingerprint}`,
  )
}
console.log('DONE')
