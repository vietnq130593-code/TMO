/**
 * Fingerprint nguồn dùng chung cho các artifact audit.
 *
 * Mục đích (chống fail-open gốc rễ): artifact phải CHỨNG MINH được nó được sinh ra
 * trên cây source nào. Không có fingerprint thì evidence không gắn với commit —
 * một artifact cũ vẫn trông "xanh" sau khi code đã đổi.
 *
 * SENTINEL-FIX: fingerprint CŨ là `${head7}+dirty:${dirtyCountToanRepo}`.
 * dirtyCount toàn repo KHÔNG ổn định: bản thân quá trình audit ghi
 * `audit-out/*.json` + `AUDIT-REPORT.md` (3 file audit-out đã được git track dù
 * .gitignore có `audit-out/`) ⇒ mỗi lần chạy lại audit làm dirtyCount tăng ⇒ mọi
 * artifact vừa sinh lập tức bị coi là STALE ⇒ gate fail-closed vô dụng (hoặc ngược
 * lại buộc phải bỏ gate để xanh).
 *
 * Cơ chế MỚI — content-based, chỉ trong SCOPE (source ảnh hưởng runtime):
 *   fingerprint = `${head7}+sc:${sha12}`
 *   sha12 = sha256(head + nội dung các file trong SCOPE đang khác HEAD)
 * - Sửa file trong SCOPE (src/, prisma/, scripts/...) ⇒ đổi fingerprint
 * - Sửa file NGOÀI SCOPE (audit-out/, AUDIT-REPORT.md, .next-*) ⇒ KHÔNG đổi
 *
 * Cấu trúc trả về:
 *   head / headShort  — git HEAD (hoặc 'unknown' nếu không phải git repo)
 *   fingerprint        — `${head7}+sc:${sha12}` (anchor dùng để so sánh)
 *   scopedDirty        — file trong SCOPE đang khác HEAD (đã sort)
 *   scopedDirtyCount   — số file đó
 *   dirtyCount/dirty   — dirtyCount TOÀN repo (chỉ để tham khảo, KHÔNG dùng làm anchor)
 *   legacyFingerprint  — chuỗi `HEAD+dirty:N` kiểu cũ (giữ để đọc artifact cũ)
 *   scope             — danh sách path dùng làm scope
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * SCOPE: những path ảnh hưởng hành vi hệ thống. Sửa trong scope ⇒ evidence cũ hết hiệu lực.
 * Cố ý KHÔNG gồm audit-out/, AUDIT-REPORT.md, .next-* (sản phẩm của audit, không phải source).
 */
export const SCOPE_PATHS = [
  'src',
  'prisma',
  'scripts',
  'tests',
  'db',
  'mini-services',
  'skills',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'eslint.config.mjs',
  'tailwind.config.ts',
  'postcss.config.mjs',
  'components.json',
  'Caddyfile',
  'ecosystem.config.cjs',
]

function gitRaw(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
    })
  } catch {
    return null
  }
}

/** Có cắt khoảng trắng — CHỈ dùng cho giá trị scalar (rev-parse HEAD). */
function git(args) {
  const raw = gitRaw(args)
  return raw === null ? null : raw.trim()
}

/**
 * `git status --porcelain -- <scope>` → danh sách file trong scope đang khác HEAD.
 * porcelain v1 format: `XY <path>`; rename ghi `old -> new` nên lấy phần cuối.
 */
function scopedStatus() {
  // KHÔNG .trim(): porcelain v1 viết `XY <path>` với X=' ' cho unstaged, trim()
  // sẽ cắn mất space đầu dòng đầu tiên ⇒ slice(3) lệch 1 ký tự ⇒ mất file
  // vào scope (bằng chứng: path 'rc/app/...' thay vì 'src/app/...').
  const raw = gitRaw(['status', '--porcelain', '--', ...SCOPE_PATHS])
  if (!raw) return []
  const files = new Set()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const rest = line.slice(3).trim()
    if (!rest) continue
    const arrows = rest.split(' -> ')
    files.add(arrows[arrows.length - 1].trim())
  }
  return [...files].sort()
}

function fileDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return 'unreadable'
  }
}

function repoDirty() {
  const raw = gitRaw(['status', '--porcelain'])
  if (!raw) return []
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

export function sourceFingerprint() {
  const head = git(['rev-parse', 'HEAD'])
  const headNorm = head || 'unknown'
  const headShort = headNorm.slice(0, 7)

  const scoped = scopedStatus()
  const allDirty = repoDirty()

  // Content-based: hash = sha256(head + nội dung từng file trong scope đang khác HEAD)
  let scopedHash = null
  if (headNorm !== 'unknown') {
    const h = createHash('sha256')
    h.update(headNorm)
    for (const f of scoped) h.update(`\n${f}:${fileDigest(f)}`)
    scopedHash = h.digest('hex').slice(0, 12)
  }

  const fingerprint = scopedHash ? `${headShort}+sc:${scopedHash}` : 'unknown+sc:none'

  return {
    head: headNorm,
    headShort,
    fingerprint,
    // Anchor chuẩn (content-based, ổn định trước/sau khi audit ghi artifact)
    scopedDirty: scoped,
    scopedDirtyCount: scoped.length,
    // Anchor legacy (KHÔNG dùng làm điều kiện chặn — tự tham chiếu khi audit ghi file)
    legacyFingerprint: `${headShort}+dirty:${allDirty.length}`,
    // dirtyCount toàn repo: tham khảo/logging
    dirtyCount: allDirty.length,
    dirty: allDirty.slice(0, 20),
    scope: SCOPE_PATHS,
  }
}
