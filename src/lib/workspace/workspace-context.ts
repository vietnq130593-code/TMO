/**
 * Workspace Context Builder (shared)
 *
 * User request 2026-08-28: "Khi tôi chọn một thư mục nghĩa là tôi muốn agents
 * có thể truy cập, nắm được nội dung thư mục gốc, có các thư mục nào, file nào
 * và có thể triển khai viết code và chạy các lệnh shell/terminal."
 *
 * → Inject root path + cấu trúc cấp 1 + hướng dẫn tool calls vào system prompt
 *   để agent TRẢ LỜI ĐƯỢC câu hỏi về workspace và THỰC THI được file/shell ops
 *   (code-team tools resolve theo active workspace — xem workspace-root.ts).
 *
 * Dùng chung bởi:
 *   - /api/openclaw/chat (MỌI agents: độc lập như Omega, team Research, user-created)
 *   - code-team/workflow-engine runAgentStep (Team Code: TL/G1/G2-A/G2-B/G3)
 *
 * Update 2026-08-29 (user request): shell tool KHÔNG còn chặn sudo/rm -rf /
 * và KHÔNG còn khóa cwd trong workspace root — user tự chịu trách nhiệm.
 */

import { sanitizeEnvPath } from '@/lib/workspace/sanitize-env-path'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'
import { isFlagEnabled } from '@/lib/feature-flags'
// Task 19-b (App Runtime Awareness): inject trạng thái preview/dev-server đang
// chạy vào system prompt — agents (chat route + workflow engine đều dùng
// buildWorkspaceContext) phải BIẾT user đang xem preview nào để không kill nhầm.
import { listRunningPreviews } from '@/lib/preview-registry'

/** Cache nhẹ 10s — system prompt được build mỗi request, tránh scan thư mục liên tục */
let workspaceCtxCache: { text: string; root: string | null; at: number } | null = null
const WORKSPACE_CTX_TTL_MS = 10_000

export interface WorkspaceContext {
  text: string
  root: string | null
}

/**
 * Task 19-b — block trạng thái preview/app đang chạy (APPEND SAU cache — luôn
 * FRESH mỗi request, không dính TTL 10s: user vừa bấm Start Preview thì agent
 * request tiếp theo phải thấy ngay).
 * - Có preview đang chạy → thêm section "TRẠNG THÁI PREVIEW/APP ĐANG CHẠY"
 *   (tối đa 3 preview mới nhất, kèm ai khởi động + giờ + log file).
 * - Không có preview / lỗi bất kỳ → KHÔNG thêm gì (giữ prompt gọn, fail-open
 *   tuyệt đối — preview awareness không bao giờ được làm hỏng chat).
 */
function appendPreviewRuntimeSection(baseText: string): string {
  try {
    const previews = listRunningPreviews()
    if (previews.length === 0) return baseText

    const lines = previews
      .slice() // không mutate mảng registry trả về
      .sort((a, b) => b.startedAt - a.startedAt) // mới nhất trước
      .slice(0, 3)
      .map(p => {
        const d = new Date(p.startedAt)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const who = p.startedBy === 'agent' ? 'agent' : 'user'
        return `- App preview đang chạy: port ${p.port ?? '?'} (root ${p.root}, ${who} khởi động lúc ${hh}:${mm}${p.logFile ? `, log ${p.logFile}` : ''})`
      })

    return `${baseText}\n\n--- TRẠNG THÁI PREVIEW/APP ĐANG CHẠY ---\n${lines.join('\n')}\n- Dùng tool get_app_runtime_status để xem log mới nhất; KHÔNG kill preview của user.`
  } catch {
    return baseText // fail-open — không bao giờ làm hỏng system prompt
  }
}

