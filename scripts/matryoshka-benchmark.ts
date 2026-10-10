/**
 * P5-M1 · MATRYOSHKA 512 BENCHMARK — BẢNG RECALL ĐỐI CHỨNG
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M1, mục #14)
 *
 * Chạy: bun scripts/matryoshka-benchmark.ts [--collection agent_memory|theopus_chunks]
 *        [--queries 100] [--k 10] [--out docs/REPORT-P5-M1-MATRYOSHKA.md]
 *
 * Đo (spec §P5-M1): recall@k — phần trăm top-k hàng xóm TRÙNG nhau giữa bản
 * 2048 đầy đủ và bản 512 rút gọn (truncateMatryoshka) trên cùng bộ vector
 * THẬT đang lưu trong Qdrant (query = chính các point trong collection —
 * deterministic, không gọi embed API) + nDCG@10 (đối chiếu xếp hạng 2048 làm
 * ground-truth — dùng ndcgAtK của stats P0-1, cùng chuẩn P1-M2).
 *
 * NGƯỠNG QUYẾT ĐỔI ĐƯỜNG ĐỌC (điểm dừng #4 blueprint — KHÔNG tự ý đổi):
 * recall@10 drop < 2% so với 2048 (tức recall@10(512) ≥ 0.98·recall@10(2048))
 * mới ĐỀ XUẤT user duyệt chuyển đường đọc agent_memory sang 512.
 *
 * Toàn bộ phép tính cosine trong bộ nhớ — KHÔNG đụng Qdrant collection pilot
 * (bảng đối chứng độc lập với pilot infra; pilot dual-write là đường đo dài
 * hạn sau ≥2 tuần dữ liệu).
 */

import { qdrant, isQdrantScrollExhausted } from '../src/lib/qdrant'
import { truncateMatryoshka, MATRYOSHKA_PILOT_DIMS } from '../src/lib/embeddings'
import { ndcgAtK } from '../src/lib/stats/ranking'

interface Args {
  collection: string
  queries: number
  k: number
  out: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
  }
  return {
    collection: get('collection', 'agent_memory'),
    queries: parseInt(get('queries', '100'), 10),
    k: parseInt(get('k', '10'), 10),
    out: get('out', 'docs/REPORT-P5-M1-MATRYOSHKA.md'),
  }
}

/** Scroll TOÀN BỘ point kèm vector từ collection (phân trang 100, dedup theo id). */
async function scrollAllVectors(collection: string): Promise<Array<{ id: string; vector: number[] }>> {
  const points: Array<{ id: string; vector: number[] }> = []
  const seenIds = new Set<string>()
  let offset: string | number | null | undefined = undefined
  for (let page = 0; page < 200; page++) {
    const body: Record<string, unknown> = { limit: 100, with_vector: true, with_payload: false }
    if (offset !== undefined && offset !== null) body.offset = offset
    // Client @qdrant trả { points, next_page_offset } ở mức GỐC (không bọc .result
    // như REST thô) — dùng đúng shape client
    const res = await qdrant.scroll(collection, body as never) as unknown as {
      points?: Array<{ id: string | number; vector?: number[] | number[][] }>
      next_page_offset?: string | number | null
    }
    const pts = res.points ?? []
    if (pts.length === 0) break
    for (const p of pts) {
      const id = String(p.id)
      if (seenIds.has(id)) continue
      seenIds.add(id)
      // Bỏ vector zero/placeholder (chunk chưa embed) — không phải dữ liệu thật.
      // with_vector trả mảng số (unnamed vector) — loại dạng mảng-nested.
      const v = Array.isArray(p.vector) && typeof p.vector[0] === 'number' ? (p.vector as number[]) : []
      if (v.length >= 512 && v.some(x => Math.abs(x) > 1e-9)) {
        points.push({ id, vector: v })
      }
    }
    // Qdrant trả next_page_offset: null khi hết — PHẢI dừng (phát hiện đợt 7:
    // bản đầu chỉ kiểm undefined → cuộn lại trang đầu 50 lần, nhân đôi dữ liệu).
    // FB-Đợt7-R4 (BUG2-068/C5): điều kiện dừng rút về helper chung của lib —
    // được pin regression test ở tests/r78-fb7-regression.test.ts.
    const next = res.next_page_offset
    if (isQdrantScrollExhausted(next)) break
    offset = next
    if (points.length >= 5000) break // cap phòng thủ
  }
  return points
}

