# VÒNG LẶP TỰ PHẢN CHIẾU — Thiết kế (DESIGN DRAFT, CHƯA TRIỂN KHAI)

> Trạng thái: **thiết kế** — tài liệu này KHÔNG có code tương ứng trong `agent/`.
> Phiên bản: v0.1-draft · Ngày: 2026-09-24 · Tác giả: Kai (theo chỉ đạo user)
> Ba chỉ thị nguyên văn của user dẫn thiết kế này:
> (1) *"Phản chiếu ở cả 2"* — phản chiếu ở CẢ HAI tầng suy luận;
> (2) *"bài học lưu dạng hypothesis có cấu trúc"*;
> (3) *"dùng lại các CoT cũ cho tiết kiệm"*.
> Nền lý thuyết: `BAYESIAN_CAUSAL_ANALYSIS.md` (gọi tắt BCA §x — 6 con đường B1–B22);
> cơ chế anh em: `MULTI_TRY_DESIGN.md` (M1/M2/M3 — chung hạ tầng đo lường Phase 2).
> Nguyên tắc đóng cửa: triển khai sau λ-log Phase 1, mọi ngưỡng là khởi tạo chờ kalib.

---

## 0. Ba chỉ thị → ba trụ cột thiết kế

| Chỉ thị user | Trụ cột trong tài liệu này | Cơ sở (BCA) |
|---|---|---|
| Phản chiếu ở cả 2 | **R1** — phản chiếu TRONG LẦN (tier A: CoT của lượt S2, ms–chục s) và **R2** — phản chiếu XUYÊN TURN (tier B: vòng hypothesis-testing qua các turn, hiện đã có mầm ở C6) | §3.3, §3.1 |
| Bài học lưu dạng hypothesis có cấu trúc | **SHR** (Structured Hypothesis Record) — schema 8 trường, mỗi bài học là một SCM mini; posterior Laplace làm độ tin cậy; PN/PS làm công trạng | §3.1, §3.2, §3.6 |
| Dùng lại các CoT cũ cho tiết kiệm | **Kho mẩu CoT** (trellis store) — nén MDL ~200–400 ký tự, truy hồi theo chữ ký ngữ cảnh, ngân sách Kraft ≤ 64 mẩu, giới hạn độ sâu chuỗi theo union bound | §3.5 |

Định vị trên thang nhân quả (BCA §2, RUL_CHT_004): TRIAS hiện ở L2 (Intervention —
"làm X thì sao"). R1 nâng chất lượng mỗi can thiệp; R2 là leo lên L3
(Counterfactual — "giá như làm X' thì sao") — điều kiện bắt buộc là có SHR, vì truy
vấn phản thực tế trả lời được chỉ khi có mô hình cấu trúc của level. Không có SHR
thì mọi "phản chiếu" chỉ là mô hình tự nói chuyện với mình (causal parrot, BCA §5).

## 1. Sơ đồ tổng thể — hai tầng phản chiếu trong vòng 8 bước

Vòng hành vi hiện có (`my_agent.py choose_action`, 8 bước) giữ nguyên khung; phản
chiếu cắm vào như sau (đánh dấu ● mới, ○ cũ):

