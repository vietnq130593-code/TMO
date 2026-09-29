/**
 * PROTECTED PATHS — Guard hạ tầng runtime của TMO (Task 24, 2026-10-21;
 * chính sách cập nhật 2026-10-27 theo user directive phiên 4).
 *
 * LỊCH SỬ: E2E 2026-10-20 run 2 (Task 23-c) — agent task READ-ONLY tự ý
 * `bun add` + rewrite prisma/schema.prisma → app OOM-crash 97 restarts.
 * Guard Task 24 chặn TOÀN BỘ hạ tầng.
 *
 * CHÍNH SÁCH MỚI (user directive 2026-10-27): "lỗi hạ tầng được hệ thống
 * bảo vệ, cho phép agent tự cài package và sửa schema" — agents giờ ĐƯỢC
 * PHÉP tự phục vụ hạ tầng ở 2 hạng mục:
 *   ✅ CÀI/GỠ PACKAGE: bun add / bun remove / npm install... (qua shell
 *      hoặc tool manage_packages — có audit ToolMetric)
 *   ✅ SỬA SCHEMA: file_write/file_edit prisma/schema.prisma + prisma
 *      migrations + chạy `prisma db push` / `bun run db:push` / `prisma
 *      generate` (regenerate client sau khi sửa schema)
 *
 * VẪN ĐƯỢC BẢO VỆ (agent KHÔNG tự sửa — phải escalate xin phê duyệt):
 *   ❌ .env* (API keys, credentials) · opencode.json (provider keys +
 *      permission policy) · .opencode/ (CLI auth + tool bridges)
 *   ❌ db/ (SQLite DATA files — dữ liệu vận hành; thay đổi DB phải qua
 *      prisma db push từ schema, không ghi tay file DB)
 *   ❌ mini-services/ (dịch vụ phụ chạy port riêng)
 *   ❌ package.json + lockfiles + tsconfig/next/tailwind/postcss/eslint/
 *      components config + Caddyfile + AGENTS.md (manifest/config hệ thống
 *      — cài package phải qua LỆNH bun add chính thống, không sửa tay)
 *
 * src/** và docs/** không khóa (code team viết code bình thường).
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

/** Thư mục con (relative root) — bảo vệ toàn bộ subtree.
 * 2026-10-27 (user directive): BỎ 'prisma' khỏi danh sách — agent được phép
 * sửa schema (prisma/schema.prisma + migrations) kèm chạy db push. DB DATA
 * (db/) vẫn bảo vệ — thay đổi cấu trúc phải đi qua prisma chính thống. */
export const INFRA_PROTECTED_DIRS: readonly string[] = [
  'db', // SQLite data files — KHÔNG ghi tay; chỉ qua prisma db push
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
  /** Lệnh AN TOÀN thay thế lệnh gốc (self-destruct guard: pm2 restart đơn
   * giản → tự đổi sang detach-safe recipe thay vì chặn). Executor dùng
   * lệnh này thay cho lệnh gốc khi có. */
  rewrite?: string
}

// 2026-10-27 (user directive): PKG_MGR_RE + PRISMA_MUTATE_RE ĐÃ BỎ CHẶN —
// agent ĐƯỢC PHÉP tự cài package (bun add/npm install...) và sửa schema
// (prisma db push / bun run db:push / migrate). Regex giữ lại chỉ để AUDIT
// LOG (biết agent đang đụng hạ tầng nào) — không còn trả verdict blocked.
/** Regex các lệnh package-manager cài/gỡ — AUDIT LOG (không chặn từ 2026-10-27). */
const PKG_MGR_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:add|remove|rm|uninstall|install|i|update|upgrade|ci)\b/

/** Regex các lệnh mutate schema/DB — AUDIT LOG (không chặn từ 2026-10-27). */
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
      // 2026-10-27: bỏ 'prisma/\S*' — agent được phép sửa schema qua
      // file_write/file_edit + lệnh prisma chính thống.
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

/** Message chung cho agent khi bị chặn (2026-10-27 — cập nhật chính sách:
 *  cài package + sửa schema giờ ĐÃ ĐƯỢC PHÉP tự làm; phần còn bảo vệ phải
 *  escalate. Kèm hướng dẫn đường tự phục vụ để agent không kẹt oan). */
