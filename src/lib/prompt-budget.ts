/**
 * CI-3 B7 (Task 13-e) — SYSTEM PROMPT BUDGET (trần ký tự TỔNG)
 *
 * Vấn đề (roadmap CI-3 B7): system prompt của 2 đường thực thi chính được ghép
 * từ NHIỀU block, nhưng chỉ skills (16k — loadEnabledSkills) / WorkingMemory
 * HOT (2k — chat route) / agent roster (8k — agent-roster.ts) có cap riêng;
 * các block còn lại (KB context, workspace, capability report, custom tools,
 * standing orders, recalled memories, persona user-edit từ DB, tool schemas
 * native-FC, protocol của goal-loop...) KHÔNG cap → prompt tổng có thể phình
 * 30–50k+ chars, ăn budget context của tác vụ thật mỗi vòng LLM.
 *
 * Giải pháp — applyPromptBudget(blocks, totalBudgetChars):
 *   1. Cắt block theo maxChars riêng (nếu có) TRƯỚC — bất kể tổng
 *      (block đã cap riêng như skills/HOT: KHÔNG truyền maxChars — coi như
 *      đã có; chỉ bị cắt thêm khi tổng vượt budget).
 *   2. Tổng (sau bước 1) vẫn vượt totalBudgetChars → cắt theo TIER priority
 *      tăng dần ("giữ ưu tiên cao nguyên vẹn" — tier thấp bị hạ trước). Trong
 *      1 tier dùng water-filling: các block TO NHẤT hạ về chung một ngưỡng,
 *      block nhỏ (< MIN_BLOCK_CUT_CHARS = 500 chars) KHÔNG BAO GIỜ bị cắt.
 *   3. Cắt giữ ĐẦU block (thông tin chính thường ở đầu) + marker cuối
 *      "…[budget-cut <kept>/<total> chars]".
 *   4. Tổng ≤ budget → KHÔNG đụng block nào (behavior 0 thay đổi cho
 *      prompt nhỏ) — join('') tái tạo đúng chuỗi ghép gốc.
 *   5. Fail-open tuyệt đối: lỗi bất kỳ → trả prompt KHÔNG cut.
 *
 * Env: SYSTEM_PROMPT_BUDGET_CHARS (default 24000 chars ~ 6k tokens; -1 hoặc
 * 0 = không giới hạn) — đọc 1 LẦN ở module level theo chỉ dẫn CI-3 B7.
 *
 * 2026-10-27 (user directive): -1 là sentinel KHÔNG GIỚI HẠN chính thức (giá trị
 * user dùng) — mọi giá trị âm đều được chuẩn hóa về -1. Ngoài biến môi trường
 * (mặc định toàn hệ thống), trần prompt còn là LỰA CHỌN THEO TÁC VỤ: caller
 * truyền promptBudgetChars (-1 = không giới hạn cho đúng tác vụ đó) qua
 * runGoalDrivenLoop → assembleGoalLoopSystemPrompt → applyPromptBudget.
 */

/** 1 block góp vào system prompt — đơn vị budget */
export interface PromptBlock {
  name: string
  content: string
  /** Cap riêng cho block này (ký tự, tính CẢ marker) — cắt trước khi xét tổng */
  maxChars?: number
  /** Ưu tiên giữ nguyên khi tổng vượt budget — CAO = giữ nguyên (mặc định 0) */
  priority?: number
}

/** Block sau khi áp budget — content có thể bị cắt (truncated = true) */
export interface BudgetedBlock {
  name: string
  content: string
  truncated: boolean
}

export interface PromptBudgetResult {
  blocks: BudgetedBlock[]
  /** Tổng ký tự SAU budget (blocks join theo thứ tự gốc) */
  totalChars: number
  /** Tên các block bị cắt (maxChars hoặc budget) — dùng cho log 1 dòng */
  truncatedBlocks: string[]
  /** Convenience: blocks.map(b => b.content).join('') — thứ tự giữ nguyên */
  prompt: string
}

const DEFAULT_BUDGET_CHARS = 24_000

