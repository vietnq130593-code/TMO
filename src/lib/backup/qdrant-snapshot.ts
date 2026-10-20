/**
 * Qdrant Snapshot Backup/Restore → Cloudflare R2 — MULTI-COLLECTION
 *
 * Phase 3 SMOLAB Proposal 10.5 · BLUEPRINT-BACKUP-GATE P1/S1 (BUG2-304)
 *
 * Why this exists
 * ---------------
 * The existing /api/storage/db-backup endpoint snapshots the SQLite file to
 * R2, but SQLite only holds document processing STATE (jobs, rows, metadata).
 * The actual vector embeddings live in Qdrant. When the sandbox resets, the
 * Qdrant data directory is wiped → chunks vanish → GraphRAG queries return
 * nothing, even though SQLite was restored.
 *
 * BUG2-304 (P2, phát hiện W3-8c 44578f9): bản cũ chỉ snapshot đúng 1 collection
 * (theopus_chunks) — theopus_documents / agent_memory / task_context /
 * theopus_episodes mất vĩnh viễn sau reset. Bản này backup NAM collection theo
 * env QDRANT_BACKUP_COLLECTIONS (mặc định 5 — xem getBackupCollections()).
 *
 * Snapshot workflow (Qdrant REST API v1.19):
 *   1. POST /collections/{name}/snapshots → 200 OK + {name, size, checksum} (synchronous)
 *   2. GET  /collections/{name}/snapshots/{name} → binary tar stream (POSIX tar)
 *   3. DELETE /collections/{name}/snapshots/{name} → cleanup after R2 upload
 *
 * Restore workflow (per collection, theo policy restoreDecision):
 *   1. findBackupKey(collection, date) — prefix per-collection; riêng chunks
 *      fallback legacy root (tar cũ trước S1 vẫn restore được)
 *   2. Download to memory
 *   3. POST /collections/{name}/snapshots/upload (multipart/form-data)
 *   4. Qdrant replaces the collection's contents from the snapshot
 *   5. GET /collections/{name} → verify pointCount
 *
 * R2 storage layout (S1.1 — per-collection key)
 * -----------------
 *   backups/qdrant/<collection>/{YYYYMMDD-HHMMSS}.tar — versioned (history)
 *   backups/qdrant/<collection>/latest.tar             — overwritten each run
 *   backups/qdrant/{YYYYMMDD-HHMMSS}.tar + latest.tar  — LEGACY root keys (chỉ
 *   chunks) — KHÔNG còn được ghi mới (dual-write đã gỡ 2026-10-20 sau khi đạt
 *   điều kiện ≥2 backup per-collection thành công + docs D0 §7.2 cập nhật);
 *   root keys cũ GIỮ LẠI trong R2 vĩnh viễn — findBackupKey vẫn fallback về
 *   root cho chunks (tar cũ trước S1 vẫn restore được).
 *
 * Restore policy (S1.2 — hàm thuần restoreDecision, unit-test r124):
 *   - theopus_chunks / theopus_documents (tĩnh)        → luôn REPLACE
 *   - agent_memory / task_context / theopus_episodes (sống) → restoreIfEmpty:
 *     chỉ REPLACE khi collection đang RỖNG — không bao giờ restore cũ đè
 *     data mới. Lối thoát disaster-recovery: force=1 (route query param,
 *     mặc định 0) — bỏ policy, REPLACE mọi collection trong scope + warning.
 *
 * Size guard (S1.1): QDRANT_BACKUP_MAX_POINTS (mặc định 5000) — collection
 * sống vượt ngưỡng → skip collection đó trong lần backup đó + warn (không fail
 * batch) — chặn tar phình vô hạn (episodes/agent_memory là dữ liệu tích lũy).
 *
 * @module backup/qdrant-snapshot
 */

import { uploadToR2, downloadFromR2, listR2Objects } from '@/lib/r2-storage'

// ==================== CONFIG ====================

/** Qdrant REST URL — read fresh from env each call (don't cache at module load
 *  so the test suite / cron can mock env before this loads). */
function getQdrantUrl(): string {
  return process.env.QDRANT_URL || 'http://localhost:6333'
}