function buildBlockedMessage(detail: string): string {
  return (
    `TỪ CHỐI (infra-guard): thao tác này chạm phần hạ tầng VẪN ĐƯỢC BẢO VỆ (${detail}) — ` +
    `.env/keys, db/ (data files), opencode.json, .opencode/, mini-services/, config hệ thống. ` +
    `LƯU Ý chính sách 2026-10-27: bạn ĐƯỢC PHÉP tự cài package (manage_packages hoặc shell bun add) ` +
    `và tự sửa schema (file_write/file_edit prisma/schema.prisma → shell "bun run db:push") — hai hạng mục này KHÔNG bị chặn. ` +
    `Thiếu tool → tự xây qua create_custom_tool. Việc thuộc chức trách agent khác → dispatch_agent/delegate_task. ` +
`Chưa có agent phù hợp → escalate_problem (Omega sẽ tạo agent mới). ` +
    `Phần còn bảo vệ (keys/.env, data DB, bridges): dùng escalate_problem để TRÌNH BÀY lý do + thay đổi cụ thể chờ phê duyệt — KHÔNG tự sửa. `
  )
}

// ============================================================================
// SELF-DESTRUCT GUARD (2026-09-29 — sự cố thực chiến 15:13:22 UTC)
// ============================================================================
// Goal-loop agent (SENTINEL, job zmdh0r4q) chạy `pm2 stop/restart
// theopusflashlite` qua tool shell của chính app → PM2 giết process tree của
// app (kể cả pm2 CLI — process CON của app đang phát lệnh) → pha "start"
// của restart KHÔNG BAO GIỜ chạy → app nằm im ở trạng thái stopped, mission
// chết giữa chừng, UI mất hoàn toàn (PM2 log: "Stopping app" + exit [0]).
//
// Chính sách: process app KHÔNG THỂ tự dừng/tự giết qua shell của chính nó —
// lệnh đến pm2 phải ĐI TỪ NGOÀI process tree (nohup detach) mới an toàn.
//   • `pm2 restart theopusflashlite` (form đơn giản, không nohup)
//     → TỰ ĐỔI sang detach-safe recipe (giữ nguyên tác vụ của agent).
//   • `pm2 stop/delete/kill` nhắm app/daemon → BLOCK kèm recipe detach +
//     giải thích (dừng vĩnh viễn là quyền operator, không phải của agent).
//   • Lệnh phức tạp chứa `pm2 restart <app>` (vd `build && pm2 restart ...`)
//     → BLOCK kèm recipe (không tự rewrite chuỗi lệnh — dễ sai semantics).
//   • Đã có `nohup` phía trước lệnh pm2 → CHO QUA (agent đã làm đúng).
// ============================================================================

/** pm2 stop/delete/rm nhắm process app (theo tên / id 0 / all / ecosystem). */
const PM2_STOP_APP_RE =
  /\bpm2\s+(?:stop|delete|del|rm)\s+(?:-{2}[\w-]+\s+)*(?:theopusflashlite|ecosystem[\w./-]*|all|0)\b/i

/** `pm2 kill` — giết cả PM2 daemon (cùng số phận tự hủy). */
const PM2_KILL_RE = /\bpm2\s+kill\b/i

/** ROUND-5 bổ sung: pkill/killall thô nhắm process Next của app — bypass pm2
 * nhưng cùng số phận tự hủy (app chết giữa chu kỳ; PM2 kéo dậy làm gián đoạn
 * mission + build đang chạy). Chỉ bắt pattern có tên rõ ràng (next dev /
 * next-server / theopusflashlite) — kill pid trần (không map được pid→app
 * bằng regex) do PM2 autorestart gánh hậu quả. */
const RAW_KILL_APP_RE =
  /\b(?:pkill|killall)\s+(?:-\S+\s+)*(?:-\w*\s+)?[^\n]*\b(?:next[- ]?(?:server|dev)|theopusflashlite)\b/i

/** `pm2 restart <app>` xuất hiện ở ĐÂU ĐÓ trong lệnh (kể cả chain `&&`). */
const PM2_RESTART_ANY_RE =
  /\bpm2\s+(?:restart|reload|startOrReload)\s+(?:-{2}[\w-]+\s+)*(?:theopusflashlite|ecosystem[\w./-]*|all|0)\b/i

