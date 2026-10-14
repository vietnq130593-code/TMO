/**
 * FREE MODELS SYNC — đồng bộ tự động danh sách model free của opencode/zen
 * ==========================================================================
 * R5 (2026-10-14 — user request):
 *  - "xác định lại list các model miễn phí hiện tại của opencode để đưa vào
 *    danh sách trong khung chọn model, tôi thấy 1 số model free đang không
 *    có tên" → catalog tĩnh (agent-constants.ts) chỉ có 8/12 model free;
 *    việc Zen/models.dev thay đổi model (xoá deprecated / phát hành mới
 *    như cat-jam-free 2026-10-12) làm catalog tĩnh lỗi thời ngay.
 *  - "Liệu có thể thiết lập để mỗi khi thay đổi model miễn phí là tự cập
 *    nhập được không" → module này.
 *
 * Nguồn đồng bộ 2 tầng (đối chiếu 2026-10-14 cho CÙNG kết quả 12 model):
 *  1. CLI chính chủ: `opencode models --verbose --refresh` (--refresh kéo
 *     metadata mới nhất từ models.dev; CLI tự lọc status deprecated).
 *     Free = cost.input==0 && cost.output==0.
 *  2. Fallback (CLI chưa cài / lỗi spawn): GET https://models.dev/api.json —
 *     provider 'opencode', lọc cost 0/0 + status !== 'deprecated'.
 *
 * Nhịp đồng bộ: TTL 6h mặc định (env FREE_MODELS_SYNC_TTL_MIN) —
 * instrumentation-node.ts tick 30' gọi maybeSyncZenFreeModels() (chỉ sync
 * khi due), boot +90s chạy sớm. User bấm "Đồng bộ ngay" trong dropdown model
 * → POST /api/agents/models/sync (force).
 *
 * Observability (bài học R4 — giao thức quan sát phải THẤY cả thay đổi
 * catalog, không chỉ event agent): mỗi lần sync hoàn tất (thành công lẫn
 * thất bại) → observeEvent kind 'model.sync' vào Đài quan sát — timeline
 * hiển thị thêm/bớt model ngay trong tab Quan sát.
 *
 * Merge catalog: getZenFreeModelCatalog() = overlay snapshot đồng bộ LÊN
 * PROVIDER_MODELS.zen tĩnh (single source agent-constants.ts giữ nguyên làm
 * fallback khi chưa sync):
 *   - model chỉ có trong sync → tự sinh label + caps từ metadata models.dev
 *     (ghi chú "chưa battery r73" — nói thật, không tự phong năng lực);
 *   - model tĩnh không còn trong danh sách free → gắn noLongerListed
 *     (KHÔNG xoá — dropdown hiển thị "đã rời danh sách free").
 */

import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PROVIDER_MODELS } from '@/lib/agent-constants'
import { observeEvent } from '@/lib/observation/ledger'

// ==================== TYPES ====================

export interface SyncedModelMeta {
  id: string
  name?: string
  release?: string
  context?: number
  output?: number
  reasoning?: boolean
  toolcall?: boolean
}

export interface CatalogEntry {
  id: string
  label: string
  caps?: { coding?: boolean; reasoning?: boolean; agentic?: boolean }
  /** 'manual' = chỉ catalog tĩnh · 'sync' = chỉ từ đồng bộ · 'both' = cả hai nguồn */
  source: 'manual' | 'sync' | 'both'
  syncedAt?: number
  meta?: SyncedModelMeta
  /** Không còn trong danh sách free của lần đồng bộ gần nhất — nói thật, KHÔNG xoá */
  noLongerListed?: boolean
  /** Vừa được thêm ở lần đồng bộ gần nhất (diff.added) — UI badge "⇄ mới" */
  justAdded?: boolean
}

export interface SyncResult {
  ok: boolean
  syncedAt: number
  source: 'cli' | 'modelsdev'
  added: string[]
  removed: string[]
  unchanged: string[]
  total: number
  /** true = lần sync đầu của process (không có baseline trước đó để so) */
  firstBaseline: boolean
  error?: string
}

