/**
 * P5-M2 — CONTENT-HASH + NEAR-DUP DEDUP KHI RE-UPLOAD
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M2, mục #17 — DA.pdf §Duplicate Rows)
 *
 * Hai lớp chống index trùng tài liệu:
 *   1. EXACT-DUP (upload): sha256(bytes) — cùng bytes là trùng tuyệt đối.
 *      Upload route check trước khi lưu gì hết; trùng → 409 + existing info.
 *      (Document.title @unique chỉ chặn trùng TÊN — cùng nội dung đổi tên
 *      vẫn lọt, đây là lớp bắt phần còn lại.)
 *   2. NEAR-DUP (process step ④ — sau chunk, TRƯỚC upsert Qdrant): cùng nội
 *      dung nhưng PDF tái xuất khác byte → hash khác → lọt lớp 1. Embed
 *      NEAR_DUP_PROBE_CHUNKS chunk đầu, searchSimilar top-1; trùng khi MỌI
 *      probe có hit ≥ NEAR_DUP_THRESHOLD VÀ tất cả trỏ về CÙNG một Document
 *      gốc. Chunk trùng không bao giờ chạm index (không ô nhiễm Qdrant).
 *
 * Ngưỡng 0.98 khởi điểm theo spec §P5-M2 — 0.92 đang dùng cho memory-merge là
 * phân phối KHÁC (chunk PDF trùng nguyên văn cho cosine gần 1.0); hiệu chỉnh
 * bằng sweep sau khi có dữ liệu thật.
 *
 * Triết lý lỗi: FAIL-OPEN — embed lỗi / SQLite lỗi / thiếu hit → KHÔNG kết luận
 * trùng, pipeline chạy tiếp ("an toàn theo hướng không chặn nhầm": bỏ sót vài
 * bản trùng ít hại hơn chặn nhầm tài liệu hợp lệ).
 */

import crypto from 'crypto'
import { db } from '@/lib/db'
import { generateEmbeddingBatch, getEmbeddingDimension } from '@/lib/embeddings'
import { searchSimilar } from '@/lib/qdrant'
import type { ChunkPayload } from '@/lib/qdrant'

// ==================== HẰNG SỐ (nguồn: spec §P5-M2) ====================

/** Ngưỡng cosine near-dup — 0.98 khởi điểm (spec: chunk trùng nguyên văn ~1.0) */
export const NEAR_DUP_THRESHOLD = 0.98
/** Số chunk đầu dùng làm probe near-dup (spec: "embed 3 chunk đầu") */
export const NEAR_DUP_PROBE_CHUNKS = 3
/** HTTP status khi MỌI file trong request upload đều trùng hash (không lưu bản mới) */
export const EXACT_DUP_HTTP_STATUS = 409 as const

// ==================== LỚP 1 — EXACT-DUP (sha256) ====================