/** Qdrant API key — undefined for local Qdrant (no auth). */
function getQdrantApiKey(): string | undefined {
  return process.env.QDRANT_API_KEY || undefined
}

/** Chunks collection name — matches src/lib/qdrant.ts COLLECTION_CHUNKS. */
function getChunksCollection(): string {
  return process.env.QDRANT_COLLECTION_CHUNKS || 'theopus_chunks'
}

/** Documents collection name — matches src/lib/qdrant.ts COLLECTION_DOCUMENTS. */
function getDocumentsCollection(): string {
  return process.env.QDRANT_COLLECTION_DOCUMENTS || 'theopus_documents'
}

/**
 * Danh sách collection được backup (S1.1).
 * Mặc định 5 collection (blueprint §2-P1 v0.2):
 *   - theopus_chunks     (corpus tĩnh — REPLACE an toàn)
 *   - theopus_documents  (metadata ingestion — REPLACE an toàn nếu backup tươi)
 *   - agent_memory       (sống — restoreIfEmpty)
 *   - task_context       (sống nhẹ — restoreIfEmpty)
 *   - theopus_episodes   (LỊCH SỬ không tái sinh được — restoreIfEmpty)
 * KHÔNG backup theopus_communities — tái sinh bằng scripts/refresh-communities.ts
 * (Leiden recompute). Override hoàn toàn bằng env QDRANT_BACKUP_COLLECTIONS
 * (comma-separated).
 */
export function getBackupCollections(): string[] {
  const raw = process.env.QDRANT_BACKUP_COLLECTIONS?.trim()
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [
    getChunksCollection(),
    getDocumentsCollection(),
    'agent_memory',
    'task_context',
    'theopus_episodes',
  ]
}

/** Size guard (S1.1) — collection vượt ngưỡng điểm → skip + warn, không fail batch. */
export function getBackupMaxPoints(): number {
  const n = Number(process.env.QDRANT_BACKUP_MAX_POINTS)
  return Number.isFinite(n) && n > 0 ? n : 5000
}

/** R2 prefix cho qdrant snapshots. */
const R2_PREFIX = 'backups/qdrant/'

/** Per-collection prefix: backups/qdrant/<collection>/ */
function collectionPrefix(collection: string): string {
  return `${R2_PREFIX}${collection}/`
}

/** Max wait for snapshot creation (Qdrant v1.19 makes snapshots synchronously,
 *  so 5s should suffice even for 1045 chunks ~20MB. Generous 60s safety net). */
const SNAPSHOT_WAIT_TIMEOUT_MS = 60_000
const SNAPSHOT_POLL_INTERVAL_MS = 1_000

// ==================== TYPES ====================

export interface QdrantCollectionBackupResult {
  collection: string
  /** ok = snapshot + upload thành công · skipped = guard/not-found (không fail batch) · error = thất bại */
  status: 'ok' | 'skipped' | 'error'
  r2Key?: string
  sizeBytes?: number
  collectionPoints?: number
  snapshotName?: string
  reason?: string
}

export interface QdrantBackupResult {
  // ==== Legacy compat fields (= kết quả của theopus_chunks — route/UI cũ đọc) ====
  r2Key: string
  sizeBytes: number
  collectionPoints: number
  snapshotName: string
  // ==== Multi-collection (S1.1) ====
  collections: QdrantCollectionBackupResult[]
}

export interface QdrantCollectionRestoreResult {
  collection: string
  /** restored = đã REPLACE · skipped = policy chặn (data sống) · error = thất bại */
  status: 'restored' | 'skipped' | 'error'
  decision?: 'replace' | 'skip'
  restoredPoints?: number
  r2Key?: string
  sizeBytes?: number
  snapshotName?: string
  reason?: string
}

export interface QdrantRestoreResult {
  // ==== Legacy compat fields (= kết quả của theopus_chunks) ====
  restoredPoints: number
  sizeBytes: number
  r2Key: string
  snapshotName: string
  // ==== Multi-collection (S1.2) ====
  force?: boolean
  collections: QdrantCollectionRestoreResult[]
}

interface QdrantSnapshotMeta {
  name: string
  creation_time: string
  size: number
  checksum?: string
}

// ==================== HELPERS ====================

