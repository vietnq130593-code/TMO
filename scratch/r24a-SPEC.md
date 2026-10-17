# SPEC R24-a — TRIỂN KHAI PHASE D0 (đo khối lượng 9 shard + ingestion thử Neo4j)

Task ID: R24-a. Repo /home/z/tmo-app ("The Magnum Opus" — Next.js 16 App Router + TS + Prisma SQLite + Qdrant + Neo4j AuraDB). App chạy pm2 (`theopusflashlite`, `next dev` port 3000, HOT-RELOAD — KHÔNG BAO GIỜ restart pm2 / build / đổi port). Qdrant 6333 online. `.env` có credentials thật (Neo4j Aura neo4j+s://6e688b02.databases.neo4j.io user/db 6e688b02; NIM 4 keys — extraction model `nvidia/nemotron-3-ultra-550b-a55b`, embed `nvidia/nemotron-3-embed-1b`; R2). KHÔNG in secrets.

## BỐI CẢNH (đọc trước khi làm)
1. Đọc 40 dòng cuối /home/z/my-project/worklog.md (mục R23).
2. Đọc /home/z/tmo-app/docs/BLUEPRINT-EVO-NAO-P1-P5.md: §0.2 hàng D0, §9 (toàn bộ + đoạn D0 cuối §9), §10 Q5 + Q9.

Nhiệm vụ D0 (user duyệt Q9=CÓ; Q5 đề xuất): (1) đo khối lượng 9 shard `knowledge/*.TXT`; (2) ingestion THỬ 1 shard nhỏ nhất vào Neo4j Aura để ước node tăng TRƯỚC khi quyết ingest nốt 8 shard; (3) report docs. Shard thử = SHD_NAS_EVOLUTION_002.TXT (nhỏ nhất 146KB + ưu tiên cao nhất §9).

## BƯỚC 1 — ĐỌC CODE HIỆN TRẠNG (chưa sửa)
- knowledge/KNOWLEDGE-PARTITION.md (cấu trúc shard: 5 layers, NODE_ID prefix, block format).
- src/app/api/ingestion/upload/route.ts (validation PDF-only ≤50MB, sha256 dup gate 409, lưu UPLOAD_DIR + backup R2 `pdfs/`, Document row + Qdrant theopus_documents point).
- src/app/api/ingestion/process/route.ts (6114 dòng — đọc: POST handler; runIngestionPipeline 7 bước trọng số 5/10/5/50/10/10/10; HÀM LOCAL extractPDFText/parsePDF/chunkText — route có BẢN SAO LOCAL, KHÔNG import từ lib; buildSystemPrompt(domain) ~dòng 940-989; KPI gates src/lib/ingestion/pipeline-expectations.ts: chunks_per_page ∈ [0.3,8], entity_rate ∈ [0.2,6]/chunk, relationship_per_entity ∈ [0.2,4]).
- src/lib/ingestion/entity-resolver.ts (resolveEntities: exact → Naive Bayes (≥100 resolved pairs — sandbox DB mới rơi về fuzzy) → fuzzy Levenshtein >0.85; globalEntityId(name,type) = `global__<slug(name)>__<slug(type)>`).
- src/lib/neo4j.ts (ENTITY_LABELS 8 labels dòng 37; upsertEntitiesBatch MERGE theo id 500/batch; getGraphStats; executeCypher/readCypher).
- src/lib/llm.ts callLLMSlot (slot -1 xoay vòng key, purpose 'extraction', maxTokens 16384, temperature 0.1).

## BƯỚC 2 — CODE CHANGE: HỖ TRỢ .TXT (additive, tối thiểu, PDF path NGUYÊN VẸN)
1. upload/route.ts: chấp nhận thêm `.txt` (ext case-insensitive + mime text/plain hoặc application/octet-stream), giữ mọi check còn lại (≤50MB, sha256 dup, R2 backup tiền tố `pdfs/`, Document row).
2. process/route.ts bước parse: nhánh .txt → đọc text trực tiếp (fs.readFile utf8) thay extractPDFText; chunkText local dùng tiếp (thuần text). XỬ LÝ KPI PAGE-BASED: txt không có trang → pageCount ảo hợp lý (vd max(1, round(estimatedTokens/1800))) để gate chunks_per_page ∈ [0.3,8] không tự FAIL doc ~60 chunks — ĐỌC code áp gate rồi chọn cách tối thiểu an toàn, comment giải thích. Domain shard 002 = 'ml'.
3. Thêm `export` cho hàm `buildSystemPrompt` trong process route (1-word diff) — scratch script tái dùng prompt thật (KHÔNG copy prompt).
4. Diff additive — đường .pdf hành xử y hệt trước.

## BƯỚC 3 — SCRIPT ĐO: scratch/r24-d0-measure.ts (chạy: cd /home/z/tmo-app && bun scratch/r24-d0-measure.ts; tự load .env — precedent scratch/r22-room-verify.ts)
Với mỗi shard trong 9 file .TXT (SHD_GEN_CAUSAL_HYPER_001, SHD_NAS_EVOLUTION_002, SHD_OPT_CONVEX_003, SHD_SYS_DYNAMICS_004, SHD_CORE_GRAPH_005, SHD_COMPLEXITY_006, SHD_DSL_007, SHD_GTH_008, PSY-CORE-SCI-009):
- bytes, dòng, số block (theo NODE_ID/block markers trong KNOWLEDGE-PARTITION.md), ước tokens (estimateTokenCount từ src/lib/ingestion/pdf-parser.ts nếu import được, không thì chars/4).
- Chunk thật: chunkText bản lib (pdf-parser.ts) domain 'ml' → số chunks/shard (ghi chú khác biệt nhỏ với bản route-local).
- EXTRACTION MẪU (LLM thật): mỗi shard 2 chunk đại diện (đầu + giữa) → callLLMSlot(-1, chunkContent, buildSystemPrompt('ml'), 'extraction', {maxTokens: 16384}) → parse JSON entities/relationships như pipeline thật (kể cả orphan filter: entity phải nằm trong ≥1 relationship) → entity-rate/chunk. Lỗi parse/429: retry 1 lần, skip + ghi nhận (fail-open). Sleep 500ms giữa call nếu rate-limit.
- Xuất bảng console + JSON scratch/r24-d0-measure.json (kèm timestamp).

## BƯỚC 4 — INGESTION THỬ SHD_NAS_EVOLUTION_002.TXT
1. TRƯỚC: script scratch/r24-d0-graph-stats.ts — getGraphStats() từ src/lib/neo4j (import tương đối) → {totalNodes, totalRelationships, labelCounts} + timestamp → scratch/r24-d0-graph-stats.json (before).
2. Chờ hot-reload (GET http://localhost:3000/api/health 200 trước), upload: `curl -X POST http://localhost:3000/api/ingestion/upload -F "files=@knowledge/SHD_NAS_EVOLUTION_002.TXT" -F "domain=ml"` → documentId.
3. Process: `curl -X POST http://localhost:3000/api/ingestion/process -H 'Content-Type: application/json' -d '{"documentId":"<id>","async":true}'` → poll GET ?documentId= mỗi ~10s tới status xong (~50-70 chunks, 4 worker, 5-20 phút — KIÊN TRÌ). Chẩn đoán qua /home/z/my-project/dev.log (phần mới nhất) khi cần.
4. FAIL/stuck → đọc error + dev.log → sửa additive → retry (PUT recover-stuck nếu route có). Iterate tới thành công HOẶC kết luận trung thực kèm bằng chứng.
5. SAU: chạy lại graph-stats (after) → node/rel/per-label delta + Cypher đếm merge: entity mới (occurrence_count=1) vs merge vào node cũ (occurrence_count>1) của doc (lọc theo documentId trên rel hoặc entity ids).
6. Ghi nhận: chunks thật, LocalEntity/LocalRelationship count của doc (SQLite), wall-time từng bước, lỗi 429.

## BƯỚC 5 — REPORT docs/D0-KHOI-LUONG-9-SHARD-NEO4J.md (tiếng Việt, phong cách docs repo)
Mục tiêu + quyết định (Q9=CÓ, Q5) · phương pháp đo · bảng 9 shard (bytes/lines/blocks/est-tokens/chunks/entity-rate mẫu/est entities) · kết quả THẬT trial 002 (chunks/entities/rels/node-rel delta/merge ratio/wall-time/lỗi) · ngoại suy 9 shard (node growth + quota Aura free-tier 200K — hiện 96.354 node ~48%) · khuyến nghị (ingest nốt 8 shard trên Aura sandbox? thứ tự — 002 xong → GEN_CAUSAL_HYPER_001 theo §9 — hay đợi máy user) · số liệu ghi ngày 2026-10-17 + môi trường sandbox Aura. KHÔNG phóng đại — mẫu 2 chunk/shard là ước lượng, ghi rõ.

## BƯỚC 6 — GATES
- bunx eslint <files đổi> → 0 lỗi.
- NODE_OPTIONS=--max-old-space-size=1200 bunx tsc --noEmit → 0 lỗi (không stop app).
- bun test tests/r110-brain-d1-kb-consult-log.test.ts + mọi test ingestion (rg -l "ingestion" tests/) → pass. KHÔNG viết test mới (D0 test = "—").

## RÀNG BUỘC
KHÔNG git commit/push (main session làm). KHÔNG restart pm2 / build / đổi port. KHÔNG sửa blueprint. KHÔNG xóa node đồ thị (H5). KHÔNG chạy community-detect (Leiden 96K node tốn RAM — ghi chú defer trong report). Không in secrets.

## WORKLOG (BẮT BUỘC) — append CUỐI /home/z/my-project/worklog.md (không overwrite):
```
---
Task ID: R24-a
Agent: subagent (D0 — đo khối lượng 9 shard + ingestion thử)
Task: <1 dòng>

Work Log:
- <bước cụ thể + số liệu chính>

Stage Summary:
- <diff files, số liệu đo, trial ingestion, gates>
```

## BÁO CÁO TRẢ VỀ (final message)
1. Files đổi + mô tả diff ngắn · 2. Bảng đo 9 shard compact · 3. Trial 002: chunks/entities/rels/node delta/merge/wall-time · 4. Gates · 5. Report path + blocked gì.
