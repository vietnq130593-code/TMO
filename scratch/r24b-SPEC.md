# SPEC R24-b — GHOST UI TOPOLOGY BRAIN-D "TRI THỨC" TRONG TAB BRAIN (§8.5 mốc a)

Task ID: R24-b. Repo /home/z/tmo-app ("The Magnum Opus" — Next.js 16 App Router + TS strict + Tailwind + shadcn/ui). App chạy pm2 (`theopusflashlite`, `next dev` port 3000, HOT-RELOAD — KHÔNG restart pm2 / build). Tab BRAIN (module Smolab) hiện có 3 SECTION dọc: (1) Chọn não & kiến trúc — selector từ BRAIN_REGISTRY + lifecycle badge NGỦ/THỨC/ACTIVE + planned.layers hiển thị cả khi dormant; (2) Đài quan sát não — BrainStage topology SVG "đường dây ánh sáng"; (3) Bảng thông số — Training Console/Tham số runtime/Nhật ký tinh chỉnh/Hàm & công thức.

## BỐI CẢNH (đọc trước)
1. 40 dòng cuối /home/z/my-project/worklog.md (mục R23).
2. /home/z/tmo-app/docs/BLUEPRINT-EVO-NAO-P1-P5.md — ĐỌC KỸ §8.5 TOÀN BỘ (spec bạn triển khai) + §8.3 (3 tầng action space).

Nhiệm vụ: não thứ 4 Brain-D "Tri Thức" xuất hiện trong tab BRAIN NGAY từ D1 dưới dạng GHOST (spec khởi điểm + tiến độ thức tỉnh kép) — KHÔNG đụng đường runtime/BrainModel (topology là HIỂN THỊ; mọi áp dụng vẫn qua A1/H7).

