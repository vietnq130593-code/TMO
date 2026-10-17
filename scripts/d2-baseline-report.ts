/**
 * BRAIN-D2 (BLUEPRINT-EVO-NAO-P1-P5 §8.2 — task 31-d) — BASELINE ĐỐI CHỨNG KB
 * ============================================================================
 *
 * Script report trên KbConsultLog THẬT: heuristic CỨNG hiện tại (pipeline 4
 * lớp cố định kb-routing: intent-classifier → kb-access → writeback →
 * synthesis) đạt mức nào — để trả lời "não Brain-D có hơn heuristic không?"
 * bằng dữ liệu (D3 phải thắng bộ số liệu này — gate A1 tương tự).
 *
 * Đo (đúng §8.2):
 *   a. Tổng quan corpus: tổng log · theo taskType · theo intent · n có runId
 *      (Outcome*) · n có tokensUsed>0.
 *   b. Phân phối latency (latencyMs — chiều hiệu năng CHÍNH D1-v1 vì tokensUsed
 *      luôn 0): p50/p95/mean/max tổng + theo intent + theo taskType.
 *   c. Tỷ lệ nguồn trúng: hit/empty/error/disabled từng nguồn (chunks/
 *      entities/memories/communities — cross sourcesEnabled × sourcesJson) +
 *      graphRecords cho row graph-query + row fallback (pipelineError) +
 *      bất thường hit-while-disabled.
 *   d. Confidence: calibrated vs rawConfidence (mean/p50/min/max + số lần lệch).
 *   e. Tương quan kết quả↔Outcome*: join runId → AgentRunRecord.runId (field
 *      runId, KHÔNG phải id — verify thật task 31-d), Pearson r cho
 *      (i) confidence (ii) tổng hits (iii) latency — chỉ trên run ĐÃ CHỐT
 *      (status ≠ 'running'); run đang mở được loại + ghi chú (outcome chưa
 *      cuối). Fail-open null khi n<3 hoặc variance 0 — trung thực hơn bịa số.
 *
 * FAIL-OPEN THEO SECTION (precedent safeCount trong src/app/api/brain/route.ts):
 * một section lỗi DB không giết cả report — section đó thành null + lý do
 * trong sectionErrors, các section khác vẫn ra.
 *
 * Output (ghi CẢ HAI):
 *   - docs/REPORT-D2-BASELINE-KB.md   (báo cáo tiếng Việt, số thật)
 *   - docs/D2-BASELINE.json           (machine-readable — gate A1 của D3 load
 *                                      và phải thắng; thresholds d2Min/d3Min)
 *
 * Usage (unset DATABASE_URL như pm2-start.sh / scripts/test-agent-zai.ts —
 * shell sandbox có thể leak DATABASE_URL trỏ DB KHÁC project; script cũng
 * tự guard bên dưới):
 *   cd /home/z/tmo-app && (unset DATABASE_URL; bun scripts/d2-baseline-report.ts)
 *
 * CHỈ ĐỌC (findMany — không ghi DB, không chạm app pm2). Ngưỡng nghĩa §8.1:
 * D2 "có dữ liệu" ≥100 log; D3 cần ≥300 log có Outcome*. Script vẫn chạy dưới
 * ngưỡng và ghi CẢNH BÁO MỎNG lên đầu report (snapshot trung thực).
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  classifySourceOutcome,
  correlateOutcome,
  mean,
  parseRetrievalConfig,
  parseSourcesJson,
  percentile,
  summarizeLatency,
  type CorrelationResult,
  type LatencySummary,
  type OutcomePair,
} from '../src/lib/kb-routing/d2-stats'

// ==================== CẤU HÌNH ====================

/** Ngưỡng nghĩa §8.1 — D2 ≥100 log, D3 ≥300 log có Outcome*. */
const THRESHOLDS = { d2Min: 100, d3Min: 300 } as const

/** 4 nguồn chuẩn của searchUserKB (kb-access.ts) — nguồn graph (graphRecords)
 * và fallback (pipelineError) xử lý riêng. */
const KB_SOURCES = ['chunks', 'entities', 'memories', 'communities'] as const
type KbSource = (typeof KB_SOURCES)[number]

const PROJECT_ROOT = path.resolve(import.meta.dir, '..')
const REPORT_MD_PATH = path.join(PROJECT_ROOT, 'docs', 'REPORT-D2-BASELINE-KB.md')
const REPORT_JSON_PATH = path.join(PROJECT_ROOT, 'docs', 'D2-BASELINE.json')

// ==================== TYPES (khối JSON machine-readable) ====================

interface PerSourceTally {
  rows: number
  hit: number
  empty: number
  error: number
  disabled: number
  hitWhileDisabled: number
}

interface ConfDist {
  n: number
  mean: number | null
  p50: number | null
  min: number | null
  max: number | null
}