function authHeaders(): Record<string, string> {
  const apiKey = getQdrantApiKey()
  return apiKey ? { 'api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}
}

/** Format a YYYYMMDD-HHMMSS timestamp (local). */
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** Thông tin 1 collection: tồn tại + point count (phân biệt "chưa tạo" vs "rỗng"). */
async function getCollectionInfo(
  collection: string
): Promise<{ exists: boolean; points: number }> {
  const url = `${getQdrantUrl()}/collections/${encodeURIComponent(collection)}`
  try {
    const res = await fetch(url, { headers: authHeaders() })
    if (res.status === 404) return { exists: false, points: 0 }
    if (!res.ok) return { exists: false, points: 0 }
    const body = (await res.json()) as {
      result?: { points_count?: number; vectors_count?: number; pointsCount?: number }
    }
    const r = body.result
    if (!r) return { exists: false, points: 0 }
    return { exists: true, points: r.points_count ?? r.vectors_count ?? r.pointsCount ?? 0 }
  } catch {
    return { exists: false, points: 0 }
  }
}

/**
 * Fetch the point count of a collection directly from Qdrant.
 * Returns 0 nếu collection chưa tồn tại / lỗi (dùng cho policy restoreIfEmpty).
 */
export async function getCollectionPointCount(collection: string): Promise<number> {
  const info = await getCollectionInfo(collection)
  return info.points
}

/** Compat — point count của chunks collection (route + callers cũ). */
export async function getChunksPointCount(): Promise<number> {
  return getCollectionPointCount(getChunksCollection())
}

// ==================== RESTORE POLICY (S1.2 — pure, unit-test r124) ====================

/**
 * Quyết định restore cho 1 collection — HÀM THUẦN (blueprint S1.2).
 *
 * - force → 'replace' (disaster-recovery có chủ ý — data sống BỊ HỎNG nhưng
 *   không rỗng thì policy skip sẽ chặn vĩnh viễn đường hồi phục).
 * - chunks/documents (collection tĩnh) → luôn 'replace'.
 * - collection sống (memory/task_context/episodes) → restoreIfEmpty:
 *   'replace' chỉ khi đang RỖNG, ngược lại 'skip' (không bao giờ đè data mới).
 */
export function restoreDecision(
  collection: string,
  currentPoints: number,
  force = false
): 'replace' | 'skip' {
  if (force) return 'replace'
  const staticCollections = [getChunksCollection(), getDocumentsCollection()]
  if (staticCollections.includes(collection)) return 'replace'
  return currentPoints === 0 ? 'replace' : 'skip'
}

// ==================== SNAPSHOT PRIMITIVES (1 collection) ====================

/** Trigger snapshot creation — trả về meta (create sync; poll fallback async). */
async function createSnapshot(collection: string): Promise<QdrantSnapshotMeta> {
  const baseUrl = getQdrantUrl()
  const snapshotUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots`

  const createRes = await fetch(snapshotUrl, {
    method: 'POST',
    headers: { ...authHeaders() },
  })
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '')
    throw new Error(
      `Qdrant snapshot create failed: HTTP ${createRes.status} ${txt.slice(0, 200)}`
    )
  }
  const createBody = (await createRes.json()) as {
    result?: QdrantSnapshotMeta
    status?: string
  }
  let snapshotMeta: QdrantSnapshotMeta | undefined = createBody.result

  // Create returned no meta (async path) → poll list endpoint up to 60s.
  if (!snapshotMeta) {
    const listUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots`
    const deadline = Date.now() + SNAPSHOT_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const listRes = await fetch(listUrl, { headers: authHeaders() })
      if (listRes.ok) {
        const listBody = (await listRes.json()) as { result?: QdrantSnapshotMeta[] }
        const snapshots = listBody.result || []
        if (snapshots.length > 0) {
          snapshotMeta = snapshots.sort((a, b) =>
            b.creation_time.localeCompare(a.creation_time)
          )[0]
          break
        }
      }
      await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS))
    }
    if (!snapshotMeta) {
      throw new Error('Qdrant snapshot creation timed out (60s) — no snapshot appeared')
    }
  }
  return snapshotMeta
}

