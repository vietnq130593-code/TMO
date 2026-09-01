# TB-14 — SOLUTION SCORING & SELECTION PROTOCOL (Rubric · Tournament · Council ⑤ · Context-Fit)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION)**
> Source of Truth: `ai-team-workflow.md` — **Phụ lục Z2 (v1.5)**, dòng 4684–4745 (nguồn gốc 4.635 dòng + Phụ lục Z v1.3 nguyên vẹn)
> Version: 1.0 (v1.5 của tập) | Ngày: 2026-09-01 | Biên soạn: Mr. Robot (Z.ai Code)
> Trạng thái quyết định: ✅ **KHÔNG còn [Q] mở** — toàn bộ chốt trong Phụ lục Z2 theo ủy quyền thorough-first của user (phiên trace 1a05c01e7a9f66f9)
> Quy ước: `[SRC Z2.x]` = trích Phụ lục Z2 nguồn · `[SRC]` = trích dòng nguồn cũ · `[EXT]` = mở rộng blueprint này

---

## §0. MỤC ĐÍCH & PHẠM VI

**Mục đích [SRC Z2 preamble]:** trả lời 4 câu hỏi hệ thống mà tập TB-00→TB-12 còn hở:

1. **Thế nào là một giải pháp / chẩn đoán CHÍNH XÁC?** → Rubric A (chẩn đoán) + Rubric B (giải pháp) — §1, §2.
2. **Xác minh bằng cách nào?** → falsification test (kill-criteria) + experiment scorecard kỳ vọng-vs-thực-đo — §3, §4.
3. **Agents áp dụng đúng tiêu chí + giải pháp phù hợp BỐI CẢNH ra sao?** → ma trận Context-Fit + protocol tra KB — §5.
4. **Loop thảo luận đầy đủ ra sao, ai tham gia, khi nào triển khai luôn vs gửi đề xuất?** → Tournament 5 vòng + Council ⑤ + quy tắc deploy — §3, §6, §7.

**Phạm vi IN:** sinh–chấm–chọn–thử–đánh giá–chốt giả thiết & giải pháp cho **cả M1 (Kaggle) lẫn M2 (System Research)**; tích hợp councils ①–⑤, KB, worklog, Decision Log.

**Phạm vi OUT:** pipeline KING 7 nhiệm vụ (TB-06) · decomposition (TB-07) · RWV chi tiết (TB-09) · schema Proposal (TB-11) — TB-14 chỉ **gắn vào** các chỗ đó, không định nghĩa lại.

**Thảo luận giữa TL và ai [EXT — trả lời trực tiếp câu hỏi user]:** Council ⑤ = **KING (chủ trì) + SIVIL + BELI + LISMA + HAN** — đủ 4 vai: người sinh giả thiết, người viết spec thử nghiệm, người chạy thử, người giữ tri thức bối cảnh. Escalate thêm ESCALATED_USER khi verdict CONVERGE đi Proposal (route TB-11) hoặc khi 3 vòng không ra kết quả.

---

## §1. RUBRIC A — CHẤM ĐIỂM CHẤN ĐOÁN `[SRC Z2.1]`

Áp dụng cho: mọi root cause (M2), mọi giả thiết nghiên cứu (M1/M2), mọi claim chẩn đoán trong Diagnostic Report (TB-04 §3.3).

### 1.1 Bảng 5 chiều × thang 0–5 (trọng số cố định)

| Chiều | Trọng số | Câu hỏi chấm | Anchor 0 / 3 / 5 |
|---|---|---|---|
| **D1 Evidence đầy đủ** | 30% | Mọi claim có evidence? | 0: không evidence · 3: một phần file:line + log · 5: 100% claim có file:line + log excerpt + đường tái tạo |
| **D2 Xác nhận nhân-quả** | 25% | Có chứng minh WHY — nhân → quả? | 0: chỉ tương quan · 3: có cơ chế giải thích · 5: **kill-test trong workspace** — vá nguyên nhân → triệu chứng biến mất |
| **D3 Nhất quán** | 15% | Khớp toàn cảnh? | 0: mâu thuẫn code/log · 3: còn 1 điểm chưa đối chiếu · 5: khớp code + log + giải thích 100% triệu chứng quan sát |
| **D4 Tái lập được** | 15% | Người khác chấm lại có khớp? | 0: không ai kiểm · 3: 1 SA độc lập khớp phần lớn · 5: **2 SA blind** cùng kết luận |
| **D5 Độ sâu** | 15% | Đến tầng nào? | 0: triệu chứng · 3: tầng code · 5: code + config/data + nguyên nhân gốc hệ thống |

