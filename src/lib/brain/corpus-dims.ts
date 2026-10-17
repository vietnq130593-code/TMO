/**
 * R31 (user chốt "thêm vài chiều tổng quan corpus" 2026-10-18) — CORPUS DIMS
 * ============================================================================
 *
 * Single-source (doctrine #9) cho 6 CHIỀU TỔNG QUAN CORPUS — phần MỞ RỘNG
 * của nhóm cfg "trạng thái KB" trong input Brain-D "Tri Thức"
 * (BLUEPRINT-EVO-NAO §8.3/§8.5.2 — kb-features: emb 2048 + cfg ~36).
 *
 * Brain-D KHÔNG nạp NỘI DUNG KB vào nơ-ron input (R30 — nó là policy head
 * quyết định CÁCH dùng KB; nội dung truy xuất đi vào AGENT context, không
 * quay lại nơ-ron). 6 chiều này là TÍN HIỆU ĐẦU ĐU (đếm → log-scale) cho
 * policy biết corpus đang GIÀU/NGHÈO thế nào để chọn nguồn + chế độ vận dụng
 * hợp lý — bằng chứng giá trị: D2 baseline R31 thấy chunks trống 14/17 +
 * memories nghèo → policy cần "biết" trước khi bật nguồn.
 *
 * Thuần kiểu + hằng số + toán — KHÔNG import db/qdrant/neo4j (an toàn client
 * bundle + bun:test, cùng chuẩn spec-schema.ts/search-space.ts). Fetcher đếm
 * thật (cache 60s) sống ở corpus-overview.ts — CHỈ server import.
 */

/** Kết quả đếm 6 nhóm corpus — mỗi nguồn fail-open độc lập (null = lỗi đếm). */
export interface KnowledgeCorpusOverview {
  /** Tổng node đồ thị Neo4j (lõi KB — blueprint §9) */
  graphNodes: number | null
  /** Node :Lesson — bài học rút ra (đầu ra writeback tầng 3 §8.3) */
  lessons: number | null
  /** Node :Episode — sự kiện run (nguồn episodic) */
  episodes: number | null
  /** Qdrant theopus_chunks — chunk tài liệu (nguồn truy xuất 1) */
  chunks: number | null
  /** Qdrant theopus_communities — cụm Leiden (nguồn truy xuất 2) */
  communities: number | null
  /** Qdrant agent_memory — trí nhớ episodic agent 2048-dim (nguồn 3) */
  memories: number | null
  /** Thời điểm đo (ISO) — client hiển thị độ tươi của số liệu */
  fetchedAt: string
}

/**
 * Metadata 6 chiều — thứ tự CỐ ĐỊNH (D3 input builder + UI dùng chung đúng
 * thứ tự này; label tiếng Việt ngắn cho grid UI, source mô tả tooltip).
 */
export const CORPUS_DIMS = [
  { key: 'graphNodes', label: 'Node đồ thị', source: 'Neo4j · lõi tri thức (§9)' },
  { key: 'lessons', label: 'Bài học', source: 'Neo4j :Lesson — writeback tầng 3 (§8.3)' },
  { key: 'episodes', label: 'Episode', source: 'Neo4j :Episode — sự kiện run' },
  { key: 'chunks', label: 'Chunk', source: 'Qdrant theopus_chunks — chunk tài liệu' },
  { key: 'communities', label: 'Cụm', source: 'Qdrant theopus_communities — cụm Leiden' },
  { key: 'memories', label: 'Bộ nhớ', source: 'Qdrant agent_memory — trí nhớ episodic 2048' },
] as const

export type CorpusDimKey = (typeof CORPUS_DIMS)[number]['key']

/**
 * Log-scale 1 chiều cho input D3: log₁₀(1+v) — nén dải 0..~100K về ~0..5,
 * giữ đơn điệu (corpus giàu hơn → giá trị lớn hơn). Âm/NaN/∞ → 0 (hàm tổng,
 * không văng — cùng chuẩn clamp01 search-space.ts).
 *
 * Bước normalisation cuối về [0,1] (chia trần log₁₀(1+CAP)) chốt tại D3
 * feature builder khi có dữ liệu thật — hàm này là CÔNG THỨC LOG CHUNG để
 * mọi caller (D3 builder / hiển thị) dùng đúng một định nghĩa (doctrine #9).
 */
export function corpusDimScaled(v: number): number {
  return Math.log10(1 + (Number.isFinite(v) && v > 0 ? v : 0))
}