/** Block nhỏ hơn ngưỡng này không cắt khi chia budget (không đáng — tối đa tiết kiệm <500 chars) */
const MIN_BLOCK_CUT_CHARS = 500

/** r68 (BUG-016 — quan sát mission cmuznvkl…6b136k): SÀN GIỮ TỐI THIỂU khi 1
 * block bị budget-cut — KHÔNG BAO GIỜ giữ 0. Bằng chứng: block `base` (identity
 * Omega 36,411 chars, priority 10) bị stub về marker `[budget-cut 0/36411]`
 * — agent chạy cả mission mà KHÔNG biết mình là ai (persona/quản trị mất).
 * Sàn 1500 chars giữ ĐẦU block (identity/cứng lẽ nằm ở đầu) — chấp nhận
 * vượt budget một chút (budget là soft-target chống phình 30-50k+, không phải
 * giới hạn cứng đáng đổi lấy việc mất định danh agent). */
const BLOCK_MIN_KEEP_CHARS = 1500

/** Độ dài tối đa của marker "…[budget-cut 123456/1234567 chars]" — dùng làm overhead khi tính water-fill */
const MARKER_MAX_CHARS = 40

/** Sentinel KHÔNG GIỚI HẠN — mọi budget ≤ 0 (kể cả -1) đều có nghĩa unlimited */
export const PROMPT_BUDGET_UNLIMITED = -1

function readBudgetFromEnv(): number {
  const raw = process.env.SYSTEM_PROMPT_BUDGET_CHARS
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_CHARS
  const v = Number(raw)
  if (!Number.isFinite(v)) return DEFAULT_BUDGET_CHARS
  // -1 (hoặc bất kỳ giá trị âm nào) = KHÔNG GIỚI HẠN — chuẩn hóa về -1
  if (v < 0) return PROMPT_BUDGET_UNLIMITED
  return Math.floor(v)
}

/** Budget mặc định — env SYSTEM_PROMPT_BUDGET_CHARS, đọc 1 lần lúc module load */
export const SYSTEM_PROMPT_BUDGET_CHARS = readBudgetFromEnv()

function buildMarker(kept: number, total: number): string {
  return `…[budget-cut ${kept}/${total} chars]`
}

/** Cắt content giữ ĐẦU headChars ký tự (trim whitespace đuôi) + marker cuối */
function cutKeepHead(content: string, headChars: number): string {
  const total = content.length
  const keep = Math.max(0, Math.min(headChars, total))
  const head = keep > 0 ? content.slice(0, keep).replace(/\s+$/, '') : ''
  return head + buildMarker(head.length, total)
}

/** Cắt content sao cho ĐỘ DÀI CUỐI (kể cả marker) ≤ finalLen — dùng cho maxChars riêng */
function cutToFinalLength(content: string, finalLen: number): string {
  const total = content.length
  let keep = Math.min(finalLen, total) - MARKER_MAX_CHARS
  while (keep > 0 && keep + buildMarker(keep, total).length > finalLen) keep -= 1
  return cutKeepHead(content, Math.max(keep, 0))
}

interface WorkingBlock {
  name: string
  content: string
  priority: number
  truncated: boolean
}

/**
 * Áp budget ký tự cho danh sách block (pure — không mutate input).
 *
 * @param blocks            các block theo thứ tự ghép (separator người gọi tự nhúng trong content)
 * @param totalBudgetChars  trần TỔNG ký tự sau cut (mặc định SYSTEM_PROMPT_BUDGET_CHARS; ≤0 = không giới hạn)
 * @param context           nhãn cho log 1 dòng khi có cut (vd 'goal-loop:OMEGA')
 */
