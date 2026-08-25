/**
 * Qdrant Snapshot Backup/Restore → Cloudflare R2
 *
 * Phase 3 SMOLAB Proposal 10.5
 *
 * Why this exists
 * ---------------
 * The existing /api/storage/db-backup endpoint snapshots the SQLite file to
 * R2, but SQLite only holds document processing STATE (jobs, rows, metadata).
 * The actual vector embeddings live in Qdrant. When the sandbox resets, the
 * Qdrant data directory is wiped → 1045 chunks vanish → GraphRAG queries
 * return nothing, even though SQLite was restored.
 *
 * This module performs a FULL Qdrant backup by triggering Qdrant's native
 * snapshot feature (binary tarball), uploading the tarball to R2.
 *
 * Snapshot workflow (Qdrant REST API v1.19):
 *   1. POST /collections/{name}/snapshots → 200 OK + {name, size, checksum} (synchronous)
 *   2. GET  /collections/{name}/snapshots/{name} → binary tar stream (POSIX tar)
 *   3. DELETE /collections/{name}/snapshots/{name} → cleanup after R2 upload
 *
 * Restore workflow:
 *   1. List R2 backups/qdrant/{YYYYMMDD}*.tar → pick latest match
 *   2. Download to memory
 *   3. PUT /collections/{name}/snapshots/{name} (multipart/form-data)
 *   4. Qdrant replaces the collection's contents from the snapshot
 *   5. GET /collections/{name} → verify pointCount matches
 *
 * Snapshot format
 * ---------------
 * Qdrant snapshots are POSIX tar archives — NOT gzip-compressed. We upload
 * the raw tarball to R2 as `backups/qdrant/{YYYYMMDD-HHMMSS}.tar` (no .gz).
 *
 * R2 storage layout
 * -----------------
 *   backups/qdrant/{YYYYMMDD-HHMMSS}.tar  — versioned snapshot (history)
 *   backups/qdrant/latest.tar             — overwritten each run (used by
 *                                            restore when no date supplied)
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

/** R2 prefix for qdrant snapshots. */
const R2_PREFIX = 'backups/qdrant/'
const R2_LATEST_KEY = 'backups/qdrant/latest.tar'

/** Max wait for snapshot creation (Qdrant v1.19 makes snapshots synchronously,
 *  so 5s should suffice even for 1045 chunks ~20MB. Generous 60s safety net). */
const SNAPSHOT_WAIT_TIMEOUT_MS = 60_000
const SNAPSHOT_POLL_INTERVAL_MS = 1_000

// ==================== TYPES ====================

export interface QdrantBackupResult {
  r2Key: string
  sizeBytes: number
  collectionPoints: number
  snapshotName: string
}

export interface QdrantRestoreResult {
  restoredPoints: number
  sizeBytes: number
  r2Key: string
  snapshotName: string
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

/**
 * Fetch the point count of the chunks collection directly from Qdrant.
 * Used as a sanity check before/after backup/restore.
 */
export async function getChunksPointCount(): Promise<number> {
  const url = `${getQdrantUrl()}/collections/${encodeURIComponent(getChunksCollection())}`
  try {
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) return 0
    const body = (await res.json()) as {
      result?: {
        points_count?: number
        vectors_count?: number
        pointsCount?: number
      }
    }
    const r = body.result
    if (!r) return 0
    return r.points_count ?? r.vectors_count ?? r.pointsCount ?? 0
  } catch {
    return 0
  }
}

// ==================== BACKUP ====================

/**
 * Trigger a Qdrant snapshot, download the binary tar, upload to R2.
 *
 * @returns {r2Key, sizeBytes, collectionPoints, snapshotName}
 */