```
        ┌────────────────────── R2: XUYÊN TURN (tier B) ──────────────────────┐
        │                                                                      │
        │  ● SHR-store (C5/C3): hypothesis sống + posterior + kho mẩu CoT      │
        │    ● promote/demote (A1)   ● PN/PS khi thắng level (A3)              │
        │    ● monitor suy thoái: entropy sụp / parrot / drift (A4)            │
        │                                                                      │
        └──────▲───────────────────────────────────────┬──────────────────────┘
               │ λ (bằng chứng: delta thật)            │ π (dự đoán: hypothesis + posterior)
   ┌───────────┴───────────┐              ┌────────────▼──────────────────────────┐
   │ C6 observe_outcome    │              │  R1: TRONG LẦN (tier A) — mỗi lượt    │
   │ ○ pred_error (đã có)  │              │  ┌──────────────────────────────────┐ │
   │ ● posterior update    │              │  │ S2 CoT 6 bước (mở rộng từ 4):    │ │
   │ ● ghi SHR α/β         │              │  │ (0) ABDUCTION: bằng chứng đến    │ │
   └───────────▲───────────┘              │  │     giờ đang ủng hộ hypothesis    │ │
               │                          │  │     nào, bác cái nào?             │ │
   ┌───────────┴───────────┐              │  │ (1) liệt kê đối tượng + vai trò  │ │
   │ env.step(action)      │              │  │ (2) suy cơ chế từ delta          │ │
   └───────────▲───────────┘              │  │ (3) chấm EIG các action (A2)     │ │
               │                          │  │ (4) hành động + hypothesis       │ │
   ┌───────────┴───────────┐              │  │ (5) REFLECT-in-turn: kết luận    │ │
   │ C4 validate → action  │              │  │     của lượt này, nói gì để     │ │
   └───────────▲───────────┘              │  │     nén thành mẩu (cho kho)     │ │
               │                          │  └──────────────────────────────────┘ │
   ┌───────────┴───────────┐              │  ● nạp prior-reasoning khi ngữ cảnh  │
   │ C2 reason (S1/S2)     │──────────────┘    khớp mẩu cũ (tiết kiệm: không suy  │
   └───────────▲───────────┘                   lại từ đầu — Viterbi, BCA §3.5)     │
               │                          └───────────────────────────────────────┘
   ┌───────────┴───────────┐
   │ C1 perceive + C6 tín │   ○ = hiện có giữ nguyên · ● = thiết kế mới
   │ hiệu + C3 truy hồi   │
   └───────────────────────┘
```

Nguyên tắc đọc sơ đồ: **R1 sống bên trong một lần gọi model** (chi phí = token, không
phát sinh action); **R2 sống bên ngoài** (chi phí ≈ 0 — thuần C6/C5 tính toán). Hai
tầng trao đổi qua cặp λ/π (MET_BEL_031): R2 nén toàn bộ quá khứ thành belief-state
ngắn đưa xuống R1 (π — dự đoán còn treo); R1 trả về hypothesis + mẩu CoT mới; hệ quả
thật (λ) quay về R2 cập nhật posterior. Đây chính là "phản chiếu ở cả 2" mà user chỉ
đạo: không chọn một tầng — hai tầng khác độ phân giải thời gian, khác chi phí, khác
cơ sở tri thức (BCA B8/B9).

## 2. SHR — Structured Hypothesis Record (trụ cột 2)

```json
{
  "id": "g2L3-H07",                    // game-level turn sinh ra
  "context_sig": {"objects": "blue-key,door", "entropy": 4.2,
                   "delta_tag": "key-moved-1"},   // chữ ký C1 (cha của SCM)
  "action": {"id": "ACTION6", "x": 12, "y": 34},  // can thiệp do(X)
  "predicted_delta": "key attaches to avatar",    // hệ quả dự kiến (con)
  "mechanics_claim": "blue objects are pickable", // MỘT quan hệ nhân quả (ICM)
  "alpha": 2, "beta": 0,               // Laplace counts (BCA A1)
  "source_turn": 17,                    // turn sinh ra
  "cot_ref": "g2L3-M04"                 // con trỏ mẩu CoT (§5) — null nếu S1
}
```

Bốn quy tắc đọc schema. Một, `mechanics_claim` bắt buộc ngắn (≤ 12 từ khoá) và nói
về MỘT quan hệ — đúng ICM (RUL_ICM_006): quan hệ tách bạch thì sai ở level này không
lây sang level khác, và là điều kiện để bài học chuyển giao (DYN_DOMAIN_ADAPTATION_
TRANSFER). Hai, `context_sig` là "biến điều chỉnh" — khi đối chiếu hypothesis giữa các
level, chỉ match trong lân cận chữ ký (bài học vay từ PC-neighborhood, BCA §5). Ba,
`alpha/beta` thay thế `uses` hiện có của `SessionGraph.record_candidate` — cùng một
hạ tầng, thêm 1 chiều thông tin (xác nhận vs bác) thay vì chỉ đếm dùng. Bốn,
`cot_ref` là mối nối sang trụ cột 3: hypothesis không mang chuỗi suy luận đầy đủ
(chống phình) — chỉ trỏ tới mẩu đã nén.

Vòng đời SHR (đóng băng bằng công thức, không bằng cảm tính):

