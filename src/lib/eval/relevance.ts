/**
 * P1-M2 · Relevance vector cho ranking metrics (nDCG@5 / MRR) — module thuần
 * toán, KHÔNG side-effect, tách khỏi runner.ts để test được độc lập (runner
 * kéo theo db/llm/judges — không import được trong test thuần).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M2 (mục #2 — ML.pdf
 * §Ranking Metrics). Đo THỨ TỰ trả về của hybrid search (BM25+RRF+MMR) —
 * thứ mà recall@5 (chỉ đếm "có mặt trong top-5") không thấy được.
 *
 * Relevance nhị phân per chunk (spec nguyên văn): "chunk i relevant ⇔ ∃
 * entity chưa khớp nào xuất hiện (substring normalized) trong chunk.text —
 * tái dùng đúng bộ khớp của recall@5 để đảm bảo nhất quán".
 *
 * FIRST-OCCURRENCE: duyệt chunk theo thứ tự xếp hạng, mỗi entity chỉ ghi
 * nhận ở CHUNK ĐẦU TIÊN chứa nó (entity đã khớp không đánh dấu thêm chunk
 * sau) → vector rel không bị phình khi cùng 1 entity xuất hiện ở nhiều chunk,
 * và nDCG đo đúng "entity xuất hiện sớm đến đâu". retrievedCount = số entity
 * tìm thấy trong danh sách chunk — ĐÚNG cùng giá trị với cách đếm recall@5
 * cũ (entity matched ⇔ ∃ chunk chứa nó) → 2 chỉ số không thể lệch nhau.
 */

/** Entity kì vọng của 1 eval case (parse từ EvalCase.expectedEntities JSON). */
export interface ExpectedEntity {
  name: string
  type?: string
}

/**
 * Chuẩn hoá text cho entity matching — curly quotes (U+2018/2019) và dashes
 * từ PDF extraction phá substring match chính xác với expected entity viết
 * bằng straight-quote của LLM (Task 13E — GIỮ NGUYÊN semantics, chuyển từ
 * runner.ts sang module này để dùng chung recall + ranking).
 */
export function normalizeForEntityMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
}

export interface RelevanceResult {
  /** rel[i] = 1 ⇔ chunk thứ i (0-based, theo thứ tự xếp hạng) chứa ít nhất 1
   *  entity kì vọng CHƯA khớp ở chunk trước đó. */
  rel: number[]
  /** Số entity kì vọng được tìm thấy trong danh sách chunk (= tử số của
   *  recall@K — cùng semantics với cách đếm cũ của runner). */
  retrievedCount: number
}

/**
 * Dựng vector relevance nhị phân từ danh sách chunk ĐÃ XẾP HẠNG (giữ nguyên
 * thứ tự truyền vào) + danh sách entity kì vọng. Một vòng duy nhất — không
 * gọi thêm phép match nào ngoài bộ khớp recall (nguyên tắc "dùng chung vòng
 * lặp" của blueprint).
 */
export function buildRelevanceVector(
  expectedEntities: ExpectedEntity[],
  chunks: Array<{ text: string }>,
): RelevanceResult {
  const rel = new Array<number>(chunks.length).fill(0)
  const matched = new Set<number>()
  const normalizedChunks = chunks.map((c) => normalizeForEntityMatch(c.text))

  for (let ci = 0; ci < chunks.length; ci++) {
    let chunkRelevant = false
    for (let ei = 0; ei < expectedEntities.length; ei++) {
      if (matched.has(ei)) continue
      if (normalizedChunks[ci].includes(normalizeForEntityMatch(expectedEntities[ei].name))) {
        matched.add(ei)
        chunkRelevant = true
      }
    }
    rel[ci] = chunkRelevant ? 1 : 0
  }

  return { rel, retrievedCount: matched.size }
}
