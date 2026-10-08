// ============================================
// src/lib/exec-allowlist.ts — P0-1 policy cho POST /api/opencode/execute
//
// VẤN ĐỀ (P0-1): src/app/api/opencode/execute/route.ts từng chạy
//   execSync(command, { cwd: userInput, env: {...process.env} })
// với `command` + `cwd` lấy thẳng từ body → RCE từ bất kỳ ai gọi được
//   route (proxy chỉ chặn bằng 1 static token, không có allowlist).
//
// NGUYÊN TẮC (module này là "policy" thuần — KHÔNG import child_process
// để test được ở mọi nơi):
//   1. KHÔNG shell. Token hoá lệnh thành argv; route gọi execFile(shell:false).
//      → Dấu `; | && $() >` chỉ là ký tự vô hại, không bao giờ được interpret.
//   2. CHỈ chạy binary trong allowlist với subcommand/flag được duyệt.
//   3. Arg dạng path phải nằm trong cwd, và không đọc file secret.
//   4. Giới hạn cứng: độ dài lệnh, số token, timeout, dung lượng output.
// ============================================

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface PolicyLimits {
  maxCommandChars: number
  maxTokens: number
  maxTokenChars: number
  maxArgs: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
}

export const LIMITS: PolicyLimits = {
  maxCommandChars: 1000,
  maxTokens: 16,
  maxTokenChars: 200,
  maxArgs: 12,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 30_000,
  maxOutputBytes: 256 * 1024, // 256KB
}

/**
 * Token hợp lệ: chữ/số + `-_./:=,@%+~*?[]`
 * KHÔNG có: space (đã tách), quote, backslash, `$`, backtick, `;`, `&`, `|`,
 * `<`, `>`, `(`, `)`, `{`, `}`, `#`, newline → không token nào chứa được
 * metachar shell.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._/:=,@%+~*?\[\]-]+$/

export type ParseError =
  | 'empty'
  | 'not_string'
  | 'too_long'
  | 'metachar'
  | 'too_many_tokens'
  | 'token_too_long'
  | 'empty_token'

export interface ParsedCommand {
  tokens: string[]
  bin: string
}

export type ParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: ParseError; message: string }

/** Tách lệnh thành argv KHÔNG qua shell (split whitespace, không quote-aware). */
export function parseCommand(raw: unknown): ParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'not_string', message: 'command must be a string' }
  }
  const value = raw.trim()
  if (!value) return { ok: false, error: 'empty', message: 'command is required' }
  if (value.length > LIMITS.maxCommandChars) {
    return {
      ok: false,
      error: 'too_long',
      message: `command exceeds ${LIMITS.maxCommandChars} characters`,
    }
  }
  const tokens = value.split(/\s+/)
  if (tokens.length > LIMITS.maxTokens) {
    return {
      ok: false,
      error: 'too_many_tokens',
      message: `command exceeds ${LIMITS.maxTokens} arguments`,
    }
  }
  for (const token of tokens) {
    if (!token) {
      return { ok: false, error: 'empty_token', message: 'empty argument' }
    }
    if (token.length > LIMITS.maxTokenChars) {
      return {
        ok: false,
        error: 'token_too_long',
        message: `argument exceeds ${LIMITS.maxTokenChars} characters`,
      }
    }
    if (!SAFE_TOKEN.test(token)) {
      return {
        ok: false,
        error: 'metachar',
        message:
          'argument rejected: quotes, backslash and shell metacharacters (; | & $ ` < > ( ) { }) are not allowed',
      }
    }
  }
  return { ok: true, value: { tokens, bin: tokens[0].toLowerCase() } }
}

// ------------------------------------------------------------
// ALLOWLIST
// ------------------------------------------------------------