| Sự kiện | Điều kiện | Hành động | Cơ sở |
|---|---|---|---|
| sinh | model trả hypothesis | ghi SHR với α=β=0 (posterior 0,5 — MaxEnt) | B3 |
| xác nhận | pred_error = 0 của đúng `id` | α += 1 | B1 |
| bác | pred_error = 1 | β += 1 | B1 |
| promote | posterior ≥ 0,80 ∧ α+β ≥ 4 ∧ PN/PS đạt (nếu có N-pass) | thành **lesson** — vào prompt belief-state ưu tiên | B1, B17 |
| demote | posterior ≤ 0,35 ∧ α+β ≥ 3 | đưa ra khỏi belief-state; giữ lại làm dữ liệu parrot-check | B1 |
| nghi vẹt | Jaccard(h, h') ≥ 0,9 với ngữ cảnh lệch ≥ 0,5 | cờ `parrot_suspect` — sau 1 lần test lại vẫn trùng thì β += 1 | B18/B19 |

## 3. R1 — phản chiếu trong lượt (tier A): S2 CoT 4 → 6 bước

S2_ADDON hiện có 4 bước (liệt kê đối tượng → suy cơ chế → chọn action theo info gain
→ nêu hypothesis). Thiết kế mở rộng thành 6 bước — thêm bước (0) Abduction trước và
bước (5) Reflect sau — phần giữa giữ nguyên để không phá các đo latency đã kalib:

```
(0) ABDUCTION — belief-state đầu lượt: "Quan sát đến giờ ủng hộ: {top-1..2 SHR còn
    sống, posterior}. Đã bác: { SHR bị loại, 1 từ khoá lý do }." (≤ 60 từ)
    [chỉ S2; S1 không nhận — ngân sách token]
(1)–(4) nguyên văn S2_ADDON hiện có; bước (3) được bổ trợ 1 dòng SỐ từ A2:
    "alive_hypotheses=5, untried_groups=2, best_split=ACTION6(12,34)" thay cho
    câu chữ mơ hồ "investigate before acting".
(5) REFLECT-in-turn — yêu cầu model kết thúc CoT bằng 2 câu chốt:
    "What this turn's reasoning established: ..." (→ nguyên liệu nén mẩu CoT §5)
    "What remains uncertain: ..." (→ nguyên liệu SHR ứng viên lượt sau)
```

Bước (0) là Abduction đúng nghĩa (BCA §3.3): trước khi hành động, cập nhật belief từ
toàn bộ bằng chứng — hiện tại việc này chỉ nằm ngầm trong chuỗi history 12 turn, để
model tự đào; belief-state nén làm cho thông tin loại trừ không bị pha loãng. Bước
(5) là phản chiếu thật sự trong lượt: buộc model phân biệt "cái biết chắc" (đã có
bằng chứng) với "cái còn đoán" (chưa test) — đúng cấu trúc λ/π. Chi phí thêm: ~150
token prompt (0) + ~80 token completion (5); KHÔNG thêm lần gọi model.

Trường hợp S1: R1 không chạy ở S1 (đúng triết lý tầng nhanh). Ngoại lệ duy nhất:
khi belief-state có lesson promoted (posterior ≥ 0,8) khớp ngữ cảnh hiện tại, S1
vẫn nhận 1 dòng "Known mechanic: {mechanics_claim} (confirmed 5/5)" — đây là hình
thức phản chiếu rẻ nhất: bài học đã trả tiền, chỉ việc dùng (Viterbi-path, §5).

## 4. R2 — phản chiếu xuyên turn (tier B): posterior, công trạng, chống suy thoái

R2 là vòng lớn: sau `env.step`, delta thật về tới `C6.observe_outcome` (λ), cập nhật
SHR (A1), rồi ở thang level (C5 `on_level_won`) tính công trạng (A3), và liên tục
chạy monitor chống suy thoái (A4). Ba điểm thiết kế chưa nói ở BCA:

**a) Thứ tự R2 trước M2 của multi-try.** Khi pred_error = 1 và δ mâu thuẫn, MULTI_TRY
M2 đề xuất 1 lần retry có ràng buộc ("OBSERVED CONTRADICTION: ..."). R2 bổ sung cho
ràng buộc đó bằng SHR: thay vì chỉ nói "hypothesis cũ sai", nói được "hypothesis cũ
sai VÀ 3 cơ chế đã bị loại VÀ 2 cơ chế còn sống" — ràng buộc giàu hơn, rẻ hơn mẫu
mù (đúng luận điểm M2-chạy-trước-M1). Tích hợp: block CONTRADICTION của M2 lấy dữ
liệu từ belief-state của R2 — không đổi cấu trúc M2, chỉ đổi nguồn chữ.

