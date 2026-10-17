/**
 * R24-a — D0 BƯỚC 3: ĐO KHỐI LƯỢNG 9 SHARD knowledge/ TRƯỚC KHI INGESTION
 * ============================================================================
 * Mục tiêu (blueprint EVO-NAO §9 D0 + Q5 đề xuất): với MỖI shard đo
 *   (1) bytes / lines / blocks (marker NODE_ID|RULE_ID|DYNAMIC_ID|METRIC_ID)
 *   (2) ước tokens (estimateTokenCount lib — chars/4)
 *   (3) chunks THẬT — chunkText lib (đúng bộ chunking pipeline, domain 'ml';
 *       lib ml = 640 tokens/overlap 96, trùng khớp route-local bản ml)
 *   (4) EXTRACTION MẪU — 2 chunk/shard (đầu + giữa) qua LLM THẬT (NIM
 *       nemotron-3-ultra-550b, callLLMSlot round-robin 4 key) với ĐÚNG
 *       buildSystemPrompt('ml') export từ process route (single-source);
 *       parse + orphan-filter (entity phải nằm trong ≥1 relationship) như
 *       extractFromChunk pipeline — bản parse đây là bản sao rút gọn của
 *       parseLLMResponse route-local (route chỉ export buildSystemPrompt theo
 *       task R24-a; khác biệt chỉ ở nhánh recovery giống nhau về ý nghĩa).
 *
 * Fail-open: lỗi parse/429 → retry 1 lần → skip + ghi nhận (script không chết).
 * Chạy: cd /home/z/tmo-app && bun scratch/r24-d0-measure.ts
 * (bun tự nạp .env từ cwd — precedent scratch/r22-room-verify.ts)
 *
 * Xuất: bảng console + scratch/r24-d0-measure.json (mọi số liệu kèm thời điểm).
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chunkText, estimateTokenCount } from '../src/lib/ingestion/pdf-parser'
import { buildSystemPrompt } from '../src/app/api/ingestion/process/route'
import { callLLMSlot } from '../src/lib/llm'

// Chạy từ repo root (bun scratch/r24-d0-measure.ts) — dùng cwd thay vì
// import.meta.dir (tránh phụ thuộc bun-types cho tsc --noEmit).
const KNOWLEDGE_DIR = join(process.cwd(), 'knowledge')
const OUT_JSON = join(process.cwd(), 'scratch', 'r24-d0-measure.json')

const SHARDS = [
  'SHD_GEN_CAUSAL_HYPER_001.TXT',
  'SHD_NAS_EVOLUTION_002.TXT',
  'SHD_OPT_CONVEX_003.TXT',
  'SHD_SYS_DYNAMICS_004.TXT',
  'SHD_CORE_GRAPH_005.TXT',
  'SHD_COMPLEXITY_006.TXT',
  'SHD_DSL_007.TXT',
  'SHD_GTH_008.TXT',
  'PSY-CORE-SCI-009.TXT',
] as const

// Domain dùng cho mọi shard khi đo: 'ml' (nội dung ML/NAS — theo task R24-a;
// trial ingestion shard 002 cũng upload domain=ml → số liệu đo khớp số trial).
const DOMAIN = 'ml' as const

/** Cùng bộ làm sạch extractTextForDocument (route R24-a) — để số chunks/chars
 *  đo ở đây khớp những gì pipeline thật sẽ thấy khi parse .txt. */