export interface BinRule {
  /** subcommand hợp lệ (token đầu tiên KHÔNG bắt đầu bằng '-') */
  subcommands?: readonly string[]
  /** cho phép chạy binary mà không có subcommand (vd `pwd`) */
  allowNoSubcommand?: boolean
  /** flag token phải khớp TRỌN regex này */
  flags?: RegExp
  /** flag khớp regex này bị chặn (đứng trước `flags`) */
  denyFlags?: RegExp
  /** số arg tối đa (không tính subcommand) */
  maxArgs?: number
  /** mọi arg không phải flag phải là path nằm trong cwd */
  pathsOnly?: boolean
  /**
   * (r64.2 — F3) Subcommand trong danh sách này KHÔNG được nhận thêm positional
   * nào sau nó: `git branch <tên>` TẠO ref, `git remote set-url …` GHI .git/config
   * (repoint origin = supply-chain) → chỉ cho phép dạng list.
   */
  noExtraPositional?: readonly string[]
  /**
   * (r64.2 — F4) Binary diễn giải arg dạng `<rev>:<path>` (git show/log/diff):
   * path-part được resolve theo REPO ROOT chứ không theo cwd → `HEAD:../ngoài`
   * thoát guard lexical 1 mức, và `HEAD:.env` đọc secret trong lịch sử commit.
   * path-part (sau ':' đầu tiên) cũng phải qua path guard.
   */
  revPathAware?: boolean
  description: string
}

/** Short flag đơn, ví dụ `-r`, `-la`, `--maxdepth`. KHÔNG cho phép `-c` (git -c core.pager=…) */
const FLAG_OK = /^--?[A-Za-z][A-Za-z0-9-]*$/
/**
 * FLAG_ANY (r64.2 — audit lượt 6, F5): flag boolean HOẶC `flag=giá-trị`.
 * Trước đây ls/tail/grep/rg bị buộc FLAG_WITH_VALUE → `ls -la`, `grep -rn`,
 * `tail -n 20`… (các dạng inspect phổ biến nhất) đều rơi 403 bad_flag.
 * Binary dùng FLAG_ANY PHẢI tự khai denyFlags cho flag nguy hiểm riêng.
 */
const FLAG_ANY = /^--?[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/:=,@%+~*?\[\]-]+)?$/
/**
 * GIT_LONG_ONLY (r64.2 — F7): git CHỈ nhận flag DÀI `--…` (kèm `=giá-trị`
 * tùy chọn). Mọi flag ngắn bị chặn tại tầng policy ⇒ `-c<config>=<giá-trị>`
 * (config override — vector diff.external/core.fsmonitor) và `-C<path>`
 * (đổi thư mục) chết ngay, không phụ thuộc hành vi parse từng bản git
 * (git 2.47 tự chối `-C=/x`, nhưng không cam kết cho mọi bản).
 */
const GIT_LONG_ONLY = /^--[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/:=,@%+~*?\[\]-]+)?$/