/** sha256 hex của bytes PDF — dùng cho contentHash + tra cứu exact-dup. */
export function sha256Hex(buffer: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Tra cứu Document có cùng contentHash (SQLite, index @@index([contentHash])).
 * Trả về bản đầu tiên tìm thấy — cho 409 kèm existingDocumentId + tiêu đề.
 * Hash "hết hiệu lực" khi Document gốc bị xóa (tái tải sau khi xóa = hợp lệ).
 */
export async function findExactDuplicate(
  contentHash: string
): Promise<{ id: string; title: string; status: string } | null> {
  if (!contentHash) return null
  try {
    const existing = await db.document.findFirst({
      where: { contentHash },
      select: { id: true, title: true, status: true },
    })
    return existing ?? null
  } catch (err) {
    // FAIL-OPEN: DB lỗi → không chặn upload (route sẽ lưu không có hash-match;
    // hash vẫn được ghi lại để lần sau có dữ liệu)
    console.warn(
      '[DocDedup] findExactDuplicate DB error — fail-open:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * Quyết định HTTP status cho POST upload khi có exact-dup:
 * MỌI file đều trùng (không file mới nào được lưu) → 409; hỗn hợp → 200
 * (per-file thông báo, tiền lệ mảng errors của route).
 */
export function exactDupResponseStatus(duplicatesCount: number, uploadedCount: number): 200 | 409 {
  return duplicatesCount > 0 && uploadedCount === 0 ? EXACT_DUP_HTTP_STATUS : 200
}

// ==================== LỚP 2 — NEAR-DUP (pure decision core) ====================

export interface ProbeHit {
  documentId: string
  score: number
}

export interface NearDupDecision {
  duplicate: boolean
  /** id Document gốc khi duplicate=true */
  duplicateOfId?: string
  /** điểm cosine từng probe (mọi phần tử ≥ NEAR_DUP_THRESHOLD khi duplicate) */
  scores: number[]
  /** lý do quyết định — để log + test đối chiếu spec */
  reason: string
}

/**
 * Lõi quyết định near-dup (THUẦN — không I/O). `probes[i]` = danh sách hit
 * (documentId ≠ doc đang xét, score ≥ ngưỡng) của probe chunk thứ i.
 *
 * Trùng ⟺ probes không rỗng ∧ MỌI probe có ≥1 hit ∧ mọi top-1 hit trỏ về
 * CÙNG một Document. Một probe trống → không trùng (nội dung mới); top-1 của
 * các probe trỏ về ≥2 Document khác nhau → chỉ trùng boilerplate (bìa/mục
 * lục) → không trùng.
 */
export function decideNearDuplicate(documentId: string, probes: Array<Array<ProbeHit>>): NearDupDecision {
  if (probes.length === 0) return { duplicate: false, scores: [], reason: 'no-probe' }

  const scores: number[] = []
  const matchedDocIds = new Set<string>()
  for (const probe of probes) {
    // Phòng thủ chiều sâu: searchSimilar đã lọc score_threshold, nhưng lõi
    // quyết định tự kiểm ngưỡng nữa (đúng "hit ≥ NEAR_DUP_THRESHOLD")
    const eligible = probe.filter(
      h => h.documentId && h.documentId !== documentId && h.score >= NEAR_DUP_THRESHOLD
    )
    if (eligible.length === 0) {
      return { duplicate: false, scores, reason: `probe-no-external-hit (đã khớp ${scores.length} probe đầu tiên)` }
    }
    const top = eligible[0] // searchSimilar đã sắp theo score giảm dần
    scores.push(top.score)
    matchedDocIds.add(top.documentId)
  }

  if (matchedDocIds.size !== 1) {
    return {
      duplicate: false,
      scores,
      reason: `probes-trỏ-${matchedDocIds.size}-doc-khác-nhau (boilerplate?, docs=${[...matchedDocIds].join(',').slice(0, 64)})`,
    }
  }

  const matchedDocId = [...matchedDocIds][0]
  return {
    duplicate: true,
    duplicateOfId: matchedDocId,
    scores,
    reason: `all-${probes.length}-probes-match-${matchedDocId.slice(0, 8)}`,
  }
}

// ==================== LỚP 2 — NEAR-DUP (đường đầy đủ: embed + search) ====================

export interface NearDupMatch {
  duplicateOfId: string
  duplicateOfTitle: string | null
  /** điểm cosine từng probe (đã qua score_threshold — mọi phần tử ≥ 0.98) */
  scores: number[]
}

/**
 * Phát hiện near-dup cho document đang xử lý FRESH: embed N chunk đầu →
 * searchSimilar top-k ≥ NEAR_DUP_THRESHOLD → decideNearDuplicate. Trả null
 * khi KHÔNG trùng HOẶC lỗi (fail-open — caller cứ chạy pipeline tiếp).
 *
 * Giải chuỗi 1 mức: doc bị khớp nếu chính nó là duplicate của doc khác thì
 * trỏ về gốc đó (A trùng B, B trùng C → A.duplicateOf = C).
 */
export async function detectNearDuplicate(
  documentId: string,
  chunks: Array<{ content: string }>
): Promise<NearDupMatch | null> {
  const probeCount = Math.min(NEAR_DUP_PROBE_CHUNKS, chunks.length)
  if (probeCount === 0) return null

  let embeddings: Array<{ vector: number[] } | null> = []
  try {
    embeddings = await generateEmbeddingBatch(chunks.slice(0, probeCount).map(c => c.content))
  } catch (err) {
    // FAIL-OPEN: embed lỗi → không kết luận trùng, pipeline chạy tiếp
    console.warn(
      `[DocDedup] Near-dup probe embed error doc ${documentId.slice(0, 8)}... — fail-open:`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }

  const dim = getEmbeddingDimension()
  const probeVectors: number[][] = []
  for (let i = 0; i < probeCount; i++) {
    const v = embeddings[i]?.vector
    // vector toàn 0 = placeholder/lỗi provider — không dùng làm probe
    if (v && v.length === dim && v.some(x => x !== 0)) probeVectors.push(v)
  }
  if (probeVectors.length === 0) return null

  const probeHits: Array<Array<ProbeHit>> = []
  for (const vector of probeVectors) {
    const hits = await searchSimilar(vector, { limit: 5, minScore: NEAR_DUP_THRESHOLD })
    probeHits.push(
      hits.map(h => ({
        documentId: String((h.payload as ChunkPayload | undefined)?.document_id ?? ''),
        score: h.score,
      }))
    )
  }

  const decision = decideNearDuplicate(documentId, probeHits)
  if (!decision.duplicate || !decision.duplicateOfId) return null
  const matchedDocId = decision.duplicateOfId

  let duplicateOfId = matchedDocId
  let duplicateOfTitle: string | null = null
  try {
    const matched = await db.document.findUnique({
      where: { id: matchedDocId },
      select: { id: true, title: true, duplicateOfId: true },
    })
    if (matched) {
      if (matched.duplicateOfId) duplicateOfId = matched.duplicateOfId
      duplicateOfTitle = matched.title
    }
  } catch {
    // SQLite lỗi — giữ matchedDocId, title null (fail-open về metadata, vẫn chặn)
  }

  return { duplicateOfId, duplicateOfTitle, scores: decision.scores }
}
