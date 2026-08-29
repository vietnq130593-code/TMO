// ============================================
// src/lib/preview-registry.ts — Shared preview/dev-server runtime registry
// (Task 19-b — "App Runtime Awareness" cho agents)
//
// VẤN ĐỀ: trước đây trạng thái preview (dev server user bấm Start trong panel
// Preview) chỉ sống trong module-level Map của /api/opencode/preview/start —
// agents KHÔNG có cách nào BIẾT user đã khởi động preview, xem port nào, ai
// khởi động (user/agent), hay app có đang chạy ổn không. Agent chỉ thấy preview
// khi chính nó gọi start_preview → nguy cơ agent kill nhầm dev server user
// đang xem.
//
// GIẢI PHÁP: tách registry ra lib dùng chung (cùng pattern globalThis-safe như
// src/lib/preview-ports.ts — an toàn Next dev multi-instance):
//   - /api/opencode/preview/{start,stop,stream}  → đọc/ghi registry
//   - tool get_app_runtime_status (tool-executor) → agents query runtime state
//   - buildWorkspaceContext (workspace-context.ts) → inject trạng thái preview
//     vào system prompt của MỌI agents (chat + workflow engine)
//
// startedBy phân biệt 'user' (bấm Preview trong UI) vs 'agent' (gọi
// start_preview tool) — hint cho agent khác biết process nào KHÔNG được kill.
//
// Registry in-memory (globalThis) — restart app là mất (giống allowlist của
// preview-ports.ts, self-healing qua detect re-scan). Fail-open tuyệt đối:
// mọi hàm đọc không throw để không bao giờ làm hỏng chat/tool execution.
// ============================================

import type { ChildProcess } from 'child_process'
import { closeSync, openSync, readSync, statSync } from 'fs'

/** Ai khởi động preview — 'user' (UI Preview panel) | 'agent' (start_preview tool) */
export type PreviewStartedBy = 'user' | 'agent'

/** Entry đầy đủ trong registry (giữ ChildProcess để stop route kill process group) */
export interface PreviewRegistryEntry {
  child: ChildProcess
  port?: number
  startedAt: number
  logFile?: string
  startedBy: PreviewStartedBy
}

/** Bản tóm tắt an toàn để inject prompt / trả về tool (không lộ ChildProcess) */
export interface RunningPreviewInfo {
  root: string
  port?: number
  pid: number | null
  startedAt: number
  startedBy: PreviewStartedBy
  logFile?: string
  alive: boolean
}

// globalThis-safe — Next dev có thể tách module instance theo route; registry
// phải là MỘT Map duy nhất cho toàn process (copy pattern preview-ports.ts).
const globalForPreviews = globalThis as unknown as {
  __tmoPreviewRegistry?: Map<string, PreviewRegistryEntry>
}

/** Map root (resolved absolute path) → preview entry. Export cho backward-compat. */
export const previewProcesses: Map<string, PreviewRegistryEntry> =
  globalForPreviews.__tmoPreviewRegistry ?? new Map<string, PreviewRegistryEntry>()
globalForPreviews.__tmoPreviewRegistry = previewProcesses

/** Đăng ký preview đang chạy cho 1 workspace root (ghi đè nếu trùng root). */
export function registerPreview(root: string, entry: PreviewRegistryEntry): void {
  if (!root || typeof root !== 'string') return
  previewProcesses.set(root, entry)
}

/** Xóa preview khỏi registry (idempotent — dùng khi stop hoặc process exit). */
export function unregisterPreview(root: string): void {
  if (!root || typeof root !== 'string') return
  previewProcesses.delete(root)
}

/** Lấy entry đầy đủ (kèm ChildProcess) — stop route cần để kill process group. */
export function getPreview(root: string): PreviewRegistryEntry | undefined {
  if (!root || typeof root !== 'string') return undefined
  return previewProcesses.get(root)
}

/**
 * Danh sách preview ĐANG SỐNG (prune entry chết ngay khi duyệt — Map cho phép
 * delete entry hiện tại trong lúc for..of). alive = child.exitCode === null
 * && !child.killed (process chưa exit và chưa bị kill).
 * Fail-open: lỗi bất kỳ → trả [] (agents không bao giờ bị chặn vì registry).
 */
export function listRunningPreviews(): RunningPreviewInfo[] {
  try {
    const out: RunningPreviewInfo[] = []
    for (const [root, entry] of previewProcesses) {
      const alive = entry.child.exitCode === null && !entry.child.killed
      if (!alive) {
        // Prune entry chết — registry tự dọn, không phình sau nhiều lần start/stop
        previewProcesses.delete(root)
        continue
      }
      out.push({
        root,
        port: entry.port,
        pid: typeof entry.child.pid === 'number' ? entry.child.pid : null,
        startedAt: entry.startedAt,
        startedBy: entry.startedBy,
        logFile: entry.logFile,
        alive: true,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Đọc tối đa ~64KB CUỐI file log rồi trả về `maxLines` dòng cuối cùng.
 * Dùng cho: tool get_app_runtime_status (recentLog) — agents xem được dev
 * server đang compile lỗi gì / render OK chưa mà không cần mở toàn bộ file.
 * Fail-open: file mất / lỗi đọc / tham số lạ → [] (không bao giờ throw).
 */
export function tailPreviewLog(logFile: string, maxLines = 20): string[] {
  try {
    if (!logFile || typeof logFile !== 'string') return []
    const safeMaxLines = Math.max(1, Math.min(100, Math.floor(Number(maxLines) || 20)))

    const size = statSync(logFile).size
    const CHUNK = 64 * 1024 // 64KB cuối là đủ cho tail log dev server
    const readLen = Math.min(size, CHUNK)
    const buf = Buffer.alloc(readLen)

    const fd = openSync(logFile, 'r')
    try {
      // Đọc từ offset (size - readLen) — đúng ~64KB cuối file
      readSync(fd, buf, 0, readLen, Math.max(0, size - readLen))
    } finally {
      closeSync(fd)
    }

    const text = buf.toString('utf-8')
    const lines = text.split('\n')
    // Dòng đầu tiên có thể bị cắt lửng giữa chừng (offset rơi giữa dòng)
    // khi file lớn hơn 64KB → bỏ để không trả về dòng lỗi ký tự.
    if (readLen < size && lines.length > 0) lines.shift()

    return lines
      .map(l => l.replace(/\r$/, ''))
      .filter(l => l.length > 0)
      .slice(-safeMaxLines)
  } catch {
    return []
  }
}