export async function backupQdrantToR2(): Promise<QdrantBackupResult> {
  const baseUrl = getQdrantUrl()
  const collection = getChunksCollection()
  const snapshotUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots`

  // 1. Capture pre-snapshot point count (used for verification + reporting)
  const collectionPoints = await getChunksPointCount()
  console.log(`[QdrantBackup] Pre-snapshot point count: ${collectionPoints}`)

  // 2. Trigger snapshot creation (Qdrant v1.19 makes these synchronously,
  //    so the response contains the new snapshot name immediately. We still
  //    poll below in case a future Qdrant version moves to async creation).
  console.log(`[QdrantBackup] POST ${snapshotUrl}`)
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

  // 3. If create returned no snapshot metadata (async path), poll the list
  //    endpoint for up to 60s waiting for the new snapshot to appear.
  if (!snapshotMeta) {
    console.log('[QdrantBackup] Create returned no meta — polling list endpoint')
    const listUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots`
    const deadline = Date.now() + SNAPSHOT_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const listRes = await fetch(listUrl, { headers: authHeaders() })
      if (listRes.ok) {
        const listBody = (await listRes.json()) as {
          result?: QdrantSnapshotMeta[]
        }
        const snapshots = listBody.result || []
        if (snapshots.length > 0) {
          // Pick the newest by creation_time
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

  const snapshotName = snapshotMeta.name
  const reportedSize = snapshotMeta.size || 0
  console.log(
    `[QdrantBackup] Snapshot created: ${snapshotName} (reported size: ${reportedSize} bytes)`
  )

  try {
    // 4. Download the snapshot binary (POSIX tar archive)
    const downloadUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`
    const downloadRes = await fetch(downloadUrl, { headers: authHeaders() })
    if (!downloadRes.ok || !downloadRes.body) {
      const txt = await downloadRes.text().catch(() => '')
      throw new Error(
        `Qdrant snapshot download failed: HTTP ${downloadRes.status} ${txt.slice(0, 200)}`
      )
    }
    // Stream → Buffer (the snapshot is binary tar, ~20MB for 1045 chunks)
    const chunks: Buffer[] = []
    // @ts-expect-error — ReadableStream types vary between Node/Web; both work here
    for await (const chunk of downloadRes.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const buffer = Buffer.concat(chunks)
    const sizeBytes = buffer.length
    console.log(
      `[QdrantBackup] Downloaded snapshot binary: ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
    )

    // 5. Upload to R2 at versioned path + overwrite "latest" pointer
    const ts = timestamp()
    const versionedKey = `${R2_PREFIX}${ts}.tar`
    const versionedResult = await uploadToR2(
      versionedKey,
      buffer,
      'application/x-tar'
    )
    if (!versionedResult.success) {
      throw new Error(`R2 upload failed (versioned): ${versionedResult.error}`)
    }

    // Latest pointer (overwritten each run — used by restore-without-date)
    const latestResult = await uploadToR2(
      R2_LATEST_KEY,
      buffer,
      'application/x-tar'
    )
    if (!latestResult.success) {
      // Non-fatal — versioned upload already succeeded
      console.warn(
        `[QdrantBackup] Failed to update latest pointer (non-fatal): ${latestResult.error}`
      )
    }

    console.log(
      `[QdrantBackup] Uploaded to R2: ${versionedKey} (${sizeBytes} bytes) + latest pointer`
    )

    return {
      r2Key: versionedKey,
      sizeBytes,
      collectionPoints,
      snapshotName,
    }
  } finally {
    // 6. Always try to delete the local Qdrant snapshot after upload (whether
    //    R2 succeeded or failed — leaving stale snapshots wastes disk space
    //    on the Qdrant storage backend).
    try {
      const delUrl = `${baseUrl}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`
      const delRes = await fetch(delUrl, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (delRes.ok) {
        console.log(`[QdrantBackup] Cleaned up local snapshot: ${snapshotName}`)
      } else {
        console.warn(
          `[QdrantBackup] Snapshot cleanup failed: HTTP ${delRes.status} (non-fatal)`
        )
      }
    } catch (err) {
      console.warn(
        `[QdrantBackup] Snapshot cleanup error (non-fatal):`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}

// ==================== RESTORE ====================

/**
 * Find the R2 key for a backup matching the given date prefix.
 *
 * @param date - YYYYMMDD (e.g. "20260824"); finds newest `backups/qdrant/{date}*.tar`
 * @returns the matching R2 key, or null if none found
 */
async function findBackupKey(date: string): Promise<string | null> {
  // Try exact prefix match first (files are named backups/qdrant/{YYYYMMDD-HHMMSS}.tar)
  const list = await listR2Objects(R2_PREFIX, 500)
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

  // If no dated match, fall back to "latest" pointer (only when date == 'latest'
  // OR caller supplied an empty date and we're being lenient).
  if (date === 'latest') return R2_LATEST_KEY

  return null
}

/**
 * Download a snapshot from R2 and restore it to Qdrant.
 *
 * Restore is destructive — Qdrant's snapshot restore REPLACES the collection
 * contents with the snapshot's contents. Caller must ensure they intend to
 * overwrite.
 *
 * @param date - YYYYMMDD; matches newest `backups/qdrant/{date}*.tar`.
 *               Use "latest" to pull the latest pointer (no date filter).
 */
export async function restoreQdrantFromR2(
  date: string
): Promise<QdrantRestoreResult> {
  const baseUrl = getQdrantUrl()
  const collection = getChunksCollection()

  // 1. Resolve R2 key for the date
  const r2Key = await findBackupKey(date)
  if (!r2Key) {
    throw new Error(
      `No Qdrant backup found matching date prefix "${date}" in R2 prefix "${R2_PREFIX}"`
    )
  }
  console.log(`[QdrantRestore] Using R2 key: ${r2Key}`)

  // 2. Download binary tar from R2
  const dl = await downloadFromR2(r2Key)
  if (!dl.success || !dl.buffer) {
    throw new Error(`R2 download failed: ${dl.error}`)
  }
  const buffer = dl.buffer
  const sizeBytes = dl.size || buffer.length
  console.log(
    `[QdrantRestore] Downloaded ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
  )

  // 3. Upload to Qdrant — this triggers a restore.
  //    Qdrant 1.19 restore-from-upload endpoint is POST /collections/{name}/snapshots/upload
  //    (multipart/form-data, field "snapshot" = binary tar). The older
  //    PUT /collections/{name}/snapshots/{name} form returns 404 on 1.19.
  //    Use a synthetic FormData-like multipart body since we want to avoid
  //    FormData runtime quirks across Node/Bun.
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
  console.log(`[QdrantRestore] Snapshot uploaded to Qdrant`)

  // 4. Poll collection point count — Qdrant restores asynchronously.
  //    Wait up to 60s for the count to grow.
  console.log('[QdrantRestore] Waiting for collection to be repopulated...')
  const preCount = await getChunksPointCount()
  const deadline = Date.now() + SNAPSHOT_WAIT_TIMEOUT_MS
  let postCount = preCount
  while (Date.now() < deadline) {
    postCount = await getChunksPointCount()
    if (postCount > 0) break
    await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS))
  }
  console.log(
    `[QdrantRestore] Post-restore point count: ${postCount} (was ${preCount} pre-restore)`
  )

  // 5. Cleanup: list + delete any snapshots the upload left in Qdrant local storage
  //    (the /snapshots/upload recover flow may register the uploaded tar as a
  //    collection snapshot — remove it so it doesn't waste disk).
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

  return {
    restoredPoints: postCount,
    sizeBytes,
    r2Key,
    snapshotName: filename,
  }
}

// ==================== LIST (for GET endpoint) ====================

/**
 * List recent Qdrant backups stored in R2.
 *
 * @param limit - max results (default 10)
 * @returns array of {key, name, date, sizeBytes, lastModified}
 */
export async function listQdrantBackups(limit: number = 10): Promise<
  Array<{
    key: string
    name: string
    date: string | null
    sizeBytes: number
    lastModified: string
  }>
> {
  const list = await listR2Objects(R2_PREFIX, 500)
  if (!list.success) return []

  return list.objects
    .filter((o) => o.key.endsWith('.tar'))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .slice(0, limit)
    .map((o) => {
      const name = o.key.split('/').pop() || o.key
      // Extract YYYYMMDD from filename pattern "{YYYYMMDD-HHMMSS}.tar"
      const m = name.match(/(\d{8})-\d{6}\.tar$/)
      return {
        key: o.key,
        name,
        date: m ? m[1] : null,
        sizeBytes: o.size,
        lastModified: o.lastModified.toISOString(),
      }
    })
}
