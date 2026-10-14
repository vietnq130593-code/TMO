// ============================================
// INFRA-DEBT DEMOTION — R12 (triển khai fix lượt quan sát 5, 2026-10-14)
// ============================================
//
// BỐI CẢNH (quan sát lượt 5 — docs/QUAN-SAT-LUOT-5-R11.md §3.1 P1-2):
// trọng tài phán complete=true nhưng thấy "side issues" → debtDecision='continue'
// → DEBT CYCLE tái khởi chu kỳ xử lý nợ. Vấn đề: side issues sinh ra từ LỖI
// HẠ TẦNG (path guard chặn oan "Access denied: path escapes workspace root",
// resolveCwd not defined, provider 410/429, SQLite contention, watchdog giết
// process...) KHÔNG PHẢI việc agent có thể trả trong phiên chat — chạy debt
// cycle cho loại nợ này = vòng lặp tự duy trì (đã đo thật: DEBT CYCLE đợt 1/100
// cho tác vụ "trả lời OK"; run Brain cháy 646K-751K tokens, 3 run chết).
//
// NGUYÊN TẮC (Giáo thức Thầy truyền lại §6, kỷ luật #4): "nợ infra không giao
// cho agent trả trong phiên chat". Module này tách side issues làm 2 loại:
//   - infra  : khớp pattern hạ tầng/guard/provider/DB/watchdog → ghi Todo
//              follow-up ngay (người quản trị/run kế xử lý), KHÔNG vào debt cycle.
//   - agent  : lỗi do chính công việc của run sinh ra (lint/test fail ở file
//              đã đụng, logic hỏng do thay đổi của run...) → debt cycle như cũ.
//
// Thiết kế pattern HIGH-PRECISION (thà thiếu còn hơn đốt chu kỳ oan): chỉ khớp
// các cụm đã gặp THẬT trong vận hành (R8/R11 + dev.log). Các lỗi code thường
// (lint fail, test fail, MODULE_NOT_FOUND trong code của run, ENOENT lệnh
// shell sai...) KHÔNG khớp — đó là nợ agent, agent sửa được.
//
// Kill-switch: GOAL_LOOP_INFRA_DEBT_DEMOTE=0 → trả về toàn bộ issues là
// 'agent' (hành vi cũ trước R12).

/** Đọc 1 lần lúc module load (env hot-reload không ảnh hưởng giữa chừng run). */
const DEMOTE_ENABLED = (process.env.GOAL_LOOP_INFRA_DEBT_DEMOTE ?? '1').trim() !== '0'

export const INFRA_DEBT_DEMOTE_ENABLED = DEMOTE_ENABLED

/**
 * Pattern lỗi hạ tầng — mỗi entry là regex case-insensitive, khớp ANY.
 * Chú thích nguồn từng họ (bằng chứng quan sát thật):
 */
export const INFRA_SIDE_ISSUE_PATTERNS: readonly RegExp[] = [
  // Workspace/path guard — R11 §3.5 P5-1/P5-2 (bão path-escape 13-14/10)
  /path escapes workspace root/i,
  /Access denied/i,
  /workspace (root|guard).*?(chặn|vô hiệu|không hợp lệ)/i,
  /rootPath.*(Windows|drive letter|không hợp lệ)/i,
  // Harness code error — R11 §8.2 (agent tự sửa infra giữa chừng, quên import)
  /(resolveCwd|sanitizeEnvPath) is not defined/i,
  /harness.*(lỗi|error|chết)/i,
  // Provider/LLM transport — R11 §3.6 P6-1/P6-3 (410 deprecated, 403 free-tier)
  /HTTP (401|402|403|410|429|5\d\d)\b/i,
  /FreeTierError|ModelDeprecated/i,
  /rate.?limit/i,
  /mọi LLM backend đều thất bại|LLM unavailable|LLM call thất bại/i,
  /provider.*(429|thất bại toàn chuỗi|chết)/i,
  // SQLite/DB contention — R11 §8.3 P-NEW-1 (socket timeout lúc response)
  /Socket timeout|SQLITE_BUSY|database is locked|Timed out fetching|expired transaction/i,
  // Permission/process/watchdog — R8 (MemWatchdog self-exit, reaper kill)
  /EACCES|permission deni/i,
  /watchdog|MemAvailable|self-exit|reaper kill/i,
  /spawn.*(thất bại|ENOENT)/i,
  // Nhãn tường thuật của arbiter tự phân loại infra
  /lỗi hạ tầng|infra error|hạ tầng bên thứ 3|ngoài tầm với/i,
]

export interface SideIssueSplit {
  /** Lỗi agent tự gây ra — debt cycle chạy cho các mục này (giữ hành vi cũ). */
  agent: string[]
  /** Lỗi hạ tầng/guard/provider — ghi Todo follow-up, KHÔNG debt cycle. */
  infra: string[]
  /** Kill-switch off → mọi issue là 'agent' (hành vi cũ). */
  demoteEnabled: boolean
}

/** Một issue có phải lỗi hạ tầng không (pure, không đụng env). */
export function isInfraSideIssue(issue: string): boolean {
  const s = String(issue || '')
  return INFRA_SIDE_ISSUE_PATTERNS.some(re => re.test(s))
}

/**
 * Tách danh sách side issues thành {agent, infra}.
 * Kill-switch GOAL_LOOP_INFRA_DEBT_DEMOTE=0 → infra luôn rỗng (mọi issue là agent).
 */
export function splitSideIssuesByInfra(issues: readonly string[]): SideIssueSplit {
  if (!DEMOTE_ENABLED) {
    return { agent: [...issues], infra: [], demoteEnabled: false }
  }
  const agent: string[] = []
  const infra: string[] = []
  for (const issue of issues) {
    if (isInfraSideIssue(issue)) infra.push(issue)
    else agent.push(issue)
  }
  return { agent, infra, demoteEnabled: true }
}
