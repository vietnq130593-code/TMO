/**
 * Agent Constants — Shared provider/model data and validation constants
 *
 * ⚠ MODEL MATRIX (R25 2026-10-18 — single source of truth, probe NIM trực tiếp):
 *   - NVIDIA NIM giữ: LÕI EMBED (embeddings.ts, nemotron-3-embed-1b) +
 *     LÕI EXTRACTION z-ai/glm-5.3-flash (llm.ts callLLMSlot — R25 đổi từ
 *     nemotron-550b đang 503 quá tải liên tục) + 4 LỰA CHỌN model agent:
 *     GLM 5.3 Flash (chính) · DeepSeek v4.1 Flash · GLM 5.3 · Nemotron-550B.
 *   - kimi-k3 ĐÃ EOL 410 trên NIM (2026-10-15T08:00Z — probe R25 xác nhận
 *     "Gone") — GỠ khỏi danh sách.
 *   - ĐÃ LOẠI BỎ TRƯỚC ĐÓ (410 EOL): minimax-m3, deepseek v4.0 (pro/flash),
 *     gpt-oss-120b, glm-5.2.
 *   - Lõi LLM mặc định của agents: OpenCode Zen space-bunny-free.
 *
 * Used by:
 * - /api/agents/route.ts (CRUD validation)
 * - /api/agents/models/route.ts (model listing)
 * - page.tsx TokenUsageSection
 *
 * This is the SINGLE SOURCE OF TRUTH for provider/model data.
 */

// ==================== PROVIDER + MODEL DATA ====================

/** EXTRACTION models — lõi trích xuất (triết tách) tài liệu (callLLMSlot)
 *  (R39 2026-10-18 — USER CHỐT: lõi chính nvidia/nemotron-3-ultra-550b-a55b
 *   "trích xuất ổn định" — kéo 868/868 chunk D0 không lỗi; glm-5.3-flash
 *   chuyển hẳn sang vai trò agent/xử lý tác vụ. Lịch sử: R25 glm chính khi
 *   nemotron 503; R38 glm hang 196s → nemotron sống lại; R39 chốt default)
 *  Đã bỏ (404/410): llama-3.1-nemotron-ultra-253b-v1, nemotron-4-340b-instruct,
 *  gpt-oss-120b (EOL 2026-09-03)
 */
export const EXTRACTION_MODELS: Record<string, Array<{ id: string; label: string }>> = {
  // R39: extraction (triết tách) NIM-FIRST — lõi chính nemotron-3-ultra-550b
  // (llm.ts callLLMSlot gọi NIM xoay 4 key; R19 không fallback — document
  // retry sau). Xoay khẩn cấp sang glm: env EXTRACTION_MODEL=z-ai/glm-5.3-flash.
  nvidia: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b (extraction chính — R39 user chốt lõi ổn định)' },
    { id: 'z-ai/glm-5.3-flash', label: 'glm-5.3-flash (extraction dự phòng qua env EXTRACTION_MODEL — lõi agent/tác vụ chính)' },
  ],
  zen: [
    { id: 'space-bunny-free', label: 'space-bunny-free (extraction fallback — zen)' },
  ],
}

/** Lõi agents — mặc định OpenCode Zen (space-bunny-free); NVIDIA NIM giữ 4
 *  lựa chọn model agent R25 (glm-5.3-flash chính / ds-v4.1-flash / glm-5.3 /
 *  nemotron-550b) + lõi embed. kimi-k3 ĐÃ EOL 410 (2026-10-15) — gỡ toàn bộ.
 */
