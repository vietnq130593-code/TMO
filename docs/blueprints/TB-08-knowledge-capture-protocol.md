# TB-08 — KNOWLEDGE CAPTURE PROTOCOL (GHI TRI THỨC NGAY TRONG VẬN HÀNH)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 Kaggle + M2 System Research)**
> Nguồn chính: `upload/ai-team-workflow.md` — section 📚 KNOWLEDGE CAPTURE (dòng 1718–1825)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-c) | Biên soạn: Mr. Robot (Z.ai Code) — nhóm C (Protocols ngang)
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.
> Quy ước chung: TB-00 §1 (roster · model stack · mission · Live System vs Workspace) + §5 ([SRC]/[EXT]/[Q] *(→ từ v1.3: [Q] đã chuyển thành [DECIDED v1.3])*)

## §0. 🎯 MỤC ĐÍCH & PHẠM VI `[TB-08 §0 ← suy từ nguồn dòng 1718–1825 + TB-00 §2]` `[EXT]`

- **Mục đích:** chuẩn hóa cách **toàn team** (NEMESIS/SIVIL/BELI/LISMA/HAN) ghi tri thức vào **TEAM KNOWLEDGE BASE (KB)** ngay trong vận hành — tri thức học từ M1 (Kaggle) và M2 (System Research TMO) là **tài sản chung**, không thất lạc khi task pivot hoặc dừng giữa chừng.
- **Tính chất protocol ngang:** áp cho **mọi tier** (SIMPLE/MEDIUM/COMPLEX — kể cả tier không qua G3), **mọi group** (G1/G2/G3), **cả 2 mission** (M1/M2) — chạy song song với mọi pipeline của TB-02.
- **Ai đọc:** 5 agents runtime (§2, §4, §7 nhúng vào Instructions) · kỹ sư triển khai (cài KB store + ma trận quyền ghi) · user (review cơ chế tri thức).
- **Không chứa:** cấu trúc lưu trữ KB + vòng G3 EVOLVE (→ TB-05); vận hành council chi tiết + Council Summary template (→ TB-06 §10); worklog schema đầy đủ (→ TB-09 §4).
- **File liên quan:** TB-05 (cấu trúc lưu trữ KB + G3 EVOLVE) · TB-06 §10/§7.8/§9.6 (council chủ trì; MONITOR & Knowledge Capture; KB tại FINALIZE) · TB-03 §4.4 (council ② = bước SYNC của G1) · TB-04 §8.3 (KB Candidates của LISMA) · TB-09 §4 (worklog trường "KB Candidates").

## §1. 🧠 NGUYÊN TẮC & 3 LỖ HỔNG THIẾT KẾ CŨ `[TB-08 §1 ← nguồn dòng 1720–1734]` `[SRC]`

**Nguyên tắc nền tảng** (dòng 1720): team research là **lực lượng tri thức** của hệ thống — mọi điều học được từ Kaggle (M1) và từ nghiên cứu chính TMO (M2) đều phải trở thành **tài sản chung của team**. **Phát hiện hay → ghi vào Knowledge Base NGAY trong cùng phiên làm việc — không chờ tới cuối chu trình.**

Thiết kế cũ: chỉ HAN ghi KB ở cuối chu trình G3 (EVOLVE) — kéo theo 3 lỗ hổng:

```
┌────────────────────────────────────────────────────────────┐
│  3 LỖ HỔNG CỦA THIẾT KẾ CŨ (chỉ HAN ghi KB ở cuối G3)      │
│  ① Tri thức phát sinh ở TL/G1/G2 phải CHỜ tới G3 mới ghi   │
│     → thất lạc nếu task pivot / dừng giữa chừng            │
│  ② Tier SIMPLE / MEDIUM không đi qua G3                    │
│     → tri thức của những task này KHÔNG BAO GIỜ vào KB     │
│  ③ Thảo luận NEMESIS ↔ SIVIL không được lưu lại              │
│     → insight từ thảo luận mất ngay khi kết thúc          │
└────────────────────────────────────────────────────────────┘
```