### 1.2 Công thức & ngưỡng

```
ScoreA = Σ (điểm chiều × trọng số)         // 0.00 – 5.00
CONFIRMED  ≥ 4.0   → được vào Options, được chọn làm primary hypothesis
PROBABLE   3.0–3.9 → được vào Options NHƯNG bắt buộc thêm 1 falsification test (§3 vòng 3)
WEAK       < 3.0   → LOẠI — không được vào Options; ghi worklog lý do loại
```

### 1.3 [EXT] Quy tắc chống gaming-rubric

- **Chấm độc lập:** D4 không do chính SIVIL chấm — 2 SA blind do KING chỉ định (tái dùng cơ chế dual-audit TC-03).
- **Evidence tối thiểu của điểm ≥3:** mọi chiều ≥3 phải dẫn 1 artifact (worklog entry / snapshot / log line) — điểm không có artifact = tự động về 1.
- **Cấm cộng dồn chứng cứ trùng:** cùng 1 file:line không được dùng để lên điểm 2 chiều khác nhau.

---

## §2. RUBRIC B — CHẤM ĐIỂM GIẢI PHÁP `[SRC Z2.2]`

Áp dụng cho: mọi Option trong bảng Options A/B/C (TB-05 §4.3, TB-11 §3), mọi quyết định chọn approach sau SYNTHESIZE (TB-03 §4.3), mọi Proposal item.

### 2.1 Bảng 6 chiều

| Chiều | Trọng số | Đo bằng |
|---|---|---|
| **S1 Phủ bài toán** | 25% | % root cause ≥ PROBABLE được xử lý + khớp Success Criteria của mission (TB-07 task .md) |
| **S2 Impact kỳ vọng** | 15% | số liệu định lượng (vd p95 121s → <10s) + đối chiếu Performance Baselines KB (TB-05 §5) |
| **S3 Rủi ro & hoàn tác** | 20% | risk matrix 4 mức (TB-04 §4.1) + rollback plan + blast radius (module nào bị chạm) |
| **S4 Effort & phức tạp** | 10% | LOC chạm · số hệ thống chạm · giờ ước tính |
| **S5 Context-fit** | 20% | điểm ma trận §5 (≥70% chiều match) + tiền lệ KB (pattern S1–S4 / lesson) + adaptation delta liệt kê đủ |
| **S6 Verify được** | 10% | Verification Plan (a) tay NGAY + (b) benchmark metric + ngưỡng — schema TB-11 §7 |

### 2.2 Ngưỡng xếp loại

```
STRONG       ≥ 4.0   → ứng viên thắng CONVERGE
RECOMMENDED  3.0–3.9 → PHẢI qua POC trong workspace trước khi thắng
CONDITIONAL  2.0–2.9 → chỉ thử khi KHÔNG còn option nào ≥ RECOMMENDED
REJECTED     < 2.0   → loại khỏi bảng Options; ghi lý do vào worklog
```

### 2.3 [EXT] Scorecard kép — kỳ vọng vs thực đo

Mỗi option có **2 scorecard B**: (1) *pre-experiment* — HAN ước lượng khi dựng Options; (2) *post-experiment* — LISMA/HAN chấm lại sau POC với số liệu thật.
- Delta mỗi chiều > 1.0 → **lesson calibration** ghi KB (category Calibration Lesson) — ai ước lệch, chiều nào lệch, lý do.
- Delta S2 > 1.0 lặp lại 2 mission của cùng HAN → HAN tự review ước lượng (anti-pattern "optimism bias").