const ALLOWLIST: Record<string, BinRule> = {
  git: {
    subcommands: [
      'status',
      'log',
      'diff',
      'show',
      'branch',
      'rev-parse',
      'ls-files',
      'describe',
      'shortlog',
      'blame',
      'remote',
    ],
    // --exec/--ext-diff/--textconv/--upload-pack/-c đều có thể chạy code tùy ý.
    // --output/--git-dir/--work-tree/--namespace/--super-prefix/--exec-path mang
    // GIÁ TRỊ là ĐƯỜNG DẪN → nếu không chặn, path guard bị bypass (arg bắt đầu bằng
    // '-' nên bị `continue`): `git log --output=/etc/cron.d/x` ghi file NGOÀI cwd,
    // `git --git-dir=/repo-khá log` đọc repo khác. → deny ở đây (denyFlags khớp
    // CẢ dạng `--flag=value` vì checkAllowlist tách flag.split('=')[0]).
    denyFlags:
      /^(--exec|--ext-diff|--textconv|--upload-pack|--upload-archive|--config-env|--output|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|-c)$/,
    flags: GIT_LONG_ONLY,
    maxArgs: 10,
    pathsOnly: true,
    noExtraPositional: ['branch', 'remote'],
    revPathAware: true,
    description: 'git read-only inspection (status/log/diff/show/branch/…)',
  },
  ls: {
    // KHÔNG có subcommand list → mọi positional đều là path, phải kiểm tra cwd
    allowNoSubcommand: true,
    flags: FLAG_ANY,
    maxArgs: 8,
    pathsOnly: true,
    description: 'list directory',
  },
  pwd: { allowNoSubcommand: true, maxArgs: 0, description: 'print working directory' },
  whoami: { allowNoSubcommand: true, maxArgs: 0, description: 'print current user' },
  uname: { allowNoSubcommand: true, flags: FLAG_OK, maxArgs: 3, description: 'system information' },
  du: {
    allowNoSubcommand: true,
    // r69 (audit lượt 9 — M1): -X/--exclude-from đọc FILE danh sách mẫu,
    // --files0-from đọc FILE danh sách path. Ngoài cwd → thoát containment
    // (đo thật: `du --files0-from=/etc/hostname` in kích thước file ngoài cwd);
    // trong cwd → đọc GIÁN TIẾP file secret mà denylist theo TÊN không thấy
    // (`paths.txt` chứa `.env`). Fail-closed như `grep -f`.
    denyFlags: /^(--files0-from|--exclude-from|-X)$/,
    flags: FLAG_ANY,
    maxArgs: 6,
    pathsOnly: true,
    description: 'disk usage',
  },
  df: { allowNoSubcommand: true, flags: FLAG_ANY, maxArgs: 4, description: 'filesystem usage' },
  head: { allowNoSubcommand: true, flags: FLAG_ANY, maxArgs: 4, pathsOnly: true, description: 'first lines of a file' },
  tail: {
    allowNoSubcommand: true,
    // r64.2 (F5+F2): FLAG_ANY cho `-n 20`…; deny mọi biến thể follow
    // (-f/-F/--follow/--retry — treo tới hết timeout, prefix-match để chặn
    // cả cụm gộp `-fn20` / `--follow=name`).
    denyFlags: /^(-[fF]|--follow|--retry)/,
    flags: FLAG_ANY,
    maxArgs: 4,
    pathsOnly: true,
    description: 'last lines of a file (không follow)',
  },
  wc: {
    allowNoSubcommand: true,
    // r69 (M1): --files0-from=F đọc danh sách path rồi MỞ chúng → bypass
    // path guard (đo thật: `wc --files0-from=/etc/hostname` trả số dòng/từ
    // của file NGOÀI cwd, exit 0).
    denyFlags: /^--files0-from$/,
    flags: FLAG_ANY,
    maxArgs: 6,
    pathsOnly: true,
    description: 'count lines/words',
  },
  cat: { allowNoSubcommand: true, flags: FLAG_ANY, maxArgs: 6, pathsOnly: true, description: 'print a (non-secret) file' },
  echo: { allowNoSubcommand: true, maxArgs: 4, description: 'print literal text' },
  node: {
    // chỉ `--version` — KHÔNG cho -e/-p/--eval (đọc code từ argv)
    allowNoSubcommand: true,
    flags: /^--?(v|version)$/,
    maxArgs: 0,
    description: 'node --version',
  },
  bun: { allowNoSubcommand: true, flags: /^--?(v|version)$/, maxArgs: 0, description: 'bun --version' },
  npm: { subcommands: ['ls', 'list', 'view', 'outdated'], flags: FLAG_OK, maxArgs: 6, description: 'npm read-only' },
  grep: {
    allowNoSubcommand: true,
    // r64.2: deny -f/--file (đọc pattern từ file — dạng attach `-f.env` và
    // `--file=.env` nhúng path vào flag token, thoát path guard).
    // r69 (M1): --exclude-from/--exclude-file đọc file danh sách mẫu (cùng
    // lớp với -f/--file đã chặn ở r64.2) → deny.
    denyFlags: /^(-f|--file)|^(--exclude-from|--exclude-file)$/,
    flags: FLAG_ANY,
    maxArgs: 8,
    pathsOnly: true,
    description: 'text search',
  },
  rg: {
    allowNoSubcommand: true,
    // r64.2 (F2): `--pre=<bin>` — rg CHẠY binary làm preprocessor trên nội dung
    // file (`rg --pre=bash foo pm2-start.sh` → bash thực thi script trong
    // repo!) → deny cứng cả --pre-glob; -f/--file như grep (fail-closed).
    // r69 (M1): --ignore-file/-case-insensitive đọc file danh sách ignore.
    denyFlags: /^(-f|--file|--pre|--pre-glob)|^(--ignore-file|--ignore-file-case-insensitive)$/,
    flags: FLAG_ANY,
    maxArgs: 8,
    pathsOnly: true,
    description: 'ripgrep search (không --pre)',
  },
  find: {
    allowNoSubcommand: true,
    flags: /^-{1,2}(maxdepth|mindepth|depth|type|name|iname|path|newer|mtime|size|ls|print|empty)$/,
    maxArgs: 8,
    pathsOnly: true,
    description: 'find files (không -exec/-delete/-fprint*)',
  },
}