/** Cosine similarity — bất biến scale nên KHÔNG cần normalize trước. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** Top-k index hàng xóm (loại chính nó) theo cosine — trả index giảm dần theo score. */
function topKNeighbors(query: number[], all: number[][], selfIdx: number, k: number): number[] {
  const scored: Array<{ idx: number; score: number }> = []
  for (let i = 0; i < all.length; i++) {
    if (i === selfIdx) continue
    scored.push({ idx: i, score: cosine(query, all[i]) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(s => s.idx)
}

async function main() {
  const args = parseArgs()
  console.log(`[P5-M1 benchmark] collection=${args.collection} queries≤${args.queries} k=${args.k}`)

  const points = await scrollAllVectors(args.collection)
  if (points.length < 10) {
    console.error(`[P5-M1 benchmark] Cần ≥10 point có vector thật — hiện ${points.length}. Thêm dữ liệu rồi chạy lại.`)
    process.exit(1)
  }
  const dim = points[0].vector.length
  console.log(`[P5-M1 benchmark] ${points.length} vector ${dim}-dim thật`)

  // Bản 512: truncate từng vector MỘT LẦN (query + corpus đều dùng bản cắt —
  // đúng kịch bản "đường đọc 512" nếu được duyệt)
  const full = points.map(p => p.vector)
  const trunc = full.map(v => truncateMatryoshka(v, MATRYOSHKA_PILOT_DIMS))
  console.log(`[P5-M1 benchmark] truncated → ${trunc[0].length}-dim (MRL giữ ${MATRYOSHKA_PILOT_DIMS} phần tử đầu)`)

  // Chọn query DETERMINISTIC: bước nhảy đều coverage toàn collection
  const step = Math.max(1, Math.floor(points.length / args.queries))
  const queryIdxs: number[] = []
  for (let i = 0; i < points.length && queryIdxs.length < args.queries; i += step) queryIdxs.push(i)

  let recallAt5Sum = 0, recallAt10Sum = 0, ndcgSum = 0
  let pairwiseCosDropSum = 0, pairwiseCount = 0
  const rows: Array<{ q: number; r5: number; r10: number; ndcg: number }> = []

  for (const qi of queryIdxs) {
    const topFull = topKNeighbors(full[qi], full, qi, args.k)
    const topTrunc = topKNeighbors(trunc[qi], trunc, qi, args.k)

    const setFull5 = new Set(topFull.slice(0, 5))
    const setFull10 = new Set(topFull)
    const setTrunc5 = new Set(topTrunc.slice(0, 5))
    const setTrunc10 = new Set(topTrunc)

    let hit5 = 0, hit10 = 0
    for (const idx of setTrunc5) if (setFull5.has(idx)) hit5++
    for (const idx of setTrunc10) if (setFull10.has(idx)) hit10++
    const r5 = setFull5.size > 0 ? hit5 / setFull5.size : 1
    const r10 = setFull10.size > 0 ? hit10 / setFull10.size : 1

    // nDCG@10: relevance = vị trí trong xếp hạng 2048 (đứng đầu 2048 mà 512
    // xếp thấp → giảm gain — đúng chuẩn P1-M2 thứ bậc)
    const rankInFull = new Map<number, number>()
    topFull.forEach((idx, rank) => rankInFull.set(idx, topFull.length - rank)) // đầu = relevance cao nhất
    const relevance = topTrunc.map(idx => rankInFull.get(idx) ?? 0)
    const ndcg = ndcgAtK(relevance, args.k)

    recallAt5Sum += r5
    recallAt10Sum += r10
    ndcgSum += ndcg
    rows.push({ q: qi, r5, r10, ndcg })

    // Độ lệch cosine từng cặp query-top1 (chẩn đoán phân phối — không phải ngưỡng)
    if (topFull.length > 0 && topTrunc.length > 0) {
      const cFull = cosine(full[qi], full[topFull[0]])
      const cTrunc = cosine(trunc[qi], trunc[topTrunc[0]])
      pairwiseCosDropSum += (cFull - cTrunc)
      pairwiseCount++
    }
  }

  const n = queryIdxs.length
  const mean = (s: number) => (s / n).toFixed(4)
  const recall5 = recallAt5Sum / n
  const recall10 = recallAt10Sum / n
  const ndcgMean = ndcgSum / n
  const cosDropMean = pairwiseCount > 0 ? pairwiseCosDropSum / pairwiseCount : 0
  // Spec: chỉ ĐỀ XUẤT chuyển đọc khi recall drop < 2% (recall10 ≥ 0.98 —
  // chuẩn của chính bảng này; quyết định vẫn thuộc user — điểm dừng #4)
  const readSwitchEligible = recall10 >= 0.98

  console.log('\n===== BẢNG RECALL ĐỐI CHỨNG (P5-M1) =====')
  console.log(`collection         : ${args.collection}`)
  console.log(`points (vector thật): ${points.length} × ${dim}-dim`)
  console.log(`queries (deterministic): ${n} · k = ${args.k}`)
  console.log(`recall@5  (512 vs 2048): ${mean(recallAt5Sum)}  (overlap top-5)`)
  console.log(`recall@10 (512 vs 2048): ${mean(recallAt10Sum)}  (overlap top-10)`)
  console.log(`nDCG@10   (2048 làm ground-truth xếp hạng): ${ndcgMean.toFixed(4)}`)
  console.log(`cosine drop trung bình (query↔top1): ${cosDropMean >= 0 ? '+' : ''}${cosDropMean.toFixed(4)}`)
  console.log(`ĐỀ XUẤT CHUYỂN ĐỌC (recall drop <2%): ${readSwitchEligible ? 'ĐỦ ĐIỀU KIỆN — nộp user duyệt (điểm dừng #4)' : 'CHƯA — giữ đường đọc 2048'}`)

  // Bảng markdown nộp
  const report = `# BÁO CÁO P5-M1 · MATRYOSHKA 512-DIM — BẢNG RECALL ĐỐI CHỨNG

> Sinh bởi \`bun scripts/matryoshka-benchmark.ts\` — ${new Date().toISOString().slice(0, 19)}Z
> (BLUEPRINT-STATS-LEARNING §P5-M1, mục #14 — MATH.pdf §PCA/§SVD/§Eigenvalues)

## Phương pháp

- Dữ liệu: ${points.length} vector ${dim}-dim THẬT từ collection \`${args.collection}\` (scroll toàn bộ, bỏ zero-vector).
- Bản 512: \`truncateMatryoshka\` giữ đúng 512 phần tử đầu (MRL) — KHÔNG renormalize (cosine bất biến scale).
- Query: ${n} point chọn đều bước (deterministic — chạy lại cho cùng kết quả); hàng xóm tính cosine trong bộ nhớ.
- recall@k = |top-k(512) ∩ top-k(2048)| / k; nDCG@10 dùng xếp hạng 2048 làm ground-truth (\`ndcgAtK\` — cùng chuẩn P1-M2).

## Kết quả

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| recall@5 | **${mean(recallAt5Sum)}** | trùng top-5 |
| recall@10 | **${mean(recallAt10Sum)}** | trùng top-10 |
| nDCG@10 | **${ndcgMean.toFixed(4)}** | giữ thứ bậc 2048 |
| cosine drop (query↔top1) | ${cosDropMean >= 0 ? '+' : ''}${cosDropMean.toFixed(4)} | chẩn đoán phân phối |

## Kết luận

- Ngưỡng đề xuất chuyển đường đọc (điểm dừng #4 blueprint): recall@10 drop < 2% → cần ≥ 0.980.
- Kết quả hiện tại: **${recall10.toFixed(4)} → ${readSwitchEligible ? 'ĐỦ điều kiện đề xuất user duyệt chuyển đọc agent_memory sang 512' : 'CHƯA đạt — đường đọc giữ nguyên 2048'}**.
- Pilot dual-write (\`MATRYOSHKA_PILOT=on\`) tiếp tục tích lũy dữ liệu sống để đối chứng dài hạn (≥2 tuần) — bảng này đo trên dữ liệu hiện có.
`

  await Bun.write(args.out, report)
  console.log(`\n[P5-M1 benchmark] Đã ghi báo cáo → ${args.out}`)
}

main().catch(err => {
  console.error('[P5-M1 benchmark] FAILED:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