interface D2BaselineJson {
  generatedAt: string
  dbUrl: string
  corpus: {
    totalLogs: number
    byTaskType: Record<string, number>
    byIntent: Record<string, number>
    withRunId: number
    withTokensUsed: number
    firstLogAt: string | null
    lastLogAt: string | null
  } | null
  latency: {
    overall: LatencySummary
    byIntent: Record<string, LatencySummary>
    byTaskType: Record<string, LatencySummary>
  } | null
  sources: {
    perSource: Record<string, PerSourceTally>
    kbRows: number
    graph: { rows: number; hit: number; empty: number; error: number }
    fallbackRows: number
    unclassifiedRows: number
    truncatedRows: number
  } | null
  confidence: {
    calibrated: ConfDist
    raw: ConfDist
    bothPresent: number
    differCount: number
    meanDelta: number | null
  } | null
  outcomeCorrelation: {
    matchedLogs: number
    distinctRuns: number
    duplicateRunRecords: number
    distinctRunOutcomes: { success: number; fail: number; open: number }
    closedRunLogs: number
    excludedOpenRunLogs: number
    confidenceVsSuccess: CorrelationResult | null
    totalHitsVsSuccess: CorrelationResult | null
    latencyVsSuccess: CorrelationResult | null
  } | null
  sectionErrors: Record<string, string>
  thresholds: { d2Min: number; d3Min: number }
}

/** Row KbConsultLog sau fetch (chỉ các trường report dùng). */
interface KbLogRow {
  createdAt: Date
  taskType: string | null
  intent: string | null
  retrievalConfigJson: string
  sourcesJson: string
  confidence: number | null
  rawConfidence: number | null
  tokensUsed: number
  latencyMs: number
  runId: string | null
}

/** Bản rút gọn AgentRunRecord cho join Outcome*. */
interface RunRecordLite {
  runId: string | null
  status: string | null
  complete: boolean | null
  stopReason: string | null
}

// ==================== ENV GUARD (chạy TRƯỚC import db) ====================

/**
 * Đọc DATABASE_URL= từ file .env (bỏ comment, strip quote — cùng logic
 * src/lib/db.ts; copy nhỏ để guard chạy TRƯỚC khi module db import).
 */
function readEnvFileDatabaseUrl(envPath: string): string {
  if (!fs.existsSync(envPath)) return ''
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    let value = ''
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        let v = m[1].trim()
        v = v.replace(/\s+#.*$/, '').trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        value = v
      }
    }
    return value
  } catch {
    return ''
  }
}

/** Chuẩn hóa URL file: → đường dẫn tuyệt đối (tương đối tính theo
 * PROJECT_ROOT/prisma — cùng quy ước schema-relative của db.ts layer 2).
 * URL không phải file: (postgres…) trả nguyên bản. */
function fileUrlToAbsolute(url: string): string {
  const m = url.match(/^file:(.+)$/)
  if (!m) return url
  const raw = m[1].trim()
  const isAbs = raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)
  return isAbs ? raw : path.resolve(path.join(PROJECT_ROOT, 'prisma'), raw)
}

/**
 * Guard DATABASE_URL — report PHẢI chạy trên DB của project này (corpus
 * KbConsultLog thật), không phải DB do shell sandbox leak (đã bắt gặp thật:
 * DATABASE_URL=file:/home/z/my-project/db/custom.db — file TỒN TẠI nên guard
 * của db.ts giữ nguyên → report nhầm corpus). Tiền lệ unset: pm2-start.sh +
 * scripts/test-agent-zai.ts. Override cố ý: đặt D2_DB_URL.
 */
function guardDatabaseUrl(): string {
  const explicit = (process.env.D2_DB_URL || '').trim()
  if (explicit) {
    process.env.DATABASE_URL = explicit
    return explicit
  }
  const envUrl = readEnvFileDatabaseUrl(path.join(PROJECT_ROOT, '.env'))
  const inherited = (process.env.DATABASE_URL || '').trim()
  if (!envUrl) {
    return inherited || '(prisma default)'
  }
  const isFileUrl = /^file:/.test(envUrl)
  const abs = fileUrlToAbsolute(envUrl)
  const sameTarget = inherited ? fileUrlToAbsolute(inherited) === abs : false
  const cwdInsideProject =
    process.cwd() === PROJECT_ROOT || process.cwd().startsWith(PROJECT_ROOT + path.sep)

  if (inherited && !sameTarget) {
    // Leak thật (đã bắt gặp: file:/home/z/my-project/db/custom.db TỒN TẠI →
    // guard "giữ env kế thừa" của db.ts sẽ giữ NHẦM DB) → ghi đè về DB project.
    console.warn(
      `[D2] ⚠️ DATABASE_URL shell ("${inherited}") trỏ DB KHÁC project — bỏ theo (tiền lệ pm2-start.sh / test-agent-zai.ts) để report không nhầm corpus. DB dùng: ${abs}`,
    )
    process.env.DATABASE_URL = isFileUrl ? `file:${abs}` : envUrl
  } else if (!cwdInsideProject) {
    // Chạy từ cwd NGOÀI project — db.ts resolve URL tương đối theo cwd sẽ trỏ
    // sai → chuẩn hóa tuyệt đối (schema-relative, đúng từ mọi cwd).
    process.env.DATABASE_URL = isFileUrl ? `file:${abs}` : envUrl
  } else if (!inherited) {
    // Không có env — nạp giá trị .env để Prisma client dùng đúng DB project.
    process.env.DATABASE_URL = envUrl
  }
  // Còn lại (env trùng đích + cwd trong project) → để db.ts tự chuẩn hóa im lặng.
  // Hiển thị/ghi report luôn ĐÍCH ĐÃ GIẢI QUYÊT (tuyệt đối) — dễ audit corpus.
  return isFileUrl ? abs : process.env.DATABASE_URL || envUrl
}