/** Form ĐƠN GIẢN: toàn bộ lệnh chỉ là `pm2 restart/reload <app> [flags]` → tự rewrite. */
const PM2_RESTART_SIMPLE_RE =
  /^\s*pm2\s+(?:restart|reload|startOrReload)\s+(?:theopusflashlite|ecosystem[\w./-]*|all|0)\b[\s\w.\/-]*$/i

/** Lệnh đã có nohup bọc phía trước (agent đã biết recipe an toàn) → cho qua. */
const DETACHED_HINT_RE = /\bnohup\b|\bsetsid\b/i

/** Recipe khởi động lại app AN TOÀN — pm2 CLI chạy trong process detached,
 * sống sót khi process tree app bị PM2 giết, đảm bảo pha start được thực thi.
 * ROUND-5: kèm timed keepalive-off flag (3 phút) để watchdog ngoài không đua
 * restart trong cửa sổ bảo trì ngắn. */
const SAFE_DETACHED_RESTART =
  `nohup sh -c 'date -d "+3 minutes" +%s > /home/z/tmo-app/.keepalive-off; sleep 2; pm2 restart theopusflashlite; sleep 20; rm -f /home/z/tmo-app/.keepalive-off' >/tmp/tmo-detached-restart.log 2>&1 & ` +
  `echo "DETACHED-RESTART-ISSUED — app restart sau ~2s (boot 10-15s); goal-loop job sẽ RESUME từ checkpoint. ` +
  `Log: /tmp/tmo-detached-restart.log"`

/** ROUND-5 — recipe CHUỖI BẢO TRÌ (build/gate nặng): sandbox 4GB không đủ
 * cho dev-server (~1.5G) + next build (~3G) cùng lúc (bằng chứng: build
 * exit 137 hai lần có dev-server chạy). Chuỗi: tạm tắt watchdog (flag hết
 * hạn 30 phút — watchdog tự hồi nhiệm vụ nếu chuỗi chết) → stop app → build
 * → start app → verify health → dọn flag. Toàn bộ chạy DETACHED nên sống
 * sót khi app chết; app LUÔN quay lại cuối chuỗi (kể cả khi build fail). */
const SAFE_DETACHED_BUILD_CHAIN =
  `nohup sh -c 'date -d "+30 minutes" +%s > /home/z/tmo-app/.keepalive-off; ` +
  `pm2 stop theopusflashlite; sleep 3; ` +
  `timeout 1500 bun run build > /tmp/tmo-build.log 2>&1; echo "BUILD_EXIT=$?" >> /tmp/tmo-build.log; ` +
  `pm2 start theopusflashlite; sleep 15; curl -s -m 10 http://127.0.0.1:3000/api/health >> /tmp/tmo-build.log; ` +
  `rm -f /home/z/tmo-app/.keepalive-off' >/tmp/tmo-build-chain.log 2>&1 & ` +
  `echo "DETACHED BUILD CHAIN ISSUED — app OFF trong lúc build (~3-8 phút), TỰ ĐỘNG bật lại cuối chuỗi kể cả khi build fail; UI mất tối đa 30 phút (flag hết hạn watchdog tự kéo lên). Log: /tmp/tmo-build.log"`

function buildSelfDestructBlockedMessage(kind: string): string {
  return (
    `TỪ CHỐI (self-destruct-guard): ${kind} nhắm process app (theopusflashlite) chạy TỪ tool shell của chính app. ` +
    `Lý do: pm2 CLI là process CON của process tree app — khi app bị dừng, pm2 CLI chết theo → pha start KHÔNG BAO GIỜ chạy → ` +
    `app nằm im stopped, mission chết giữa chừng (đã xảy ra thật 2026-09-29 15:13 UTC, job zmdh0r4q).\n` +
    `RECIPE KHỞI ĐỘNG LẠI APP (pm2 CLI detach qua nohup — sống sót khi app chết):\n  ${SAFE_DETACHED_RESTART}\n` +
    `RECIPE BUILD/GATE NẶNG (app đang giữ ~1.5G, build cần ~3G — sandbox 4G KHÔNG đủ chạy song song; ` +
    `bằng chứng thực chiến: build exit 137 × 2 lần khi dev-server chạy) — chuỗi bảo trì detached, app TỰ ĐỘNG bật lại cuối chuỗi:\n  ${SAFE_DETACHED_BUILD_CHAIN}\n` +
    `LƯU Ý: muốn dừng app VĨNH VIỄN là quyền operator (shell riêng của người vận hành) — agent trong app không dừng app của chính mình.`
  )
}

