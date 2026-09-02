/**
 * RESEARCH TEAM — G2 EXPERIMENT (TB-14 §3 vòng 4 + §8 ExperimentRecord + TC-16)
 * =================================================================================
 * Spec:
 *  - TB-14 §3 vòng 4 EXPERIMENT — HAN dựng options A/B/C + scorecard B kỳ vọng
 *    (scoreRubricB), LISMA đo → scorecard B thực đo → computeScorecardDelta.
 *  - TB-14 §8 + Phụ lục Z2.2/Z2.3 — ExperimentRecord model:
 *      status flow DRAFT → SPEC → POC → MEASURED → SCORED.
 *  - TB-14 §10 TC-16 — calibration delta: persist deltaJson + calibration lesson refs.
 *
 * Lifecycle functions (status transitions):
 *  - createExperiment       → DRAFT
 *  - setSpec                → SPEC (ghi specPath)
 *  - startPoc               → POC   (ghi branchName = P-POC-<optionId>)
 *  - recordMetrics          → MEASURED (ghi metricsJson)
 *  - scoreExperiment        → SCORED (ghi scoreMeasured + deltaJson + lesson refs)
 *
 * Fail-open: mọi function wrap try/catch. DB error → throw (caller handle,
 * KHÔNG crash process — caller có try/catch ở tournament/king layer). Các hàm
 * get/list không throw — trả null/empty array khi DB error.
 */

import { db } from '@/lib/db'
import {
  encodeJson,
  decodeJsonObject,
  decodeJson,
  decodeExperiment,
  type DecodedExperimentRecord,
  type ExperimentDelta,
} from '../types'
import { computeScorecardDelta, type RubricBResult } from '../scoring/rubric-b'

// ============================================================
// §1. CONSTANTS
// ============================================================

const BRANCH_PREFIX = 'P-POC-' // TB-14 §3 vòng 4 — branch workspace P-POC-<option>

// ============================================================
// §2. LIFECYCLE — create / setSpec / startPoc / recordMetrics / scoreExperiment
// ============================================================

/** Tạo ExperimentRecord mới với status 'DRAFT'. */
export async function createExperiment(
  missionId: string,
  optionId: string,
  hypothesisRef?: string,
): Promise<DecodedExperimentRecord> {
  const row = await db.experimentRecord.create({
    data: {
      missionId,
      optionId,
      hypothesisRef: hypothesisRef ?? null,
      scoreExpected: '{}', // default — caller setSpec sẽ fill
      status: 'DRAFT',
    },
  })
  return decodeExperiment(row)
}

/** Set spec path → status 'SPEC'. */
export async function setSpec(experimentId: string, specPath: string): Promise<DecodedExperimentRecord> {
  const row = await db.experimentRecord.update({
    where: { id: experimentId },
    data: {
      specPath,
      status: 'SPEC',
    },
  })
  return decodeExperiment(row)
}

/** Start POC — branchName format `P-POC-<optionId>`. Status → 'POC'. */
export async function startPoc(
  experimentId: string,
  branchName: string,
): Promise<DecodedExperimentRecord> {
  const row = await db.experimentRecord.update({
    where: { id: experimentId },
    data: {
      branchName,
      status: 'POC',
    },
  })
  return decodeExperiment(row)
}

/** Helper: sinh branchName chuẩn `P-POC-<optionId>`. */
export function buildPocBranchName(optionId: string): string {
  const safe = optionId.replace(/[^A-Za-z0-9-_]/g, '').slice(0, 20) || 'X'
  return `${BRANCH_PREFIX}${safe}`
}

/** Record metrics đo được → status 'MEASURED'. metricsJson = encodeJson(metrics). */
export async function recordMetrics(
  experimentId: string,
  metrics: Record<string, unknown>,
): Promise<DecodedExperimentRecord> {
  const row = await db.experimentRecord.update({
    where: { id: experimentId },
    data: {
      metricsJson: encodeJson(metrics),
      status: 'MEASURED',
    },
  })
  return decodeExperiment(row)
}