/** Download snapshot binary (POSIX tar) về Buffer. */
async function downloadSnapshot(
  collection: string,
  snapshotName: string
): Promise<Buffer> {
  const baseUrl = getQdrantUrl()
  const downloadUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`
  const downloadRes = await fetch(downloadUrl, { headers: authHeaders() })
  if (!downloadRes.ok || !downloadRes.body) {
    const txt = await downloadRes.text().catch(() => '')
    throw new Error(
      `Qdrant snapshot download failed: HTTP ${downloadRes.status} ${txt.slice(0, 200)}`
    )
  }
  const chunks: Buffer[] = []
  // @ts-expect-error — ReadableStream types vary between Node/Web; both work here
  for await (const chunk of downloadRes.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Dọn snapshot local trên Qdrant sau khi dùng xong (non-fatal). */
async function deleteLocalSnapshot(collection: string, snapshotName: string): Promise<void> {
  try {
    const baseUrl = getQdrantUrl()
    const delUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`
    const delRes = await fetch(delUrl, { method: 'DELETE', headers: authHeaders() })
    if (delRes.ok) {
      console.log(`[QdrantBackup] Cleaned up local snapshot: ${snapshotName}`)
    } else {
      console.warn(`[QdrantBackup] Snapshot cleanup failed: HTTP ${delRes.status} (non-fatal)`)
    }
  } catch (err) {
    console.warn(
      `[QdrantBackup] Snapshot cleanup error (non-fatal):`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ==================== BACKUP (S1.1 — multi-collection) ====================

/** Backup 1 collection: snapshot → download → upload per-collection keys. */
async function backupOneCollection(
  collection: string,
  maxPoints: number
): Promise<QdrantCollectionBackupResult> {
  // 0. Collection tồn tại? (chưa tạo → skip-graceful, KHÔNG fail batch)
  const info = await getCollectionInfo(collection)
  if (!info.exists) {
    console.warn(`[QdrantBackup] ⚠ SKIP "${collection}" — collection không tồn tại trên Qdrant`)
    return { collection, status: 'skipped', reason: 'collection không tồn tại' }
  }

  // 1. Size guard (S1.1) — chặn tar phình vô hạn cho collection sống.
  if (info.points > maxPoints) {
    console.warn(
      `[QdrantBackup] ⚠ SKIP "${collection}" — ${info.points} điểm > guard ${maxPoints} (QDRANT_BACKUP_MAX_POINTS)`
    )
    return {
      collection,
      status: 'skipped',
      reason: `vượt size guard: ${info.points} > ${maxPoints} điểm (QDRANT_BACKUP_MAX_POINTS)`,
    }
  }

  console.log(`[QdrantBackup] === Collection "${collection}" (${info.points} points) ===`)

  // 2. Snapshot + download
  const meta = await createSnapshot(collection)
  const snapshotName = meta.name
  console.log(
    `[QdrantBackup] Snapshot created: ${snapshotName} (reported size: ${meta.size || 0} bytes)`
  )

  try {
    const buffer = await downloadSnapshot(collection, snapshotName)
    const sizeBytes = buffer.length
    console.log(
      `[QdrantBackup] Downloaded snapshot binary: ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
    )

    // 3. Upload per-collection: versioned + latest pointer
    const ts = timestamp()
    const prefix = collectionPrefix(collection)
    const versionedKey = `${prefix}${ts}.tar`
    const versionedResult = await uploadToR2(versionedKey, buffer, 'application/x-tar')
    if (!versionedResult.success) {
      throw new Error(`R2 upload failed (versioned): ${versionedResult.error}`)
    }
    const latestResult = await uploadToR2(`${prefix}latest.tar`, buffer, 'application/x-tar')
    if (!latestResult.success) {
      console.warn(
        `[QdrantBackup] Failed to update per-collection latest pointer (non-fatal): ${latestResult.error}`
      )
    }
    console.log(`[QdrantBackup] Uploaded to R2: ${versionedKey} (${sizeBytes} bytes) + ${prefix}latest.tar`)

    // 4. LEGACY dual-write ĐÃ GỠ (2026-10-20) — điều kiện blueprint §4-S1.1 đạt:
    //    ≥2 backup per-collection thành công (verify GET snapshot-full byCollection)
    //    + docs D0 §7.2 cập nhật curl mới. Root keys cũ KHÔNG xóa khỏi R2;
    //    findBackupKey vẫn fallback root cho chunks (đường hồi 868 chunks).

    return {
      collection,
      status: 'ok',
      r2Key: versionedKey,
      sizeBytes,
      collectionPoints: info.points,
      snapshotName,
    }
  } finally {
    await deleteLocalSnapshot(collection, snapshotName)
  }
}

/**
 * Backup TOÀN BỘ collection trong getBackupCollections() → R2.
 *
 * Lỗi 1 collection (chưa tồn tại / vượt guard) → skip-graceful + log, KHÔNG fail
 * batch. Riêng collection chunks gặp LỖI THẬT (Qdrant/R2 down) → throw để route
 * báo 500 (giữ contract cũ của POST ?store=qdrant).
 */
export async function backupQdrantToR2(): Promise<QdrantBackupResult> {
  const collections = getBackupCollections()
  const maxPoints = getBackupMaxPoints()
  console.log(`[QdrantBackup] Multi-collection backup: [${collections.join(', ')}] (guard ${maxPoints} điểm)`)

  const results: QdrantCollectionBackupResult[] = []
  for (const collection of collections) {
    try {
      results.push(await backupOneCollection(collection, maxPoints))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[QdrantBackup] ✗ LỖI collection "${collection}": ${msg} (skip-graceful)`)
      results.push({ collection, status: 'error', reason: msg })
    }
  }

  // Legacy compat fields = kết quả chunks (contract cũ của route/UI).
  const chunksRes = results.find((r) => r.collection === getChunksCollection())
  if (chunksRes?.status === 'error') {
    // Giữ contract cũ: chunks fail thật → throw (route ?store=qdrant trả 500).
    throw new Error(`chunks backup failed: ${chunksRes.reason}`)
  }

  const ok = (r?: QdrantCollectionBackupResult) =>
    r?.status === 'ok' ? r : undefined
  const chunksOk = ok(chunksRes)
  return {
    r2Key: chunksOk?.r2Key ?? '',
    sizeBytes: chunksOk?.sizeBytes ?? 0,
    collectionPoints: chunksOk?.collectionPoints ?? 0,
    snapshotName: chunksOk?.snapshotName ?? '',
    collections: results,
  }
}

// ==================== RESTORE (S1.2 — per-collection + policy + force) ====================

/**
 * Tìm R2 key backup cho 1 collection.
 *
 * Thứ tự: (1) key per-collection khớp date prefix; (2) date='latest' →
 * per-collection latest.tar; (3) LEGACY fallback — chỉ theopus_chunks, tar cũ
 * nằm ở root prefix (trước S1) — bỏ qua bước này là giết đường hồi phục 868
 * chunks đã chứng minh (blueprint §8-1).
 *
 * @param date YYYYMMDD hoặc 'latest'
 * @returns R2 key, hoặc null nếu không tìm thấy
 */
export async function findBackupKey(
  collection: string,
  date: string
): Promise<string | null> {
  // (1) per-collection prefix
  const prefix = collectionPrefix(collection)
  const list = await listR2Objects(prefix, 500)
  if (!list.success) {
    throw new Error(`R2 list failed: ${list.error}`)
  }
  const matches = list.objects
    .filter((o) => {
      const name = o.key.split('/').pop() || ''
      return name.startsWith(`${date}-`) && name.endsWith('.tar')
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  if (matches.length > 0) return matches[0].key

  // (2) latest pointer per-collection
  if (date === 'latest') {
    const latestKey = `${prefix}latest.tar`
    if (list.objects.some((o) => o.key === latestKey)) return latestKey
  }

  // (3) LEGACY root fallback — chỉ chunks (tar cũ trước S1)
  if (collection === getChunksCollection()) {
    const rootList = await listR2Objects(R2_PREFIX, 500)
    if (!rootList.success) {
      throw new Error(`R2 list failed: ${rootList.error}`)
    }
    const rootMatches = rootList.objects
      .filter((o) => {
        const parts = o.key.split('/')
        // Chỉ nhận key root: backups/qdrant/<file>.tar (3 segment) — per-collection có 4
        if (parts.length !== 3 || !o.key.endsWith('.tar')) return false
        const name = parts[2] || ''
        return date === 'latest' ? name === 'latest.tar' : name.startsWith(`${date}-`)
      })
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    if (rootMatches.length > 0) return rootMatches[0].key
  }

  return null
}

/** Upload tar vào Qdrant (multipart) → đợi restore xong → trả point count sau restore. */
async function restoreTarToCollection(
  collection: string,
  buffer: Buffer,
  r2Key: string
): Promise<number> {
  const baseUrl = getQdrantUrl()
  // Qdrant 1.19 restore-from-upload: POST /collections/{name}/snapshots/upload
  // (multipart/form-data, field "snapshot" = binary tar). Synthetic multipart
  // body để tránh FormData runtime quirks Node/Bun.
  const boundary = `----theopus-restore-${Date.now()}`
  const filename = r2Key.split('/').pop() || 'snapshot.tar'
  const partHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="snapshot"; filename="${filename}"\r\n` +
    `Content-Type: application/x-tar\r\n\r\n`
  const partFooter = `\r\n--${boundary}--\r\n`
  const body = Buffer.concat([
    Buffer.from(partHeader, 'utf8'),
    buffer,
    Buffer.from(partFooter, 'utf8'),
  ])

  const uploadUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/upload`
  console.log(`[QdrantRestore] POST ${uploadUrl} (${body.length} bytes multipart)`)

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })
  if (!uploadRes.ok) {
    const txt = await uploadRes.text().catch(() => '')
    throw new Error(
      `Qdrant snapshot upload failed: HTTP ${uploadRes.status} ${txt.slice(0, 300)}`
    )
  }
  console.log(`[QdrantRestore] Snapshot uploaded to Qdrant (${collection})`)

  // Poll point count — Qdrant restores asynchronously (wait up to 60s).
  console.log(`[QdrantRestore] Waiting for collection "${collection}" to be repopulated...`)
  const deadline = Date.now() + SNAPSHOT_WAIT_TIMEOUT_MS
  let postCount = 0
  while (Date.now() < deadline) {
    postCount = await getCollectionPointCount(collection)
    if (postCount > 0) break
    await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS))
  }

  // Cleanup: xóa snapshot local mà upload có thể để lại (non-fatal).
  try {
    const listUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots`
    const listRes = await fetch(listUrl, { headers: authHeaders() })
    if (listRes.ok) {
      const listData = (await listRes.json()) as { result?: Array<{ name?: string }> }
      for (const snap of listData.result ?? []) {
        if (!snap.name) continue
        const delUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snap.name)}`
        await fetch(delUrl, { method: 'DELETE', headers: authHeaders() })
        console.log(`[QdrantRestore] Cleaned up local snapshot: ${snap.name}`)
      }
    }
  } catch {
    // non-fatal
  }

  return postCount
}