export async function buildWorkspaceContext(): Promise<WorkspaceContext> {
  const now = Date.now()
  if (workspaceCtxCache && now - workspaceCtxCache.at < WORKSPACE_CTX_TTL_MS) {
    // Cache hit phần workspace root + listing; trạng thái preview vẫn append FRESH
    return { text: appendPreviewRuntimeSection(workspaceCtxCache.text), root: workspaceCtxCache.root }
  }

  let root: string | null = null
  try {
    root = await getActiveWorkspaceRoot()
  } catch {
    root = null
  }
  if (!root) {
    workspaceCtxCache = { text: '', root: null, at: now }
    return { text: appendPreviewRuntimeSection(''), root: null }
  }

  // Scan cấu trúc cấp 1 (skip hidden + node_modules để gọn prompt)
  let listing: string[] = []
  try {
    const entries = readdirSync(root)
      .filter(name => !name.startsWith('.') && name !== 'node_modules')
      .sort()
      .slice(0, 40)
    listing = entries.map(name => {
      try {
        return statSync(join(root!, name)).isDirectory() ? `${name}/` : name
      } catch {
        return name
      }
    })
  } catch {
    listing = []
  }

  const shellEnabled = isFlagEnabled('ENABLE_SHELL_TOOL')
  const shellHint = shellEnabled
    ? '  - tool_call: shell({"command": "npm run build"})  — chạy lệnh shell/terminal (mặc định cwd = workspace root; có thể truyền "cwd" khác)'
    : '  - shell: HIỆN TẮT — bật ENABLE_SHELL_TOOL=true trong .env rồi restart app'

  const gitEnabled = isFlagEnabled('ENABLE_GIT_COMMIT')
  const gitHint = gitEnabled
    ? `  - tool_call: git_commit({"message": "...", "paths": ["..."], "all": true})  — commit thay đổi (scoped paths)
  - tool_call: git_push({"branch": "main"})  — PUSH code lên remote khi user yêu cầu (token đã lưu sẵn — không cần hỏi)
  - tool_call: git_pull({"branch": "main"})  — PULL code mới nhất từ remote khi user yêu cầu (ff-only an toàn; dry_run:true để xem trước; force:true chỉ khi user yêu cầu)`
    : '  - git tools: HIỆN TẮT — bật ENABLE_GIT_COMMIT=true trong .env rồi restart app'

  // ━━━ FIX 2026-09-15 (P5 — user directive clone-first): workspace là bản CLONE ━━━
  // Khi TMO_CLONE_DIR được cấu hình, mọi agent (team + standalone) được thông
  // báo rõ workspace đang thao tác là thư mục clone AN TOÀN để chỉnh sửa;
  // hệ thống đang vận hành chỉ cập nhật qua push GitHub → pull (riêng).
  // Không hardcode path — đọc từ env (user local: E:\APP\TMO-clone...).
  // FIX 2026-10-14 (spawn ENOENT): chỉ nêu clone dir khi là path POSIX hợp lệ,
  // tồn tại và là directory — chặn Windows path lọt vào prompt agent.
  const cloneDir = sanitizeEnvPath(process.env.TMO_CLONE_DIR, 'TMO_CLONE_DIR').path || ''
  const cloneNote = cloneDir
    ? `\n🔐 CLONE-FIRST WORKFLOW: workspace này là THƯ MỤC CLONE của TMO chính thức — AN TOÀN để đọc/sửa/commit (${cloneDir}). Quy trình nâng cấp hệ thống: (1) sửa code + chạy kiểm định (lint/type_check/run_tests) TRÊN CLONE → (2) TOÀN BỘ PASS + không còn vấn đề mới git_push lên GitHub → (3) hệ thống TMO đang vận hành cập nhật bằng git_pull riêng. TUYỆT ĐỐI không sửa trực tiếp hệ thống đang chạy; không kết luận "nâng cấp thành công" khi pipeline kiểm định chưa PASS.`
    : ''

  const text = `--- Active Workspace (thư mục user đã chọn) ---
Workspace root: ${root}${cloneNote}
Cấu trúc cấp 1 (${listing.length} mục${listing.length >= 40 ? ', đã giới hạn 40' : ''}):
${listing.length > 0 ? listing.join('\n') : '(thư mục trống hoặc không đọc được)'}

HƯỚNG DẪN làm việc với workspace:
- Khi user hỏi về "thư mục hiện tại / thư mục gốc / root / project này" → chính là: ${root}
- Khi user yêu cầu xem cấu trúc, đọc/hiệu chỉnh file, chạy lệnh → EMIT TOOL CALL đúng format:
  - tool_call: file_list({"path": "."})  — liệt kê thư mục (path relative với root)
  - tool_call: file_read({"path": "src/app/page.tsx"})  — đọc nội dung file
  - tool_call: file_edit({"path": "...", "old_string": "...", "new_string": "..."})  — sửa file
  - tool_call: grep({"pattern": "từ_khoá", "path": "src"})  — tìm kiếm text trong code
${shellHint}
${gitHint}
- Tool gọi với path RELATIVE với root (hoặc absolute path nằm trong root). Tool tự resolve theo root — KHÔNG cần đoán đường dẫn tuyệt đối.
- Sau khi có kết quả tool, TÓM TẮT cho user bằng tiếng Việt (cấu trúc cây, nội dung file, output lệnh...).`

  workspaceCtxCache = { text, root, at: now }
  // Trạng thái preview append SAU cache — mỗi request đọc registry mới nhất
  return { text: appendPreviewRuntimeSection(text), root }
}

/** Invalidate cache — gọi sau khi user switch active workspace (PATCH /api/workspace). */
export function invalidateWorkspaceContextCache(): void {
  workspaceCtxCache = null
}
