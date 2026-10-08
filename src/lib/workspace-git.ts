/**
 * WORKSPACE GIT STATUS — helper đọc trạng thái working tree (chỉ-đọc, an toàn).
 *
 * r69 (BUG-009 + BUG-025 — quan sát mission cmuznvkl…6b136k):
 * sub-agent để lại rác `tmp/` ở repo root KHÔNG ai thấy; 101 dòng fix thật
 * nằm trong working tree KHÔNG commit, KHÔNG bước bàn giao cuối — công sức
 * suýt mồ côi. Cơ chế hardcode: mọi wrap-up (sub-agent machine block + goal-
 * loop final report) đều CHỤP git status và BÁO rõ phần chưa commit — lỗi
 * vệ sinh không còn "vô hình".
 *
 * An toàn: execFile với argv CỐ ĐỊNH (không shell → không injection), chỉ
 * đọc (status --porcelain), timeout 5s, fail-open tuyệt đối (lỗi → mảng
 * rỗng — không bao giờ làm hỏng wrap-up).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5_000
/** Cap số dòng status hiển thị — repo bẩn nặng vẫn gọn báo cáo (r69 test đọc hằng số này) */
export const MAX_UNCOMMITTED_LINES_VISIBLE = 30

export interface WorkspaceGitStatus {
  /** true = lệnh git chạy thành công (working tree là git repo) */
  ok: boolean
  /** Mỗi dòng `git status --porcelain` (đã cap MAX_STATUS_LINES) */
  lines: string[]
  /** Tổng số dòng thật (kể cả phần bị cap) */
  total: number
}

/**
 * Chụp `git status --porcelain` tại workspace root đang active.
 * Trả {ok:false, lines:[]} khi không phải git repo / git lỗi / timeout —
 * caller xử lý fail-open theo ngữ cảnh riêng.
 */
export async function getWorkspaceGitStatus(): Promise<WorkspaceGitStatus> {
  try {
    const { resolveWorkspaceRoot } = await import('@/lib/code-team/workspace-root')
    const root = await resolveWorkspaceRoot()
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 },
    )
    const all = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    return {
      ok: true,
      lines: all.slice(0, MAX_UNCOMMITTED_LINES_VISIBLE),
      total: all.length,
    }
  } catch {
    return { ok: false, lines: [], total: 0 }
  }
}

/**
 * Format khối báo cáo "thay đổi chưa commit" cho final report/machine block.
 * Trả '' khi working tree SẠCH hoặc git không đọc được (fail-open im lặng —
 * không thích báo cáo nhiễu khi repo không phải git).
 */
export function formatUncommittedBlock(status: WorkspaceGitStatus, title: string): string {
  if (!status.ok || status.lines.length === 0) return ''
  // Cap phòng vệ (r69 test bắt lỗi): caller có thể truyền snapshot chưa cắt
  // (vd mock/test) — hàm tự chịu trách nhiệm giới hạn hiển thị.
  const shown = status.lines.slice(0, MAX_UNCOMMITTED_LINES_VISIBLE)
  const extra = status.total > shown.length
    ? `\n- (+${status.total - shown.length} dòng khác — xem git status đầy đủ)`
    : ''
  return `${title}:\n${shown.join('\n')}${extra}`
}

/**
 * DELTA 2 ảnh chụp git status (trước/sau một khoảng thời gian — vd thời gian
 * sub-agent chạy): trả MỚI/XỬA dòng (dòng có ở sau mà không có ở trước).
 * 2 sub-agent chạy song song chia sẻ working tree → delta có thể lẫn thay
 * đổi của agent kia — caller ghi rõ ngữ cảnh "trong khoảng thời gian chạy".
 */
export function diffGitStatusSnapshots(before: WorkspaceGitStatus, after: WorkspaceGitStatus): string[] {
  if (!after.ok) return []
  if (!before.ok) return after.lines
  const beforeSet = new Set(before.lines)
  return after.lines.filter(l => !beforeSet.has(l))
}