export const ALLOWLIST_BINARIES = Object.keys(ALLOWLIST)

export type AllowErrorCode =
  | 'not_allowlisted'
  | 'bad_flag'
  | 'bad_subcommand'
  | 'too_many_args'
  | 'path_not_allowed'
  /** r64.2 (F3): subcommand read-only bị đè positional (git branch <tên>…) */
  | 'extra_positional'

export type AllowResult =
  | {
      ok: true
      bin: string
      subcommand?: string
      args: string[]
      rule: BinRule
    }
  | { ok: false; code: AllowErrorCode; message: string }

function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-' && token !== '--'
}

/**
 * Kiểm tra argv đã token-hoá nằm trong allowlist.
 * KHÔNG gọi process/spawn — thuần hàm.
 */
export function checkAllowlist(parsed: ParsedCommand): AllowResult {
  const rule = ALLOWLIST[parsed.bin]
  if (!rule) {
    return {
      ok: false,
      code: 'not_allowlisted',
      message: `command not allowed: ${parsed.bin} (allowlist: ${ALLOWLIST_BINARIES.join(', ')})`,
    }
  }

  const rest = parsed.tokens.slice(1)
  const flags = rest.filter(isFlag)
  const positional = rest.filter((t) => !isFlag(t))
  const maxArgs = rule.maxArgs ?? LIMITS.maxArgs
  if (positional.length > maxArgs) {
    return { ok: false, code: 'too_many_args', message: `${parsed.bin}: too many arguments` }
  }

  for (const flag of flags) {
    // deny phải khớp CẢ dạng có giá trị: `--exec`, `--exec=rm`, `--config-env=x`.
    // Nếu chỉ regex `^(--exec)$` thì `--exec=rm` lọt qua (bug đã bị test bắt).
    const flagName = flag.split('=')[0]
    if (rule.denyFlags?.test(flag) || rule.denyFlags?.test(flagName)) {
      return { ok: false, code: 'bad_flag', message: `${parsed.bin}: flag not allowed: ${flag}` }
    }
    if (rule.flags && !rule.flags.test(flag)) {
      return { ok: false, code: 'bad_flag', message: `${parsed.bin}: flag not allowed: ${flag}` }
    }
  }

  // CHỉ coi positional[0] là subcommand khi rule thật sự khai báo danh sách.
  // Nếu không, mọi positional là path (vd `cat .env`) và PHẢI qua path guard —
  // nếu gọi nhầm là subcommand, arg đầu tiên sẽ thoát kiểm tra path (bug: đọc được .env).
  const subcommand = rule.subcommands ? positional[0] : undefined
  if (!subcommand) {
    if (!rule.allowNoSubcommand) {
      return {
        ok: false,
        code: 'bad_subcommand',
        message: `${parsed.bin}: missing subcommand (allowed: ${(rule.subcommands ?? []).join(', ')})`,
      }
    }
  } else if (rule.subcommands && !rule.subcommands.includes(subcommand)) {
    return {
      ok: false,
      code: 'bad_subcommand',
      message: `${parsed.bin}: subcommand not allowed: ${subcommand} (allowed: ${rule.subcommands.join(', ')})`,
    }
  }

  // r64.2 (F3): `git branch <tên>` ghi ref, `git remote set-url …` ghi
  // .git/config — hai subcommand này chỉ được dùng ở DẠNG LIST (0 positional thêm).
  if (
    subcommand &&
    rule.noExtraPositional?.includes(subcommand) &&
    positional.length > 1
  ) {
    return {
      ok: false,
      code: 'extra_positional',
      message: `${parsed.bin} ${subcommand}: listing only — positional arguments not allowed for this subcommand`,
    }
  }

  return { ok: true, bin: parsed.bin, subcommand, args: rest, rule }
}