---

## §3. TOURNAMENT GIẢ THIỆT — 5 VÒNG, TỐI ĐA 3 LẦN LẶP `[SRC Z2.3]`

```
VÒNG 1 GENERATE     SIVIL sinh ≥3 giả thiết / 1 vấn đề (SA matrix TB-03 §5)
                     │  ≤3 giả thiết sinh được → ESCALATE KING (hypothesis nghèo)
                     ▼
VÒNG 2 SCORE-A      Chấm Rubric A độc lập (D4 bởi 2 SA blind)
                     │  WEAK → loại; top-2 đi tiếp; gap top-2 < 0.5 → cả 2 đi tiếp
                     ▼
VÒNG 3 FALSIFY      Mỗi giả thiết: kill-criteria (evidence nào sẽ BÁC BỎ?)
                     BELI viết spec test tối thiểu → LISMA chạy trong workspace
                     │  bị bác bỏ → loại + ghi worklog negative-evidence
                     │  PROBABLE sống sót → nâng lên CONFIRMED (D2 = 5 khi kill-test pass)
                     ▼
VÒNG 4 EXPERIMENT   HAN dựng Options A/B/C — mỗi option kèm scorecard B kỳ vọng (§2.3)
                     LISMA triển khai POC top-2 trong workspace (branch riêng/option)
                     → đo → scorecard B thực đo → delta → lesson calibration KB
                     ▼
VÒNG 5 COUNCIL ⑤    KING + SIVIL + BELI + LISMA + HAN (blocking) phê scorecards → verdict §6
                     │  CONTINUE-ITERATE → quay lại vòng 1 (đém lượt: tối đa 3)
                     ▼
              CONVERGE / PIVOT / DROP
```

**Điều kiện sang vòng kế [EXT — cụ thể hóa]:**
- 1→2: ≥2 giả thiết còn sống sau sinh (kém hơn → escalate).
- 2→3: ≥1 giả thiết ≥ PROBABLE.
- 3→4: ≥1 giả thiết CONFIRMED hoặc ≥2 PROBABLE (để có so sánh).
- 4→5: đủ scorecard kép cho mọi option đã chạy POC.

**Ràng buộc vòng lặp:** tối đa **3 lặp tournament** cho 1 vấn đề [SRC Z2.3]; vòng thứ 3 bắt buộc verdict cuối (CONVERGE/DROP — không CONTINUE nữa) — khớp trần 3 vòng G3 (TB-05) để chống vòng lặp vô hạn.

---

## §4. XÁC MINH (VERIFICATION) — TÍCH HỢP KHÔNG ĐỊNH NGHĨA LẠI

| Việc xác minh | Cơ chế sẵn có dùng lại | TB-14 thêm |
|---|---|---|
| Chẩn đoán đúng | LISMA VERIFYING M2: đối chiếu root cause ↔ evidence (TB-04 §2.2) + KING CP2 | điểm D2 yêu cầu kill-test workspace (nâng chuẩn từ "khớp code ↔ logs" lên "vá → hết triệu chứng") |
| Fix/POC chạy đúng | RWV loop (TB-09) trong workspace branch | branch P-POC-<option> riêng từng option — tách bạch diff để council so |
| Hiệu quả thật | Verification Plan (a) tay NGAY + (b) benchmark DEFERRED (TB-11 §7) | scorecard S6 bắt buộc cả (a)+(b) mới đủ 10 điểm chiều |
| Điểm rubric đúng | Evidence log bắt buộc (DR: claim thiếu evidence bị loại) | anchor artifact cho mọi chiều ≥3 (§1.3) |
| Không phá phần khác | Regression entry + re-test (TB-04 §9.1, TC-04) | scorecard S3 trừ điểm khi thiếu regression test |

---

## §5. MA TRẬN CONTEXT-FIT `[SRC Z2.4]`

### 5.1 Bản ghi áp dụng trong KB (mở rộng schema KB entry — TB-05 §5)

Mỗi pattern/lesson/baseline khi ghi KB **BẮT BUỘC** kèm khối `applicability`:

```json
{
  "context": {
    "module": "llm-gateway",        // module hệ thống
    "protocol_tier": "T2-T3",        // tier/phiên bản protocol áp dụng
    "data_scale": ">=1M events",     // quy mô dữ liệu
    "load_profile": "p95 < 10s",     // profile tải
    "dependencies": ["key-pool", "fallback-chain"],
    "environment": "prod|sandbox|both",
    "time_constraint": "hotfix <= 1h | planned",
    "user_policy": "deploy_mode=auto | proposal-only"
  },
  "pre_conditions":  ["4 NIM key active", "fallback chain bat dau"],
  "adaptation_delta": ["doi timeout 30m → 8m khi rate-limit 429 lien tuc"],
  "contraindication": ["KHONG dung khi single-key (khong co pool)"]
}
```

### 5.2 Protocol kiểm tra (HAN thực hiện khi trajectory reuse giải pháp cũ)

1. **Match:** đếm chiều khớp giữa bối cảnh mission hiện tại ↔ `context` → tỉ lệ match.
2. **Gate:** `match ≥ 70%` AND `100% pre_conditions` AND `0 contraindication` → **APPLICABLE** — `adaptation_delta` trở thành yêu cầu bắt buộc trong spec BELI.
3. **Fail bất kỳ gate** → KHÔNG clone mù giải pháp cũ → vào tournament §3 như giải pháp mới (giải pháp cũ vẫn được vào vòng GENERATE làm 1 ứng viên).
4. Kết quả check ghi worklog: `contextfit: <pattern-id> match <x/8> pre <n/N> contra <0|1> → APPLICABLE|TOURNAMENT`.

### 5.3 [EXT] Context-fit cho 2 mission type

- **M1 (Kaggle):** chiều bối cảnh = dataset profile (size, kiểu feature, target), metric cuộc thi, thời gian còn lại — pattern ensemble áp dụng theo bảng TB-05 §5 ("Weighted avg tốt khi models ít 2–3").
- **M2 (System):** 8 chiều mặc định §5.1 — đặc biệt `environment` và `user_policy` là 2 chiều cấm bỏ qua.

---

## §6. COUNCIL ⑤ — SOLUTION COUNCIL `[SRC Z2.3 vòng 5 + Z2.6]`

### 6.1 Thành phần & quorum

| Vai | Agent | Bắt buộc? |
|---|---|---|
| Chủ trì | KING | ✅ |
| Giả thiết/evidence | SIVIL | ✅ |
| Spec/POC design | BELI | ✅ (G1) |
| Kết quả chạy thử | LISMA | ✅ (nếu vòng 4 đã chạy) |
| KB/context-fit | HAN | ✅ |
| User | ESCALATED_USER | khi verdict = CONVERGE → Proposal, hoặc DROP task T3 |

**Quorum tối thiểu [EXT]:** KING + ít nhất 1 agent mỗi engine có mặt ở vòng đang xét. Thiếu → hoãn, không chấm bớt (thorough-first).

### 6.2 Agenda cố định (5 mục, theo thứ tự)

1. Đối chiếu scorecard kép từng option (kỳ vọng vs thực đo + delta lesson).
2. Rà kill-test: giả thiết thắng có thực sự CONFIRMED (D2=5)?
3. Context-fit check lần cuối (§5.2) cho option thắng.
4. Rà ngân sách vòng: còn lặp tournament không? (≤3).
5. **Verdict** — 1 trong 4, ghi CouncilTranscript (kind=5) + Decision Log KING.

### 6.3 Bảng verdict

| Verdict | Điều kiện | Hành động kế |
|---|---|---|
| **CONTINUE-ITERATE** | điểm đang tăng qua các vòng + còn lượt (<3) | vòng tournament kế — tinh chỉnh giả thiết/option |
| **CONVERGE** | option ≥ 4.0 (STRONG) VÀ gap ≥ 0.5 vs á quân VÀ context-fit đạt | chốt phương án → quyết định deploy (§7) |
| **PIVOT** | 2 vòng liên tiếp điểm đi ngang/giảm | quay theo quy tắc PIVOT TB-06 §8.6/8.7 (Decision Log bắt buộc) |
| **DROP** | 3 vòng không ra giả thiết ≥ PROBABLE | negative result → KB anti-pattern + đóng task (nguồn: negative result hợp lệ) |