/**
 * Restore NHIỀU collection từ R2 theo policy restoreDecision (S1.2).
 *
 * @param date YYYYMMDD hoặc 'latest'
 * @param opts.force   bỏ policy — REPLACE mọi collection trong scope (disaster-
 *                     recovery; warning ghi đè điểm sống). Mặc định false.
 * @param opts.collections  override danh sách collection (mặc định getBackupCollections())
 *
 * Contract cũ giữ nguyên: chunks gặp lỗi thật (no backup / Qdrant down) → throw
 * (route ?store=qdrant trả 500 như trước). Collection khác lỗi → nằm trong
 * collections[] với status 'error' (batch vẫn tiếp tục).
 */
export async function restoreQdrantFromR2(
  date: string,
  opts: { force?: boolean; collections?: string[] } = {}
): Promise<QdrantRestoreResult> {
  const force = opts.force === true
  const list = opts.collections?.length ? opts.collections : getBackupCollections()
  console.log(
    `[QdrantRestore] Multi-collection restore: [${list.join(', ')}] date=${date}${force ? ' FORCE=1 (bỏ policy)' : ''}`
  )

  const perCollection: QdrantCollectionRestoreResult[] = []
  for (const collection of list) {
    const currentPoints = await getCollectionPointCount(collection)
    const decision = restoreDecision(collection, currentPoints, force)

    if (decision === 'skip') {
      const reason = `còn ${currentPoints} điểm đang sống — policy restoreIfEmpty chặn (dùng force=1 để ghi đè có chủ ý)`
      console.log(`[QdrantRestore] ⊘ SKIP "${collection}" — ${reason}`)
      perCollection.push({ collection, status: 'skipped', decision, reason })
      continue
    }

    if (force && currentPoints > 0) {
      console.warn(
        `[QdrantRestore] ⚠ FORCE restore — ghi đè ${currentPoints} điểm đang sống của "${collection}"`
      )
    }

    try {
      const r2Key = await findBackupKey(collection, date)
      if (!r2Key) {
        throw new Error(
          `No Qdrant backup found for collection "${collection}" matching date "${date}"`
        )
      }
      console.log(`[QdrantRestore] Using R2 key: ${r2Key}`)

      const dl = await downloadFromR2(r2Key)
      if (!dl.success || !dl.buffer) {
        throw new Error(`R2 download failed: ${dl.error}`)
      }
      const buffer = dl.buffer
      const sizeBytes = dl.size || buffer.length
      console.log(
        `[QdrantRestore] Downloaded ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
      )

      const restoredPoints = await restoreTarToCollection(collection, buffer, r2Key)
      console.log(
        `[QdrantRestore] ✓ "${collection}" restored: ${restoredPoints} points (was ${currentPoints} pre-restore)`
      )
      perCollection.push({
        collection,
        status: 'restored',
        decision,
        restoredPoints,
        r2Key,
        sizeBytes,
        snapshotName: r2Key.split('/').pop() || 'snapshot.tar',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[QdrantRestore] ✗ LỖI collection "${collection}": ${msg}`)
      perCollection.push({ collection, status: 'error', decision, reason: msg })
    }
  }

  // Contract cũ: chunks lỗi thật → throw (route trả 500 — operator curl biết ngay).
  const chunksEntry = perCollection.find((e) => e.collection === getChunksCollection())
  if (chunksEntry?.status === 'error') {
    throw new Error(chunksEntry.reason)
  }

  const chunksRestored: QdrantCollectionRestoreResult | undefined =
    chunksEntry?.status === 'restored' ? chunksEntry : undefined
  return {
    restoredPoints: chunksRestored?.restoredPoints ?? 0,
    sizeBytes: chunksRestored?.sizeBytes ?? 0,
    r2Key: chunksRestored?.r2Key ?? '',
    snapshotName: chunksRestored?.snapshotName ?? '',
    force,
    collections: perCollection,
  }
}