// ------------------------------------------------------------
// PATH GUARD — chặn traversal + đọc file secret
// ------------------------------------------------------------

/**
 * Tên file/thư mục chứa secret — KHÔNG BAO GIỜ được đọc qua route này.
 *
 * r65 (audit lượt 7 — H2/H4): bổ sung họ database + .git/.
 * - Trước đây `cat db/custom.db` PASS policy — DB app chứa toàn bộ dữ liệu
 *   runtime (ChatMessage, AgentSession, AgentMemory, tokensUsage…) nằm ngay
 *   trong cwd mặc định (project root) → đọc tự do qua đường local-exec
 *   HỢP LỆ (không cần shell!). Cả đường rev:path `git show HEAD:db/custom.db`.
 * - `.git/` internals (.git/config có thể chứa credential dạng
 *   https://token@host trong remote URL; .git/index lộ cấu trúc tree).
 * - False-positive đã cân: `.gitignore`/`.gitattributes` KHÔNG match
 *   (pattern yêu cầu `.git` kết thúc hoặc theo sau bởi '/').
 */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.tmo-api-token$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i,
  // r65 (H2): database file mọi biến thể (kể cả -wal/-shm/-journal sidecar
  // của SQLite — WAL thậm chí chứa dữ liệu tươi hơn DB chính).
  /\.(db|db3|sqlite|sqlite3)(-(wal|shm|journal))?$/i,
  // r65 (H4): git internals — KHÔNG match .gitignore/.gitattributes.
  /(^|\/)\.git(\/|$)/i,
]

export function isSecretPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return SECRET_PATTERNS.some((re) => re.test(normalized))
}

/** true nếu `target` nằm trong `root` (root hoặc root/...) */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)
}

/** Arg dạng path có an toàn để truyền cho lệnh read-only không? */
export function isPathArgAllowed(value: string, cwd: string): boolean {
  if (isSecretPath(value)) return false
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  return isInside(cwd, absolute)
}

/**
 * Cwd được phép: project root + các root thêm qua env
 * TMO_EXEC_ALLOWED_ROOTS (phân tách bởi `,` hoặc `:`).
 */
export function allowedRoots(): string[] {
  const roots = new Set<string>([resolve(process.cwd())])
  const extra = process.env.TMO_EXEC_ALLOWED_ROOTS
  if (extra) {
    for (const part of extra.split(/[,:]/)) {
      const trimmed = part.trim()
      if (trimmed) roots.add(resolve(trimmed))
    }
  }
  return [...roots]
}

export type CwdResult = { ok: true; cwd: string } | { ok: false; message: string }

/** Chỉ chấp nhận cwd nằm trong allowedRoots — không nhận `..` thoát ra ngoài. */
export function resolveSafeCwd(candidate: unknown): CwdResult {
  if (candidate === undefined || candidate === null || candidate === '') {
    return { ok: true, cwd: resolve(process.cwd()) }
  }
  if (typeof candidate !== 'string') return { ok: false, message: 'cwd must be a string' }
  if (candidate.length > 512) return { ok: false, message: 'cwd path too long' }
  if (isSecretPath(candidate)) return { ok: false, message: 'cwd not allowed' }
  const absolute = resolve(candidate)
  const roots = allowedRoots()
  if (!roots.some((root) => isInside(root, absolute))) {
    return {
      ok: false,
      message: `cwd not allowed (allowed roots: ${roots.join(', ')})`,
    }
  }
  // r68 (audit lượt 8 — K1): guard trên là LEXICAL. Một symlink NẰM TRONG allowed
  // root nhưng trỏ ra ngoài (`ln -s /etc repo/etc-link`) vượt qua `isInside`
  // (đường dẫn gốc nằm trong root), còn execFile({ cwd }) đi theo symlink THẬT →
  // lệnh chạy ở /etc và `ls`/`cat passwd` đọc NGOÀI containment. Bằng chứng máy:
  // resolveSafeCwd(cwd=tmp/.../etc-link) => ok, findRealpathEscape => null,
  // exec `ls` trả danh sách root filesystem (exit 0).
  // FIX: với path TỒN TẠI, realpath(candidate) phải nằm trong realpath(root) tương ứng
  // (giống hệt F8 cho path-arg nhưng áp cho cwd). Path không tồn tại → giữ hành vi cũ
  // (lệnh con tự lỗi, không đọc được gì).
  if (existsSync(absolute)) {
    let realAbsolute = absolute
    try {
      realAbsolute = realpathSync(absolute)
    } catch {
      realAbsolute = absolute
    }
    const contained = roots.some((root) => {
      let realRoot = root
      try {
        if (existsSync(root)) realRoot = realpathSync(root)
      } catch {
        realRoot = root
      }
      return isInside(realRoot, realAbsolute)
    })
    if (!contained) {
      return {
        ok: false,
        message: 'cwd not allowed (symlink escapes allowed roots)',
      }
    }
  }
  return { ok: true, cwd: absolute }
}