export function applyPromptBudget(
  blocks: PromptBlock[],
  totalBudgetChars: number = SYSTEM_PROMPT_BUDGET_CHARS,
  context?: string,
): PromptBudgetResult {
  // Normalize input — fail-open với input không hợp lệ (block rỗng/content không string)
  const normalized: Array<{ name: string; content: string; maxChars?: number; priority: number }> = []
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      normalized.push({
        name: typeof b.name === 'string' && b.name.length > 0 ? b.name : 'block',
        content: typeof b.content === 'string' ? b.content : '',
        maxChars:
          typeof b.maxChars === 'number' && Number.isFinite(b.maxChars)
            ? Math.floor(b.maxChars)
            : undefined,
        priority:
          typeof b.priority === 'number' && Number.isFinite(b.priority)
            ? Math.floor(b.priority)
            : 0,
      })
    }
  }
  const originalTotal = normalized.reduce((s, b) => s + b.content.length, 0)

  try {
    // ── Pass 1: cap riêng theo maxChars (bất kể tổng) ──
    const working: WorkingBlock[] = normalized.map(b => {
      if (b.maxChars !== undefined && b.maxChars > 0 && b.content.length > b.maxChars) {
        return { name: b.name, content: cutToFinalLength(b.content, b.maxChars), priority: b.priority, truncated: true }
      }
      return { name: b.name, content: b.content, priority: b.priority, truncated: false }
    })

    let total = working.reduce((s, b) => s + b.content.length, 0)
    const budget =
      typeof totalBudgetChars === 'number' && Number.isFinite(totalBudgetChars)
        ? Math.floor(totalBudgetChars)
        : SYSTEM_PROMPT_BUDGET_CHARS

    // ── Pass 2: budget TỔNG (0 = unlimited; tổng đã ≤ budget → không đụng gì) ──
    if (budget > 0 && total > budget) {
      let remaining = total - budget // chars cần shaving
      const priorities = Array.from(
        new Set(
          working
            .filter(b => b.content.length >= MIN_BLOCK_CUT_CHARS)
            .map(b => b.priority),
        ),
      ).sort((a, b) => a - b)

      for (const p of priorities) {
        if (remaining <= 0) break
        const tier = working.filter(
          b => b.priority === p && b.content.length >= MIN_BLOCK_CUT_CHARS,
        )
        if (tier.length === 0) continue
        const tierTotal = tier.reduce((s, b) => s + b.content.length, 0)

        // Water-filling: f(T) = Σ (L ≤ T+OH ? L : T+OH) — ước lượng ĐỘ DÀI CUỐI
        // của tier nếu mọi block > T bị hạ về T (est overhead OH ≥ marker thật).
        const lengths = tier.map(b => b.content.length)
        const finalAt = (t: number) =>
          lengths.reduce((s, L) => s + (L > t + MARKER_MAX_CHARS ? t + MARKER_MAX_CHARS : L), 0)
        const cap = tierTotal - remaining

        if (finalAt(0) > cap) {
          // Hạ cả tier về mức sàn BLOCK_MIN_KEEP_CHARS (r68 BUG-016 — TRƯỚC
          // đây stub về marker 0-kept: block base/identity bị xoá trắng, agent
          // mất định danh cả run). Vẫn chưa đủ shaving → phần excess chuyển
          // sang tier priority cao kế tiếp (nhưng từng block đã cắt giữ ≥ sàn).
          for (const b of tier) {
            const keepFloor = Math.min(BLOCK_MIN_KEEP_CHARS, b.content.length)
            b.content = cutKeepHead(b.content, keepFloor)
            b.truncated = true
          }
          remaining -= tierTotal - tier.reduce((s, b) => s + b.content.length, 0)
          continue
        }

        // Binary search T lớn nhất sao cho finalAt(T) ≤ cap (finalAt đơn điệu tăng theo T)
        let lo = 0
        let hi = Math.max(...lengths)
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2)
          if (finalAt(mid) <= cap) lo = mid
          else hi = mid - 1
        }
        // r68 (BUG-016): sàn giữ tối thiểu — threshold tính ra 0/khả năng cắt
        // về 0 KHÔNG được chấp nhận cho block ≥ 500 chars (đã từng xoá identity).
        // Lưu ý: hi đã hội tụ về lo sau binary search — sàn phải đối chiếu
        // BLOCK_MIN_KEEP_CHARS trực tiếp (bigger-than-tier thì tự vô hại vì
        // block < threshold sẽ không bị cắt).
        const threshold = Math.max(lo, BLOCK_MIN_KEEP_CHARS)
        for (const b of tier) {
          if (b.content.length > threshold + MARKER_MAX_CHARS) {
            b.content = cutKeepHead(b.content, threshold)
            b.truncated = true
          }
        }
        remaining = 0
        break
      }
      // remaining > 0 sau mọi tier = toàn bộ block còn lại đều < 500 chars —
      // đã cố gắng tối đa, KHÔNG ép cắt block nhỏ (theo thiết kế "không đáng").
      total = working.reduce((s, b) => s + b.content.length, 0)
    }

    const finalBlocks: BudgetedBlock[] = working.map(b => ({
      name: b.name,
      content: b.content,
      truncated: b.truncated,
    }))
    const truncatedBlocks = finalBlocks.filter(b => b.truncated).map(b => b.name)

    // Log 1 DÒNG — chỉ khi thực sự cắt (tránh log spam mỗi bước)
    if (truncatedBlocks.length > 0) {
      console.log(
        `[PromptBudget] ${context ?? 'prompt'}: cut ${truncatedBlocks.join(',')} — total ${originalTotal}→${total} chars`,
      )
      // r68 (BUG-016): kênh giám sát — block bị cắt sâu (>75% mất) phải sáng
      // đèn riêng trong log (đôi khi là identity/persona bị ăn — trước đây im
      // lặng, chỉ biết khi soi checkpoint tay).
      for (const b of finalBlocks) {
        if (!b.truncated) continue
        const m = b.content.match(/\[budget-cut (\d+)\/(\d+) chars\]/)
        if (m && Number(m[2]) > 0 && Number(m[1]) / Number(m[2]) < 0.25) {
          console.warn(
            `[PromptBudget] ⚠️ block '${b.name}' giữ ${m[1]}/${m[2]} chars (<25%) — nội dung gốc bị cắt sâu, kiểm tra.priority/mức budget nếu đây là block cốt lõi`,
          )
        }
      }
    }

    return {
      blocks: finalBlocks,
      totalChars: total,
      truncatedBlocks,
      prompt: finalBlocks.map(b => b.content).join(''),
    }
  } catch (err) {
    // FAIL-OPEN — lỗi budget: dùng prompt KHÔNG cut
    console.warn(
      `[PromptBudget] ${context ?? 'prompt'}: áp budget thất bại (fail-open — giữ prompt nguyên bản): ${err instanceof Error ? err.message : String(err)}`,
    )
    const uncut: BudgetedBlock[] = normalized.map(b => ({
      name: b.name,
      content: b.content,
      truncated: false,
    }))
    return {
      blocks: uncut,
      totalChars: originalTotal,
      truncatedBlocks: [],
      prompt: uncut.map(b => b.content).join(''),
    }
  }
}