export interface SyncStatus {
  syncedAt: number | null
  source: 'cli' | 'modelsdev' | null
  total: number | null
  lastDiff: { added: string[]; removed: string[] } | null
  lastError: string | null
  syncing: boolean
  ttlMin: number
  nextDueAt: number | null
}

// ==================== STATE (globalThis — sống sót HMR, tiền lệ ledger/tuning) ====================

interface FmsState {
  snapshot: SyncedModelMeta[] | null
  syncedAt: number | null
  source: 'cli' | 'modelsdev' | null
  lastDiff: { added: string[]; removed: string[] } | null
  lastError: string | null
  syncing: boolean
  inflight: Promise<SyncResult> | null
  binCache: { bin: string | null; at: number } | null
}

const globalForFms = globalThis as unknown as { __tmoFreeModelsSync?: FmsState }

function state(): FmsState {
  if (!globalForFms.__tmoFreeModelsSync) {
    globalForFms.__tmoFreeModelsSync = {
      snapshot: null,
      syncedAt: null,
      source: null,
      lastDiff: null,
      lastError: null,
      syncing: false,
      inflight: null,
      binCache: null,
    }
  }
  return globalForFms.__tmoFreeModelsSync
}

const TTL_MIN = Math.max(5, parseInt(process.env.FREE_MODELS_SYNC_TTL_MIN || '360', 10) || 360)

// ==================== CLI BIN RESOLUTION (mirror resolveOpenCodeCliBin llm.ts — giữ 2 module độc lập, sync KHÔNG kéo llm.ts 6k dòng vào instrumentation) ====================

function resolveOpenCodeBin(): string | null {
  const st = state()
  const now = Date.now()
  if (st.binCache && now - st.binCache.at < 10 * 60_000) return st.binCache.bin
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const candidates: string[] = []
  const envBin = process.env.OPENCODE_CLI_BIN?.trim()
  if (envBin) candidates.push(envBin)
  candidates.push(join(homedir(), '.opencode', 'bin', exe))
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        st.binCache = { bin: c, at: now }
        return c
      }
    } catch { /* ignore */ }
  }
  // PATH lookup — try execSync which/where (5s)
  try {
    const out = execSync(process.platform === 'win32' ? 'where opencode' : 'which opencode', {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }) as string
    const first = out.split('\n').map(l => l.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) {
      st.binCache = { bin: first, at: now }
      return first
    }
  } catch { /* không có trong PATH */ }
  st.binCache = { bin: null, at: now }
  return null
}

// ==================== PARSER — CLI `opencode models --verbose` ====================
// Định dạng (v1.19.0): mỗi model 1 dòng header `<provider>/<id>` + 1 block
// JSON pretty-print (cost/limit/capabilities/release_date).
//
// BUG R5 (phát hiện live 2026-10-14): output có thể chứa NHIỀU provider —
// `opencode/...` (zen chính) + `opencode-k1|k2|k3/...` (config tmo-app
// opencode.json — key xoay) + thậm chí `cloudflare-ai-gateway/...` (57 model,
// ~84KB — xuất hiện trong 1 lần chạy của app). Parser cũ chỉ nhận diện header
// `^opencode\/` → phần nội dung provider khác nằm SAU model `opencode/` cuối
// cùng bị NUỐT vào block đó → JSON.parse fail → model cuối (step-5-preview-
// free, đứng cuối danh sách) biến mất khỏi danh sách free (11/12).
// FIX: header của BẤT KỲ provider nào (`<provider>/<id>`) đều chấm dứt block
// hiện tại; chỉ block provider 'opencode' được thu — nội dung provider khác
// bị bỏ qua (cloudflare-ai-gateway/alibaba/qwen3-max ≠ model free của zen).
const CLI_HEADER_RE = /^[a-z][a-z0-9_-]*\/[A-Za-z0-9._-]+\s*$/
function parseCliModelsOutput(out: string): SyncedModelMeta[] {
  const metas: SyncedModelMeta[] = []
  const lines = out.split('\n')
  let currentId: string | null = null
  let jsonBuf: string[] = []
  const flush = () => {
    if (currentId && jsonBuf.length > 0) {
      try {
        const j = JSON.parse(jsonBuf.join('\n')) as {
          cost?: { input?: number; output?: number }
          limit?: { context?: number; output?: number }
          capabilities?: { reasoning?: boolean; toolcall?: boolean }
          release_date?: string
          name?: string
        }
        if ((j.cost?.input ?? 1) === 0 && (j.cost?.output ?? 1) === 0) {
          metas.push({
            id: currentId,
            name: typeof j.name === 'string' ? j.name : undefined,
            release: j.release_date,
            context: j.limit?.context,
            output: j.limit?.output,
            reasoning: j.capabilities?.reasoning === true,
            toolcall: j.capabilities?.toolcall === true,
          })
        }
      } catch (err) {
        // KHÔNG im lặng (bài học R5: block fail parse từng làm mất model cuối
        // danh sách mà không ai biết) — log 1 dòng, bỏ qua model đó (fail-open)
        console.warn(`[FreeModelsSync] JSON.parse fail cho model "${currentId}": ${err instanceof Error ? err.message : String(err)} — block bị bỏ qua`)
      }
    }
    currentId = null
    jsonBuf = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (CLI_HEADER_RE.test(line)) {
      // Header BẤT KỲ provider nào — chấm dứt block trước đó (flush);
      // chỉ model của provider 'opencode' (zen free tier) được thu.
      flush()
      currentId = line.startsWith('opencode/') ? line.slice('opencode/'.length).trim() : null
      continue
    }
    if (currentId) {
      // Bỏ dòng rỗng đầu block; JSON bắt đầu tại '{'
      if (jsonBuf.length === 0 && !line.trim()) continue
      jsonBuf.push(raw)
    }
  }
  flush()
  return metas
}