/**
 * Với binary đánh dấu `pathsOnly`, mọi positional arg phải là path an toàn.
 * Subcommand (vd `status` của git) cũng đi qua cùng phép kiểm — nó luôn
 * resolve nằm trong cwd nên không gây false-positive.
 *
 * r64.2 (F4): rule `revPathAware` (git) — arg dạng `<rev>:<path>` được git
 * diễn giải theo REPO ROOT (không theo cwd) → path-part (sau ':' đầu tiên)
 * cũng phải qua path guard: chặn `git show HEAD:.env` (secret trong lịch sử
 * commit) và `git show HEAD:../ngoài-repo` (thoát guard lexical 1 mức).
 * Cú pháp commit-search `:/<text>` cũng bị chặn (path-part absolute) — chấp
 * nhận trade-off fail-closed.
 */
export function validatePaths(allow: Extract<AllowResult, { ok: true }>, cwd: string): AllowResult {
  if (!allow.rule.pathsOnly) return allow
  for (const arg of allow.args) {
    if (arg.startsWith('-')) {
      // r69 (audit lượt 9 — M1): token bắt đầu bằng '-' KHÔNG có nghĩa là
      // "không phải path". `--output=/etc/cron.d/x`, `--files0-from=/etc/hostname`
      // mang ĐƯỜNG DẪN trong phần sau '=' và trước đây thoát hoàn toàn khỏi
      // path guard. Áp CÙNG phép kiểm (secret + containment) cho phần value:
      // tuyệt đối / ngoài cwd / tên file secret → chặn. Value không phải path
      // (`--color=auto`, `--maxdepth=2`, `--pretty=format:%h`) vẫn qua.
      const eq = arg.indexOf('=')
      const flagValue = eq > 0 ? arg.slice(eq + 1) : ''
      if (flagValue && !isPathArgAllowed(flagValue, cwd)) {
        return {
          ok: false,
          code: 'path_not_allowed',
          message: `flag value not allowed (outside cwd or secret file): ${arg}`,
        }
      }
      continue
    }
    if (allow.subcommand && arg === allow.subcommand) continue
    if (!isPathArgAllowed(arg, cwd)) {
      return {
        ok: false,
        code: 'path_not_allowed',
        message: `path not allowed (outside cwd or secret file): ${arg}`,
      }
    }
    if (allow.rule.revPathAware && arg.includes(':')) {
      const pathPart = arg.slice(arg.indexOf(':') + 1)
      if (pathPart && !isPathArgAllowed(pathPart, cwd)) {
        return {
          ok: false,
          code: 'path_not_allowed',
          message: `rev-path not allowed (outside cwd or secret file): ${arg}`,
        }
      }
    }
  }
  return allow
}

/** Log-safe: chỉ bin + subcommand + fingerprint, KHÔNG log raw command (có thể chứa secret do user gõ). */
export function commandFingerprint(command: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < command.length; i++) {
    hash ^= command.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}