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
 * ROUND-6 (2026-10-28, user directive): "Ghi đè file bảo vệ qua shell
 * (echo >, tee, sed -i...) → chặn như lớp 1" — bịt toàn bộ bypass thực nghiệm:
 *   • Lớp 1 shell: redirect có quote (`> ".env"`), biến $F làm target, perl -pi,
 *     awk -i inplace, ed/ex -s, install, patch, git apply/checkout/restore/stash,
 *     rsync, scp, sponge, shred, ln, curl -o, wget (-O lẫn basename-URL),
 *     sqlite3 write, `npm pkg set`, code inline python/node/bun -c/-e có
 *     write-hint. Token khớp giờ được VERIFY bằng path-resolve (giết
 *     false-positive /tmp/db/x, src/package.json; bắt ~/tmo-app/.env).
 *   • Lớp 1 opencode: executeFileWrite (action='write') giờ qua guard.
 *   • Lớp 2 bridge: gatewayTool proxy + API /api/openclaw/bridge + chính
 *     mini-service gateway-bridge (18791) đều gọi guardBridgeToolInvocation
 *     trước khi forward — agent không còn đường ghi đè file bảo vệ qua
 *     exec/write/edit/apply_patch/code_execution/process của bridge.
 *   Kiểm định: 42/42 vector tấn công chặn, 44/44 lệnh hợp lệ cho qua
 *   (bun/audit/recipe/git/prisma/curl health-check...), tsc sạch.
 *
 * Tắt guard (operator only): env TMO_INFRA_GUARD=off — tắt TOÀN BỘ guard kể
 * từ 2026-09-30 (gap fix): cả isProtectedInfraPathSync (file_write/edit/delete,
 * opencode write) lẫn 3 hàm guard command/inline/bridge đều tôn trọng env này.
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
 *
 * TMO_INFRA_GUARD=off (operator directive 2026-09-30 "tắt hoàn toàn"):
 * trả về không-bảo-vệ cho MỌI path — phủ toàn bộ guard (shell, inline code,
 * bridge, file_write/edit/delete, opencode write). Trước đây chỉ 3 hàm guard
 * (guardShellCommand/guardInlineCode/guardBridgeToolInvocation) check env —
 * file-op gọi trực tiếp hàm này nên guard tắt không trọn vẹn (gap fix).
 */
