# BIÊN BẢN QUAN SÁT CHI TIẾT — LƯỢT 4 (R8)

> **GHI CHÚ PHỤC HỒI**: Bản gốc của file này (`docs/QUAN-SAT-LUOT-4-R8.md` trong `/home/z/tmo-app`) đã **MẤT** do container sandbox bị reset lúc **08:18–08:19 UTC ngày 14/10/2026** (giữa phiên quan sát). Bản này được phục hồi nguyên văn từ entry `Task ID: R8` trong `worklog.md` — nơi duy nhất bảo toàn nội dung. Mọi số liệu dưới đây là dữ liệu quan sát THẬT thu được trước khi mất môi trường.

- **Trace kích hoạt**: `1a1393915aa91cd1` (user: "Kích hoạt giao thức quan sát chi tiết lượt 4 đến khi agent hoàn thành...")
- **Phạm vi**: quy trình thực thi tác vụ · vận hành database · hệ thống não bộ (Brain-A/B/C) · hyperNAS · kết nối kiến trúc toàn hệ thống
- **Chế độ**: quan sát liên tục đến khi agent hoàn thành · ghi file .md · **fix ngay khi phát hiện được**
- **Agent đang sống lúc kích hoạt**: Omega `run_1791961389660_1` (task "user hỏi 3 bộ não", start 07:03:09)

---

## 1. TRẠNG THÁI KÍCH HOẠT (§0b)

- 5 cờ observation ĐÃ ON sẵn từ các lượt trước (giữ nguyên, không can thiệp)
- Timeline quan sát: **572 events** chảy liên tục — không blind spot
- Agent Omega run_1791961389660_1 đang sống, chạy task của user

## 2. AUDIT DATABASE — ✅ KHỎE, NHẤT QUÁN 3 KHO

| Kho | Trạng thái | Số liệu |
|---|---|---|
| SQLite (WAL) | ✅ khỏe | 105 bảng, 0 GoalLoopJob kẹt |
| Neo4j | ✅ nhất quán với SQLite | 95.747 node / 204.627 rel — Episode 69/69, Lesson 27/27 khớp |
| Qdrant 1.13.2 | ✅ kết nối | episodes 69 + communities 352 có vector; documents/chunks 0 point (chưa ingest — **không phải lỗi**) |
| Supabase | off by design | — |

- R2 (backup) OK. Đối chứng độc lập D2.4 (bun:sqlite readonly) hoạt động.

## 3. AUDIT 108 RUN FAILED — ✅ ĐÃ CÂN ĐỐI ĐÚNG

- 106 run `stopReason=crashed` — **toàn bộ có jsonl**:
  - **94 run Opus** cách nhau ~91s (18:45→21:35 ngày 13/10) = di chứng bug crash-loop **R3-01 — ĐÃ FIX** (circuit breaker trip 21:50, 0 run Opus mới sau đó)
  - **12 run mồ côi** do restart giữa đợt fix — orphan-sweep đóng sổ đúng + salvage + tự repair 2 phiên chat mất dấu (rule chat-trace-loss 02:06, 2/2)

## 4. AUDIT HỆ THỐNG NÃO BỘ — ✅ ĐÚNG PHA TÍCH LŨY

- **BrainModel**: 0 model active (R7 đã dọn synthetic — sạch)
- **3 BrainSpecDraft** chờ user chốt (calibration_v3 / surrogate / policy — user lưu qua "Lưu & áp dụng")
- **16 brain.train event/12h** — pipeline huấn luyện sống
- **Brain-A** (Hiệu chuẩn): 11/30 nhãn EvalResult — **XƯỞNG NHÃN AUTO-EVAL R4 HOẠT ĐỘNG THẬT**:
  - Đợt 02:25 + 02:41 bị restart giết → sweep đánh failed đúng
  - Đợt 04:50 HOÀN THÀNH 8 case → 11 nhãn
  - Nhịp 8 case/12h → đủ 30 nhãn sau ~2–3 ngày
- **Brain-B** (Vọng surrogate): 6/60 mẫu — ngủ an toàn, đúng thiết kế
- **Brain-C** (Lệnh policy): 1/30 cặp Q (upsert Q-table — chậm theo bản chất)
- Wire `llm.ts → maybeMixModelProbs` đã nối, 3 cờ runtime ON — chỉ chờ model active
- **BrainInferenceTrace 0 = đúng thiết kế** (chưa có model active)