**b) Ghi công khi thắng level (A3) cần đối chiếu NGƯỢC.** PN hỏi "bỏ h thì có thắng
không?" — với dữ liệu 1 session, chỉ trả lời được qua các lần replay (RESET tự nhiên
hoặc M3 N-pass). Vì vậy luồng C5 `on_level_won` v0.2: ghi SHR-dùng-trong-level + kết
quả; chỉ khi cùng level có ≥ 3 lần chơi (qua M3 hoặc session dài) mới tính PN/PS và
chỉ khi đạt ngưỡng mới promote bậc 2 (lesson "đã chứng minh nhân quả thắng-thua").
Trước đó, promote bậc 1 (posterior ≥ 0,8) là đủ để DÙNG, nhưng báo cáo mid-session
phải ghi rõ cấp độ chứng cứ — không thổi phồng "biết chắc" (đúng SENT-triết-lý chống
entropy collapse: niềm tin chắc hết chỗ đứng thì hết đường học).

**c) Monitor A4 là vòng phản chiếu CỦA vòng phản chiếu.** Bệnh riêng của R2: guidance
của C6 là chuỗi câu cố định theo ngưỡng — model học cách bỏ đọc sau vài lần lặp. A4
đo entropy từ khoá của {hypothesis + guidance} trong cửa sổ 6 turn; sụp dưới 0,35
liên tiếp → (i) đảo cấu trúc câu guidance, (ii) nâng nỗ lực một nấc (S1→S2, hoặc
tăng N nếu multi-try bật), (iii) ghi audit `reflection_collapse`. Tín hiệu này là
thước đo trực tiếp cho câu hỏi "TRIAS có đang tự lặp hay đang tự học" — ngôn ngữ
QSAF của shard (B20) nhưng đo bằng dữ liệu λ-log sẵn có.

## 5. Kho mẩu CoT — tái dùng cho tiết kiệm (trụ cột 3)

Bốn thành phần, mỗi thành phần một ràng buộc từ BCA:

**Nén (MDL, B2/B11):** sau lượt S2 có REFLECT (bước 5), lấy 2 câu chốt + 1 câu cơ
chế → mẩu 200–400 ký tự. Nén tại chỗ từ output đã có — không gọi model thêm. Mẫu
mẩu: `[g2L3-M04 | ctx: blue-key,door,4.2 | mech: blue=pickable | concl: key moved
toward door | conf: α2β0]`. Chữ "chưng cất" của DYN_PATH_EXPLOSION_DISTILLATION:
giữ phần DỰ ĐOÁN ĐƯỢC (cơ chế + kết luận), bỏ phần diễn giải từng bước — phần không
tái dụng được.

**Truy hồi (Viterbi + PC-neighborhood, B13):** đầu lượt S2 (và lesson-match cho S1),
tính Jaccard từ khoá `context_sig` hiện tại vs mẩu trong kho cùng game (Phase 2) hoặc
toàn session (Phase 3, đối chiếu Q2 của BCA §7). Ngưỡng ≥ 0,5 → nạp tối đa 2 mẩu
posterior cao nhất vào prompt dưới nhãn `Prior reasoning (may be wrong, verify):`.
Cụm "may be wrong, verify" là bắt buộc thiết kế — mẩu là prior không phải chân lý;
nhờ nhãn này model vẫn để chỗ cho bằng chứng mới (chống parrot, B18).

**Ngân sách (Kraft, B14):** kho ≤ 64 mẩu/game (~16 KB); đầy thì ghi đè mẩu có
posterior thấp nhất VÀ lâu chưa truy hồi nhất (LRU×quality). Mỗi lượt nạp tối đa 2
mẩu + tối đa 1 lesson — tổng ≤ ~700 token belief-state. R<C (B15): vượt ngưỡng này
thì chất lượng suy luận giảm thay vì tăng — kênh prompt là kênh nhiễu.

