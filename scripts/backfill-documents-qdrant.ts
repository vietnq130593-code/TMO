/**
 * BLUEPRINT-BACKUP-GATE S1.3 — BACKFILL 1 LẦN: theopus_documents 9 điểm đã mất.
 *
 * Vì sao: BUG2-304 — backup R2 cũ chỉ snapshot theopus_chunks; sau reset #3,
 * theopus_documents = 0 điểm (D0 §7.1 từng verify 9/9 lúc 13:51 18-10) và
 * SQLite Document = 0 (mất cùng reset) → nguồn tái tạo duy nhất còn là 9 file
 * knowledge/*.TXT trên repo (8 SHD_*.TXT + 1 PSY-CORE-SCI-009.TXT — glob
 * knowledge/*.TXT, KHÔNG phải SHD_* vì glob đó bắt 8/9).
 *
 * Payload metadata-only theo DocumentPayload (src/lib/qdrant.ts) — KHÔNG
 * chunking, KHÔNG LLM/embedding (payload không có trường chunk_count; chunks
 * corpus đã hồi 868/868 bằng restore R2 từ W3-8c).
 *
 * ID: UUID v5-style DETERMINISTIC từ slug (md5/sha1 của tên file + namespace
 * cố định) — blueprint v0.2 viết "doc-shd-<slug>" nhưng Qdrant CHỈ nhận UUID
 * hoặc integer làm point ID (chuỗi tự do → 400 Bad Request — bắt.live khi
 * backfill lần đầu). Deterministic → idempotent; traceability qua payload
 * file_path = knowledge/<file>.
 *
 * Idempotent: id deterministic — chạy nhiều lần chỉ overwrite.
 *
 * Usage (source .env như mọi script chạy nền của repo):
 *   set -a && source .env && set +a && bun scripts/backfill-documents-qdrant.ts
 */
import { upsertDocument } from '../src/lib/qdrant'
import type { DocumentPayload } from '../src/lib/qdrant'
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Slug deterministic từ tên file: SHD_COMPLEXITY_006.TXT → shd-complexity-006 */
function slugify(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.txt$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** UUID v5-style deterministic từ slug (Qdrant chỉ nhận UUID/integer — doc-shd-<slug> thô bị 400). */
function deterministicUuid(slug: string): string {
  const h = createHash('sha1').update(`tmo-doc-shd:${slug}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function main() {
  const knowledgeDir = join(import.meta.dir, '..', 'knowledge')
  const files = readdirSync(knowledgeDir)
    .filter((f) => f.toUpperCase().endsWith('.TXT'))
    .sort()
  console.log(`[S1.3-Backfill] Tìm thấy ${files.length} file knowledge/*.TXT`)

  if (files.length === 0) {
    console.warn('[S1.3-Backfill] KHÔNG có file nào — thoát (kỳ vọng 9: 8 SHD_* + 1 PSY-CORE-SCI-009)')
    process.exit(1)
  }

  const now = new Date().toISOString()
  let ok = 0
  let fail = 0

  for (const file of files) {
    const content = readFileSync(join(knowledgeDir, file), 'utf-8')
    // Synthetic page count cho .txt (D0 quy ước process route: 1 trang ≈ 1800
    // tokens ≈ 7.200 ký tự) — max(1, round(chars/7200)).
    const pageCount = Math.max(1, Math.round(content.length / 7200))

    // Payload spec đầy đủ theo DocumentPayload — status PHẢI nằm trong union 9
    // giá trị ('indexed' = cuối pipeline; sai giá trị = vô hình ở UI Documents,
    // pattern BUG2-291) · domain='ml' theo D0 upload .TXT.
    const payload: DocumentPayload = {
      title: file,
      file_path: `knowledge/${file}`,
      domain: 'ml',
      status: 'indexed',
      page_count: pageCount,
      processing_steps: [],
      processing_percent: 100,
      created_at: now,
      updated_at: now,
    }

    const id = deterministicUuid(slugify(file))
    const success = await upsertDocument(id, payload)
    if (success) {
      ok++
      console.log(`[S1.3-Backfill] ✓ ${file} → id=${id} (page_count=${pageCount})`)
    } else {
      fail++
      console.error(`[S1.3-Backfill] ✗ ${file} — upsertDocument trả false (xem log [Qdrant] phía trên)`)
    }
  }

  // Verify: point count sau backfill (kỳ vọng 9/9).
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const collection = process.env.QDRANT_COLLECTION_DOCUMENTS || 'theopus_documents'
  let pointCount = -1
  try {
    const res = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collection)}`)
    if (res.ok) {
      const body = (await res.json()) as { result?: { points_count?: number } }
      pointCount = body.result?.points_count ?? -1
    }
  } catch {
    // giữ -1 — in cảnh báo thủ công
  }

  console.log(
    `[S1.3-Backfill] HOÀN TẤT: ${ok} ok, ${fail} fail — pointCount "${collection}" = ${pointCount}` +
      (pointCount === files.length ? ' (đúng kỳ vọng)' : ' (KIỂM TRA LẠI — kỳ vọng ' + files.length + ')')
  )
  process.exit(fail === 0 && pointCount === files.length ? 0 : 1)
}

main().catch((err) => {
  console.error('[S1.3-Backfill] LỖI:', err)
  process.exit(1)
})