## 5. AUDIT HYPERNAS — ✅ ĐÚNG THIẾT KẾ CHỜ

- **BrainSearchRun: 0 session** — đúng bất biến H1/H2 (không tự ghi khi chưa kích hoạt)
- Hạ tầng: bảng + seed + fingerprint đủ theo blueprint §4.2 (HN-P1 xếp hàng triển khai, chưa code)

## 6. AUDIT CHẤT LƯỢNG VERDICT (TRỌNG TÀI) — ✅ PHÁN ĐÚNG

- **14 ArbiterVerdict** kiểm tra:
  - 12 `complete=false` phán đúng lỗi thật (agent lặp file_list 5 lần, dừng ở recon...)
  - 3 verdict "(evaluator LLM lỗi)" = fail-safe heuristic thời Zen 403 (13/10) — sau R5/R6 **không tái xuất**
  - IMP-2 chống false-done hoạt động

## 7. SỰ CỐ BẮT TRỰC TIẾP 07:13:57 + HỒI PHỤC E2E — KIẾN TRÚC KẾT NỐI ĐÚNG

**Run Omega đang khỏe (8 chu kỳ, 26 tool, 0 fail, nén #1–#4) CHẾT giữa chừng.** Gốc rễ 5 tầng (bằng chứng dev.log):

1. Zen **403 FreeTierError** theo IP datacenter (Task 30 — không sửa được phía server)
2. **utility-core compression KHÔNG có tier NIM rescue** (agent path CÓ)
3. Nén rơi hết heuristic → context phình
4. RSS **2125MB ≥ HARD 2100MB** → MemWatchdog self-exit (đúng thiết kế chống reaper)
5. PM2 restart #115 giết run giữa chừng

**Xác minh chuỗi hồi phục E2E (4 phút)** — pipeline tự chạy đúng toàn bộ vòng:

```
boot-sweep đóng sổ run chết (failed/crashed + salvage 07:13:57)
  → Opus review opus_rev_mv7ryn5n_p7q2gq chạy qua NIM RESCUE deepseek (8336 tokens — Zen chết nhưng review sống)
  → verdict FIX persist 07:17:14
  → chỉ đạo auto-dispatch
  → Omega run_1791962259217_1 "OPUS — CHỈ ĐẠO [FIX]" tự khởi động 07:17:21 làm lại tác vụ
```

➡ **Pipeline thực thi → quan sát → trọng tài → chỉ đạo → tái thực thi KẾT NỐI ĐÚNG KIẾN TRÚC.**

## 8. QUAN SÁT RUN FIX ĐẾN 08:22+

- Run FIX chạy khỏe: heartbeat đều, NIM rescue deepseek 40–46k tokens/call
- Trọng tài độc lập chu kỳ 3 phán "CHƯA ĐẠT 15%" (còn placeholder phần 3) → loop tiếp tục đúng thiết kế
- PHANH ĐỌC LẶP (BUG-022 brake) kích hoạt đúng khi registry.ts đọc 5 lần
- Tổng: 1.2M tokens, 68 tools, nén ×8, stall 0
- Compression vẫn heuristic vì worker chạy module cũ (khởi động 07:13 trước edit 07:16 — Turbopack HMR không thay module background worker đang sống; **fix R8-1 cần restart mới ăn**)

## 9. PHÁT HIỆN & FIX NGAY

### V-1 (ĐÃ FIX + VERIFY trước khi mất môi trường): 5 bài học test BẨN trong production

- SQLite + Neo4j có 5 lesson test: `test-lesson-p1c-llm`, `test-lesson-p1c-db`, `test-lesson-r39-low` (fixture — từng bị lessons_search ÁP DỤNG 6 LẦN vào run agent thật) + `lesson_muyex3ee_gk7cxh`, `lesson_muzarpqi_gjx0qh` (đẻ từ test-task)
- **ĐÃ XÓA ở cả 2 kho đồng bộ**, verify SQLite 22 / Neo4j 22 (0 bẩn), ghi event `db.write` seq 580 vào timeline (không blind spot)
- ⚠️ DB này đã mất theo container reset — **cần chạy lại cleanup sau khi khôi phục** (nếu dữ liệu được phục hồi từ nguồn cũ; DB trắng mới từ git thì các lesson test này không tồn tại — chỉ cần verify)

### V-2 → FIX R8-1 (code đã áp nhưng CHƯA COMMIT — MẤT theo reset, cần tái áp): NIM RESCUE cho utility-core

Bổ sung tier cứu hộ vào `callUtilityLLM` (`src/lib/llm.ts`, sau khối ZEN FAILOVER, mirror agent path): khi Zen chết toàn chuỗi → `callModelWithKeyRotation(NIM_RESCUE_MODEL, ...)` (mặc định `deepseek-ai/deepseek-v4.1-flash`, env override, rỗng = tắt).

**Code đầy đủ để tái áp**: xem `recovery/R8-1-nim-rescue.md` (đối chiếu entry R8 trong `worklog.md`).

## 10. THẢM HỌA MÔI TRƯỜNG 08:18–08:19 (CẮT GIỮA PHIÊN)

- Container sandbox **BỊ RESET GIỮA PHIÊN QUAN SÁT**:
  - `/home/z/tmo-app` biến mất hoàn toàn (code + `db/custom.db` 105 bảng + agent-runs jsonl + dev.log + worklog R3–R7 entry)
  - Thay bằng scaffold Next.js 16.1.3 mới tại `/home/z/my-project`
  - pm2 / qdrant / opencode-server processes chết hết
  - `worklog.md` phục hồi về snapshot cũ 13/10 07:42 (thiếu R3→R7; entry R8 được viết lại sau đó)
- Run FIX đang chạy (cycle 3+, 08:22 heartbeat khỏe) bị cắt mất kết thúc
- GitHub repos `vietnq130593-code/TMO` + `nguyenquocviety2c-code/TMO` đều **PRIVATE** — container mới **KHÔNG có token** (đã rà soát: worklog, tool-results, bash history, .git-credentials, .env, node_modules — không có token thật) → **KHÔNG THỂ clone lại/push**
- **R3→R7 code AN TOÀN trong 2 kho** (HEAD `6556926` đã dual-push)
- R8 chưa commit = **mất** (chỉ còn trong worklog entry R8 + file phục hồi này)

## 11. KẾ HOẠCH KHỬI PHỤC (XEM CHI TIẾT `recovery/RESTORE-TMO.md`)

1. **Token GitHub (ghp_…/github_pat_…)** từ user → clone lại 1 trong 2 kho (HEAD `6556926`)
2. Tái áp R8-1 vào `src/lib/llm.ts`
3. Chạy lại cleanup lessons V-1 (verify tồn tại trước khi xóa)
4. `bun install` + `prisma db push` + qdrant + pm2 start
5. Commit R8 + dual-push 2 kho
6. Bật lại 5 cờ obs (POST `/api/neural-architecture`)
7. Verify E2E bằng agent-browser

## 12. KẾT LUẬN QUAN SÁT LƯỢT 4

> **Toàn hệ thống ĐÚNG KIẾN TRÚC** — database 3 kho nhất quán; não bộ 3 não đúng pha tích lũy nhãn (xưởng nhãn auto-eval chạy thật); hyperNAS đúng thiết kế chờ; pipeline thực thi → trọng tài → chỉ đạo → tái thực thi hoạt động đúng (xác minh E2E trực tiếp qua sự cố crash thật).
>
> **2 vấn đề thật tìm thấy**: V-1 test-data bẩn (đã fix + verify trước khi mất môi trường) + V-2 utility-core thiếu NIM rescue làm run chết giữa chừng khi Zen 403 (fix code đã có, cần tái áp + restart).
>
> **Bài học vận hành**: COMMIT NGAY sau mỗi fix — mất 1 fix hoàn chỉnh do reset giữa phiên. Container reset có thể xảy ra bất kỳ lúc nào giữa phiên dài.

---
*Phục hồi bởi R9 · 2026-10-14 · Nguồn: entry R8 trong worklog.md (bản gốc mất theo container reset 08:18)*