function normalizeTxt(raw: string): string {
  return raw
    .replace(/\f/g, '\n\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/\t+/g, '  ').replace(/  +/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim()
}

/** Đếm block theo marker cấu trúc (KNOWLEDGE-PARTITION.md §3 — định vị theo ID
 *  prefix, không theo số layer). Gộp cả dạng YAML-list `- NODE_ID:` (shard 001). */
function countBlocks(text: string): { node: number; rule: number; dynamic: number; metric: number; total: number } {
  const count = (re: RegExp): number => (text.match(re) || []).length
  const node = count(/^(?:-\s*)?NODE_ID\s*:/gm)
  const rule = count(/^(?:-\s*)?RULE_ID\s*:/gm)
  const dynamic = count(/^(?:-\s*)?DYNAMIC_ID\s*:/gm)
  const metric = count(/^(?:-\s*)?METRIC_ID\s*:/gm)
  return { node, rule, dynamic, metric, total: node + rule + dynamic + metric }
}

interface SampledChunk {
  chunkIndex: number
  chunkLabel: string
  rawEntities: number
  rawRels: number
  entitiesAfterOrphanFilter: number
  relsAfterOrphanFilter: number
  rawEntityNamesDropped: number
  finishReason?: string
  tokensUsed?: number
  parseRecovered: boolean
  /** có giá trị = lượt call fail (fail-open, không chết script) */
  error?: string
}

interface ShardMeasure {
  shard: string
  bytes: number
  lines: number
  blocks: { node: number; rule: number; dynamic: number; metric: number; total: number }
  estTokens: number
  normalizedChars: number
  chunks: number
  chunksDomainMl: number
  syntheticPages: number
  chunksPerPage: number
  samples: SampledChunk[]
  entityRatePerChunk: number | null
  estEntitiesRaw: number | null
  llmCallsOk: number
  llmCallsFailed: number
}

/** Parse JSON từ LLM — bản rút gọn của parseLLMResponse route-local (route chỉ
 *  export buildSystemPrompt theo scope R24-a): code fence → {...} → close-brace
 *  recovery cho JSON truncate. Trả null nếu không parse được. */
function parseLLMJson(text: string): { entities: Array<{ name: string; type: string }>; relationships: Array<{ source: string; target: string }> } | null {
  let raw: unknown = null
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlock) { try { raw = JSON.parse(codeBlock[1].trim()) } catch { /* next */ } }
  if (!raw) {
    const brace = text.match(/\{[\s\S]*\}/)
    if (brace) { try { raw = JSON.parse(brace[0]) } catch { /* next */ } }
  }
  if (!raw) {
    const start = text.indexOf('{')
    if (start >= 0) {
      let partial = text.slice(start).trim().replace(/,\s*$/, '')
      if (((partial.match(/"/g) || []).length) % 2 === 1) partial += '"'
      const ob = (partial.match(/{/g) || []).length, cb = (partial.match(/}/g) || []).length
      const obr = (partial.match(/\[/g) || []).length, cbr = (partial.match(/\]/g) || []).length
      partial += ']'.repeat(Math.max(0, obr - cbr)) + '}'.repeat(Math.max(0, ob - cb))
      try { raw = JSON.parse(partial) } catch { return null }
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const entities = Array.isArray(obj.entities)
    ? (obj.entities as Array<Record<string, unknown>>)
        .map(e => ({ name: String(e?.name ?? '').trim(), type: String(e?.type ?? 'Concept') }))
        .filter(e => e.name)
    : []
  const relationships = Array.isArray(obj.relationships)
    ? (obj.relationships as Array<Record<string, unknown>>)
        .map(r => ({ source: String(r?.source ?? '').trim(), target: String(r?.target ?? '').trim() }))
        .filter(r => r.source && r.target)
    : []
  if (entities.length === 0 && relationships.length === 0) return null
  return { entities, relationships }
}

// NVIDIA NIM quan sát thấy 503 "sóng" (server_error kéo dài 1-3 phút rồi tự
// hết — probe R24-a 2026-10-17: cùng payload fail rồi OK cách nhau vài phút).
// Task gốc ghi "retry 1 lần" cho lỗi parse/429 lẻ tẻ; với sóng 503 cần backoff
// dài hơn — nâng 4 attempt, backoff 8s/16s/24s, vẫn fail-open (skip + ghi nhận).
const MAX_ATTEMPTS = 4
const BACKOFF_MS = [0, 8000, 16000, 24000]

/** 1 lượt gọi LLM + parse + orphan filter như extractFromChunk (route ~dòng
 *  1202-1216): entity chỉ giữ khi nằm trong ≥1 relationship. Retry có backoff. */
async function sampleExtraction(
  chunkIndex: number,
  chunkContent: string,
): Promise<SampledChunk> {
  const userPrompt = `Text to analyze (chunk ${chunkIndex}):\n\n${chunkContent}`
  const systemPrompt = buildSystemPrompt(DOMAIN)
  const fail = (error: string): SampledChunk => ({ chunkLabel: `#${chunkIndex}`, rawEntities: 0, rawRels: 0, entitiesAfterOrphanFilter: 0, relsAfterOrphanFilter: 0, rawEntityNamesDropped: 0, parseRecovered: false, chunkIndex, error })

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: Awaited<ReturnType<typeof callLLMSlot>> | null = null
    try {
      result = await callLLMSlot(-1, userPrompt, systemPrompt, 'extraction', { maxTokens: 16384 })
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) return fail(`call throw: ${err instanceof Error ? err.message : String(err)}`)
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    const content = result?.content || ''
    if (!content) {
      if (attempt === MAX_ATTEMPTS) return fail(`empty content sau ${MAX_ATTEMPTS} attempt: ${String(result?.error ?? 'unknown').slice(0, 120)}`)
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    const parsed = parseLLMJson(content)
    if (!parsed) {
      if (attempt === MAX_ATTEMPTS) return fail(`parse fail (${MAX_ATTEMPTS} attempts)`)
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    // ORPHAN FILTER — giống extractFromChunk route (lowercase + trim so khớp)
    const inRels = new Set<string>()
    for (const r of parsed.relationships) { inRels.add(r.source.toLowerCase()); inRels.add(r.target.toLowerCase()) }
    const kept = parsed.entities.filter(e => inRels.has(e.name.toLowerCase()))
    const finishReason = (result as { finish_reason?: string }).finish_reason
    const tokensUsed = result.tokensUsed
    return {
      chunkLabel: `#${chunkIndex}`,
      rawEntities: parsed.entities.length,
      rawRels: parsed.relationships.length,
      entitiesAfterOrphanFilter: kept.length,
      relsAfterOrphanFilter: parsed.relationships.length,
      rawEntityNamesDropped: parsed.entities.length - kept.length,
      finishReason,
      tokensUsed,
      parseRecovered: false,
      chunkIndex,
    }
  }
  // unreachable
  return { chunkLabel: `#${chunkIndex}`, rawEntities: 0, rawRels: 0, entitiesAfterOrphanFilter: 0, relsAfterOrphanFilter: 0, rawEntityNamesDropped: 0, parseRecovered: false, chunkIndex, error: 'unreachable' }
}

const measuredAt = new Date().toISOString()
const callSeq = { n: 0 }
const results: ShardMeasure[] = []

for (const shard of SHARDS) {
  const raw = readFileSync(join(KNOWLEDGE_DIR, shard), 'utf8')
  const normalized = normalizeTxt(raw)
  const blocks = countBlocks(normalized)
  const chunks = chunkText(normalized, DOMAIN)
  const estTokens = estimateTokenCount(normalized)
  const syntheticPages = Math.max(1, Math.round(estTokens / 1800))
  const chunksPerPage = chunks.length / syntheticPages

  // 2 chunk đại diện: đầu + giữa (đúng chỉ định task R24-a)
  const midIndex = Math.floor(chunks.length / 2)
  const sampleIdx = chunks.length === 1 ? [0] : Array.from(new Set([0, midIndex]))
  const samples: SampledChunk[] = []
  let llmOk = 0, llmFailed = 0
  for (const idx of sampleIdx) {
    const s = await sampleExtraction(chunks[idx].chunkIndex, chunks[idx].content)
    callSeq.n++
    if (s.error) {
      llmFailed++
      samples.push(s)
      console.log(`  [LLM] chunk #${idx}: FAIL — ${s.error}`)
    } else {
      llmOk++
      samples.push(s)
      console.log(`  [LLM] chunk #${idx}: ${s.entitiesAfterOrphanFilter} entities (sau orphan filter, dropped ${s.rawEntityNamesDropped}), ${s.relsAfterOrphanFilter} rels, finish=${s.finishReason ?? '?'}, tokens=${s.tokensUsed ?? '?'}`)
    }
    await new Promise(r => setTimeout(r, 500)) // chống rate-limit giữa các call
  }

  const okSamples = samples.filter(s => !s.error)
  const entityRatePerChunk = okSamples.length > 0
    ? okSamples.reduce((sum, s) => sum + s.entitiesAfterOrphanFilter, 0) / okSamples.length
    : null
  const estEntitiesRaw = entityRatePerChunk !== null ? Math.round(entityRatePerChunk * chunks.length) : null

  results.push({
    shard, bytes: Buffer.byteLength(raw, 'utf8'), lines: raw.split('\n').length,
    blocks, estTokens, normalizedChars: normalized.length,
    chunks: chunks.length, chunksDomainMl: chunks.length, syntheticPages, chunksPerPage,
    samples, entityRatePerChunk, estEntitiesRaw, llmCallsOk: llmOk, llmCallsFailed: llmFailed,
  })

  console.log(`[MEASURE] ${shard}: ${raw.length}B, ${blocks.total} blocks, ${chunks.length} chunks (ml), ${syntheticPages} trang ảo, ${chunksPerPage.toFixed(2)} chunks/trang, entity-rate ${entityRatePerChunk !== null ? entityRatePerChunk.toFixed(1) : 'N/A'}/chunk, est entities ${estEntitiesRaw ?? 'N/A'}`)
}

// ==================== BẢNG CONSOLE ====================
console.log('\n===== BẢNG ĐO 9 SHARD (D0 — R24-a, ' + measuredAt + ') =====')
console.log('shard | bytes | lines | blocks(N+R+D+M) | est-tok | chunks(ml) | trang ảo | chunks/trang | entity-rate mẫu | est entities (raw)')
for (const r of results) {
  console.log(
    `${r.shard} | ${r.bytes} | ${r.lines} | ${r.blocks.total} (${r.blocks.node}+${r.blocks.rule}+${r.blocks.dynamic}+${r.blocks.metric}) | ${r.estTokens} | ${r.chunks} | ${r.syntheticPages} | ${r.chunksPerPage.toFixed(2)} | ${r.entityRatePerChunk !== null ? r.entityRatePerChunk.toFixed(1) : 'N/A'} | ${r.estEntitiesRaw ?? 'N/A'}`,
  )
}
const totChunks = results.reduce((s, r) => s + r.chunks, 0)
const totEstEntities = results.reduce((s, r) => s + (r.estEntitiesRaw ?? 0), 0)
console.log(`TỔNG: chunks=${totChunks}, est entities raw (chưa merge/resolver)=${totEstEntities}`)
console.log(`LLM calls: OK=${results.reduce((s, r) => s + r.llmCallsOk, 0)}, FAIL=${results.reduce((s, r) => s + r.llmCallsFailed, 0)}`)

// ==================== JSON ====================
const payload = {
  task: 'R24-a D0 bước 3 — đo khối lượng 9 shard trước ingestion',
  measuredAt,
  env: 'sandbox AuraDB — Neo4j Aura free-tier; extraction NIM nemotron-3-ultra-550b (callLLMSlot round-robin)',
  domain: DOMAIN,
  methodology: {
    tokens: 'estimateTokenCount lib (chars/4) trên text đã normalize như extractTextForDocument route R24-a',
    chunks: 'chunkText lib domain ml (640 tokens/overlap 96 — trùng route-local ml)',
    entityRate: 'TRUNG BÌNH 2 chunk mẫu (đầu + giữa)/shard sau orphan filter — ƯỚC LƯỢNG, không phải kết quả extract đủ shard',
    estEntities: 'entityRate × chunks — chưa trừ merge/resolver (hiệu chỉnh bằng trial shard 002)',
    blocks: 'đếm marker ^(?:- )?(NODE_ID|RULE_ID|DYNAMIC_ID|METRIC_ID): trên text normalize',
  },
  shards: results,
}
writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2))
console.log(`\n[OK] JSON: ${OUT_JSON}`)