| Lỗ hổng | Hậu quả thực tế | Cơ chế vá (thiết kế mới) |
|---|---|---|
| ① Tri thức chờ tới G3 | task pivot / dừng giữa chừng → mất tri thức TL/G1/G2 | NEMESIS/SIVIL ghi trực tiếp tại MONITOR/DECIDE/FINALIZE/SYNTHESIZE (§2) |
| ② Tier không qua G3 | task T1/T2 không sinh entry nào | NEMESIS ghi tại MONITOR + FINALIZE — quy tắc vàng #2 (§7) |
| ③ Thảo luận không lưu | council xong là mất insight | Research Council: discussion summary vào worklog + KB entries NGAY (§3) |

## §2. 🔐 BẢNG QUYỀN GHI KB — 5 AGENTS `[TB-08 §2 ← nguồn dòng 1736–1746]` `[SRC]`

| Agent | Quyền ghi KB | Thời điểm capture (nguồn) |
|---|---|---|
| **NEMESIS** (TL) | **Ghi trực tiếp** | MONITOR (đọc worklog) / DECIDE (pivot lessons) / FINALIZE / Research Council |
| **SIVIL** (G1 Sub-Orch) | **Ghi trực tiếp** | SYNTHESIZE (insight từ sub-agents) / Research Council |
| **HAN** (G3) | **Ghi trực tiếp + CURATOR** | Chu trình G3 (như cũ) + consolidate/dedup entries của cả team |
| **BELI** (G1 Coder) | **Đề xuất qua worklog** | Edge cases + patterns gặp khi code → trường "KB Candidates" |
| **LISMA** (G2) | **Đề xuất qua worklog** | Bug patterns + root cause insight khi review → trường "KB Candidates" |

**Vì sao BELI/LISMA không ghi trực tiếp** (dòng 1746): findings của họ **cần được xác nhận** — NEMESIS/SIVIL/HAN đọc "KB Candidates" trong worklog và **quyết định ghi** (entry nào cũng phải có evidence). Agent duyệt chịu trách nhiệm entry → tri thức chưa kiểm chứng không lọt vào KB.