// ==================== HELPERS FORMAT ====================

/** Số → chuỗi cố định chữ số thập phân; null → '—'. */
function fmt(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

/** Pearson r → 3 chữ số; null → 'null (không tính được)'. */
function fmtR(v: CorrelationResult | null): string {
  return v ? `${v.pearsonR.toFixed(3)} (n=${v.n})` : 'null (không tính được — n<3 hoặc variance 0)'
}

/** Key nhóm cho Record: null → 'NULL' (đúng cách gọi của blueprint §8.1). */
function groupKey(v: string | null | undefined): string {
  return v ?? 'NULL'
}

// ==================== CÁC SECTION (fail-open từng section) ====================

function computeCorpus(logs: readonly KbLogRow[]): NonNullable<D2BaselineJson['corpus']> {
  const byTaskType: Record<string, number> = {}
  const byIntent: Record<string, number> = {}
  let withRunId = 0
  let withTokensUsed = 0
  for (const l of logs) {
    const tk = groupKey(l.taskType)
    byTaskType[tk] = (byTaskType[tk] ?? 0) + 1
    const ik = groupKey(l.intent)
    byIntent[ik] = (byIntent[ik] ?? 0) + 1
    if (l.runId) withRunId++
    if (l.tokensUsed > 0) withTokensUsed++
  }
  return {
    totalLogs: logs.length,
    byTaskType,
    byIntent,
    withRunId,
    withTokensUsed,
    firstLogAt: logs.length ? logs[0].createdAt.toISOString() : null,
    lastLogAt: logs.length ? logs[logs.length - 1].createdAt.toISOString() : null,
  }
}

function computeLatency(logs: readonly KbLogRow[]): NonNullable<D2BaselineJson['latency']> {
  const byIntent: Record<string, LatencySummary> = {}
  const byTaskType: Record<string, LatencySummary> = {}
  const intentGroups = new Map<string, number[]>()
  const taskGroups = new Map<string, number[]>()
  for (const l of logs) {
    const ik = groupKey(l.intent)
    const tk = groupKey(l.taskType)
    if (!intentGroups.has(ik)) intentGroups.set(ik, [])
    if (!taskGroups.has(tk)) taskGroups.set(tk, [])
    intentGroups.get(ik)!.push(l.latencyMs)
    taskGroups.get(tk)!.push(l.latencyMs)
  }
  for (const [k, vals] of intentGroups) byIntent[k] = summarizeLatency(vals)
  for (const [k, vals] of taskGroups) byTaskType[k] = summarizeLatency(vals)
  return {
    overall: summarizeLatency(logs.map(l => l.latencyMs)),
    byIntent,
    byTaskType,
  }
}

function computeSources(logs: readonly KbLogRow[]): NonNullable<D2BaselineJson['sources']> {
  const perSource: Record<string, PerSourceTally> = {}
  for (const s of KB_SOURCES) {
    perSource[s] = { rows: 0, hit: 0, empty: 0, error: 0, disabled: 0, hitWhileDisabled: 0 }
  }
  let kbRows = 0
  let fallbackRows = 0
  let unclassifiedRows = 0
  let truncatedRows = 0
  const graph = { rows: 0, hit: 0, empty: 0, error: 0 }

  for (const l of logs) {
    const src = parseSourcesJson(l.sourcesJson)
    if (!src) {
      unclassifiedRows++
      continue
    }
    if (src.truncated) truncatedRows++

    const isKbRow = KB_SOURCES.some(s => typeof src[s] === 'number')
    const isGraphRow = typeof src.graphRecords === 'number' || src.graphError !== undefined
    const isFallbackRow = src.pipelineError !== undefined

    if (isKbRow) {
      kbRows++
      const cfg = parseRetrievalConfig(l.retrievalConfigJson)
      for (const s of KB_SOURCES) {
        const outcome = classifySourceOutcome(
          cfg?.sourcesEnabled?.[s],
          src[s],
          src.errors?.[s],
        )
        const t = perSource[s]!
        t.rows++
        if (outcome === 'hit') t.hit++
        else if (outcome === 'empty') t.empty++
        else if (outcome === 'error') t.error++
        else if (outcome === 'disabled') t.disabled++
        else t.hitWhileDisabled++
      }
    }
    if (isGraphRow) {
      graph.rows++
      if (src.graphError !== undefined) graph.error++
      else if ((src.graphRecords ?? 0) > 0) graph.hit++
      else graph.empty++
    }
    if (isFallbackRow) fallbackRows++
    if (!isKbRow && !isGraphRow && !isFallbackRow) unclassifiedRows++
  }
  return { perSource, kbRows, graph, fallbackRows, unclassifiedRows, truncatedRows }
}

function confDist(values: readonly number[]): ConfDist {
  const finite = values.filter(v => Number.isFinite(v))
  if (finite.length === 0) return { n: 0, mean: null, p50: null, min: null, max: null }
  const sorted = [...finite].sort((a, b) => a - b)
  return {
    n: finite.length,
    mean: mean(finite),
    p50: percentile(sorted, 50),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

function computeConfidence(logs: readonly KbLogRow[]): NonNullable<D2BaselineJson['confidence']> {
  const calibrated = logs.filter(l => l.confidence !== null).map(l => l.confidence as number)
  const raw = logs.filter(l => l.rawConfidence !== null).map(l => l.rawConfidence as number)
  let bothPresent = 0
  let differCount = 0
  const deltas: number[] = []
  for (const l of logs) {
    if (l.confidence !== null && l.rawConfidence !== null) {
      bothPresent++
      const d = l.confidence - l.rawConfidence
      if (d !== 0) differCount++
      deltas.push(d)
    }
  }
  return {
    calibrated: confDist(calibrated),
    raw: confDist(raw),
    bothPresent,
    differCount,
    meanDelta: deltas.length ? mean(deltas) : null,
  }
}

/** Outcome* của 1 run: 1 = thành công (complete===true hoặc status==='completed'
 * — cùng ngữ nghĩa reward.ts outcomeFromEvidence), 0 = còn lại. */
function runOutcomeSuccess(rec: RunRecordLite): boolean {
  return rec.complete === true || rec.status === 'completed'
}

/** Run ĐÃ CHỐT (outcome cuối) — 'running' là run còn mở, chưa có outcome. */
function runIsClosed(rec: RunRecordLite): boolean {
  return rec.status !== 'running'
}

async function computeOutcomeCorrelation(
  db: Awaited<ReturnType<typeof importDb>>['db'],
  logs: readonly KbLogRow[],
): Promise<NonNullable<D2BaselineJson['outcomeCorrelation']>> {
  const runIds = [...new Set(logs.filter(l => l.runId).map(l => l.runId as string))]
  const recs: RunRecordLite[] = await db.agentRunRecord.findMany({
    where: { runId: { in: runIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { runId: true, status: true, complete: true, stopReason: true },
  })
  // First-wins tất định (createdAt asc) — hiện chưa có runId trùng, nhưng nếu
  // có thì row đầu theo thời gian là run gốc.
  const runMap = new Map<string, RunRecordLite>()
  let duplicateRunRecords = 0
  for (const rec of recs) {
    const key = rec.runId ?? ''
    if (runMap.has(key)) duplicateRunRecords++
    else runMap.set(key, rec)
  }

  const distinctRunOutcomes = { success: 0, fail: 0, open: 0 }
  for (const rec of runMap.values()) {
    if (!runIsClosed(rec)) distinctRunOutcomes.open++
    else if (runOutcomeSuccess(rec)) distinctRunOutcomes.success++
    else distinctRunOutcomes.fail++
  }

  let matchedLogs = 0
  let closedRunLogs = 0
  let excludedOpenRunLogs = 0
  const confPairs: OutcomePair[] = []
  const hitPairs: OutcomePair[] = []
  const latPairs: OutcomePair[] = []

  for (const l of logs) {
    if (!l.runId) continue
    const rec = runMap.get(l.runId)
    if (!rec) continue
    matchedLogs++
    if (!runIsClosed(rec)) {
      excludedOpenRunLogs++
      continue // outcome chưa chốt — loại khỏi tương quan (trung thực)
    }
    closedRunLogs++
    const ok = runOutcomeSuccess(rec)
    if (l.confidence !== null) confPairs.push({ metric: l.confidence, outcomeSuccess: ok })
    latPairs.push({ metric: l.latencyMs, outcomeSuccess: ok })

    // Tổng hits: row KB = 4 nguồn; row graph = graphRecords; row fallback
    // (pipelineError) LOẠI — hits của fallback nằm ngoài corpus D1-v1.
    const src = parseSourcesJson(l.sourcesJson)
    if (src) {
      if (KB_SOURCES.some(s => typeof src[s] === 'number')) {
        const total = KB_SOURCES.reduce((sum, s) => sum + (src[s] ?? 0), 0)
        hitPairs.push({ metric: total, outcomeSuccess: ok })
      } else if (typeof src.graphRecords === 'number') {
        hitPairs.push({ metric: src.graphRecords, outcomeSuccess: ok })
      }
    }
  }

  return {
    matchedLogs,
    distinctRuns: runMap.size,
    duplicateRunRecords,
    distinctRunOutcomes,
    closedRunLogs,
    excludedOpenRunLogs,
    confidenceVsSuccess: correlateOutcome(confPairs),
    totalHitsVsSuccess: correlateOutcome(hitPairs),
    latencyVsSuccess: correlateOutcome(latPairs),
  }
}

// ==================== MARKDOWN REPORT ====================

function buildMarkdown(json: D2BaselineJson): string {
  const c = json.corpus
  const lat = json.latency
  const src = json.sources
  const conf = json.confidence
  const corr = json.outcomeCorrelation
  const L: string[] = []

  L.push('# REPORT D2 — BASELINE ĐỐI CHỨNG KB (heuristic CỨNG 4 lớp)')
  L.push('')
  L.push(`> BLUEPRINT-EVO-NAO-P1-P5 §8.2 · Task 31-d · Sinh lúc: \`${json.generatedAt}\` · Nguồn: bảng \`KbConsultLog\` thật (\`${json.dbUrl}\`) + join \`runId → AgentRunRecord.runId\` cho Outcome*.`)
  L.push(`> Chạy lại: \`cd /home/z/tmo-app && (unset DATABASE_URL; bun scripts/d2-baseline-report.ts)\` — script CHỈ ĐỌC DB, không chạm app pm2. Số liệu machine-readable kèm theo: \`docs/D2-BASELINE.json\` (gate A1 của D3 load từ đây).`)
  L.push('')

  // ---- 0. Cảnh báo mỏng ----
  L.push('## 0. CẢNH BÁO DỮ LIỆU MỎNG — đọc trước khi dùng số liệu')
  L.push('')
  if (c) {
    const d2Progress = Math.min(100, Math.round((c.totalLogs / THRESHOLDS.d2Min) * 100))
    const d3Progress = Math.min(100, Math.round((c.withRunId / THRESHOLDS.d3Min) * 100))
    L.push(`- Corpus hiện **n = ${c.totalLogs} log** — DƯỚI ngưỡng ≥${THRESHOLDS.d2Min} của D2 (§8.1: D2 "bắt đầu có dữ liệu" ≥100 log; tiến độ ${d2Progress}%). Đây là SNAPSHOT trung thực, không phải báo cáo đủ sức thống kê.`)
    L.push(`- Log có Outcome* (runId): **${c.withRunId}/${c.totalLogs}** — tiến độ ngưỡng D3 ≥${THRESHOLDS.d3Min}: ${d3Progress}%. ${c.withRunId < THRESHOLDS.d3Min ? 'D3 chưa đủ dữ liệu train.' : ''}`)
    L.push(`- Số liệu KHÔNG đáng tin ở n này: p95 (cần ~20+ quan sát mỗi nhóm mới ổn), mọi hệ số tương quan Pearson (dưới ~30 cặp độc lập thì r dao động rất rộng), tỷ lệ nguồn theo intent (nhóm intent NULL áp đảo).`)
    if (corr && corr.distinctRuns < 10) {
      L.push(`- Tương quan Outcome* chỉ join được **${corr.distinctRuns} run riêng biệt** (${corr.distinctRunOutcomes.success} success / ${corr.distinctRunOutcomes.fail} fail / ${corr.distinctRunOutcomes.open} đang mở) — quá ít để nói gì về quan hệ nhân-quả; r dưới đây chỉ ghi nhận KHÔNG suy diễn.`)
    }
    L.push(`- tokensUsed luôn 0 (thiết kế D1-v1 — API embed/rerank chưa trả usage, R21 chốt) → latencyMs là chiều hiệu năng duy nhất của snapshot này.`)
  } else {
    L.push(`- KHÔNG đọc được corpus (lỗi section: ${json.sectionErrors.corpus ?? 'không rõ'}) — xem sectionErrors cuối report.`)
  }
  L.push('')

  // ---- 1. Corpus ----
  L.push('## 1. Tổng quan corpus')
  L.push('')
  if (c) {
    L.push('| Chỉ số | Giá trị |')
    L.push('|---|---|')
    L.push(`| Tổng log | **${c.totalLogs}** |`)
    L.push(`| Log có runId (Outcome*) | ${c.withRunId} |`)
    L.push(`| Log có tokensUsed > 0 | ${c.withTokensUsed} |`)
    L.push(`| Khoảng thời gian | ${c.firstLogAt ? c.firstLogAt.slice(0, 19).replace('T', ' ') : '—'} → ${c.lastLogAt ? c.lastLogAt.slice(0, 19).replace('T', ' ') : '—'} (UTC) |`)
    L.push('')
    L.push('Theo taskType (§8.1: chat · tool:* · smart-kb · kb-fallback-dense · graph-query · NULL):')
    L.push('')
    L.push('| taskType | n |')
    L.push('|---|---|')
    for (const [k, n] of Object.entries(c.byTaskType).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${k === 'NULL' ? 'NULL (caller không bọc)' : k} | ${n} |`)
    }
    L.push('')
    L.push('Theo intent (intent-classifier: casual/meta/procedural/factual):')
    L.push('')
    L.push('| intent | n |')
    L.push('|---|---|')
    for (const [k, n] of Object.entries(c.byIntent).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${k === 'NULL' ? 'NULL (không classify)' : k} | ${n} |`)
    }
  } else {
    L.push(`Section lỗi: ${json.sectionErrors.corpus ?? '—'}`)
  }
  L.push('')

  // ---- 2. Latency ----
  L.push('## 2. Phân phối latency (latencyMs)')
  L.push('')
  if (lat) {
    const o = lat.overall
    L.push('| Phạm vi | n | p50 | p95 | mean | max |')
    L.push('|---|---|---|---|---|---|')
    L.push(`| **TOÀN BỘ** | ${o.n} | ${fmt(o.p50)} | ${fmt(o.p95)} | ${fmt(o.mean)} | ${fmt(o.max)} |`)
    for (const [k, s] of Object.entries(lat.byIntent).sort((a, b) => b[1].n - a[1].n)) {
      L.push(`| intent=${k} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.mean)} | ${fmt(s.max)} |`)
    }
    for (const [k, s] of Object.entries(lat.byTaskType).sort((a, b) => b[1].n - a[1].n)) {
      L.push(`| taskType=${k} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.mean)} | ${fmt(s.max)} |`)
    }
    L.push('')
    L.push('Đọc: pipeline 4 lớp cố định đang trả kết quả ở p50 ~' + fmt(lat.overall.p50, 0) + 'ms / p95 ~' + fmt(lat.overall.p95, 0) + 'ms trên corpus này. D3 (khi thức tỉnh) phải đạt latency tương đương hoặc tốt hơn trên cùng corpus — đấy là điều kiện hiệu năng của gate A1 (analog chặn H7 latency của HyperNAS).')
  } else {
    L.push(`Section lỗi: ${json.sectionErrors.latency ?? '—'}`)
  }
  L.push('')

  // ---- 3. Sources ----
  L.push('## 3. Kết quả nguồn (hit / empty / error / disabled)')
  L.push('')
  if (src) {
    L.push(`Row searchUserKB (4 nguồn song song): **${src.kbRows}** · row graph-query (graphRecords): **${src.graph.rows}** · row fallback dense-only (pipelineError): **${src.fallbackRows}** · không phân loại được (sourcesJson rác/thiếu): **${src.unclassifiedRows}** · row bị truncate JSON: **${src.truncatedRows}**.`)
    L.push('')
    L.push('| Nguồn | rows | hit | empty | error | disabled | hit-while-disabled (bất thường) | hit-rate (trên lượt nguồn CHẠY) |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const [s, t] of Object.entries(src.perSource)) {
      const ranRows = t.hit + t.empty + t.error // disabled = không chạy — loại khỏi mẫu
      const rate = ranRows > 0 ? (t.hit / ranRows) * 100 : null
      L.push(`| ${s} | ${t.rows} | ${t.hit} | ${t.empty} | ${t.error} | ${t.disabled} | ${t.hitWhileDisabled} | ${fmt(rate, 1)}% |`)
    }
    L.push(`| graph (Cypher) | ${src.graph.rows} | ${src.graph.hit} | ${src.graph.empty} | ${src.graph.error} | — | — | ${fmt(src.graph.rows > 0 ? (src.graph.hit / src.graph.rows) * 100 : null, 1)}% |`)
    L.push('')
    L.push('Phân biệt (§8.2): EMPTY = nguồn bật nhưng KB không có gì (không phải lỗi) · DISABLED = nguồn TẮT qua sourcesEnabled (bỏ chạy chủ đích, vd caller không truyền agentId → entities/memories tắt) · ERROR = nguồn chết (allSettled rejected) · HIT-WHILE-DISABLED = bất thường cấu hình (nguồn tắt mà vẫn có hits — hiện phải = 0).')
  } else {
    L.push(`Section lỗi: ${json.sectionErrors.sources ?? '—'}`)
  }
  L.push('')

  // ---- 4. Confidence ----
  L.push('## 4. Confidence — calibrated (Brain-A) vs rawConfidence (heuristic gốc)')
  L.push('')
  if (conf) {
    L.push('| Trường | n | mean | p50 | min | max |')
    L.push('|---|---|---|---|---|---|')
    L.push(`| confidence (SAU calibration) | ${conf.calibrated.n} | ${fmt(conf.calibrated.mean, 4)} | ${fmt(conf.calibrated.p50, 4)} | ${fmt(conf.calibrated.min, 4)} | ${fmt(conf.calibrated.max, 4)} |`)
    L.push(`| rawConfidence (TRƯỚC calibration) | ${conf.raw.n} | ${fmt(conf.raw.mean, 4)} | ${fmt(conf.raw.p50, 4)} | ${fmt(conf.raw.min, 4)} | ${fmt(conf.raw.max, 4)} |`)
    L.push('')
    L.push(`Cả hai trường cùng có mặt ở ${conf.bothPresent} row; **lệch nhau ${conf.differCount} row** (meanΔ = ${fmt(conf.meanDelta, 6)}). ${conf.differCount === 0 ? '→ CalibrationModel chưa train (hoặc trả nguyên raw) — calibrated đang ĐỒNG NHẤT heuristic.' : '→ Calibration đang dịch confidence — D3 đối chiếu trên rawConfidence để tránh feedback-loop (Task 20-c).'}`)
  } else {
    L.push(`Section lỗi: ${json.sectionErrors.confidence ?? '—'}`)
  }
  L.push('')

  // ---- 5. Outcome correlation ----
  L.push('## 5. Tương quan kết quả ↔ Outcome* (Pearson r)')
  L.push('')
  if (corr) {
    L.push(`Join: ${corr.matchedLogs} log row có runId khớp AgentRunRecord · ${corr.distinctRuns} run riêng biệt (outcome: ${corr.distinctRunOutcomes.success} success / ${corr.distinctRunOutcomes.fail} fail / ${corr.distinctRunOutcomes.open} đang mở)${corr.duplicateRunRecords > 0 ? ` · ⚠️ ${corr.duplicateRunRecords} record runId TRÙNG (lấy row đầu theo createdAt)` : ''}. Tương quan chỉ tính trên run ĐÃ CHỐT: ${corr.closedRunLogs} row (${corr.excludedOpenRunLogs} row thuộc run đang 'running' bị loại — outcome chưa cuối).`)
    L.push('')
    L.push('| Cặp | Pearson r | n |')
    L.push('|---|---|---|')
    L.push(`| confidence ↔ thành công | ${corr.confidenceVsSuccess ? corr.confidenceVsSuccess.pearsonR.toFixed(3) : 'null'} | ${corr.confidenceVsSuccess?.n ?? 0} |`)
    L.push(`| tổng hits ↔ thành công | ${corr.totalHitsVsSuccess ? corr.totalHitsVsSuccess.pearsonR.toFixed(3) : 'null'} | ${corr.totalHitsVsSuccess?.n ?? 0} |`)
    L.push(`| latencyMs ↔ thành công | ${corr.latencyVsSuccess ? corr.latencyVsSuccess.pearsonR.toFixed(3) : 'null'} | ${corr.latencyVsSuccess?.n ?? 0} |`)
    L.push('')
    L.push(`\`null\` = không tính được (n<3 hoặc variance 0 — helper correlateOutcome fail-open). Với ${corr.distinctRuns} run riêng biệt, r chỉ có giá trị GHI NHẬN — không suy diễn quan hệ (các row cùng run dùng chung 1 outcome → quan sát không độc lập).`)
  } else {
    L.push(`Section lỗi: ${json.sectionErrors.outcomeCorrelation ?? '—'}`)
  }
  L.push('')

  // ---- 6. Gate A1 ----
  L.push('## 6. Bộ số liệu đối chứng cho D3 (gate A1)')
  L.push('')
  L.push('Khi D3 policy head (§8.3) thức tỉnh (≥300 log có Outcome*) và bật runtime_knowledge, nó phải THẮNG heuristic CỨNG trên CÙNG cách đo — đủ mục nào tính mục đó:')
  L.push('')
  L.push('| # | Chỉ số baseline (heuristic CỨNG) | Giá trị snapshot |')
  L.push('|---|---|---|')
  if (lat) L.push(`| 1 | Latency p50 / p95 toàn bộ (ms) | ${fmt(lat.overall.p50)} / ${fmt(lat.overall.p95)} |`)
  if (src) {
    KB_SOURCES.forEach((s, i) => {
      const t = src.perSource[s]!
      const ranRows = t.hit + t.empty + t.error
      L.push(`| 2${'abcd'[i]} | Hit-rate nguồn ${s} (trên lượt nguồn chạy) | ${fmt(ranRows > 0 ? (t.hit / ranRows) * 100 : null, 1)}% (${t.hit}/${ranRows}) |`)
    })
    L.push(`| 3 | Bất thường hit-while-disabled | ${Object.values(src.perSource).reduce((a, t) => a + t.hitWhileDisabled, 0)} (phải giữ 0) |`)
  }
  if (conf) L.push(`| 4 | Mean confidence (calibrated) | ${fmt(conf.calibrated.mean, 4)} |`)
  if (corr && corr.totalHitsVsSuccess) L.push(`| 5 | r(tổng hits ↔ thành công) | ${corr.totalHitsVsSuccess.pearsonR.toFixed(3)} (n=${corr.totalHitsVsSuccess.n}) |`)
  L.push(`| 6 | Ngưỡng dữ liệu | D2 ≥ ${THRESHOLDS.d2Min} log (đang ${c ? c.totalLogs : '?'}) · D3 ≥ ${THRESHOLDS.d3Min} log có Outcome* (đang ${c ? c.withRunId : '?'}) |`)
  L.push('')
  L.push(`Snapshot này được ghi ở \`docs/D2-BASELINE.json\` cùng \`(generatedAt, thresholds)\` — D3 tải file này thay vì hard-code (single-source doctrine #9), so trên corpus TẠI THỜI ĐIỂM ĐO LẠI (không so chéo snapshot cũ).`)
  L.push('')

  // ---- 7. Ghi chú kỹ thuật ----
  L.push('## 7. Ghi chú kỹ thuật & hạn chế')
  L.push('')
  L.push('- Outcome* = complete===true HOẶC status===\'completed\' (cùng ngữ nghĩa reward.ts outcomeFromEvidence); run status=\'running\' bị loại khỏi tương quan (outcome chưa chốt) và đếm riêng.')
  L.push('- KbConsultLog.runId nối AgentRunRecord.RUNID (field runId — verify thật: join theo id KHÔNG khớp).')
  L.push('- Row fallback (pipelineError) không có hits trong corpus D1-v1 (kết quả nằm ở diagnostics tool) → bị loại khỏi cặp tương quan "tổng hits", vẫn tính ở latency.')
  L.push('- sourcesJson/retrievalConfigJson parse fail-open (d2-stats.ts) — row rác bị đếm "không phân loại được", không sập report.')
  L.push('- Section lỗi DB được ghi ở sectionErrors (fail-open theo section — precedent safeCount /api/brain):')
  const errKeys = Object.keys(json.sectionErrors)
  if (errKeys.length === 0) {
    L.push('  - (không có — mọi section tính thành công)')
  } else {
    for (const k of errKeys) L.push(`  - ${k}: ${json.sectionErrors[k]}`)
  }
  L.push('- Helper thuần: src/lib/kb-routing/d2-stats.ts (doctrine #9 — test r117, 31 test). Script này CHỈ ĐỌC DB.')
  L.push('')
  return L.join('\n')
}

// ==================== MAIN ====================

/** Import động db SAU guard DATABASE_URL (module db.ts resolve URL lúc import). */
async function importDb() {
  return import('../src/lib/db')
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString()
  const dbUrl = guardDatabaseUrl()
  console.log(`[D2] Baseline đối chứng — DB: ${dbUrl}`)

  const { db } = await importDb()

  const json: D2BaselineJson = {
    generatedAt,
    dbUrl,
    corpus: null,
    latency: null,
    sources: null,
    confidence: null,
    outcomeCorrelation: null,
    sectionErrors: {},
    thresholds: { d2Min: THRESHOLDS.d2Min, d3Min: THRESHOLDS.d3Min },
  }

  // Fetch 1 lần — mọi section tính từ cùng snapshot trong bộ nhớ (all định
  // nghĩa trên CÙNG tập row → số liệu các section khớp nhau).
  let logs: KbLogRow[] = []
  try {
    logs = (await db.kbConsultLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        taskType: true,
        intent: true,
        retrievalConfigJson: true,
        sourcesJson: true,
        confidence: true,
        rawConfidence: true,
        tokensUsed: true,
        latencyMs: true,
        runId: true,
      },
    })) as KbLogRow[]
    console.log(`[D2] Fetch KbConsultLog: ${logs.length} row`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    json.sectionErrors.fetch = msg
    console.error('[D2] ❌ Không đọc được KbConsultLog:', msg)
  }

  // ---- từng section fail-open ----
  try {
    json.corpus = computeCorpus(logs)
  } catch (err) {
    json.sectionErrors.corpus = err instanceof Error ? err.message : String(err)
  }
  try {
    json.latency = computeLatency(logs)
  } catch (err) {
    json.sectionErrors.latency = err instanceof Error ? err.message : String(err)
  }
  try {
    json.sources = computeSources(logs)
  } catch (err) {
    json.sectionErrors.sources = err instanceof Error ? err.message : String(err)
  }
  try {
    json.confidence = computeConfidence(logs)
  } catch (err) {
    json.sectionErrors.confidence = err instanceof Error ? err.message : String(err)
  }
  try {
    json.outcomeCorrelation = await computeOutcomeCorrelation(db, logs)
  } catch (err) {
    json.sectionErrors.outcomeCorrelation = err instanceof Error ? err.message : String(err)
  }

  // ---- ghi 2 output ----
  const md = buildMarkdown(json)
  fs.mkdirSync(path.dirname(REPORT_MD_PATH), { recursive: true })
  fs.writeFileSync(REPORT_MD_PATH, md, 'utf8')
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log(`[D2] ✅ Ghi ${path.relative(PROJECT_ROOT, REPORT_MD_PATH)} (${md.length} chữ)`)
  console.log(`[D2] ✅ Ghi ${path.relative(PROJECT_ROOT, REPORT_JSON_PATH)}`)

  // ---- tóm tắt console ----
  if (json.corpus) {
    console.log(`[D2] Corpus: ${json.corpus.totalLogs} log · withRunId ${json.corpus.withRunId} · tokensUsed>0: ${json.corpus.withTokensUsed}`)
    console.log(`[D2]   byTaskType: ${JSON.stringify(json.corpus.byTaskType)}`)
    console.log(`[D2]   byIntent: ${JSON.stringify(json.corpus.byIntent)}`)
  }
  if (json.latency) {
    const o = json.latency.overall
    console.log(`[D2] Latency: p50=${fmt(o.p50)} p95=${fmt(o.p95)} mean=${fmt(o.mean)} max=${fmt(o.max)} (n=${o.n})`)
  }
  if (json.sources) {
    for (const [s, t] of Object.entries(json.sources.perSource)) {
      console.log(`[D2]   nguồn ${s}: hit=${t.hit} empty=${t.empty} error=${t.error} disabled=${t.disabled} hitWhileDisabled=${t.hitWhileDisabled} (rows=${t.rows})`)
    }
    console.log(`[D2]   graph: hit=${json.sources.graph.hit} empty=${json.sources.graph.empty} error=${json.sources.graph.error} (rows=${json.sources.graph.rows}) · fallback=${json.sources.fallbackRows}`)
  }
  if (json.confidence) {
    console.log(`[D2] Confidence: calibrated n=${json.confidence.calibrated.n} mean=${fmt(json.confidence.calibrated.mean, 4)} · raw n=${json.confidence.raw.n} mean=${fmt(json.confidence.raw.mean, 4)} · lệch ${json.confidence.differCount}/${json.confidence.bothPresent} row`)
  }
  if (json.outcomeCorrelation) {
    const oc = json.outcomeCorrelation
    console.log(`[D2] Outcome*: matched=${oc.matchedLogs} runs=${oc.distinctRuns} (success=${oc.distinctRunOutcomes.success} fail=${oc.distinctRunOutcomes.fail} open=${oc.distinctRunOutcomes.open})`)
    console.log(`[D2]   conf↔success: ${fmtR(oc.confidenceVsSuccess)} · hits↔success: ${fmtR(oc.totalHitsVsSuccess)} · latency↔success: ${fmtR(oc.latencyVsSuccess)}`)
  }
  const nErr = Object.keys(json.sectionErrors).length
  if (nErr > 0) {
    console.warn(`[D2] ⚠️ ${nErr} section lỗi (fail-open — xem sectionErrors trong report)`)
  }

  try {
    await db.$disconnect()
  } catch {
    // fail-open — process.exit dưới đây đóng event loop
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[D2] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