**Độ sâu chuỗi (union bound, B15):** mẩu sinh từ lượt có dùng mẩu cũ tạo thành
chuỗi nguồn gốc. Giới hạn: chuỗi dài ≤ 3 thế hệ; mẩu thế hệ 3 bị đánh dấu `tail`
— không cho phép sinh mẩu thế hệ 4 từ nó. Lý do: xác suất sai của chuỗi ≤ tổng sai
từng mắt xích (RUL_UNI_068) — sai lệch tích luỹ qua "mẩu dẫn mẩu" chính là trôi ngữ
nghĩa (ICOER, B20); chặn độ sâu là cách rẻ nhất để chặn trôi. Monitor drift: mỗi
checkpoint (cuối game) so từ khoá mẩu-con vs mẩu-gốc cùng chuỗi; Jaccard < 0,4 →
đánh dấu `drifted`, cấm tái dùng nhánh đó.

Ba số liệu chứng minh "tiết kiệm" không phải khẩu hiệu: (1) token — mẩu 300 ký tự
thay cho CoT suy lại từ đầu (~2–4K token thinking nếu native bật); (2) độ trễ —
lượt có mẩu khớp có thể hạ nhiệt độ/nén prompt vì đường suy luận chính đã có sẵn
(Viterbi giữ lộ trình tốt nhất); (3) tính đúng — mẩu chỉ vào khi posterior ≥ 0,7,
nên kỳ vọng sai của thành phần "đã biết" giảm theo đúng số lần xác nhận (Laplace).

## 6. Tích hợp kiến trúc (chỉ vạch vị trí — KHÔNG sửa code v0.1)

| Thành phần | Thay đổi dự kiến khi triển khai | Ghi chú |
|---|---|---|
| `config.yaml` + `config.py` | thêm `FeaturesCfg.use_reflection` (default **false**), `use_cot_reuse` (default **false**), `ReflectionCfg` {promote=0.80, demote=0.35, min_obs=4, cot_budget=64, cot_match=0.5, chain_depth=3} | 2 cờ tách bạch vì 2 cơ chế đo A/B khác nhau (đúng bài MULTI_TRY Q3) |
| `c6_metacognition.py` | thêm `HypothesisTracker` (A1 posterior + belief-state render ≤ 60 từ); `observe_outcome` nhận `hyp_id`; A4 monitor (entropy cửa sổ 6); `should_multi_try()` (MULTI_TRY) đọc posterior — tín hiệu mới: "tập sống trống" | vẫn 0 model call — đúng ranh giới C6-lite |
| `c5_learning.py` | `on_level_won` ghi SHR-dùng + A3 PN/PS khi k ≥ 3; promote 2 bậc; `record_candidate` nâng cấp thành `record_shr` | schema tương thích ngược: candidates cũ = SHR thiếu trường, default 0 |
| `c3_memory.py` | `SessionGraph` thêm `hypotheses: {id: SHR}` + `cot_scraps: {id: mẩu}` + chuỗi nguồn gốc; checkpoint flush đủ cả 3 | singleton cấp module giữ nguyên — SHR sống qua game (D3 mức 1) |
| `c2_reasoner.py` | S2_ADDON 4→6 bước (bước 0 belief-state, bước 5 REFLECT); nạp prior-reasoning khi match; S1 nhận 1 dòng lesson khi có promoted | OUTPUT_CONTRACT JSON thêm 2 trường tuỳ chọn `established`/`uncertain` (bước 5) — parse khoan dung như hiện tại |
| `my_agent.py` | luồng 8 bước giữ nguyên; cắm belief-state vào build-prompt của C2; sau observe_outcome gọi tracker.update | fallback heuristic không đổi semantics |
| `s_safety.py` | audit event `turn` thêm `hyp_id, posterior, belief_len, cot_hit`; event mới `reflection_collapse`, `parrot_suspect` | dữ liệu λ cho A/B Phase 2 |
| cell 2 (notebook) | `make sync-cells` tái sinh khi `agent/` đổi — không sửa tay cell | config_hash tự đổi đúng quy trình |

## 7. Chi phí, chống chỉ định