export const PROVIDER_MODELS: Record<string, Array<{ id: string; label: string; caps?: { coding?: boolean; reasoning?: boolean; agentic?: boolean } }>> = {
  // ===== OPENCODE ZEN (FIX 2026-09-25 — E2E tool audit) =====
  // 13/13 agents thực tế đang chạy provider='zen' (Task 8 migration) nhưng
  // VALID_PROVIDERS trước đây chỉ có 'nvidia' → create_agent (Omega Agent
  // Factory) KHÔNG tạo được agent zen — mọi agent mới sinh ra đều dính provider
  // nvidia với key chết. Thêm zen + 4 model free ĐÃ VERIFY chạy được (Task 5-7).
  zen: [
    // r73 (2026-10-09 — user request "đánh giá + phân loại model free mới"):
    // matrix test 14 ứng viên + battery 2 tầng (cơ bản + khó) qua opencode CLI
    // v1.18.35 native. KẾT QUẢ: 8 model SỐNG, tất cả PASS coding (romanToInt
    // 6/6 case), reasoning (bài vòi hồ bơi = 140 phút), agentic cơ bản (JSON
    // 3 bước). Battery KHÓ phân hóa: big-pickle/mimo/ling/nemotron×2/step-5
    // giữ JSON schema lồng nhau ĐÚNG; space-bunny + longcat lỗi format JSON
    // phức tạp (hợp quan sát r70: SBF là model phát tool-call đứt nhiều nhất —
    // parser salvage r70 F1-F7 chính là bù cho đặc tính này).
    // ĐÃ LOẠI sau matrix r73: exo-free (deprecated), ling-3.0-flash-fin-free
    // (không phản hồi), muse-spark-1.3-contributor-free (geo-block), claude-
    // fable-5 (access disabled), claude-fable-5-1 (insufficient funds),
    // grok-build-0.1 (không phản hồi).
    // Vận hành: space-bunny-free chạy ĐƯỢC qua HTTP (xoay 3 key) LẪN CLI; 7
    // model còn lại CHỈ qua CLI native (HTTP = FreeTierError 403 — bằng chứng
    // 2026-10-09). llm.ts tự route 2 transport + last-resort chéo model (r73).
    //
    // ⚠ r74 CẬP NHẬT (2026-10-09 ~09:30Z — review phát hiện, BUG2-033): Zen
    // ĐÃ ĐÓNG LẠI cửa native CLI cho model free ngoài SBF — probe trực tiếp
    // `opencode run --model opencode/{big-pickle,mimo}` trả 403 FreeTierError
    // "free tier can only be used from within OpenCode" từ CẢ /tmp LẪN app-dir
    // với CẢ key #1 LẪN key #2 → chặn POLICY TOÀN CỤC (r73 đoán "sandbox
    // app-dir quota" là SAI CHẨN ĐOÁN). Chỉ space-bunny-free còn mở (HTTP xoay
    // key + native + alias CLI — bằng chứng writeback OK). Hệ quả hiện tại:
    // chọn 7 model ngoài SBF → chuỗi failover tự chuyển tiếp về SBF (agent
    // KHÔNG chết — thiết kế nhiều lớp r73). GIỮ NGUYÊN 8 model trong catalog
    // (policy Zen lật ngược nhiều lần: 09-27 chặn → r72 mở → r74 chặn lại —
    // xoá sẽ lại phải thêm) — caps từ battery r73 vẫn đúng về NĂNG LỰC model;
    // trạng thái SỐNG/CHẾT realtime do /api/agents/models gắn blockedTransports
    // từ zenModelBlockSummary() (llm.ts) → dropdown hiển thị badge ⚠ nói thật.
    {
      id: 'space-bunny-free',
      label: 'space-bunny-free (LÕI CHÍNH — HTTP xoay key + ZEN FAILOVER)',
      caps: { coding: true, reasoning: true, agentic: false },
    },
    {
      id: 'big-pickle',
      label: 'big-pickle (⚡ nhanh nhất coding · JSON schema chuẩn — toàn diện)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'mimo-v2.6-flash-free',
      label: 'mimo-v2.6-flash-free (⚡ NHANH NHẤT tổng thể · đủ 3 năng lực — hợp tác vụ nhẹ)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'ling-3.1-flash-free',
      label: 'ling-3.1-flash-free (đủ 3 năng lực · coding chậm hơn trung bình)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'longcat-2.5-preview-free',
      label: 'longcat-2.5-preview-free (coding ✓ reasoning ✓ · JSON phức tạp hay lỗi format)',
      caps: { coding: true, reasoning: true, agentic: false },
    },
    {
      id: 'nemotron-3-ultra-free',
      label: 'nemotron-3-ultra-free (reasoning SÂU nhất — chậm · đủ 3 năng lực; từng là lõi extraction)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'nemotron-3.5-lightning-free',
      label: 'nemotron-3.5-lightning-free (đủ 3 năng lực · tốc độ trung bình)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'step-5-preview-free',
      label: 'step-5-preview-free (đủ 3 năng lực · coding chậm nhất)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    // R5 (2026-10-14 — user request "xác định lại list các model miễn phí
    // hiện tại của opencode... 1 số model free đang không có tên"): đối chiếu
    // models.dev + CLI `opencode models --verbose --refresh` cho 12 model
    // free (cost 0/0, status != deprecated) — catalog cũ chỉ có 8/12. Bổ sung
    // 4 model còn thiếu. 3 model từng bị loại ở matrix r73 được đưa TRỞ LẠI
    // vì trạng thái metadata đã đổi (nói thật — live blockedTransports từ
    // /api/agents/models sẽ hiển thị thực tế từng model; r73 đo ở thời điểm
    // 2026-10-09, policy Zen/models.dev lật nhiều lần từ đó). cat-jam-free
    // là model MỚI phát hành 2026-10-12 (sau r73) — chưa battery.
    // Danh sách này được giữ tươi tự động bởi src/lib/free-models-sync.ts
    // (TTL 6h, nguồn CLI opencode / models.dev — diff vào Đài quan sát).
    {
      id: 'cat-jam-free',
      label: 'cat-jam-free (MỚI phát hành 2026-10-12 — models.dev; ctx 262k/ra 131k; reasoning+toolcall; chưa battery r73)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'exo-free',
      label: 'exo-free (r73 loại vì deprecated — models.dev 2026-10-14 hiện active trở lại; ctx 1M/ra 131k; chưa probe lại từ IP này)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'ling-3.0-flash-fin-free',
      label: 'ling-3.0-flash-fin-free (r73 loại vì không phản hồi — vẫn trong danh sách free models.dev 2026-10-14; chưa probe lại)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    {
      id: 'muse-spark-1.3-contributor-free',
      label: 'muse-spark-1.3-contributor-free (r73 loại vì geo-block — vẫn trong danh sách free models.dev 2026-10-14; chưa probe lại)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
  ],
  nvidia: [
    // R25 (2026-10-18 — user report: "NIM không còn Kimi K3, ngoài DS v4.1
    // còn GLM 5.3 Flash và GLM 5.3"; probe trực tiếp xác nhận catalog) —
    // GLM 5.3 FLASH là MODEL AGENT NIM CHÍNH: 200/~0,7s (nhanh nhất catalog
    // còn sống), reasoning model (content + reasoning_content). Chọn →
    // callLLMForAgent route NIM thật; fail → báo lỗi R19 (không fallback).
    {
      id: 'z-ai/glm-5.3-flash',
      label: 'GLM 5.3 Flash (NVIDIA NIM — ⚡ nhanh ~1s/call; model chính R25)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    // GLM 5.3 — siêu model reasoning (user muốn có sẵn). Probe R25: >150s
    // cho prompt tối giản → timeout slow-model 600s (NIM_SLOW_MODEL_TIMEOUT_MS).
    {
      id: 'z-ai/glm-5.3',
      label: 'GLM 5.3 (NVIDIA NIM — siêu model reasoning; rất chậm, quan sát 504 kéo dài)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    // 2026-10-14 (user request) — giữ lựa chọn. Probe R25: sống nhưng reasoning
    // chậm (~135s prompt tối giản) → timeout slow-model 600s.
    {
      id: 'deepseek-ai/deepseek-v4.1-flash',
      label: 'DeepSeek v4.1 Flash (NVIDIA NIM — reasoning chậm ~2 phút/call)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    // R17 từng là model agent chính; R25: NIM quá tải 503 liên tục từ
    // 2026-10-17 — giữ làm lựa chọn (breaker fail-fast khi bệnh; từng là lõi
    // extraction — R25 chuyển extraction sang glm-5.3-flash).
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b',
      label: 'Nemotron-3 Ultra 550B (NVIDIA NIM — ⚠ thường quá tải 503; từng là model chính R17)',
      caps: { coding: true, reasoning: true, agentic: true },
    },
    // kimi-k3 ĐÃ EOL 410 (2026-10-15T08:00Z — probe R25 "Gone") — GỠ. Agent
    // cũ còn cấu hình kimi-k3 nhận lỗi rõ ràng kèm hướng dẫn (llm.ts EOL_NIM_MODELS).
    // Lõi embed KHÔNG phải LLM agent — giữ để hiển thị/đối chiếu (UI chat
    // dropdown lọc mục này ra).
    { id: 'nvidia/nemotron-3-embed-1b', label: 'nemotron-3-embed-1b (CHỈ lõi embed — không phải LLM agent)' },
  ],
}

export const PROVIDER_DATA = [
  {
    key: 'zen',
    label: 'OpenCode Zen (lõi agents — mặc định)',
    icon: '⚡',
    models: PROVIDER_MODELS.zen,
  },
  {
    key: 'nvidia',
    label: 'NVIDIA NIM (GLM 5.3 Flash chính + GLM 5.3 + DeepSeek v4.1 Flash + Nemotron-550B + embed + extraction)',
    icon: '🎮',
    models: PROVIDER_MODELS.nvidia,
  },
]

// ==================== VALIDATION CONSTANTS ====================

export const VALID_PROVIDERS = ['zen', 'nvidia']
export const VALID_DOMAINS = ['programming', 'algorithm', 'ml', 'meta_cognitive', 'linux', 'security', 'ux_ui', 'mixed']
// G4 (user request 2026-09-08 — Omega Agent Factory/dispatch): vị trí MỞ RỘNG cho
// team code — TL/G1/G2-A/G2-B/G3 đã được 5 agent hệ thống (MEGATRON/SHOCWAVE/RAMPAGE/
// SENTINEL/CATALYST) giữ; agent do Omega tạo/điều động vào team code dùng G4+.
export const CODE_POSITIONS = ['TL', 'G1', 'G2-A', 'G2-B', 'G3', 'G4', 'G5']
export const RESEARCH_POSITIONS = ['TL', 'G1', 'G2', 'G3', 'G4', 'G5']
export const TEAM_POSITIONS: Record<string, string[]> = {
  code: CODE_POSITIONS,
  research: RESEARCH_POSITIONS,
}

// Field length limits
export const AGENT_NAME_MIN = 2
export const AGENT_NAME_MAX = 50
export const AGENT_DESCRIPTION_MAX = 10000
export const AGENT_INSTRUCTION_MAX = 50000
export const AGENT_TEMPERATURE_MIN = 0.0
export const AGENT_TEMPERATURE_MAX = 2.0
export const AGENT_MAX_TOKENS_MIN = 256
// TASK 39 (phiên 8 — 2026-09-28): nâng trần 32768 → 524288 (space-bunny-free
// output tối đa 512k) + hỗ trợ -1 = KHÔNG GIỚI HẠN (callZenProvider omit
// max_tokens → provider dùng max output của model) — user directive "agents
// dùng lượng token tùy ý".
export const AGENT_MAX_TOKENS_MAX = 524288
export const AGENT_MAX_TOKENS_UNLIMITED = -1

// Domain options (for UI)
export const AGENT_DOMAINS = [
  { value: 'programming', label: 'Lập trình' },
  { value: 'algorithm', label: 'Thuật toán' },
  { value: 'ml', label: 'Machine Learning' },
  { value: 'meta_cognitive', label: 'Siêu nhận thức' },
  { value: 'linux', label: 'Linux' },
  { value: 'security', label: 'Bảo mật' },
  { value: 'ux_ui', label: 'Thiết kế UX/UI' },
  { value: 'mixed', label: 'Tổng hợp' },
]

// Team options (for UI)
export const TEAM_OPTIONS = [
  { value: 'code', label: 'Code', positions: CODE_POSITIONS },
  { value: 'research', label: 'Research', positions: RESEARCH_POSITIONS },
]

// Position labels (for UI)
export const POSITION_LABELS: Record<string, string> = {
  'TL': 'Team Lead',
  'G1': 'Architecture & Design',
  'G2-A': 'Code Execution',
  'G2-B': 'Review & Bug Fix',
  'G3': 'Optimization',
  // Legacy positions (kept for backward compatibility)
  'G2': 'Member 2',
  'G3-OLD': 'Member 3',
  'G4': 'Member 4 (mở rộng — Omega Factory)',
  'G5': 'Member 5 (mở rộng — Omega Factory)',
}

// Provider options (for UI, with icons)
export const PROVIDER_OPTIONS = [
  { value: 'nvidia', label: 'NVIDIA NIM', icon: '🎮' },
]

// Avatar emoji options (for UI)
export const AVATAR_OPTIONS = ['🤖', '🏗️', '🔬', '🎨', '📊', '🧠', '💡', '⚡', '🎯', '🛡️', '📝', '🔍', '💻', '🌐', '🧪', '📐']

// Provider badge colors (for UI)
export const PROVIDER_BADGE_COLORS: Record<string, string> = {
  nvidia: 'bg-green-950/50 text-green-400 border-green-500/55',
}

// Team badge colors (for UI)
export const TEAM_BADGE_COLORS: Record<string, string> = {
  code: 'bg-amber-950/50 text-amber-400 border-amber-500/55',
  research: 'bg-cyan-950/50 text-cyan-400 border-cyan-500/55',
}

// Agent colors for multi-agent chat — each Code Team agent has a unique color
export const AGENT_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  MEGATRON:     { border: 'border-amber-500',    bg: 'bg-amber-950/20',    text: 'text-amber-400' },
  SHOCWAVE:   { border: 'border-violet-500',   bg: 'bg-violet-950/20',  text: 'text-violet-400' },
  RAMPAGE:     { border: 'border-cyan-500',     bg: 'bg-cyan-950/20',     text: 'text-cyan-400' },
  SENTINEL: { border: 'border-rose-500',     bg: 'bg-rose-950/20',    text: 'text-rose-400' },
  CATALYST: { border: 'border-emerald-500',  bg: 'bg-emerald-950/20', text: 'text-emerald-400' },
  Omega:    { border: 'border-sky-500',      bg: 'bg-sky-950/20',     text: 'text-sky-400' },
  // ALISTA — Kỹ sư Bảo trì Hệ thống (v1.1, 2026-09-01) — amber-on-stone để phân
  // biệt với MEGATRON (amber-500 sáng hơn). Màu cam-đá ám bảo trì.
  ALISTA:   { border: 'border-amber-600',    bg: 'bg-stone-950/30',   text: 'text-amber-300' },
  // TASK 48 — Linh Sickyx (đổi tên từ RAVAGE Task 47): Kỹ sư An ninh mạng
  // ĐỘC LẬP. Màu cam cháy (orange) — phân biệt với amber MEGATRON/ALISTA,
  // gợi chất "offense security" (pentest/red team).
  'Linh Sickyx': { border: 'border-orange-500', bg: 'bg-orange-950/20', text: 'text-orange-400' },
}

// Position colors — fallback for agents not in AGENT_COLORS by name
export const POSITION_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  'TL':    { border: 'border-amber-500',    bg: 'bg-amber-950/20',    text: 'text-amber-400' },
  'G1':    { border: 'border-violet-500',   bg: 'bg-violet-950/20',  text: 'text-violet-400' },
  'G2-A':  { border: 'border-cyan-500',     bg: 'bg-cyan-950/20',     text: 'text-cyan-400' },
  'G2-B':  { border: 'border-rose-500',     bg: 'bg-rose-950/20',    text: 'text-rose-400' },
  'G3':    { border: 'border-emerald-500',  bg: 'bg-emerald-950/20', text: 'text-emerald-400' },
}