/** Chạy CLI `opencode models --verbose --refresh` — resolve 25s. */
function runCliModels(): Promise<SyncedModelMeta[]> {
  return new Promise((resolve) => {
    const bin = resolveOpenCodeBin()
    if (!bin) {
      resolve([])
      return
    }
    // Windows npm shim .cmd cần shell — dùng shell:true kèm chuỗi command
    const useShell = bin.endsWith('.cmd')
    const child = useShell
      ? spawn('cmd', ['/c', bin, 'models', '--verbose', '--refresh'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, ['models', '--verbose', '--refresh'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* đã chết */ }
    }, 25_000)
    child.on('error', () => { clearTimeout(killTimer); resolve([]) })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (code === 0 && stdout.trim()) {
        const parsed = parseCliModelsOutput(stdout)
        if (parsed.length > 0) resolve(parsed)
        else resolve([])
      } else {
        console.warn(`[FreeModelsSync] CLI exit ${code}: ${stderr.slice(0, 200)}`)
        resolve([])
      }
    })
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
  })
}

// ==================== FALLBACK — models.dev api.json ====================

interface ModelsDevModel {
  name?: string
  cost?: { input?: number; output?: number }
  status?: string
  release_date?: string
  limit?: { context?: number; output?: number }
  capabilities?: { reasoning?: boolean; toolcall?: boolean }
}

async function fetchModelsDevFreeModels(): Promise<SyncedModelMeta[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
    const j = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>
    const oc = j['opencode']
    if (!oc?.models) return []
    const metas: SyncedModelMeta[] = []
    for (const [id, m] of Object.entries(oc.models)) {
      const free = (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0
      const notDeprecated = m.status !== 'deprecated'
      if (!free || !notDeprecated) continue
      metas.push({
        id,
        name: typeof m.name === 'string' ? m.name : undefined,
        release: m.release_date,
        context: m.limit?.context,
        output: m.limit?.output,
        reasoning: m.capabilities?.reasoning === true,
        toolcall: m.capabilities?.toolcall === true,
      })
    }
    return metas
  } finally {
    clearTimeout(timer)
  }
}

// ==================== SYNC CORE ====================

