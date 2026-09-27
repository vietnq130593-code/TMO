/**
 * PROTECTED PATHS — Guard hạ tầng runtime của TMO (Task 24, 2026-10-21).
 *
 * BÀI HỌC E2E 2026-10-20 run 2 (Task 23-c): agent được giao task READ-ONLY
 * ("kiểm tra sức khỏe dự án") đã TỰ Ý chạy `bun add better-sqlite3` (sửa
 * package.json + bun.lock) và rewrite `prisma/schema.prisma` — khiến app
 * OOM-crash 97 lần restart, phải git restore thủ công.
 *
 * Nguyên tắc: agent làm task KHÔNG được tự ý sửa HẠ TẦNG RUNTIME của chính
 * hệ thống TMO (dependency manifests, lockfiles, prisma schema, SQLite DB,
 * .env, bridges .opencode, gateway config). src/** và docs/** KHÔNG bị
 * khóa — code team vẫn viết code bình thường (git rollback được, không phá
 * runtime). Nếu task THẬT SỰ cần thay đổi hạ tầng → agent phải escalate
 * (tmo_escalate) xin phép operator, KHÔNG tự làm.
 *
 * Guard áp tại 2 lớp:
 *   1. Server-side: shell() + fileWrite/fileEdit/fileDelete trong
 *      code-team/dev-tools.ts (mọi builtin tool + bridge tmo_* đều qua đây).
 *   2. OpenCode CLI: opencode.json permission deny native bash/edit/write
 *      → agent buộc dùng bridge tmo_shell/tmo_file_write/tmo_file_edit
 *      → mọi thao tác ghi đều đi qua lớp 1.
 *
 * Tắt guard (operator only): env TMO_INFRA_GUARD=off.
 */

import path from 'path'

/** File đơn (relative workspace root, so sánh thường) — hạ tầng runtime. */
export const INFRA_PROTECTED_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'opencode.json', // provider keys + permission policy của CLI
  'tsconfig.json',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'tailwind.config.ts',
  'tailwind.config.js',
  'postcss.config.mjs',
  'postcss.config.js',
  'eslint.config.mjs',
  'eslint.config.js',
  'components.json',
  'caddyfile',
  'agents.md', // rules hệ thống — agent tự sửa rules = leo thang quyền
  'agent.md',
]

/** Thư mục con (relative root) — bảo vệ toàn bộ subtree. */
export const INFRA_PROTECTED_DIRS: readonly string[] = [
  'prisma', // schema + migrations
  'db', // SQLite data files
  '.opencode', // CLI auth + tool bridges (agent sửa bridge = tự hack quyền)
  'mini-services', // dịch vụ phụ chạy port riêng
]

/** Prefix file (relative root) — mọi file khớp prefix đều bảo vệ. */
const INFRA_PROTECTED_PREFIXES: readonly string[] = ['.env']

export interface InfraPathVerdict {
  protected: boolean
  /** Pattern đã khớp (để log/message). */
  matched?: string
}

/**
 * Kiểm tra 1 đường dẫn tuyệt đối có nằm trong danh sách bảo vệ hay không.
 * CHỈ khớp khi path nằm TRONG workspace root — file cùng tên ở workspace
 * khác (vd /tmp/task-x/package.json) KHÔNG bị chặn.
 */
export function isProtectedInfraPathSync(absPath: string, root: string): InfraPathVerdict {
  const absRoot = path.resolve(root)
  const resolved = path.resolve(absPath)
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    return { protected: false }
  }
  const rel = path.relative(absRoot, resolved).split(path.sep).join('/')
  if (!rel) return { protected: false }

  const lower = rel.toLowerCase()
  for (const f of INFRA_PROTECTED_FILES) {
    if (lower === f) return { protected: true, matched: rel }
  }
  const firstSeg = lower.split('/')[0]
  for (const d of INFRA_PROTECTED_DIRS) {
    if (firstSeg === d) return { protected: true, matched: rel }
  }
  for (const p of INFRA_PROTECTED_PREFIXES) {
    if (lower.startsWith(p)) return { protected: true, matched: rel }
  }
  return { protected: false }
}

export interface ShellGuardVerdict {
  blocked: boolean
  /** Mô tả pattern đã chặn (log/audit). */
  reason?: string
  /** Message đầy đủ trả về cho agent (tiếng Việt + hướng dẫn escalate). */
  message?: string
}

/** Regex các lệnh package-manager cài/gỡ nâng cấp — chỉ chặn trong TMO context. */
const PKG_MGR_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:add|remove|rm|uninstall|install|i|update|upgrade|ci)\b/

/** Regex các lệnh mutate schema/DB. */
const PRISMA_MUTATE_RE = /\b(?:prisma\s+(?:db\s+push|db\s+seed|migrate|studio)|bun\s+run\s+db:push)\b/

/** Các lệnh ghi/xoá file nguy hiểm — kết hợp với token protected phía dưới. */
const FILE_WRITE_CMD_RE = /\b(?:rm|mv|cp|dd|truncate|chmod|chown|tee)\b|\bsed\b[^;|&]*-i/

/**
 * Token trỏ tới file/thư mục protected: khớp cả dạng relative (prisma/schema.prisma)
 * lẫn absolute (.../tmo-app/package.json). Chỉ dùng trong TMO context để tránh
 * false-positive với dự án khác có cấu trúc tương tự.
 */
