/**
 * R24-a — D0 BƯỚC 3b: GAP-FILL entity-rate cho shard đo N/A (đợt sóng 503 NIM)
 * ============================================================================
 * Đợt đo chính (scratch/r24-d0-measure.ts, 09:35–10:01 UTC) chỉ đạt 6/18 lượt
 * gọi LLM vì NVIDIA NIM nemotron-3-ultra-550b gặp sóng 503/hang dài — 4 shard
 * rơi entity-rate N/A (OPT_CONVEX_003, SYS_DYNAMICS_004, GTH_008,
 * PSY-CORE-SCI-009) + 4 shard thiếu mẫu giữa. Script này CHỈ gọi lại đúng các
 * mẫu lỗi đó (không lặp lại mẫu đã OK — tiết kiệm quota NIM), cập nhật kết quả
 * vào chính scratch/r24-d0-measure.json (kèm lịch sử gapFill để trace).
 *
 * Chạy: cd /home/z/tmo-app && bun scratch/r24-d0-measure-gapfill.ts
 * Fail-open như bản chính: lỗi → skip + ghi nhận (để chạy lại sau).
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chunkText } from '../src/lib/ingestion/pdf-parser'
import { buildSystemPrompt } from '../src/app/api/ingestion/process/route'
import { callLLMSlot } from '../src/lib/llm'

const KNOWLEDGE_DIR = join(process.cwd(), 'knowledge')
const JSON_PATH = join(process.cwd(), 'scratch', 'r24-d0-measure.json')

const DOMAIN = 'ml' as const

// Cùng bộ normalize + parse + orphan-filter như script đo chính (giữ số liệu
// so sánh được apples-to-apples với r24-d0-measure.json).
function normalizeTxt(raw: string): string {
  return raw
    .replace(/\f/g, '\n\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/\t+/g, '  ').replace(/  +/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim()
}

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

const MAX_ATTEMPTS = 4
const BACKOFF_MS = [0, 8000, 16000, 24000]

interface SampleResult {
  ok: boolean
  entitiesAfterOrphanFilter?: number
  rels?: number
  finishReason?: string
  tokensUsed?: number
  error?: string
}

async function sampleChunk(chunkIndex: number, content: string): Promise<SampleResult> {
  const userPrompt = `Text to analyze (chunk ${chunkIndex}):\n\n${content}`
  const systemPrompt = buildSystemPrompt(DOMAIN)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: Awaited<ReturnType<typeof callLLMSlot>> | null = null
    try {
      result = await callLLMSlot(-1, userPrompt, systemPrompt, 'extraction', { maxTokens: 16384 })
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `call throw: ${err instanceof Error ? err.message : String(err)}` }
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    const content2 = result?.content || ''
    if (!content2) {
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `empty content sau ${MAX_ATTEMPTS} attempt` }
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    const parsed = parseLLMJson(content2)
    if (!parsed) {
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `parse fail (${MAX_ATTEMPTS} attempts)` }
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
      continue
    }
    const inRels = new Set<string>()
    for (const r of parsed.relationships) { inRels.add(r.source.toLowerCase()); inRels.add(r.target.toLowerCase()) }
    const kept = parsed.entities.filter(e => inRels.has(e.name.toLowerCase()))
    return {
      ok: true,
      entitiesAfterOrphanFilter: kept.length,
      rels: parsed.relationships.length,
      finishReason: (result as { finish_reason?: string }).finish_reason,
      tokensUsed: result.tokensUsed,
    }
  }
  return { ok: false, error: 'unreachable' }
}

// ==================== MAIN ====================
interface MeasureJson {
  measuredAt: string
  shards: Array<{
    shard: string
    chunks: number
    entityRatePerChunk: number | null
    estEntitiesRaw: number | null
    llmCallsOk: number
    llmCallsFailed: number
    samples: Array<{ chunkIndex: number; error?: string; entitiesAfterOrphanFilter?: number; relsAfterOrphanFilter?: number; rawEntities?: number; rawRels?: number; rawEntityNamesDropped?: number; finishReason?: string; tokensUsed?: number; parseRecovered?: boolean; chunkLabel?: string }>
    [k: string]: unknown
  }>
  [k: string]: unknown
}

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as MeasureJson
const gapFillAt = new Date().toISOString()
let callsOk = 0, callsFail = 0
// 1 entry lịch sử cho PHIÊN chạy này — mutate cùng tham chiếu, ghi sau mỗi mẫu
const runEntry: { gapFillAt: string; callsOk: number; callsFail: number; note?: string } = { gapFillAt, callsOk: 0, callsFail: 0, note: 'in-progress (kill an toàn — đã ghi incremental)' }
if (!Array.isArray(data.gapFillHistory)) data.gapFillHistory = []
;(data.gapFillHistory as unknown[]).push(runEntry)
// Ghi ngay frame đầu (chưa có mẫu nào) — nếu script chết ngay sau start vẫn còn dấu vết
writeFileSync(JSON_PATH, JSON.stringify(data, null, 2))

for (const shard of data.shards) {
  const failedSamples = shard.samples.filter(s => s.error)
  if (failedSamples.length === 0) continue
  const raw = readFileSync(join(KNOWLEDGE_DIR, shard.shard), 'utf8')
  const chunks = chunkText(normalizeTxt(raw), DOMAIN)
  console.log(`[GAP-FILL] ${shard.shard}: ${failedSamples.length} mẫu lỗi — gọi lại...`)
  for (const s of failedSamples) {
    const chunk = chunks.find(c => c.chunkIndex === s.chunkIndex) || chunks[s.chunkIndex] || chunks[0]
    const r = await sampleChunk(s.chunkIndex, chunk.content)
    if (r.ok) {
      callsOk++
      s.entitiesAfterOrphanFilter = r.entitiesAfterOrphanFilter
      s.relsAfterOrphanFilter = r.rels
      s.rawEntities = r.entitiesAfterOrphanFilter
      s.rawRels = r.rels
      s.rawEntityNamesDropped = 0
      s.finishReason = r.finishReason
      s.tokensUsed = r.tokensUsed
      delete s.error
      console.log(`  chunk #${s.chunkIndex}: ${r.entitiesAfterOrphanFilter} entities, ${r.rels} rels (finish=${r.finishReason ?? '?'})`)
    } else {
      callsFail++
      console.log(`  chunk #${s.chunkIndex}: VẪN FAIL — ${r.error?.slice(0, 90)}`)
    }
    // R24-a: ghi incremental sau MỖI mẫu — script có thể bị kill giữa chừng
    // (timeout/503 sóng dài) mà không mất kết quả các mẫu đã xong. runEntry là
    // CÙNG tham chiếu trong mảng history → mutate là đủ cập nhật JSON.
    runEntry.callsOk = callsOk
    runEntry.callsFail = callsFail
    writeFileSync(JSON_PATH, JSON.stringify(data, null, 2))
    await new Promise(r2 => setTimeout(r2, 500))
  }
  // Tính lại entity-rate + est từ MỌI mẫu OK hiện có (đã bao gồm mẫu gốc còn sống)
  const okSamples = shard.samples.filter(s => !s.error)
  if (okSamples.length > 0) {
    const rate = okSamples.reduce((sum, s) => sum + (s.entitiesAfterOrphanFilter || 0), 0) / okSamples.length
    shard.entityRatePerChunk = rate
    shard.estEntitiesRaw = Math.round(rate * shard.chunks)
    console.log(`  → entity-rate ${rate.toFixed(1)}/chunk (từ ${okSamples.length} mẫu OK), est ${shard.estEntitiesRaw} entities`)
  }
  shard.llmCallsOk = shard.samples.filter(s => !s.error).length
  shard.llmCallsFailed = shard.samples.filter(s => s.error).length
}

// Ghi lịch sử gapFill (bản cuối — mỗi mẫu đã ghi incremental; dòng này chỉ
// cập nhật note + chốt số liệu + tính lại mọi entity-rate từ JSON mới nhất)
runEntry.note = 'done'
writeFileSync(JSON_PATH, JSON.stringify(data, null, 2))
console.log(`\n[GAP-FILL] xong: OK=${callsOk} FAIL=${callsFail} → ${JSON_PATH}`)