**Blocking:** council ⑤ là **cổng chặn** — không được sang deploy/FINALIZE khi chưa có verdict (đồng bộ quy tắc council ②③ — DR council ĐỒNG BỘ blocking).

---

## §7. QUYẾT ĐỊNH TRIỂN KHAI SAU CONVERGE `[SRC Z2.5]`

```
CONVERGE
   │
   ├─ DIRECT-APPLY (triển khai luôn) — HỘI ĐỦ 5 ĐIỀU:
   │    (1) user phê deploy_mode=auto (mission brief / StandingOrder)
   │    (2) risk = LOW
   │    (3) reversible — rollback < 15 phút
   │    (4) tier ≤ T2
   │    (5) blast radius = đơn module
   │    → LISMA apply qua RWV trong workspace → verify → merge → ghi KB
   │      → THÔNG BÁO USER SAU KHI XONG (notification + worklog)
   │
   └─ PROPOSAL (gửi đề xuất) — mặc định, mọi trường hợp thiếu ≥1 điều kiện
        → Proposal P-YYYYMMDD-NNN (schema TB-11) → SELF-DIRECTION
          → timeout 48h/24h + deputy + nhắc 12h (DR-C5)
```

**Bất biến:** quy tắc C1 Phụ lục Z KHÔNG đổi — verify-only mission không tự sinh thay đổi; DIRECT-APPLY chỉ áp cho mission đã có thay đổi được user **phê trước** (deploy_mode=auto). Quyết định DIRECT-APPLY luôn ghi Decision Log: `deploy_route=direct, risk=LOW, rollback<15m, tier=T2, blast=llm-gateway, auth=mission-brief#deploy_mode`.

---

## §8. SCHEMAS & DATA (đóng góp vào TB-13 §3)

```prisma
model HypothesisRecord {
  id            String  @id @default(cuid())
  missionId     String
  problemStmt   String                     // 1 vấn đề được tournament
  hypothesis    String                     // nội dung giả thiết
  scoreAJson    String  @default("{}")     // {D1..D5, score, grade}
  killCriteria  String?                    // evidence nào bác bỏ
  killTestResult String?                   // PASS (sống) | FAIL (bác bỏ) + evidence
  status        String                     // GENERATED|SCORING|FALSIFYING|CONFIRMED|REJECTED|KILLED
  round         Int     @default(1)        // vòng tournament 1..3
  createdAt     DateTime @default(now())
}

model ExperimentRecord {
  id             String  @id @default(cuid())
  missionId      String
  optionId       String                    // A/B/C...
  hypothesisRef  String?                   // HypothesisRecord id
  specPath       String?                   // spec BELI
  branchName     String?                   // P-POC-<option>
  scoreExpected  String  @default("{}")    // scorecard B pre
  scoreMeasured  String?                   // scorecard B post
  deltaJson      String?                   // delta + calibration lesson refs
  metricsJson    String?                   // số liệu đo (a) manual / (b) benchmark
  status         String                    // DRAFT|SPEC|POC|MEASURED|SCORED
  createdAt      DateTime @default(now())
}
```

`CouncilTranscript` (TB-13 §3): dùng thêm `kind = 5` cho council ⑤. `ResearchKBEntry`: thêm cột JSON `applicabilityJson` (khối §5.1). `ModelSwitchEvent`: không đổi.

**Worklog schema thêm 2 khối [EXT]:** `hypotheses: [{id, scoreA, grade}]` trong entry research; `contextfit: {patternId, match, verdict}` khi reuse KB.

---

## §9. ERROR HANDLING & EDGE CASES