## BƯỚC 1 — ĐỌC CODE HIỆN TẠI
- src/lib/brain/registry.ts (BRAIN_REGISTRY 3 não, BrainSpec, BrainLayerSpec, BRAIN_TRAINABLE_KEYS, computeLabelTotal)
- src/lib/brain/stage-geometry.ts (THUẦN — buildStageLayout cột tuần tự, STAGE_LIMITS, r90 pin từng số)
- src/components/smolab/brain-tab.tsx · brain-studio.tsx · brain-stage.tsx (tìm đúng đường dẫn rg -l "BrainStage|brain-studio" src/components) — SECTION 1 render selector từ registry; planned.layers → StageColumn; lifecycle badge; SurrogateHead 3 TAB Brain-B (precedent đa đầu ra); responsive NEURAL_DESKTOP_BREAKPOINT
- src/lib/learning/neural-types.ts (TUNING_SPECS — cờ #32 kb_consult_log cuối mảng; node 'kb-access'; NEURAL_NODES/NEURAL_EDGES)
- src/app/api/brain/route.ts (safeCount pattern; counts map keys: evalResults/agentRuns/qEntries/verdicts)
- Tests pin: tests/r90-* (geometry) + rg -n "TUNING_SPECS" tests/ tìm mọi test pin số cờ (convention "PIN UPDATE" — cập nhật pin khi thêm cờ)

## BƯỚC 2 — IMPLEMENT

### 2.1 registry.ts
- `BrainKey` thêm 'knowledge'.
- `BrainLayerSpec` thêm optional: `headGroup?: 'mode' | 'retrieval' | 'meta'` + `groupLabel?: string` (additive).
- Entry thứ 4 BRAIN_REGISTRY (sau policy):
  - key 'knowledge', name 'Tri Thức', title 'Brain-D · Tri Thức (Knowledge Policy Head)'
  - role: 'Policy head quyết định CÁCH dùng KB trong từng tác vụ — chế độ vận dụng (context-block/structured-subgraph/traversal-plan) + tham số truy xuất + meta (skip/writeback). D1 LOG-ONLY đã sống; thức tỉnh D2 (≥100 log) / D3 (≥300 log có Outcome*).'
  - phase 'BRAIN-D3', flag 'RUNTIME_KNOWLEDGE', flagTuningKey 'runtime_knowledge'
  - inputModes ['kb-features'], defaultInputMode 'kb-features'
  - planned.layers (6 cột):
    1. { units: 0, activation: '', unitsLabel: 'emb 2048 + cfg ~30' }
    2. { units: 32, activation: 'tanh' }
    3. { units: 16, activation: 'tanh' }
    4. { units: 3, activation: 'softmax', headGroup: 'mode', groupLabel: 'Chế độ vận dụng' }
    5. { units: 9, activation: 'sigmoid', headGroup: 'retrieval', groupLabel: 'Tham số truy xuất' }
    6. { units: 2, activation: 'sigmoid', headGroup: 'meta', groupLabel: 'Meta' }
    - loss: 'CE + BCE (3 tầng — một quyết định)'
  - signals: [
      { key: 'kbLogsTotal', table: 'KbConsultLog', label: 'Log KB consult (ngưỡng D2)', min: 100, source: 'BLUEPRINT-EVO-NAO §8.1 — D2 cần ≥100 log' },
      { key: 'kbLogsWithOutcome', table: 'KbConsultLog (runId ≠ null)', label: 'Log có Outcome* (ngưỡng D3)', min: 300, source: 'BLUEPRINT-EVO-NAO §8.1 — D3 cần ≥300 log có Outcome*' } ]
- BRAIN_TRAINABLE_KEYS GIỮ 3 key cũ (knowledge chưa trainable tới D3 — nút train tự tắt).

### 2.2 neural-types.ts — 2 cờ kill-switch (#33, #34 nối CUỐI TUNING_SPECS, format precedent kb_consult_log: key/label/description/nodeId/type enum ['off','on']/default/envKey/envMap/warning/appliesTo):
- #33 `runtime_knowledge` (label RUNTIME_KNOWLEDGE, envKey RUNTIME_KNOWLEDGE, default 'off', nodeId 'kb-access'): kill-switch tầng runtime Brain-D — on = khi D3 policy head sống + có bản active, truy vấn KB được điều phối bởi Brain-D (mixture λ như Brain-C); off = pipeline heuristic CỨNG 4 lớp y hệt hôm nay. Warning: cờ chỉ có ý nghĩa từ BRAIN-D3 — hiện là placeholder đặt tên sớm đúng key đã pin trong blueprint (tránh đổi key sau làm mất giá trị tuning user).
- #34 `knowledge_organ_strategy` (label KNOWLEDGE_ORGAN_STRATEGY, envKey KNOWLEDGE_ORGAN_STRATEGY, default 'off', nodeId 'kb-access'): kill-switch riêng organ "chế độ vận dụng" (Tầng 1 §8.3) — off = mọi lượt consult dùng context-block (mặc định); on = khi runtime_knowledge on VÀ Brain-D active, head được phép đề xuất structured-subgraph/traversal-plan.
- Verify comment header section graph ("6 LỚP × 23 NODE × 37 CẠNH" có thể lỗi thời) — cập nhật comment cho đúng NEURAL_NODES.length/NEURAL_EDGES.length thực tế (KHÔNG đụng dữ liệu nodes/edges).

### 2.3 api/brain/route.ts
Thêm 2 đếm safeCount vào Promise.all + counts map: 'kbLogsTotal' = db.kbConsultLog.count(); 'kbLogsWithOutcome' = db.kbConsultLog.count({ where: { runId: { not: null } } }). Fail-open độc lập. Không cần logic khác (inputDim tự null như policy — kiểm chứng đường generic).

### 2.4 stage-geometry.ts — mở rộng ADDITIVE headGroup (§8.5.2)
- StageColumn thêm `headGroup?: 'mode' | 'retrieval' | 'meta'` (+ optional `groupLabel?: string`).
- STAGE_LIMITS thêm `headGroupGap: 64` (viewBox units giữa 2 nhóm khác nhau).
- buildStageLayout: chèn headGroupGap giữa 2 cột KỀ NHAU có headGroup khác nhau (kể cả undefined↔defined); cùng nhóm dính liền.
- Return thêm `headGroups: Array<{ id: 'mode'|'retrieval'|'meta'; label: string; fromCol: number; toCol: number; x1: number; x2: number }>` (rỗng khi không có) — component vẽ label nhóm + vạch accent.
- BACKWARD COMPAT TUYỆT ĐỐI: không cột nào có headGroup → output GIỐNG HỆT trước (r90 pins pass KHÔNG SỬA). Thuần, tất định.

### 2.5 UI (SECTION 1+2+3)
- SECTION 1 (brain-studio.tsx): nút thứ 4 "Tri Thức" tự xuất hiện từ registry — KIỂM CHỨNG grid 4 nút đẹp (grid 1/2/4 cột breakpoint precedent); badge NGỦ; khối "thức tỉnh khi đủ mẫu" hiển thị TIẾN ĐỘ KÉP (2 thanh: log tổng 0/100 → D2 + log Outcome* 0/300 → D3 — copy rõ); badge 2 cờ: nếu UI hiện mỗi brain 1 flagTuningKey thì thêm cơ chế tối thiểu (vd BrainSpec optional `extraFlagTuningKeys?: string[]` = ['knowledge_organ_strategy']) hiển thị badge thứ 2; toggle qua tuning-store (audit Nhật ký tinh chỉnh precedent).
- SECTION 2 (brain-stage.tsx): ghost topology knowledge — 3 CỤM ĐẦU RA ĐỒNG THỜI (KHÔNG tab như SurrogateHead Brain-B — 3 tầng là MỘT quyết định) + label nhóm + màu accent mode=amber · retrieval=cyan · meta=fuchsia (dùng headGroups + groupLabel); tooltip hover cụm → giải thích tầng (copy §8.3: Tầng 1 context-block/structured-subgraph/traversal-plan · Tầng 2 4 nguồn on/off + topK + trọng số hybrid + MMR λ + rerank + độ sâu · Tầng 3 skip/writeback); hover unit → tên chế độ/tham số (map TĨNH, không API mới); chip "DỰ KIẾN — CHƯA HỌC" khi dormant (precedent planned.layers); dòng mixture λ precedent Brain-C: "λ = 1 − min(n/200, WilsonLB)" + chip "% heuristic vs não" (bắt đầu 100% heuristic).
- Mobile-first §8.5.4: `<md` 3 cụm XẾP DỌC — áp pattern responsive BrainStage hiện có (NEURAL_DESKTOP_BREAKPOINT, widthOverride); a11y role/aria-live/sr-only; min touch 44px mobile; KHÔNG dependency mới (SVG + Tailwind tokens).
- SECTION 3: như não khác — nút train disable (trainable=false), Tham số runtime hiển thị 2 cờ knowledge.

### 2.6 TEST MỚI tests/r114-brain-d-ghost-topology.test.ts (bun:test, phong cách r90/r110)
1. Registry: knowledge entry đúng key/name/flagTuningKey; 2 signals min 100/300; planned.layers 6 mục, headGroup đúng 3 mục cuối; 'knowledge' KHÔNG trong BRAIN_TRAINABLE_KEYS.
2. Cờ: getTuningSpec('runtime_knowledge')/('knowledge_organ_strategy') tồn tại, default 'off', enum ['off','on'], nodeId 'kb-access'; TUNING_SPECS.length = con số mới đúng + CẬP NHẬT mọi test cũ pin con số này.
3. Geometry: không headGroup → deep-equal output cũ (pin vài số then chốt); có headGroup → khe giữa nhóm = headGroupGap, cùng nhóm kề nhau không khe, headGroups đúng span/label; tất định (chạy 2 lần deep-equal).

## BƯỚC 3 — GATES
- bunx eslint <files đổi> → 0 lỗi.
- NODE_OPTIONS=--max-old-space-size=1200 bunx tsc --noEmit → 0 lỗi.
- bun test tests/r114-brain-d-ghost-topology.test.ts → pass.
- bun test tests/r90-*.test.ts + mọi test pin count cờ + tests/r110-brain-d1-kb-consult-log.test.ts → pass (chỉ PIN UPDATE, không weaken assertion khác).
- bun run check:imports → PASS.

## BƯỚC 4 — VERIFY UI THẬT (Skill agent-browser)
App :3000 next dev — chờ hot-reload (request đầu chậm), rồi:
1. Mở http://localhost:3000 → module Smolab → tab BRAIN.
2. SECTION 1: 4 nút não; "Tri Thức" hiển thị + bấm chọn được; badge NGỦ; 2 thanh tiến độ 0/100 + 0/300; badge 2 cờ.
3. SECTION 2: topology 3 cụm amber/cyan/fuchsia + label nhóm; chip "DỰ KIẾN — CHƯA HỌC".
4. Bấm lại não A/B/C — topology cũ không hỏng.
5. Console 0 error; viewport 375px — 3 cụm xếp dọc hoặc pattern responsive hoạt động.
(Transient compile error → retry sau vài giây.) Ghi nhận mọi bất thường.

## RÀNG BUỘC
KHÔNG git commit/push. KHÔNG restart pm2. KHÔNG sửa blueprint. KHÔNG đụng BrainModel/active. Không thêm dependency. Không in secrets. Style code + comment tiếng Việt precedent (hằng số mới kèm chú thích nguồn doctrine #1).

## WORKLOG (BẮT BUỘC) — append CUỐI /home/z/my-project/worklog.md (không overwrite):
```
---
Task ID: R24-b
Agent: subagent (ghost UI topology Brain-D §8.5 mốc a)
Task: <1 dòng>

Work Log:
- <bước cụ thể + kết quả>

Stage Summary:
- <files đổi, test results, browser verify>
```

## BÁO CÁO TRẢ VỀ
1. Files đổi + tóm tắt diff · 2. Kết quả gates · 3. Browser verify từng mục SECTION 1/2/3 + console sạch? · 4. Vấn đề nảy sinh + cách xử lý.