function emitSyncEvent(result: SyncResult, prevTotal: number | null): void {
  const srcLabel = result.source === 'cli' ? 'CLI opencode' : 'models.dev'
  let summary: string
  if (!result.ok) {
    summary = `Đồng bộ model free opencode thất bại: ${result.error?.slice(0, 160)} — giữ snapshot cũ${prevTotal != null ? ` (${prevTotal} model)` : ''}`
  } else if (result.firstBaseline) {
    summary = `Đồng bộ model free opencode (baseline lần đầu): ${result.total} model — nguồn ${srcLabel}`
  } else if (result.added.length === 0 && result.removed.length === 0) {
    summary = `Đồng bộ model free opencode: ${result.total} model — không đổi (nguồn ${srcLabel})`
  } else {
    const parts: string[] = []
    if (result.added.length > 0) parts.push(`thêm ${result.added.length} [${result.added.join(', ')}]`)
    if (result.removed.length > 0) parts.push(`bỏ ${result.removed.length} [${result.removed.join(', ')}]`)
    summary = `Đồng bộ model free opencode: ${result.total} model — ${parts.join(' · ')} (nguồn ${srcLabel})`
  }
  try {
    observeEvent({
      actor: 'system',
      kind: 'model.sync',
      summary,
      payload: {
        ok: result.ok,
        source: result.source,
        total: result.total,
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged.slice(0, 30),
        firstBaseline: result.firstBaseline,
        error: result.error,
      },
      runId: null,
      sessionId: null,
    })
  } catch (err) {
    // Ledger fail-open không làm hỏng sync — chỉ log
    console.warn('[FreeModelsSync] observeEvent lỗi (không chặn sync):', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Đồng bộ danh sách model free opencode/zen.
 * - force=true bỏ TTL (nút "Đồng bộ ngay"); nếu đang có sync chạy sẽ trả về
 *   promise đó (không chạy chồng).
 */
export function syncZenFreeModels(force = false): Promise<SyncResult> {
  const st = state()
  if (st.inflight) return st.inflight
  if (!force) {
    if (st.snapshot && st.syncedAt && Date.now() - st.syncedAt < TTL_MIN * 60_000) {
      return Promise.resolve({
        ok: true,
        syncedAt: st.syncedAt,
        source: st.source ?? 'cli',
        added: [],
        removed: [],
        unchanged: st.snapshot.map(m => m.id),
        total: st.snapshot.length,
        firstBaseline: false,
        error: 'skip-ttl (đồng bộ gần đây — dùng force để bỏ TTL)',
      })
    }
  }
  st.syncing = true
  const prevSnapshot = st.snapshot
  const prevTotal = st.snapshot ? st.snapshot.length : null
  const run = (async (): Promise<SyncResult> => {
    let metas: SyncedModelMeta[] = []
    let source: 'cli' | 'modelsdev' = 'cli'
    let cliError = ''
    try {
      metas = await runCliModels()
      if (metas.length === 0) {
        cliError = 'CLI không trả model free (chưa cài/lỗi — xem log)'
        metas = await fetchModelsDevFreeModels()
        source = 'modelsdev'
      }
    } catch (err) {
      try {
        metas = await fetchModelsDevFreeModels()
        source = 'modelsdev'
      } catch (err2) {
        const result: SyncResult = {
          ok: false,
          syncedAt: Date.now(),
          source: 'cli',
          added: [], removed: [], unchanged: [],
          total: prevTotal ?? 0,
          firstBaseline: prevSnapshot == null,
          error: `CLI: ${err instanceof Error ? err.message : String(err)}; models.dev: ${err2 instanceof Error ? err2.message : String(err2)}${cliError ? ` (${cliError})` : ''}`,
        }
        st.lastError = result.error ?? null
        emitSyncEvent(result, prevTotal)
        return result
      }
    }
    const prevIds = new Set((prevSnapshot ?? []).map(m => m.id))
    const nextIds = metas.map(m => m.id)
    const added = nextIds.filter(id => !prevIds.has(id))
    const removed = prevSnapshot ? (prevSnapshot ?? []).map(m => m.id).filter(id => !nextIds.includes(id)) : []
    const unchanged = nextIds.filter(id => prevIds.has(id))
    const result: SyncResult = {
      ok: true,
      syncedAt: Date.now(),
      source,
      added,
      removed,
      unchanged,
      total: metas.length,
      firstBaseline: prevSnapshot == null,
    }
    st.snapshot = metas
    st.syncedAt = result.syncedAt
    st.source = source
    st.lastDiff = { added, removed }
    st.lastError = null
    emitSyncEvent(result, prevTotal)
    console.log(`[FreeModelsSync] ✅ ${metas.length} model free (nguồn ${source})${added.length ? ` · thêm: ${added.join(', ')}` : ''}${removed.length ? ` · bỏ: ${removed.join(', ')}` : ''}`)
    return result
  })()
  st.inflight = run
  run.finally(() => {
    st.syncing = false
    st.inflight = null
  })
  return run
}

/** Tick an toàn cho instrumentation — chỉ sync khi due, nuốt lỗi (không crash app). */
export async function maybeSyncZenFreeModels(): Promise<void> {
  try {
    const st = state()
    if (st.syncing) return
    if (st.snapshot && st.syncedAt && Date.now() - st.syncedAt < TTL_MIN * 60_000) return
    await syncZenFreeModels(true)
  } catch (err) {
    console.warn('[FreeModelsSync] maybeSync lỗi (không crash):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== MERGED CATALOG ====================

function autoLabel(m: SyncedModelMeta, justAdded: boolean): string {
  const bits: string[] = [`đồng bộ tự động ${m.release ? `models.dev ${m.release}` : 'models.dev'}`]
  if (m.context) bits.push(`ctx ${(m.context / 1000).toFixed(0)}k`)
  if (m.output) bits.push(`ra ${(m.output / 1024).toFixed(0)}k`)
  bits.push('chưa battery r73')
  if (justAdded) bits.push('VỪA THÊM ở lần sync gần nhất')
  return `${m.id} (${bits.join(' · ')})`
}

/**
 * Catalog zen = overlay snapshot đồng bộ lên PROVIDER_MODELS.zen tĩnh.
 * Sync chưa từng chạy (process mới) → trả catalog tĩnh (fallback — không blocking).
 * Đồng bộ theo tham chiếu: caller so sánh diff qua getSyncStatus().
 */
export function getZenFreeModelCatalog(): Array<CatalogEntry & { blockedHint?: never }> {
  const st = state()
  const staticZen = PROVIDER_MODELS.zen ?? []
  const snapshot = st.snapshot
  const syncedAt = st.syncedAt ?? undefined
  const justAddedSet = new Set(st.lastDiff?.added ?? [])
  if (!snapshot) {
    // Chưa sync trong process này — catalog tĩnh + meta trống (source manual)
    return staticZen.map(m => ({ ...m, source: 'manual' as const }))
  }
  const byId = new Map(snapshot.map(m => [m.id, m]))
  const seen = new Set<string>()
  const out: Array<CatalogEntry> = []
  for (const s of staticZen) {
    seen.add(s.id)
    const meta = byId.get(s.id)
    if (meta) {
      out.push({
        ...s,
        source: 'both',
        syncedAt,
        meta,
        noLongerListed: false,
        justAdded: justAddedSet.has(s.id),
      })
    } else {
      // Tĩnh nhưng không còn trong danh sách free — nói thật, KHÔNG xoá
      out.push({ ...s, source: 'manual', noLongerListed: true })
    }
  }
  for (const m of snapshot) {
    if (seen.has(m.id)) continue
    out.push({
      id: m.id,
      label: autoLabel(m, justAddedSet.has(m.id)),
      // caps từ metadata models.dev — chưa battery r73 (nói thật trong label)
      caps: { coding: m.toolcall === true, reasoning: m.reasoning === true, agentic: m.toolcall === true },
      source: 'sync',
      syncedAt,
      meta: m,
      justAdded: justAddedSet.has(m.id),
    })
  }
  return out
}

/** Trạng thái sync cho API + UI. */
export function getSyncStatus(): SyncStatus {
  const st = state()
  return {
    syncedAt: st.syncedAt,
    source: st.source,
    total: st.snapshot ? st.snapshot.length : null,
    lastDiff: st.lastDiff,
    lastError: st.lastError,
    syncing: st.syncing,
    ttlMin: TTL_MIN,
    nextDueAt: st.syncedAt ? st.syncedAt + TTL_MIN * 60_000 : null,
  }
}