| # | Tình huống | Xử lý |
|---|---|---|
| E1 | SIVIL sinh được <3 giả thiết | ESCALATE KING — "hypothesis nghèo" → KING nới rộng vấn đề hoặc hạ ambition (Decision Log) |
| E2 | 2 SA blind chấm D4 lệch nhau >2 điểm | vòng 3 đánh giá lại từ đầu + SIVIL trình CẢ 2 bản chấm lên council ⑤ (khớp cơ chế TB-03 §5.3 dual-interpretation) |
| E3 | Kill-test không thực hiện được (không tái tạo được triệu chứng) | D2 tối đa = 3 (chỉ cơ chế giải thích); giả thiết tối đa PROBABLE — không bao giờ CONFIRMED |
| E4 | Scorecard thực đo thiếu (POC fail trước khi đo) | option về CONDITIONAL; nếu fail do infra → retry 1 lần; fail do bản chất → REJECTED + negative-evidence |
| E5 | User bỏ phiếu deploy_mode không rõ (mission brief mơ hồ) | mặc định Proposal (fail-safe) — hỏi 1 câu đúng chỗ theo quy tắc TC-01 |
| E6 | Tournament vòng 3 vẫn 2 option-gap <0.5 | council ⑤ chọn theo S3 (rủi ro thấp hơn thắng) — tie-break an toàn, KHÔNG mở vòng 4 |
| E7 | Giải pháp cũ KB match 100% nhưng từng bị REJECTED ở mission khác | contraindication mới được ghi vào KB sau mission REJECT (EVOLVE) — lần check sau sẽ chặn |
| E8 | M1 không có "root cause" (cuộc thi không phải bug) | Rubric A áp cho giả thiết approach (vd "leakage nằm ở target encoding"); kill-test = experiment nhỏ CV |
| E9 | Council ⑤ thiếu quorum (1 engine vắng) | hoãn + reminder; quá 30 phút → deputy engine (SIVIL↔HAN thay nhau, DR-C5 pattern) |
| E10 | Option thắng chạm nhiều module (blast radius lớn) | tự động rơi khỏi DIRECT-APPLY (vi phạm điều kiện 5) → Proposal — KHÔNG cắt nhỏ để né rule |

---

## §10. E2E TEST CASES MỚI (đóng góp vào TB-12 §3.2)

| TC | Kịch bản | Hành vi đúng | Verify | Phủ |
|---|---|---|---|---|
| **TC-15** | Tournament: 3 giả thiết, 1 cái không có kill-criteria thiết kế được | Giả thiết đó tối đa PROBABLE, KHÔNG thể CONFIRMED; nếu vào vòng 4 phải kèm falsification plan | DB: `HypothesisRecord.killCriteria` NOT NULL khi status CONFIRMED | §1.2/§3 |
| **TC-16** | Scorecard kỳ vọng 4.2 — thực đo 2.1 | Delta >1 → lesson calibration ghi KB; council verdict CONTINUE-ITERATE (không CONVERGE) | KB có entry Calibration; CouncilTranscript kind=5 verdict đúng | §2.3/§6.3 |
| **TC-17** | Reuse pattern KB có pre-condition "4 key active" nhưng mission chạy single-key | HAN chặn APPLICABLE → giải pháp vào tournament như ứng viên mới kèm adaptation | worklog có khối `contextfit` verdict TOURNAMENT | §5.2 |
| **TC-18** | CONVERGE winner: risk LOW + deploy_mode=auto + T2 + rollback 10m + đơn module → DIRECT-APPLY; kịch bản đôi: risk HIGH mọi điều kiện khác đúng | (a) apply + verify + KB + notify user; (b) **KHÔNG direct** → Proposal | Decision Log dòng deploy_route; Proposal DB status SUBMITTED | §7 |

---

## §11. ACCEPTANCE CRITERIA (checklist verify ≥ 10 items)

