# BÁO CÁO P5-M1 · MATRYOSHKA 512-DIM PILOT — BẢNG RECALL ĐỐI CHỨNG

> Sinh bởi `bun scripts/matryoshka-benchmark.ts` + live probe API — 2026-10-10
> (BLUEPRINT-STATS-LEARNING §P5-M1, mục #14 — MATH.pdf §PCA/§SVD/§Eigenvalues)
>
> **KẾT LUẬN PILOT (đúng cơ chế điểm dừng #4 blueprint): KHÔNG chuyển đường
> đọc agent_memory sang 512-dim** — recall drop 8–27% vượt xa ngưỡng 2%.
> Đường đọc giữ nguyên 2048; hạ tầng dual-write (`MATRYOSHKA_PILOT=on`, mặc
> định OFF) để sẵn sàng đối chứng lại khi đổi model embed có MRL thật.

---

## 0 · Phương pháp

- **Bản 512** = `truncateMatryoshka` giữ đúng 512 phần tử đầu (MRL
  prefix-truncation), KHÔNG renormalize (cosine bất biến scale).
- **Query** = chính các point trong collection, chọn đều bước (deterministic —
  chạy lại cho cùng kết quả); hàng xóm tính cosine trong bộ nhớ.
- **recall@k** = |top-k(512) ∩ top-k(2048)| / k; **nDCG@10** dùng xếp hạng
  2048 làm ground-truth (`ndcgAtK` — cùng chuẩn P1-M2).
- Phép đo thứ 3 (raw API): 30 câu kỹ thuật phân biệt nhúng MỚI qua
  `nvidia/nemotron-3-embed-1b` (chưa qua INT8 quantization của Qdrant) —
  đo chất lượng MRL thuần của model.

## 1 · VECTOR LƯU QDRANT (tái lập từ scalar quantization INT8)

### theopus_chunks (KB — nội dung PDF đã index)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| vector thật | **33** × 2048-dim | scroll toàn collection, bỏ zero-vector |
| recall@5 | **0.8848** | trùng top-5 |
| recall@10 | **0.9152** | trùng top-10 |
| nDCG@10 | **0.9905** | giữ thứ bậc 2048 tốt (hoán vị gần đầu hiếm) |
| cosine drop (query↔top1) | −0.0364 | cosine 512 thấp hơn ~0.04 |

### agent_memory (ký ức hội thoại agent)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| vector thật | **15** × 2048-dim | |
| recall@5 | **0.8933** | |
| recall@10 | **0.9467** | |
| nDCG@10 | **0.9906** | |
| cosine drop (query↔top1) | −0.0382 | |

## 2 · VECTOR MỚI TỪ API (raw — chưa INT8, 30 câu kỹ thuật phân biệt)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| recall@5 | **0.7267** | thấp NHẤT trong 3 phép đo — loại bỏ giả thuyết "INT8 là thủ phạm" |

## 3 · Diễn giải

1. **Model `nvidia/nemotron-3-embed-1b` không giữ cấu trúc hàng xóm ở 512-dim**
   như spec §P5-M1 giả định (kỳ vọng kiểm chứng: "top-5 trùng ≥98%"). Đo được
   0.73–0.89 tùy corpus — **sai-kỳ-vọng phía spec** (lần 10 theo sổ giao thức
   fixbug), không phải lỗi code: `truncateMatryoshka` giữ đúng từng byte 512
   phần tử đầu (test r78 khớp từng vị trí + dữ liệu MRL-cấu-trúc đạt ≥98%
   xác nhận cơ chế).
2. **Độ lệch phụ thuộc cấu trúc corpus**: KB (33 chunk từ ~4 tài liệu — cụm hóa
   cao) → 0.88; 30 câu phân biệt chủ đề (hàng xóm chỉ tương đồng vừa phải,
   biên mỏng) → 0.73. Trên KB lớn thực tế kết quả sẽ nằm giữa hai đầu này.
3. **nDCG@10 ≈ 0.99** dù recall thấp: các hàng xóm bị hoán vị nằm GẦN nhau
   trong xếp hạng (không phải hàng xóm hoàn toàn sai) — chất lượng ranking
   tổng thể suy giảm ít hơn chất lượng tập top-k.

## 4 · Quyết định theo điểm dừng #4 blueprint

> "chuyển đường đọc agent_memory sang 512-dim chỉ khi recall drop <2%"

- Ngưỡng: cần recall@10 ≥ 0.98. Đạt được: **0.9152 (chunks) / 0.9467 (memory) /
  0.7267 (raw phân tán)** → drop 5–27% — **KHÔNG đủ điều kiện đề xuất**.
- Hành động: giữ nguyên toàn bộ đường đọc 2048 (mặc định — không đổi gì);
  pilot dual-write + benchmark script để sẵn đối chứng lại khi đổi model
  embed (ví dụ model có MRL chính thức hỗ trợ `dimensions` parameter).
- Pilot collection `agent_memory_512` (không quantization, dim-guard bỏ qua
  theo quy ước tên `_512`) chỉ được tạo khi `MATRYOSHKA_PILOT=on` — hiện OFF.

## 5 · Tái sinh bảng

```bash
bun scripts/matryoshka-benchmark.ts --collection theopus_chunks   # bảng §1.a
bun scripts/matryoshka-benchmark.ts --collection agent_memory     # bảng §1.b
# §2 (raw API): scripts/tmp-mrl-live-check.ts — đo 30 câu qua generateEmbeddingBatch
```
