#!/usr/bin/env bun
/**
 * S5 — CHECK BRANCH PROTECTION ĐA REMOTE (BLUEPRINT-BACKUP-GATE P5)
 * ============================================================================
 *
 * Vì sao: branch protection GitHub bật THỦ CÔNG 1 lần (quality-gate.yml comment
 * "khuyến nghị") — nếu quên bật, --no-verify local + push thẳng lên main
 * không bị GitHub chặn. Không có gì kiểm tra "đã bật chưa". Hơn nữa repo có
 * NHIỀU remote push (mirror + origin — 2 tài khoản GitHub khác nhau) → kiểm
 * 1 repo có thể kết luận SAI cho repo còn lại (L3 review v0.2).
 *
 * Script này kiểm TẤT CẢ remote push: parse URL lấy PAT (REDACT NGAY — PAT
 * không bao giờ được in ra output), GET /repos/<slug>/branches/main/protection
 * từng repo qua GitHub REST API (không cần gh CLI).
 *
 * 200 → kiểm required_status_checks có require job quality-gate (fuzzy match
 *        'quality-gate'/'Quality Gate') + enforce_admins.enabled
 * 404   → protection CHƯA bật
 * 403   → PAT thiếu quyền admin:read — không kết luận được, in hướng dẫn
 * 401   → token hết hạn/sai
 *
 * Usage:
 *   bun scripts/check-branch-protection.mjs            # warn-only (exit 0)
 *   bun scripts/check-branch-protection.mjs --strict   # exit 1 nếu repo nào chưa bật
 *   ... --branch=main                                  # đổi branch (mặc định main)
 *
 * Gắn PLAYBOOK checklist phát hành (warn-only chạy thường, --strict trước release).
 * PAT redact: hàm redactUrl() — token trong URL bị thay bằng *** ngay khi parse.
 */

import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const branchArg = args.find((a) => a.startsWith('--branch='))
const branch = branchArg ? branchArg.slice(9) : 'main'

/** REDACT token trong URL — PAT không bao giờ được in ra output (§8-8). */
function redactUrl(url) {
  return url.replace(/(https?:\/\/)[^@]+@/, '$1***@')
}