- **HAN kiêm Curator:** curate là trách nhiệm dọn dẹp (dedup/merge/retire — §4 Bước 4), KHÔNG phải độc quyền ghi; mọi agent được đọc KB mọi lúc (quy tắc vàng #4).
- **Quyền gắn ROLE, không gắn model:** model chính Kimi-k3 hay fallback (DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3) thì quyền KB không đổi (TB-00 §1.2).

`[EXT]` Áp theo pha pipeline (khớp TB-02/TB-06):

| Pha pipeline | Ai có thể sinh KB entry trong pha này |
|---|---|
| DECOMPOSE → ASSIGN (council ①) | NEMESIS, SIVIL |
| G1 chạy — SYNTHESIZE (council ②) | SIVIL (trực tiếp); BELI (candidate) |
| G2 chạy — duyệt tại CP2 | LISMA (candidate — NEMESIS/SIVIL/HAN duyệt) |
| G3 chạy — EVOLVE | HAN (trực tiếp + curate) |
| Mọi Checkpoint / FINALIZE | NEMESIS (verify + chốt) |

## §3. 🏛️ RESEARCH COUNCIL — NGUỒN TRI THỨC SỐNG `[TB-08 §3 ← nguồn dòng 1748–1771]` `[SRC]`

NEMESIS ↔ SIVIL tiến hành **nhiều thảo luận** trong suốt quá trình vận hành — nơi tri thức được **phát hiện, thách thức và chốt**. Box nguồn đầy đủ (4 thời điểm + nội dung + output): **TB-06 §10.1**; council ② trong G1 workflow: **TB-03 §4.4**.

| Thời điểm (4 cố định — nguồn) | Nội dung thảo luận | Output |
|---|---|---|
| ① Sau DECOMPOSE — trước ASSIGN | Challenge hypotheses: NEMESIS hỏi, SIVIL đáp bằng findings; đối chiếu cách chia parts/tier với KB "đã có chưa?" | Discussion summary (ghi vào worklog) + KB entries mới (KB Write Protocol §4) |
| ② Sau SYNTHESIZE — trước khi BELI code | Chốt specs; insight từ sub-agents; chốt tri thức mới → ghi KB NGAY | như trên |
| ③ Khi G1 ESCALATE | Phân tích blocking issue / 2 interpretation SA mâu thuẫn (TB-03 §5.3) | như trên |
| ④ Tại mỗi Checkpoint | Review findings/metrics vừa verify; challenge hướng đi + chốt tri thức ảnh hưởng DECIDE — council KHÔNG quyết thay DECIDE (guard dưới; TB-02 §3.3) | như trên |

> Guard `[EXT — đồng bộ TB-06 §10.3]`: **council KHÔNG quyết định thay DECIDE** — council chỉ CHALLENGE (thách thức giả thuyết/findings) + chốt tri thức; mọi quyết định pipeline vẫn là của NEMESIS qua DECIDE (TB-02 §3.3), council chỉ cung cấp thảo luận/tri thức đầu vào cho DECIDE.

Liên hệ TB-08: council là **kênh sinh tri thức chính** — mọi thảo luận kết thúc bằng câu hỏi **"Có gì KB chưa có?"** (quy tắc vàng #5, §7); tri thức council lưu chủ yếu vào category `Research Insights` (§6). Council ④ trùng thời điểm READ/VERIFY của RWV loop (**TB-09 §2–§3**) — NEMESIS vừa verify hướng nghiên cứu vừa chốt tri thức trong cùng phiên.

## §4. ✍️ KB WRITE PROTOCOL — 4 BƯỚC `[TB-08 §4 ← nguồn dòng 1774–1789]` `[SRC]`

```
┌────────────────────────────────────────────────────────────┐
│  BƯỚC 1 — SEARCH   Tra KB theo category + keywords:        │
│                     → Đã có → bỏ qua (hoặc bổ sung        │
│                       evidence nếu làm entry mạnh hơn)     │
│                     → Chưa có → sang Bước 2                │
│  BƯỚC 2 — FORMAT   Viết entry theo KB Entry Schema (§5):   │
│                     insight ngắn + actionable;             │
│                     evidence BẮT BUỘC                       │
│  BƯỚC 3 — WRITE    NEMESIS/SIVIL/HAN: ghi trực tiếp           │
│                     BELI/LISMA: để trong worklog trường    │
│                     "KB Candidates" (duyệt theo §8)        │
│  BƯỚC 4 — CURATE   HAN consolidate trong chu trình G3 gần  │
│                     nhất: dedup (trùng → merge) /          │
│                     retire (lỗi thời → RETIRED)            │
└────────────────────────────────────────────────────────────┘
```

*(Box trên là bản chuẩn toàn tập — TB-05 §7.3 trích nguyên văn, chỉ điều chỉnh cross-ref nội bộ theo ngữ cảnh TB-05.)*

Quy tắc runtime bổ sung `[EXT]`:

| Bước | Quy tắc thêm (không mâu thuẫn nguồn) |
|---|---|
| SEARCH | Tra 2 khóa: category đích + 3–5 keyword của insight; entry cũ yếu hơn → merge evidence vào entry cũ, không tạo entry song song cùng nội dung |
| FORMAT | 1 insight = 1 câu = 1 entry; entry ghép nhiều insight → tách trước khi ghi |
| WRITE | Agent ghi trực tiếp chịu trách nhiệm entry (Source = tên mình); BELI/LISMA đi theo flow §8 |
| CURATE | Chỉ HAN được curate; task T1/T2 không qua G3 → entries status NEW chờ chu trình G3 gần nhất của task bất kỳ — không chặn task đang chạy |

✅ *(đồng bộ tham chiếu — đã xử lý tại tổng duyệt Task 8)* TB-06 §10.3 đã trỏ đúng "TB-08 §4" cho KB Write Protocol (TB-06 dòng 998) — không còn trỏ "TB-08 §3". **[DECIDED v1.3]** Chu kỳ CURATE: **định kỳ KÉP (3 mốc):** (a) mỗi ~10 entry NEW; (b) cuối mỗi mission; (c) định kỳ 7 ngày nếu KB còn entry NEW — HAN chủ trì, không cần chờ task T3 (✅ chốt theo DECISION-RECORD v1.3 — TB-08 Q1).

## §5. 📇 KB ENTRY SCHEMA + 3 VÍ DỤ THẬT `[TB-08 §5 ← nguồn dòng 1791–1811]` `[SRC]`

Template chuẩn (mọi entry, mọi agent ghi):

```markdown
## KB Entry
- ID: KB-YYYYMMDD-NNN
- Category: [category có sẵn của KB (xem cấu trúc lưu trữ — TB-05)
             hoặc Research Insights (mới)]
- Insight: [1 câu — ngắn, actionable]
- Evidence/Context: [file:line | log excerpt | metric | discussion ref]
- Source: [NEMESIS/SIVIL/BELI/LISMA/HAN + thời điểm phát hiện]
- Mission: [M1 | M2]
- Status: NEW → CURATED → (RETIRED)
```

Quy tắc ID `[EXT]`: NNN tăng dần trong 1 ngày; không tái dùng số của entry đã RETIRED; ID immutable — merge/retire không đổi ID entry còn sống (entry bị gộp được tham chiếu trong evidence).

3 ví dụ entry thật (nguồn dòng 1807–1811 — giữ nguyên):

| ID | Category | Insight | Evidence | Source | Mission |
|---|---|---|---|---|---|
| KB-20250612-001 | Config Lessons | Neo4j Aura: user = instance ID (8-hex), không phải luôn là "neo4j" | AuraDB handshake: user "neo4j" 401 / instance ID 200 | NEMESIS (MONITOR) | M2 |
| KB-20250612-002 | System Anti-Patterns | LLM key 4xx → KHÔNG retry mù — fail-fast ngay | log 121s (retry mù) vs 6.2s (fail-fast) | LISMA → HAN | M2 |
| KB-20250612-003 | Research Insights | Decompose audit hệ thống theo 4 branch (hiện trạng → điểm yếu → pattern → feasibility) cho coverage đủ | Discussion ② Research Council — task audit memory | SIVIL | M2 |

Cách đọc 3 ví dụ: **(1)** NEMESIS tự ghi lúc MONITOR — quyền trực tiếp; **(2)** LISMA đề xuất qua KB Candidates, HAN duyệt → Source ghi dạng "LISMA → HAN" (chuẩn Source cho candidate được duyệt — §8); **(3)** SIVIL chốt từ council ② → rơi vào category Research Insights.

## §6. 🗂️ CATEGORY MỚI — RESEARCH INSIGHTS `[TB-08 §6 ← nguồn dòng 1813–1815]` `[SRC]`

Tri thức **phương pháp nghiên cứu**: cách decompose hiệu quả, exploration strategy, discussion outcomes, cách verify claim. Đây là category lưu chính những gì **Research Council đúc kết** — tri thức về **cách nghiên cứu**, tách biệt với tri thức về **nội dung** (Kaggle/System). Cấu trúc bảng lưu trữ các category M1/M2 do TB-05 định nghĩa; TB-08 chỉ bổ sung category này đúng nguồn dòng 1797.

| Phân tách | Tri thức nội dung | Tri thức phương pháp (Research Insights) |
|---|---|---|
| Trả lời câu hỏi | "Cái gì đúng với data / hệ thống này?" | "Cách nghiên cứu cái gì hiệu quả?" |
| Category chứa | M1: Data Preprocessing, Model Training, Ensemble, Anti-Patterns · M2: System Patterns, System Anti-Patterns, Config Lessons, Performance Baselines | Research Insights |
| Sinh từ | Findings/bugs/fixes của G1/G2/G3 | Council ①–④, pivot lessons (DECIDE), verify outcomes |
| Ví dụ | "Target encoding cần K-Fold" | "Decompose audit theo 4 branch cho coverage đủ" (KB-20250612-003) |

## §7. 🏆 5 QUY TẮC VÀNG `[TB-08 §7 ← nguồn dòng 1817–1823]` `[SRC]`

| # | Quy tắc (nguồn) | Diễn giải runtime | Cơ chế đảm bảo |
|---|---|---|---|
| 1 | **Ghi ngay, không hoãn** | tri thức phát hiện hôm nay không đợi tới chu trình sau | KB Write Protocol chạy trong cùng phiên; council chốt xong ghi NGAY |
| 2 | **Mọi tier đều capture** | SIMPLE/MEDIUM không qua G3 → NEMESIS ghi tại MONITOR + FINALIZE | bảng quyền §2 + reminder trong MONITOR (TB-06 §7.8) |
| 3 | **Evidence trước khi ghi** | insight không có evidence/context = không ghi (giữ KB sạch) | Bước 2 FORMAT chặn; CURATE soi lại |
| 4 | **KB là của team** | HAN curate nhưng không độc quyền; NEMESIS/SIVIL ghi trực tiếp, BELI/LISMA đề xuất | bảng quyền §2 — mọi agent đọc KB tự do |
| 5 | **Research Council là nguồn tri thức sống** | mọi thảo luận NEMESIS ↔ SIVIL kết thúc bằng: "Có gì KB chưa có?" | Council Summary bắt buộc mục "KB entries sinh ra" (TB-06 §10.2) |

## §8. 🔄 FLOW "KB CANDIDATES" — BELI/LISMA → DUYỆT → KB `[TB-08 §8 ← mở rộng từ nguồn dòng 1743–1746, 1785]` `[EXT]`

Nguồn chỉ định: BELI/LISMA để candidate trong worklog; NEMESIS/SIVIL/HAN đọc và quyết định ghi. Flow chuẩn hóa:

```
BELI (khi code) / LISMA (khi review)
   │ ghi vào worklog — trường "KB Candidates"
   │ (format TB-04 §8.3: insight 1 câu + loại + evidence + mission)
   ▼
3 CỔNG DUYỆT — ai đọc, ở đâu:
   NEMESIS  — tại Checkpoint (MONITOR) hoặc FINALIZE
   SIVIL — tại SYNTHESIZE / council ② (candidate của BELI)
   HAN   — tại G3 Phase EVOLVE (đầu vào tự nhiên của G3)
   ▼
Quyết định: GHI / BỎ / YÊU CẦU BỔ SUNG EVIDENCE
   │ nếu GHI → KB Write Protocol §4 (SEARCH → FORMAT → WRITE)
   ▼
Entry vào KB — Source = "BELI/LISMA → <agent duyệt>"
   (mẫu nguồn: KB-20250612-002 = "LISMA → HAN")
```

Quy tắc `[EXT]`:

| # | Quy tắc | Lý do |
|---|---|---|
| K1 | Candidate phải có evidence ngay trong worklog (file:line / log excerpt / metric) — không evidence = không đủ điều kiện duyệt | quy tắc vàng #3 |
| K2 | 1 candidate do đúng 1 agent duyệt — không ghi trùng 2 lần | Bước SEARCH chống trùng |
| K3 | Candidate bị BỎ → agent đề xuất được phản hồi 1 dòng lý do trong worklog checkpoint kế (không im lặng) | giữ động lực đề xuất |
| K4 | SLA: candidate không được để qua 2 checkpoint liên tiếp không ai duyệt → NEMESIS xử lý bắt buộc tại checkpoint kế | chống thất lạc — vá tinh thần lỗ hổng ① |
| K5 | Candidate được GHI thì giữ nguyên văn insight (chỉ chuẩn format) — người duyệt chịu trách nhiệm entry | minh bạch nguồn gốc tri thức |

## §9. ✅ ACCEPTANCE CRITERIA `[TB-08 §9]`

Checklist verify khi triển khai protocol:

- [ ] AC1 — Protocol áp được cho MỌI tier × group × mission — không nhánh pipeline nào bị loại khỏi capture (§0).
- [ ] AC2 — 3 lỗ hổng thiết kế cũ được nêu đúng nguồn + mỗi lỗ hổng có cơ chế vá tương ứng (§1).
- [ ] AC3 — Bảng quyền 5 agent khớp nguồn: NEMESIS/SIVIL/HAN trực tiếp, HAN kiêm CURATOR, BELI/LISMA chỉ đề xuất (§2).
- [ ] AC4 — Lý do BELI/LISMA không ghi trực tiếp được ghi rõ: findings cần xác nhận + evidence bắt buộc (§2).
- [ ] AC5 — Research Council đủ 4 thời điểm ①–④ đúng nguồn; tham chiếu TB-06 §10 + TB-03 §4.4 không mâu thuẫn (§3).
- [ ] AC6 — KB Write Protocol đủ 4 bước đúng thứ tự SEARCH → FORMAT → WRITE → CURATE, đúng ngữ nghĩa từng bước (§4).
- [ ] AC7 — KB Entry Schema đủ 7 trường + vòng đời Status NEW → CURATED → RETIRED (§5).
- [ ] AC8 — 3 ví dụ entry thật giữ nguyên dữ liệu nguồn (Neo4j instance ID / fail-fast 121s → 6.2s / decompose 4 branch) (§5).
- [ ] AC9 — Category Research Insights được định nghĩa + bảng tách tri thức phương pháp vs nội dung (§6).
- [ ] AC10 — 5 quy tắc vàng đủ, đúng nguyên văn tinh thần nguồn (§7).
- [ ] AC11 — Flow KB Candidates đủ 5 phần: ai ghi, 3 cổng duyệt, quyết định, Source = "BELI/LISMA → <agent duyệt>", SLA (§8).
- [ ] AC12 — Mọi section có marker `[TB-08 §n ← nguồn dòng a–b]` + nhãn [SRC]/[EXT]/[Q] (Phụ lục A).

## PHỤ LỤC A — TRACEABILITY MATRIX

| Section nguồn (dòng) | Nội dung nguồn | Section TB-08 | Mức |
|---|---|---|---|
| 1718–1720 | Nguyên tắc lực lượng tri thức — ghi ngay cùng phiên | §1 | [SRC] |
| 1722–1734 | Thiết kế cũ + 3 lỗ hổng | §1 | [SRC] |
| 1736–1746 | Bảng quyền ghi KB 5 agents + lý do BELI/LISMA | §2 | [SRC] |
| 1748–1771 | Research Council — 4 thời điểm, nội dung, output | §3 | [SRC] |
| 1774–1789 | KB Write Protocol 4 bước | §4 | [SRC] |
| 1791–1811 | KB Entry Schema + 3 ví dụ thật | §5 | [SRC] |
| 1797, 1813–1815 | Category mới Research Insights | §6 | [SRC] |
| 1817–1823 | 5 quy tắc vàng | §7 | [SRC] |
| 1743–1746, 1785 | KB Candidates trong worklog — duyệt rồi mới ghi | §8 | [EXT] (flow chuẩn hóa) |
| TB-00 §1/§2/§5 + TB-05/TB-06/TB-03/TB-04/TB-09 | Quy ước tập + tham chiếu ngang | header, §0, §2–§8 | [EXT] |

**[DECIDED v1.3] Cả 2 câu hỏi mở của file đã chốt:** (1) chu kỳ curate định kỳ KÉP (~10 entry NEW · cuối mission · 7 ngày — HAN chủ trì); (2) KB lưu theo kiến trúc 3 lớp ✅ DR-C6 (SQLite/Prisma canonical + snapshot .md multi-file + index; Live read-only — khớp TB-05 §11 Q3/Q5). *(Lịch sử: [Q] cũ "đồng bộ tham chiếu TB-06 §10.3 → TB-08 §4" đã xử lý tại tổng duyệt Task 8 — TB-06 dòng 998 đã trỏ đúng.)*