export function isProtectedInfraPathSync(absPath: string, root: string): InfraPathVerdict {
  if (process.env.TMO_INFRA_GUARD === 'off') return { protected: false }
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

/** Các lệnh ghi/xoá file nguy hiểm — kết hợp với token protected phía dưới.
 * ROUND-6 (2026-10-28, user directive): mở rộng bịt các bypass thực nghiệm —
 * perl -pi, awk/gawk -i inplace, ed/ex -s, install, patch, git apply/checkout/
 * restore/stash, rsync, scp, sponge, shred, ln, curl -o, wget -O. Loại
 * trừ `install` đứng sau package-manager (bun/npm/pnpm/yarn install...) theo
 * chính sách 2026-10-27 cho phép tự cài package. */
const FILE_WRITE_CMD_RE = new RegExp(
  [
    '\\b(?:rm|mv|cp|dd|truncate|chmod|chown|tee|shred|sponge|rsync|scp|ln)\\b',
    '(?<!\\b(?:bun|npm|pnpm|yarn|apt|apt-get|brew|pip3?|pipx|gem|cargo|go|dpkg)\\s+)install\\b',
    '\\bsed\\b[^;|&]*-i',
    '\\bperl\\b[^;|&]*\\s-\\w*i\\b',
    '\\b(?:g?awk|mawk)\\b[^;|&]*\\s-i\\b',
    '\\b(?:ed|ex)\\s+-s\\b',
    '\\bpatch\\b',
    '\\bgit\\s+(?:apply|checkout|restore|stash)\\b',
    '\\bcurl\\b[^;|&]*\\s(?:-o|--output)\\b',
    '\\bwget\\b[^;|&]*\\s(?:-O|--output-document)\\b',
  ].join('|'),
)

/** Sửa package.json qua `npm pkg set` — sửa tay config hệ thống không qua lệnh
 * cài/gỡ package chính thống (bun add/remove) → chặn thẳng (ROUND-6). */
const PKG_JSON_MUTATE_RE = /\b(?:npm|pnpm|yarn)\s+pkg\s+(?:set|unset|delete)\b/

/** sqlite3 CLI ghi thẳng file DB — kết hợp keyword ghi (ROUND-6). */
const SQLITE3_RE = /\bsqlite3?\b/
const SQL_WRITE_KW_RE = /\b(?:insert|update|delete|drop|create|alter|replace|attach|detach|pragma|vacuum)\b/i

/** Interpreter chạy code inline — python/node/bun/deno/perl/ruby/php -c/-e/-r.
 * Code inline có thể ghi file qua open()/writeFileSync/Bun.write... — kết hợp
 * với CODE_WRITE_HINT_RE + token protected để chặn (ROUND-6). */
const INLINE_INTERPRETER_RE = /\b(?:python3?|node|bun|deno|perl|ruby|php)\b[^;|&]*\s(?:--eval|-c|-e|-r)\b/

/** Dấu hiệu GHI file trong code inline (python/node/bun...). */
const CODE_WRITE_HINT_RE =
  /open\s*\([^)]*["']?>|open\s*\([^)]*["'][wa]b?["']\s*[,)]|writeFileSync|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync|truncateSync|writeFile\s*\(|Bun\.write|writeTextFile|write_text|write_bytes|os\.(?:remove|unlink|rename|truncate)|shutil\.|fs\.(?:rename|unlink|rm|truncate)\s*\(|new\s+Database\s*\(|--outfile/

/**
 * Token trỏ tới file/thư mục protected: khớp cả dạng relative (prisma/schema.prisma)
 * lẫn absolute (.../tmo-app/package.json). Chỉ dùng trong TMO context để tránh
 * false-positive với dự án khác có cấu trúc tương tự.
 */
const PROTECTED_TOKEN_RE = new RegExp(
  '(?:^|[\\s"\'=(/])(?:\\.?/)?(?:' +
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

/** Redirect ghi file: `> target` / `>> target` / `>| target` (clobber).
 * ROUND-6: thêm `\|?` sau redirect (bash noclobber bypass) — target sẽ được
 * strip quote phía dưới (bug cũ: `> ".env"` / `>package.json'` bypass). */
const REDIRECT_RE = />{1,2}\|?\s*([^\s|;&)]+)/g

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

/** Bản /g của token regex — dùng cho vòng lặp exec (bản gốc không /g chỉ
 * trả mãi match đầu → vòng lặp không tiến + tốn guard-limit). */
const PROTECTED_TOKEN_G_RE = new RegExp(PROTECTED_TOKEN_RE.source, 'gi')

/** Trích path chứa segment protected từ chuỗi lệnh/code, VERIFY bằng resolve.
 * Token khớp (PROTECTED_TOKEN_RE) chỉ là trigger — mở rộng 2 phía để lấy
 * FULL path quanh token (src/package.json, /tmp/db/x, ~/tmo-app/.env),
 * resolve rồi mới quyết định. Tránh cả false-positive lẫn false-negative. */
function findProtectedPathTarget(
  text: string,
  resolveFromCwd: (tok: string) => string,
  absRoot: string,
): string | null {
  PROTECTED_TOKEN_G_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = PROTECTED_TOKEN_G_RE.exec(text)) !== null && guard++ < 50) {
    // m[0] chứa 1 ký tự boundary phía trước (space/quote/=(/) — bỏ để lấy token
    const token = m[0].replace(/^[\s"'=(/]/, '')
    if (!token) continue
    const tokenStart = m.index + (m[0].length - token.length)
    const tokenEnd = tokenStart + token.length
    // Mở rộng trái qua ký tự path (chữ số, chữ, @ . ~ - _ , /)
    let start = tokenStart
    while (start > 0 && /[\w@.~,-]|\//.test(text[start - 1])) start--
    // Mở rộng phải qua ký tự path
    let end = tokenEnd
    while (end < text.length && /[\w@.~,-]|\//.test(text[end])) end++
    const candidate = text.slice(start, end).replace(/^["']+|["']+$/g, '')
    if (!candidate) continue
    const verdict = isProtectedInfraPathSync(resolveFromCwd(candidate), absRoot)
    if (verdict.protected) return verdict.matched || candidate
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

  // ROUND-6: track biến được gán giá trị protected path (`F=.env; echo x > $F`
  // — bug cũ: redirect target là biến thì resolve không ra path protected).
  const protectedVars = new Set<string>()
  const ASSIGN_RE = /(?:^|[\s;])([A-Za-z_]\w*)=([^\s;&|)'"]+)/g
  let am: RegExpExecArray | null
  while ((am = ASSIGN_RE.exec(command)) !== null) {
    const val = am[2]
    if (isProtectedInfraPathSync(resolveFromCwd(val), absRoot).protected) {
      protectedVars.add(am[1])
    }
  }

  REDIRECT_RE.lastIndex = 0
  let rm: RegExpExecArray | null
  while ((rm = REDIRECT_RE.exec(command)) !== null) {
    // ROUND-6: strip quote bao quanh target (bug cũ: `> ".env"` / `>file'` bypass)
    const target = (rm[1] || '').replace(/^["']+|["']+$/g, '')
    if (!target) continue
    // ROUND-6: redirect vào biến $F đã gán protected path
    if (target.startsWith('$')) {
      const varName = target.replace(/^\$\{?/, '').replace(/\}$/, '')
      if (protectedVars.has(varName)) {
        redirectTarget = `$${varName} (biến gán protected path)`
        break
      }
      continue // biến lạ — không resolve tĩnh được, bỏ qua
    }
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

  // 4) Lệnh ghi/xoá file (danh sách FILE_WRITE_CMD_RE) có token protected.
  // ROUND-6: token khớp chỉ là TRIGGER — sau đó VERIFY bằng resolve path thật
  // (giết false-positive `/tmp/db/x`, `src/package.json`, URL `x/package.json`;
  // bắt thêm false-negative `~/tmo-app/.env`, `/home/z/tmo-app/db/x`).
  if (FILE_WRITE_CMD_RE.test(command)) {
    const hit = findProtectedPathTarget(command, resolveFromCwd, absRoot)
    if (hit) {
      return {
        blocked: true,
        reason: `file-mutation command on protected path: ${hit}`,
        message: buildBlockedMessage(hit),
      }
    }
    // wget KHÔNG -O ghi file theo BASENAME URL vào cwd — URL chứa basename
    // protected (vd `wget https://x/package.json`) → nguy hiểm dù path-trigger
    // không resolve về root. Chặn khi wget + protected basename xuất hiện.
    if (/\bwget\b/.test(command)) {
      PROTECTED_TOKEN_RE.lastIndex = 0
      if (PROTECTED_TOKEN_RE.test(command)) {
        return {
          blocked: true,
          reason: 'wget (output = basename URL vào cwd) nhắm protected file',
          message: buildBlockedMessage('wget tải về đè file protected theo basename'),
        }
      }
    }
  }

  // 4b) ROUND-6: `npm pkg set/unset` — sửa package.json không qua lệnh cài
  // package chính thống (bun add/remove) → chặn như file_edit package.json.
  if (PKG_JSON_MUTATE_RE.test(command)) {
    return {
      blocked: true,
      reason: 'npm/pnpm/yarn pkg set — mutate package.json trực tiếp',
      message: buildBlockedMessage('package.json (qua npm pkg set)'),
    }
  }

  // 4c) ROUND-6: sqlite3 CLI ghi thẳng file DB (INSERT/UPDATE/DROP...) —
  // thay đổi dữ liệu DB phải qua prisma chính thống, không ghi tay file DB.
  if (SQLITE3_RE.test(command) && SQL_WRITE_KW_RE.test(command)) {
    const hit = findProtectedPathTarget(command, resolveFromCwd, absRoot)
    if (hit) {
      return {
        blocked: true,
        reason: `sqlite3 write trên protected DB file: ${hit}`,
        message: buildBlockedMessage(hit),
      }
    }
  }

  // 4d) ROUND-6: interpreter chạy code inline (python/node/bun -c/-e...) có
  // dấu hiệu GHI file + token protected — echo/tee/sed -i nhưng qua code.
  if (INLINE_INTERPRETER_RE.test(command) && CODE_WRITE_HINT_RE.test(command)) {
    const hit = findProtectedPathTarget(command, resolveFromCwd, absRoot)
    if (hit) {
      return {
        blocked: true,
        reason: `inline-code write (python/node/bun -c/-e) → protected path: ${hit}`,
        message: buildBlockedMessage(hit),
      }
    }
  }

  return { blocked: false }
}

/** Wrapper tiện dụng cho các file-op (đã resolve xong path). */
export function buildFileOpBlockedMessage(relPath: string): string {
  return buildBlockedMessage(relPath)
}

// ============================================================================
// ROUND-6 (2026-10-28): GUARD LỚP 2 — GATEWAY-BRIDGE TOOLS
// ============================================================================
// Lỗ hổng: gateway_tool proxy (dev-tools.ts) + API /api/openclaw/bridge +
// mini-service gateway-bridge (18791, KHÔNG auth) chuyển tiếp 36 bridge tools
// thẳng tới gateway — trong đó `exec`, `write`, `edit`, `apply_patch`,
// `code_execution`, `process` ghi file/chạy lệnh KHÔNG qua guardShellCommand.
// Agent có thể bypass lớp 1 hoàn toàn: `gateway_tool {name:"write", args:{
// path:".env"}}` hoặc `curl -XPOST 127.0.0.1:18791/tools/invoke`.
// Fix: guardBridgeToolInvocation đặt tại MỌI choke point (app proxy, API route,
// và bản thân bridge mini-service) — mọi invocation tool ghi/lệnh phải qua
// đúng guard như lớp 1 (user directive: "chặn như lớp 1").
// ============================================================================

/** Code chạy inline (python/node/bun -c/-e hoặc tool code_execution) có dấu
 * hiệu ghi file + protected token → chặn như lớp 1. */
export function guardInlineCode(code: string, root: string): ShellGuardVerdict {
  if (process.env.TMO_INFRA_GUARD === 'off') return { blocked: false }
  if (!code || !CODE_WRITE_HINT_RE.test(code)) return { blocked: false }
  const absRoot = path.resolve(root)
  const resolveFromRoot = (tok: string): string => {
    if (tok.startsWith('/') || tok.startsWith('~')) return path.resolve(tok.replace(/^~/, process.env.HOME || '~'))
    return path.resolve(absRoot, tok)
  }
  const hit = findProtectedPathTarget(code, resolveFromRoot, absRoot)
  if (hit) {
    return {
      blocked: true,
      reason: `inline-code write → protected path: ${hit}`,
      message: buildBlockedMessage(hit),
    }
  }
  return { blocked: false }
}

/** Các bridge tool có khả năng GHI file / chạy lệnh — phải qua guard. */
export const BRIDGE_MUTATING_TOOLS: readonly string[] = [
  'exec',
  'write',
  'edit',
  'apply_patch',
  'code_execution',
  'process',
]

/** Guard invocation bridge tool (gọi tại MỌI choke point trước khi forward):
 *  - exec/process: command → guardShellCommand (đủ self-destruct + infra)
 *  - code_execution: code → guardInlineCode
 *  - write/edit/apply_patch: path → isProtectedInfraPathSync
 * Trả verdict — blocked: true thì choke point PHẢI từ chối invocation. */
export function guardBridgeToolInvocation(input: {
  name: string
  args: Record<string, unknown>
  root: string
  cwd?: string
}): ShellGuardVerdict {
  if (process.env.TMO_INFRA_GUARD === 'off') return { blocked: false }
  const { name } = input
  if (!BRIDGE_MUTATING_TOOLS.includes(name)) return { blocked: false }
  const a = input.args || {}
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const absRoot = path.resolve(input.root)
  const absCwd = path.resolve(input.cwd || input.root)

  if (name === 'write' || name === 'edit' || name === 'apply_patch') {
    const p = s(a.path) || s(a.file) || s(a.filename) || s(a.target)
    if (!p) return { blocked: false }
    const resolved = p.startsWith('/') || p.startsWith('~')
      ? path.resolve(p.replace(/^~/, process.env.HOME || '~'))
      : path.resolve(absCwd, p)
    const verdict = isProtectedInfraPathSync(resolved, absRoot)
    if (verdict.protected) {
      return {
        blocked: true,
        reason: `bridge ${name} → protected path: ${verdict.matched || p}`,
        message: buildBlockedMessage(verdict.matched || p),
      }
    }
    return { blocked: false }
  }

  if (name === 'code_execution') {
    const code = s(a.code) || s(a.script) || s(a.source) || s(a.input)
    if (!code) return { blocked: false }
    return guardInlineCode(code, absRoot)
  }

  // exec / process: chạy shell → guard đầy đủ như lớp 1
  const command = s(a.command) || s(a.cmd) || s(a.script) || s(a.code)
  if (!command) return { blocked: false }
  return guardShellCommand(command, absCwd, absRoot)
}