/**
 * Score experiment với scorecard B measured (post-experiment).
 *
 * TB-14 §3 vòng 4 + §10 TC-16:
 *  1. Persist scoreMeasured (encodeJson).
 *  2. Compute delta vs scoreExpected (computeScorecardDelta).
 *  3. Persist deltaJson + calibration lesson refs (KB-CAL-* / KB-ANTIPATTERN-*).
 *  4. Status → 'SCORED'.
 *
 * Caller (tournament/HAN/LISMA) chịu trách nhiệm persist KB entries thật với
 * các lessonRef được trả về (P4/P5 lo ResearchKBEntry.create).
 */
export async function scoreExperiment(
  experimentId: string,
  measured: RubricBResult,
): Promise<{ experiment: DecodedExperimentRecord; delta: ExperimentDelta | null; lessons: string[] }> {
  // Fetch current để lấy scoreExpected
  const current = await db.experimentRecord.findUnique({ where: { id: experimentId } })
  if (!current) {
    throw new Error(`ExperimentRecord ${experimentId} not found`)
  }

  // Decode scoreExpected (có thể là {} default)
  const expectedRaw = decodeJsonObject<Record<string, unknown>>(current.scoreExpected)
  const expected: RubricBResult =
    expectedRaw && typeof expectedRaw === 'object' && 'total' in expectedRaw
      ? (expectedRaw as unknown as RubricBResult)
      : {
          dimensions: {},
          total: 0,
          grade: 'REJECTED',
          perDimension: {
            S1: { score: 0, weight: 0, weighted: 0 },
            S2: { score: 0, weight: 0, weighted: 0 },
            S3: { score: 0, weight: 0, weighted: 0 },
            S4: { score: 0, weight: 0, weighted: 0 },
            S5: { score: 0, weight: 0, weighted: 0 },
            S6: { score: 0, weight: 0, weighted: 0 },
          },
        }

  // TC-16: computeScorecardDelta
  const { deltas, lessons } = computeScorecardDelta(expected, measured)

  const delta: ExperimentDelta = {
    expectedTotal: expected.total,
    measuredTotal: measured.total,
    delta: Number((measured.total - expected.total).toFixed(4)),
    calibrationLessonRefs: lessons,
  }

  const row = await db.experimentRecord.update({
    where: { id: experimentId },
    data: {
      scoreMeasured: encodeJson(measured),
      deltaJson: encodeJson(delta),
      status: 'SCORED',
    },
  })

  return { experiment: decodeExperiment(row), delta, lessons }
}

// ============================================================
// §3. READ HELPERS — get / list (non-throwing)
// ============================================================

export async function getExperiment(id: string): Promise<DecodedExperimentRecord | null> {
  try {
    const row = await db.experimentRecord.findUnique({ where: { id } })
    return row ? decodeExperiment(row) : null
  } catch (err) {
    console.warn(
      '[Experiment] getExperiment failed (non-blocking — null):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

export async function listExperiments(missionId: string): Promise<DecodedExperimentRecord[]> {
  try {
    const rows = await db.experimentRecord.findMany({
      where: { missionId },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(decodeExperiment)
  } catch (err) {
    console.warn(
      '[Experiment] listExperiments failed (non-blocking — empty):',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

/**
 * Decode scoreExpected/scoreMeasured/delta từ row (đã decode qua decodeExperiment).
 * Helper cho caller muốn truy cập typed scorecard mà không cần JSON.parse thủ công.
 */
export function readScorecards(exp: DecodedExperimentRecord): {
  expected: RubricBResult | null
  measured: RubricBResult | null
  delta: ExperimentDelta | null
} {
  const expected =
    exp.scoreExpected && typeof exp.scoreExpected === 'object' && 'total' in exp.scoreExpected
      ? (exp.scoreExpected as unknown as RubricBResult)
      : null
  const measured =
    exp.scoreMeasured && typeof exp.scoreMeasured === 'object' && 'total' in exp.scoreMeasured
      ? (exp.scoreMeasured as unknown as RubricBResult)
      : null
  const delta = exp.delta ?? null
  return { expected, measured, delta }
}

/** Re-export decodeJson cho caller tiện dụng (match pattern của P0 types.ts). */
export { decodeJson as _decodeJson, decodeJsonObject as _decodeJsonObject }