**Chi phí tính theo kịch bản 3.000 turn/session (MULTI_TRY §6):** R2 ≈ 0 (tính toán
thuần, ~1 ms/turn); R1 thêm ~230 token/lượt S2 — với ~30–40% turn là S2, tổng ~
0,3–0,4 triệu token completion, tương đương < 10% ngân sách reasoning hiện định;
kho mẩu nạp ~700 token × tỷ lệ khớp (đo được, Q4 BCA). Không thành phần nào phát
sinh action thật → RHAE không đổi. Điểm cần kalib: thời gian thinking native có thể
tăng vì bước (5) kéo dài CoT — TokenMeter đã tách reasoning_tokens để theo dõi.

**Chống chỉ định (tắt `use_reflection`):** (i) game đã thắng chắc (levels gần hoàn
thành + pred_error thấp) — đúng nguyên tắc bỏ reasoning thừa khi thắng (BLUEPRINT
§3.5); (ii) `budget.remaining_actions() < 20` — cạn ngân sách thì mọi suy luận là
lệch tiền của game khác; (iii) session cuối window (C7 báo λ thời gian cao) — reflection
là thứ đầu tiên hy sinh vì nó không đụng đường phát action; (iv) monitor A4 báo
collapse 2 lần liên tiếp mà không hồi → tắt belief-state game đó, về M0 (đã có tiền
lệ "fallback bảo toàn agent" của QSAF, B20).

## 8. Phân pha nghiệm thu

- **Bước 0 (cùng đợt sửa cell tiếp theo, chi phí ~0):** audit event `turn` thêm
  `hyp_id` — chuỗi hypothesis bắt đầu được theo dõi từ Phase 1 (chỉ thêm khoá, không
  đổi hành vi — đúng lời BCA §7 Phase 1).
- **Phase 2-A:** SHR + A1 + belief-state (B1/B3/B5/B8/B9) + A4-lite; A/B theo từng
  game: R2 bật vs tắt — đo (i) tỷ lệ hypothesis lặp lại sau khi bị bác (kỳ vọng giảm),
  (ii) RHAE/action (kỳ vọng không đổi), (iii) pred_error trung bình trượt (kỳ vọng giảm).
- **Phase 2-B:** R1 6 bước + EIG số (B10–B12) + kho mẩu (B13–B15); A/B độc lập với
  2-A nhờ 2 cờ riêng; đo (iv) tỷ lệ khớp mẩu + hành vi sau khớp, (v) token/turn,
  (vi) think_chars.
- **Phase 3:** PN/PS (B17), test-lại + parrot (B18/B19), turbo M1b (B21, nếu
  MULTI_TRY Q mở được); điều kiện vào Phase 3: Phase 2 chứng minh window dư bằng
  λ-log — đúng nguyên tắc đóng cửa của cả 3 tài liệu thiết kế.
- Tiêu chí sống/chết chung (mọi cặp A/B): RHAE/action không xấu đi VÀ ít nhất 1 trong
  (i)/(iii)/(v) cải thiện có ý nghĩa theo phương pháp Duck (P(true_delta>0) ≥ 0,90).

## 9. Câu hỏi mở (chờ λ-log, không chờ ý kiến)

- Q1: belief-state ≤ 60 từ có đủ mang "3 cơ chế đã loại + 2 còn sống"? Nếu phải
  100 từ thì S2 prompt còn đủ kênh cho scene? Đo bằng ablation độ dài 60/100/150.
- Q2: mẩu CoT match cross-game (Phase 3) có nên yêu cầu cùng `delta_tag` hay chỉ
  `objects`? Câu hỏi tương đương BCA-Q2 — gộp thử nghiệm.
- Q3: bước (5) REFLECT thêm 2 trường JSON — model Qwen3-27B tuân thủ schema mở rộng
  ổn không? Probe cell 4 hiện có chỉ đo format 4 trường cũ; cần probe 6 trường.
- Q4: khi A2 nói "best split = ACTION6 vùng X" nhưng model vẫn chọn action khác —
  ghi nhận là dữ liệu (model có thông tin riêng) hay là tín hiệu prompt không đủ
  trọng lượng? So sánh tỷ lệ theo gợi ý trước/sau khi nâng từ ngữ ("statistics:"
  → "hard constraint:") — chỉ quyết định bằng λ-log.