/** Parse remote URL → { token, slug } | null (không phải github https có token). */
function parseGithubUrl(url) {
  const m = url.match(/^https:\/\/([^@]+)@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (!m) return null
  return { token: m[1], slug: m[2] }
}

async function checkRemote(name, url) {
  const parsed = parseGithubUrl(url)
  console.log(`\n── Remote "${name}": ${redactUrl(url)}`)

  if (!parsed) {
    console.log(`   ⚠ URL không phải https://<PAT>@github.com/<slug> (hoặc không có token) — không kiểm được qua API.`)
    console.log(`   → Kiểm tay: https://github.com/<slug>/settings/branches`)
    return { name, status: 'unchecked' }
  }
  const { token, slug } = parsed

  const api = `https://api.github.com/repos/${slug}/branches/${encodeURIComponent(branch)}/protection`
  let res
  try {
    res = await fetch(api, {
      headers: {
        Authorization: `Bearer ${token}`, // token CHỈ dùng ở đây — không log
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tmo-check-branch-protection',
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.log(`   ⚠ Lỗi mạng: ${err instanceof Error ? err.message : String(err)} — không kết luận được.`)
    return { name, slug, status: 'unchecked' }
  }

  if (res.status === 401) {
    console.log(`   ✗ 401 — PAT hết hạn hoặc sai. Gia hạn token rồi chạy lại.`)
    return { name, slug, status: 'unprotected' }
  }
  if (res.status === 403) {
    // PAT fine-grained thường thiếu admin:read — không kết luận được
    console.log(`   ⚠ 403 — PAT không có quyền đọc branch protection (cần admin:read).`)
    printManualSteps(slug)
    return { name, slug, status: 'unchecked' }
  }
  if (res.status === 404) {
    console.log(`   ✗ 404 — branch protection CHƯA bật cho "${branch}" (hoặc branch/repo không tồn tại).`)
    printManualSteps(slug)
    return { name, slug, status: 'unprotected' }
  }
  if (!res.ok) {
    console.log(`   ⚠ HTTP ${res.status} — không kết luận được.`)
    return { name, slug, status: 'unchecked' }
  }

  // 200 — protection ĐANG bật, kiểm chất lượng cấu hình
  const prot = await res.json().catch(() => null)
  const requiredChecks = prot?.required_status_checks
  const contexts = [
    ...(requiredChecks?.contexts ?? []),
    ...((requiredChecks?.checks ?? []).map((c) => c?.context ?? c?.app?.name ?? '')),
  ]
  const hasQualityGate = contexts.some((c) => /quality[-_ ]?gate/i.test(String(c)))
  const enforceAdmins = prot?.enforce_admins?.enabled === true

  let ok = true
  if (!requiredChecks) {
    console.log(`   ⚠ Protection bật nhưng KHÔNG require status checks nào.`)
    ok = false
  } else if (!hasQualityGate) {
    console.log(`   ⚠ Require status checks có (${contexts.join(', ') || 'trống'}) nhưng CHƯA thấy job quality-gate.`)
    ok = false
  }
  if (!enforceAdmins) {
    console.log(`   ⚠ "Include administrators" (enforce_admins) CHƯA bật — admin vẫn push thẳng.`)
    ok = false
  }
  if (ok) {
    console.log(`   ✓ Protection ĐÃ bật đúng: require quality-gate + enforce admins (branch "${branch}").`)
  } else {
    printManualSteps(slug)
  }
  return { name, slug, status: ok ? 'protected' : 'unprotected' }
}

function printManualSteps(slug) {
  console.log(`   → BẬT TAY (5 bước, 1 lần):`)
  console.log(`     1. https://github.com/${slug}/settings/branches → Add branch protection rule`)
  console.log(`     2. Branch name pattern: main`)
  console.log(`     3. ✔ Require a pull request before merging`)
  console.log(`     4. ✔ Require status checks to pass before merging → chọn job "Quality Gate"`)
  console.log(`        + ✔ Require branches to be up to date before merging`)
  console.log(`     5. ✔ Include administrators`)
}

async function main() {
  console.log(`S5 — Check branch protection đa remote (branch "${branch}"${strict ? ' · STRICT' : ' · warn-only'})`)

  // Lấy TẤT CẢ remote push (mirror + origin — 2 tài khoản GitHub khác nhau)
  let remoteOut
  try {
    remoteOut = execSync('git remote -v', { encoding: 'utf-8' })
  } catch (err) {
    console.error('Không chạy được `git remote -v`:', err instanceof Error ? err.message : err)
    process.exit(strict ? 1 : 0)
  }
  const remotes = remoteOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('(push)'))
    .map((l) => {
      const parts = l.split(/\s+/)
      return { name: parts[0], url: parts.slice(1, -1).join(' ') }
    })

  if (remotes.length === 0) {
    console.log('Không có remote push nào — không có gì để kiểm.')
    process.exit(0)
  }
  console.log(`Tìm thấy ${remotes.length} remote push: ${remotes.map((r) => r.name).join(', ')}`)

  const results = []
  for (const r of remotes) {
    results.push(await checkRemote(r.name, r.url))
  }

  // Báo cáo tổng hợp per-repo
  console.log(`\n────────────────────────────────────────`)
  const byStatus = { protected: [], unprotected: [], unchecked: [] }
  for (const r of results) byStatus[r.status].push(`${r.name}${r.slug ? ` (${r.slug})` : ''}`)
  console.log(`✓ Đã bật đúng : ${byStatus.protected.join(', ') || '(không)'}`)
  console.log(`✗ Chưa bật    : ${byStatus.unprotected.join(', ') || '(không)'}`)
  console.log(`? Không kiểm được (PAT/403/mạng): ${byStatus.unchecked.join(', ') || '(không)'}`)

  if (byStatus.unprotected.length > 0) {
    console.log(`\n⚠ ${byStatus.unprotected.length} repo CHƯA bật protection — push thẳng main không bị GitHub chặn.`)
    if (strict) {
      console.log(`STRICT mode → exit 1 (chặn checklist phát hành).`)
      process.exit(1)
    }
    console.log(`(warn-only — chạy với --strict để chặn)`)
  } else {
    console.log(`\nOK — không repo nào ở trạng thái "chưa bật".`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Lỗi không đoán trước:', err)
  process.exit(strict ? 1 : 0)
})