const PROTECTED_TOKEN_RE = new RegExp(
  '(?:^|[\\s"\'=(])(?:\\.?/)?(?:' +
    [
      'package\\.json',
      'package-lock\\.json',
      'bun\\.lockb?',
      'pnpm-lock\\.yaml',
      'yarn\\.lock',
      'opencode\\.json',
      'tsconfig\\.json',
      'next\\.config\\.\\w+',
      'tailwind\\.config\\.\\w+',
      'postcss\\.config\\.\\w+',
      'eslint\\.config\\.\\w+',
      'components\\.json',
      'Caddyfile',
      'AGENTS?\\.md',
      'prisma/\\S*',
      'db/\\S*',
      '\\.opencode/\\S*',
      'mini-services/\\S*',
      '\\.env\\S*',
    ].join('|') +
    ')(?=$|[\\s"\')|;&])',
  'i',
)

/** Redirect ghi file: `> target` / `>> target`. */
const REDIRECT_RE = />{1,2}\s*([^\s|;&)]+)/g

/** Message chung cho agent khi bị chặn. */
function buildBlockedMessage(detail: string): string {
  return (
    `TỪ CHỐI (infra-guard): lệnh/thao tác này chạm HẠ TẦNG RUNTIME của hệ thống TMO ` +
    `(${detail}). Bài học 2026-10-20: agent tự ý bun add + sửa prisma/schema.prisma đã khiến app crash 97 lần. ` +
    `Nếu task THẬT SỰ cần thay đổi này (cài package, sửa schema, đổi .env...), hãy dùng tool tmo_escalate ` +
    `(hoặc escalate_problem) để TRÌNH BÀY lý do + thay đổi cụ thể cho operator phê duyệt — KHÔNG tự sửa. ` +
    `Với task bình thường: chỉ ĐỌC (file_read/grep/shell đọc) hoặc ghi code trong src/ (tmo_file_write/tmo_file_edit).`
  )
}

/**
 * Guard lệnh shell trước khi spawn.
 *
 * @param command lệnh shell đầy đủ
 * @param cwd     working directory ĐÃ resolve (mặc định = workspace root)
 * @param root    workspace root ĐÃ resolve
 */
export function guardShellCommand(command: string, cwd: string, root: string): ShellGuardVerdict {
  if (process.env.TMO_INFRA_GUARD === 'off') return { blocked: false }

  const absRoot = path.resolve(root)
  const absCwd = path.resolve(cwd)
  const cwdInRoot = absCwd === absRoot || absCwd.startsWith(absRoot + path.sep)
  // Command nhắc tên workspace (vd `cd /home/z/tmo-app && ...`) cũng coi là TMO context.
  const mentionsRoot = command.includes(path.basename(absRoot))
  const tmoContext = cwdInRoot || mentionsRoot
  if (!tmoContext) return { blocked: false }

  // 1) Package manager cài/gỡ — chặn (thay đổi manifests + node_modules runtime).
  if (PKG_MGR_RE.test(command)) {
    const m = command.match(PKG_MGR_RE)
    return {
      blocked: true,
      reason: `package-manager mutation: ${m?.[0]}`,
      message: buildBlockedMessage(m?.[0] || 'package manager install/remove'),
    }
  }

  // 2) Prisma mutate — chặn.
  if (PRISMA_MUTATE_RE.test(command)) {
    const m = command.match(PRISMA_MUTATE_RE)
    return {
      blocked: true,
      reason: `prisma mutation: ${m?.[0]}`,
      message: buildBlockedMessage(m?.[0] || 'prisma migrate/db push'),
    }
  }

  // 3) Ghi/xoá nhắm protected path — theo redirect target hoặc token trong lệnh.
  let redirectTarget = ''
  const resolveFromCwd = (tok: string): string => {
    // Token có thể là path (relative tới cwd nếu cwd trong root) hoặc absolute.
    if (tok.startsWith('/') || tok.startsWith('~')) return path.resolve(tok.replace(/^~/, process.env.HOME || '~'))
    return path.resolve(cwdInRoot ? absCwd : absRoot, tok)
  }

  REDIRECT_RE.lastIndex = 0
  let rm: RegExpExecArray | null
  while ((rm = REDIRECT_RE.exec(command)) !== null) {
    const target = rm[1]
    if (!target) continue
    const verdict = isProtectedInfraPathSync(resolveFromCwd(target), absRoot)
    if (verdict.protected) {
      redirectTarget = verdict.matched || target
      break
    }
  }
  if (redirectTarget) {
    return {
      blocked: true,
      reason: `shell redirect → protected path: ${redirectTarget}`,
      message: buildBlockedMessage(`ghi đè ${redirectTarget}`),
    }
  }

  // 4) Lệnh ghi/xoá file (rm/mv/cp/dd/truncate/chmod/chown/tee/sed -i) có token protected.
  if (FILE_WRITE_CMD_RE.test(command) && PROTECTED_TOKEN_RE.test(command)) {
    const tokenMatch = command.match(PROTECTED_TOKEN_RE)
    return {
      blocked: true,
      reason: `file-mutation command on protected path: ${tokenMatch?.[0]?.trim()}`,
      message: buildBlockedMessage(tokenMatch?.[0]?.trim() || 'protected path'),
    }
  }

  return { blocked: false }
}

/** Wrapper tiện dụng cho các file-op (đã resolve xong path). */
export function buildFileOpBlockedMessage(relPath: string): string {
  return buildBlockedMessage(relPath)
}