- [ ] **AC1.** Rubric A: 5 chiều × đúng trọng số 30/25/15/15/15; ngưỡng 4.0/3.0 đúng §1.2.
- [ ] **AC2.** Rubric B: 6 chiều × đúng trọng số 25/15/20/10/20/10; 4 ngưỡng §2.2.
- [ ] **AC3.** Mọi chiều ≥3 có anchor artifact — thiếu artifact tự về 1 (§1.3).
- [ ] **AC4.** Tournament: đủ 5 vòng, điều kiện sang vòng đúng §3, trần 3 lặp.
- [ ] **AC5.** D4 luôn do 2 SA blind chấm — SIVIL không tự chấm D4.
- [ ] **AC6.** Kill-test pass → D2=5 → CONFIRMED; không kill-test → tối đa PROBABLE.
- [ ] **AC7.** Scorecard kép (kỳ vọng + thực đo) bắt buộc mọi option qua POC.
- [ ] **AC8.** Council ⑤: 5 thành phần + quorum + 5 agenda + 4 verdict + blocking.
- [ ] **AC9.** Context-fit: khối applicability 8 chiều + 3 gate (70%/100%/0) + ghi worklog.
- [ ] **AC10.** DIRECT-APPLY: hội đủ 5 điều kiện + Decision Log + notify user; thiếu 1 → Proposal.
- [ ] **AC11.** Schemas: HypothesisRecord + ExperimentRecord + kind=5 + applicabilityJson.
- [ ] **AC12.** TC-15→TC-18 pass trong bộ E2E (TB-12 cập nhật 14→18 TC).
- [ ] **AC13.** Không [Q] mở — mọi quyết định truy được về Phụ lục Z2 (dòng 4684–4745).

## §12. DECISIONS — [DECIDED v1.5] (không mở [Q])

| Quyết định | Chốt |
|---|---|
| Rubric tồn tại ở đâu | 2 rubric riêng (A chẩn đoán / B giải pháp) — Phụ lục Z2 + TB-14, không trộn với TRIAGE 3 điểm (đó là chấm độ phức tạp task, việc khác) |
| Ai chấm | SIVIL đề xuất + 2 SA blind chấm D4; HAN chấm B; council ⑤ phê chung — KING không tự chấm (chỉ chủ trì) |
| Bao nhiêu giả thiết | ≥3/vấn đề; top-2 đi tiếp; gap <0.5 → cả 2 |
| Trần vòng | 3 lặp tournament; vòng 3 bắt buộc verdict cuối |
| Tie-break cuối | S3 (rủi ro thấp) thắng — an toàn trước |
| Deploy rule | 5 điều kiện DIRECT-APPLY (hội ĐỦ); default Proposal — C1 không đổi |
| Council số | ⑤ là council thứ 5, kind=5, blocking như ②③ |
| M1 có dùng? | Có — Rubric A áp cho hypothesis approach; kill-test = CV experiment nhỏ |

## Phụ lục A — TRACEABILITY MATRIX

| Nguồn | Section TB-14 |
|---|---|
| Phụ lục Z2 §Z2.1 (dòng 4690–4703) | §1 |
| Phụ lục Z2 §Z2.2 (dòng 4705–4720) | §2 |
| Phụ lục Z2 §Z2.3 (dòng 4722–4740) | §3, §4, §6 |
| Phụ lục Z2 §Z2.4 (dòng 4730–4736) | §5 |
| Phụ lục Z2 §Z2.5 (dòng 4738–4742) | §7 |
| TB-03 §4.3/§4.4 (SYNTHESIZE + council ②) | §3 vòng 1–2 tích hợp |
| TB-04 §2.2/§3.3 (VERIFYING M2 + Diagnostic Report) | §1, §4 |
| TB-05 §4.3/§5 (Options + KB categories) | §2, §5 |
| TB-06 §8 (DECIDE/PIVOT) | §6.3 PIVOT/DROP |
| TB-09 (RWV) | §4 hàng 2 |
| TB-11 §7 (Verification Plan) | §2.1 S6, §4 |
| TB-12 §3.2 (14 TC) | §10 (thêm 4 TC) |

---

*TB-14 tạo Task 23 (2026-09-01) theo yêu cầu user trực tiếp. Tập blueprint hiện 14 file TB + 3 companion. Khi sửa: append-only + cập nhật README + đồng bộ 3 vị trí (docs/blueprints · upload/blueprints · tmo-app/docs/blueprints) + push GitHub.*