/** Guard tự-hủy: chạy TRƯỚC mọi guard khác (áp dụng mọi cwd — giết app là
 * tự hủy bất kể cwd đặt ở đâu). Trả verdict block/rewrite hoặc null. */
function guardSelfDestruct(command: string): ShellGuardVerdict | null {
  // Đã có nohup/setsid phía trước → agent đã làm đúng detach → cho qua.
  if (DETACHED_HINT_RE.test(command)) return null

  if (PM2_STOP_APP_RE.test(command)) {
    const m = command.match(PM2_STOP_APP_RE)
    return {
      blocked: true,
      reason: `self-destruct: ${m?.[0]}`,
      message: buildSelfDestructBlockedMessage(`lệnh \`${m?.[0]}\``),
    }
  }
  if (PM2_KILL_RE.test(command)) {
    return {
      blocked: true,
      reason: 'self-destruct: pm2 kill',
      message: buildSelfDestructBlockedMessage('`pm2 kill`'),
    }
  }
  if (RAW_KILL_APP_RE.test(command)) {
    const m = command.match(RAW_KILL_APP_RE)
    return {
      blocked: true,
      reason: `self-destruct (raw kill): ${m?.[0]?.slice(0, 60)}`,
      message: buildSelfDestructBlockedMessage(`lệnh kill thô nhắm process app (\`${m?.[0]?.slice(0, 60)}\`)`),
    }
  }
  if (PM2_RESTART_ANY_RE.test(command)) {
    if (PM2_RESTART_SIMPLE_RE.test(command)) {
      // Form đơn giản → tự đổi sang detach-safe (giữ nguyên tác vụ agent).
      const m = command.match(PM2_RESTART_ANY_RE)
      return {
        blocked: false,
        reason: `self-destruct rewrite: ${m?.[0]} → detach-safe`,
        rewrite: SAFE_DETACHED_RESTART,
      }
    }
    // Chuỗi phức tạp (build && pm2 restart ...) → block kèm recipe.
    const m = command.match(PM2_RESTART_ANY_RE)
    return {
      blocked: true,
      reason: `self-destruct: ${m?.[0]} trong chuỗi lệnh phức tạp`,
      message: buildSelfDestructBlockedMessage(`\`${m?.[0]}\` lồng trong chuỗi lệnh`),
    }
  }
  return null
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

  // Self-destruct guard — ưu tiên cao nhất, áp dụng ở MỌI cwd (lệnh giết app
  // là tự hủy bất kể cwd ở đâu; guard path bên dưới chỉ áp TMO context).
  const selfDestruct = guardSelfDestruct(command)
  if (selfDestruct) {
    if (selfDestruct.blocked) {
      console.warn(`[InfraGuard] SELF-DESTRUCT blocked: ${selfDestruct.reason}`)
    } else {
      console.log(`[InfraGuard] SELF-DESTRUCT rewrite: ${selfDestruct.reason}`)
    }
    return selfDestruct
  }

  const absRoot = path.resolve(root)
  const absCwd = path.resolve(cwd)
  const cwdInRoot = absCwd === absRoot || absCwd.startsWith(absRoot + path.sep)
  // Command nhắc tên workspace (vd `cd /home/z/tmo-app && ...`) cũng coi là TMO context.
  const mentionsRoot = command.includes(path.basename(absRoot))
  const tmoContext = cwdInRoot || mentionsRoot
  if (!tmoContext) return { blocked: false }

  // 2026-10-27 (user directive): (1) package-manager cài/gỡ và (2) prisma
  // db push/migrate KHÔNG CÒN BỊ CHẶN — agent được phép tự cài package + sửa
  // schema. Chỉ AUDIT LOG 1 dòng để operator truy vết được ai đụng hạ tầng.
  if (PKG_MGR_RE.test(command)) {
    const m = command.match(PKG_MGR_RE)
    console.log(`[InfraGuard] AUDIT: cho phép lệnh package-manager (2026-10-27 policy): ${m?.[0]} — cwd=${cwd}`)
  }
  if (PRISMA_MUTATE_RE.test(command)) {
    const m = command.match(PRISMA_MUTATE_RE)
    console.log(`[InfraGuard] AUDIT: cho phép lệnh prisma mutate (2026-10-27 policy): ${m?.[0]} — cwd=${cwd}`)
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