// ==================== LIST (for GET endpoint) ====================

export interface QdrantBackupEntry {
  key: string
  name: string
  date: string | null
  sizeBytes: number
  lastModified: string
  /** S1.2 — collection mà key này thuộc về (root key = legacy chunks). */
  collection: string
}

/**
 * List recent Qdrant backups stored in R2 (flat, sort mới nhất trước).
 * Mỗi entry có field `collection` (parse từ key; key root 3-segment = legacy
 * chunks) — GET snapshot-full dùng để group byCollection (blueprint S1.2).
 *
 * @param limit - max results (default 10)
 */
export async function listQdrantBackups(limit: number = 10): Promise<QdrantBackupEntry[]> {
  const list = await listR2Objects(R2_PREFIX, 500)
  if (!list.success) return []

  return list.objects
    .filter((o) => o.key.endsWith('.tar'))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .slice(0, limit)
    .map((o) => {
      const name = o.key.split('/').pop() || o.key
      const parts = o.key.split('/')
      // parts = ['backups','qdrant','<file>'] (root/legacy → chunks) hoặc
      // ['backups','qdrant','<collection>','<file>'] (per-collection)
      const collection = parts.length >= 4 ? parts[2] : getChunksCollection()
      const m = name.match(/(\d{8})-\d{6}\.tar$/)
      return {
        key: o.key,
        name,
        date: m ? m[1] : null,
        sizeBytes: o.size,
        lastModified: o.lastModified.toISOString(),
        collection,
      }
    })
}