/**
 * Convenience wrapper cho 2 đường wiring (goal-loop + workflow step): áp budget
 * mặc định (SYSTEM_PROMPT_BUDGET_CHARS) và trả chuỗi prompt hoàn chỉnh — thứ tự
 * block giữ nguyên, separator đã nhúng sẵn trong content mỗi block. Fail-open
 * tuyệt đối: không bao giờ throw (lỗi → chuỗi ghép KHÔNG cut).
 */
export function budgetPrompt(blocks: PromptBlock[], context?: string): string {
  return budgetPromptWith(blocks, undefined, context)
}

/**
 * 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): budgetPrompt nhận
 * override theo tác vụ. budgetOverride <= 0 (-1 = unlimited) → KHÔNG cắt;
 * undefined/NaN → dùng mặc định hệ thống (SYSTEM_PROMPT_BUDGET_CHARS).
 */
export function budgetPromptWith(
  blocks: PromptBlock[],
  budgetOverride?: number,
  context?: string,
): string {
  try {
    const budget = typeof budgetOverride === 'number' && Number.isFinite(budgetOverride)
      ? Math.floor(budgetOverride)
      : SYSTEM_PROMPT_BUDGET_CHARS
    return applyPromptBudget(blocks, budget, context).prompt
  } catch {
    return blocks.map(b => (typeof b?.content === 'string' ? b.content : '')).join('')
  }
}
