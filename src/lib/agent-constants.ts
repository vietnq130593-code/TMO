/**
 * Agent Constants — Shared provider/model data and validation constants
 *
 * Architecture: NVIDIA NIM ONLY (single provider)
 *   - 2 extraction cores: nemotron-3-ultra-550b (chính) + gpt-oss-120b (fallback)
 *     (user directive 2026-09-05 — kimi-k3 bị CẤM cho tác vụ trích xuất tài liệu)
 *   - 4 agent/chat cores (fallback chain — user directive 2026-08-28:
 *     kimi-k3 chính → deepseek-v4-pro-0813 → deepseek-v4-flash-0731 → minimax-m3)
 *     (user directive 2026-08-27: bỏ gpt-oss-120b khỏi Agent/Chat)
 *   - glm-5.2 removed 2026-08-25 (NIM end-of-life — HTTP 410)
 *   - glm-5.3 KHÔNG tồn tại trên NIM (verified 2026-08-27 — 404, catalog không có GLM)
 *   - NOT using: kimi-k2.6 (đã quay lại catalog, không dùng), glm-5.1 (deprecated),
 *     minimax-m2.7 (deprecated), qwen3.5-397b (not on NIM),
 *     deepseek-v4-pro bản cũ không suffix (404 — bản mới: deepseek-v4-pro-0813,
 *     verified live 2026-08-28 qua GET /v1/models)
 *   - NOT using: Mistral, Cerebras, OpenRouter (removed)
 *
 * Used by:
 * - /api/agents/route.ts (CRUD validation)
 * - /api/agents/models/route.ts (model listing)
 * - page.tsx TokenUsageSection
 *
 * This is the SINGLE SOURCE OF TRUTH for provider/model data.
 */

// ==================== PROVIDER + MODEL DATA ====================

/** EXTRACTION models — chuỗi 2 lõi dùng cho trích xuất tài liệu (callLLMSlot)
 *  (user directive 2026-09-05: nemotron-3-ultra-550b làm LÕI CHÍNH +
 *   openai/gpt-oss-120b ("chatgpt-os-120b") làm FALL BACK — kimi-k3 TUYỆT ĐỐI
 *   không dùng cho trích xuất tài liệu)
 *  Đã bỏ llama-3.1-nemotron-ultra-253b-v1 (404 NOT FOUND — deprecated)
 *  Đã bỏ nemotron-4-340b-instruct (404 NOT FOUND — deprecated)
 */
export const EXTRACTION_MODELS: Record<string, Array<{ id: string; label: string }>> = {
  nvidia: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b (chính)' },
    { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (fallback)' },
  ],
}

/** ALL models — NVIDIA NIM ONLY
 *  2 lõi trích xuất + 4 lõi Agent/Chat (user directive 2026-08-28:
 *  kimi-k3 làm lõi CHÍNH + fallback chain deepseek-v4-pro-0813 →
 *  deepseek-v4-flash-0731 → minimax-m3; extraction vẫn nemotron-550b chính +
 *  gpt-oss-120b fallback — kimi-k3 bị cấm ở pipeline trích xuất tài liệu)
 *  Verified 2026-08-25 via actual completion calls against integrate.api.nvidia.com
 *  deepseek-v4-pro-0813 verified live 2026-08-28 qua GET /v1/models
 *  Deprecated (404): glm-5.1, minimax-m2.7, qwen3.5-397b, deepseek-v4-pro (bản cũ)
 *  Deprecated (404): llama-3.1-nemotron-ultra-253b-v1, nemotron-4-340b-instruct
 *  Deprecated (410): z-ai/glm-5.2 | glm-5.3: không tồn tại (verified 2026-08-27)
 */
export const PROVIDER_MODELS: Record<string, Array<{ id: string; label: string }>> = {
  // ===== OPENCODE ZEN (FIX 2026-09-25 — E2E tool audit) =====
  // 13/13 agents thực tế đang chạy provider='zen' (Task 8 migration) nhưng
  // VALID_PROVIDERS trước đây chỉ có 'nvidia' → create_agent (Omega Agent
  // Factory) KHÔNG tạo được agent zen — mọi agent mới sinh ra đều dính provider
  // nvidia với key chết. Thêm zen + 4 model free ĐÃ VERIFY chạy được (Task 5-7).
  zen: [
    { id: 'nemotron-3-ultra-free', label: 'nemotron-3-ultra-free (550B MoE — lõi chính, TL/Omega/Opus)' },
    // 2026-10-27 (user directive phiên 4): Muse Spark 1.3 Contributor làm model
    // chính cho các agent KHÔNG phải Omega/Opus/TL (9 generator agents). Chạy
    // trực tiếp ở môi trường local VN của user; trên server geo-blocked → chuỗi
    // fallback NIM (safety net) đảm bảo agent vẫn vận hành.
    { id: 'muse-spark-1.3-contributor-free', label: 'muse-spark-1.3-contributor-free (generators — G1-G3 code/research + ALISTA)' },
    { id: 'nemotron-3.5-lightning-free', label: 'nemotron-3.5-lightning-free (30B MoE — nhanh, utility)' },
    { id: 'mimo-v2.6-flash-free', label: 'mimo-v2.6-flash-free (nhẹ — small_model CLI)' },
    { id: 'space-bunny-free', label: 'space-bunny-free (phụ)' },
  ],
  nvidia: [
    // Extraction cores (2 lõi — chỉ trích xuất dữ liệu, user directive 2026-09-05)
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b (extraction chính)' },
    { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (extraction fallback — EOL 410)' },
    // Agent/Chat cores — minimax-m3 lõi chính (TẠM THỜI — user directive
    // 2026-10-16: duy nhất khả dụng sau matrix test 4 lõi × 4 key) + 3 lõi
    // fallback: kimi-k3 (#1 — NIM hồi tự dùng lại) → ds-pro (#2) → ds-flash (#3):
    { id: 'minimaxai/minimax-m3', label: 'minimax-m3 (lõi chính — tạm thời)' },
    { id: 'moonshotai/kimi-k3', label: 'kimi-k3 (fallback #1)' },
    { id: 'deepseek-ai/deepseek-v4-pro-0813', label: 'deepseek-v4-pro (fallback #2)' },
    { id: 'deepseek-ai/deepseek-v4-flash-0731', label: 'deepseek-v4-flash (fallback #3)' },
  ],
}

export const PROVIDER_DATA = [
  {
    key: 'zen',
    label: 'OpenCode Zen (free — qua CLI)',
    icon: '⚡',
    models: PROVIDER_MODELS.zen,
  },
  {
    key: 'nvidia',
    label: 'NVIDIA NIM',
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
export const AGENT_MAX_TOKENS_MAX = 32768

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
}

// Position colors — fallback for agents not in AGENT_COLORS by name
export const POSITION_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  'TL':    { border: 'border-amber-500',    bg: 'bg-amber-950/20',    text: 'text-amber-400' },
  'G1':    { border: 'border-violet-500',   bg: 'bg-violet-950/20',  text: 'text-violet-400' },
  'G2-A':  { border: 'border-cyan-500',     bg: 'bg-cyan-950/20',     text: 'text-cyan-400' },
  'G2-B':  { border: 'border-rose-500',     bg: 'bg-rose-950/20',    text: 'text-rose-400' },
  'G3':    { border: 'border-emerald-500',  bg: 'bg-emerald-950/20', text: 'text-emerald-400' },
}
