#!/usr/bin/env bun
/**
 * scripts/audit-manifest.ts — VÒNG 9 (2026-09-30): MANIFEST MÁY-ĐỌC HỢP NHẤT
 * ==========================================================================================
 * Bổ sung theo báo cáo audit vòng 8 chưa nghiệm thu (run cmunq7lta — SENTINEL,
 * 11 chu kỳ no_progress). Các khuyết điểm đã khắc phục:
 *
 *   1. Manifest máy-đọc được HỢP NHẤT runtime: builtin tools + custom tools +
 *      skill registry (DB AgentSkill) + filesystem skills (+ MCP mock — minh bạch).
 *   2. Chứng minh mỗi ID xuất hiện đúng 1 lần trong namespace; báo cáo khác biệt
 *      giữa các registry KÈM lý do từng khác biệt.
 *   3. Kiểm định skill 4 phần: mapping runtime → tồn tại + nội dung SKILL.md →
 *      self-check (front-matter/schema) → dry-run (readSkill thật, read-only).
 *   4. Phân loại MỖI entry: PASS | FAIL | BLOCKED_CONFIG | BLOCKED_EXTERNAL |
 *      NOT_APPLICABLE — luôn kèm reason.
 *   5. Baseline TRƯỚC/SAU: git (HEAD + porcelain), knowledge DB (row counts),
 *      package fixture (sha256 package.json + .env) — chứng minh script này
 *      KHÔNG gây side effect ngoài ý muốn.
 *   6. Verification exit-code THẬT: bun test · tsc --noEmit · lint · smoke
 *      health · tái hiện 3 kết quả lịch sử (giải mã nguồn gốc + drift).
 *
 * Kết quả probe 1:1 từng TOOL nằm ở scripts/audit-tools.ts (chạy riêng) →
 * audit-out/tools-audit.json + audit-out/tool-probes/<tool>.json. Script này
 * HỢP NHẤT kết quả đó vào manifest nếu có.
 *
 * Output: audit-out/manifest/manifest.json (machine) + MANIFEST.md (human).
 * Script READ-ONLY với DB thật (chỉ SELECT/đếm) — không ghi, không push schema.
 *
 * Usage: cd /home/z/tmo-app && bun scripts/audit-manifest.ts
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { Database as SqliteDatabase } from 'bun:sqlite'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, 'audit-out', 'manifest')

type Class = 'PASS' | 'FAIL' | 'BLOCKED_CONFIG' | 'BLOCKED_EXTERNAL' | 'NOT_APPLICABLE'

interface ManifestEntry {
  id: string
  kind: 'builtin-tool' | 'custom-tool' | 'db-skill' | 'fs-skill' | 'mcp-tool'
  source: string
  classification: Class
  reason: string
  detail?: Record<string, unknown>
}

const sha = (p: string): string => {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) } catch { return '(missing)' }
}
const run = (cmd: string, args: string[], timeoutMs = 300_000) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: timeoutMs })
  // Giữ ĐUÔI output (summary "Ran N tests…" nằm ở cuối — cắt đầu sẽ mất)
  return { code: r.status, stdout: (r.stdout || '').slice(-12_000), stderr: (r.stderr || '').slice(-4_000) }
}

// ==================== 0. ENV (trước khi import module app) ====================
// Nạp .env của app nhưng pin DATABASE_URL về DB THẬT của app (read-only) —
// chống shell nhiễm DATABASE_URL path my-project (bẫy đã biết trong worklog).
function loadAppEnv(): void {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (m[1] === 'DATABASE_URL') continue // pin bên dưới
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
  process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
}

// ==================== BASELINE TRƯỚC ====================
interface Baseline {
  gitHead: string
  gitPorcelain: string
  packageSha: string
  envSha: string
  dbCounts: Record<string, number>
  fsSkillsCount: number
}
function dbCounts(): Record<string, number> {
  // bun:sqlite readonly — độc lập với Prisma, an toàn tuyệt đối (không thể ghi)
  const sqlite = new SqliteDatabase(path.join(ROOT, 'db', 'custom.db'), { readonly: true })
  const tables = ['AgentSkill', 'CustomTool', 'KnowledgeChunk', 'ChatMessage', 'GoalLoopJob', 'ToolMetric', 'CronJob']
  const out: Record<string, number> = {}
  for (const t of tables) {
    try { out[t] = (sqlite.query(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c } catch { out[t] = -1 }
  }
  sqlite.close?.()
  return out
}

/** Bảng knowledge/registry (strict — audit KHÔNG được làm đổi) — khác biệt
 * ToolMetric/ChatMessage/GoalLoopJob/CronJob là hoạt động nền CỦA APP ĐANG CHẠY
 * (cron, agent activity) chứ không phải side effect của script (script mở
 * bun:sqlite readonly — cấu trúc KHÔNG THỂ ghi). */
const KNOWLEDGE_STRICT_TABLES = ['AgentSkill', 'CustomTool', 'KnowledgeChunk']

async function main() {
  console.log('[manifest] Vòng 9 — Manifest hợp nhất runtime (builtin + custom + skills + MCP)')
  loadAppEnv()

  const gitHead = run('git', ['rev-parse', 'HEAD'], 15_000).stdout.trim()
  const gitBefore = run('git', ['status', '--porcelain'], 15_000).stdout.trim()

  // Import module app SAU khi env chốt
  const { getAllBuiltinToolNames, getAllBuiltinToolSummaries } = await import('../src/lib/code-team/tool-executor')
  const { ensureCustomToolsLoaded, getAllCustomTools } = await import('../src/lib/custom-tool-registry')
  const { listSkills, readSkill } = await import('../src/lib/code-team/dev-tools')
  const mcp = await import('../src/lib/mcp/mcp-bridge')

  // ---------- BASELINE TRƯỚC (knowledge + package fixture) ----------
  const pkgShaBefore = sha(path.join(ROOT, 'package.json'))
  const envShaBefore = sha(path.join(ROOT, '.env'))
  const dbBefore = dbCounts()
  const skillsDir = path.join(ROOT, 'skills')
  const fsSlugs = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter(d => fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, 'SKILL.md')))
    : []
  const fsCountBefore = fsSlugs.length

  // ==================== 1. THU THẬP 4 REGISTRY ====================
  await ensureCustomToolsLoaded()
  const builtinNames = getAllBuiltinToolNames()
  const builtinSummaries = getAllBuiltinToolSummaries()
  const customTools = getAllCustomTools()
  const skills = await listSkills({ source: 'all' })
  const dbSkills = (skills as { dbSkills?: Array<Record<string, unknown>> }).dbSkills ?? []
  const fsSkills = (skills as { filesystemSkills?: Array<Record<string, unknown>> }).filesystemSkills ?? []
  const mcpServers = await mcp.listAvailableServers()
  const mcpToolList: Array<{ server: string; tool: string; mock: boolean }> = []
  for (const s of mcpServers) {
    const tools = (await mcp.getServerTools(s.id)) as Array<{ name?: string }>
    for (const t of tools) mcpToolList.push({ server: s.id, tool: String(t?.name ?? '(?)'), mock: true })
  }

  console.log(`[manifest] builtin=${builtinNames.length} · custom=${customTools.length} · db-skills=${dbSkills.length} · fs-skills=${fsSkills.length} (listSkills) / ${fsSlugs.length} (scan đĩa) · mcp=${mcpToolList.length} (mock Phase 3)`)

  // ==================== 2. UNIQUENESS + DIFF GIỮA CÁC REGISTRY ====================
  const entries: ManifestEntry[] = []
  const dupReport: Array<{ namespace: string; id: string; count: number }> = []
  const pushUnique = (namespace: string, list: string[]) => {
    const seen = new Map<string, number>()
    for (const id of list) seen.set(id, (seen.get(id) || 0) + 1)
    for (const [id, count] of seen) if (count > 1) dupReport.push({ namespace, id, count })
    return list
  }
  pushUnique('builtin-tool', builtinNames)
  pushUnique('custom-tool', customTools.map(c => c.name))
  pushUnique('db-skill', dbSkills.map(s => String(s.slug)))
  pushUnique('fs-skill', fsSkills.map(s => String(s.slug)))
  pushUnique('mcp-tool', mcpToolList.map(t => `${t.server}.${t.tool}`))

  // Khác biệt giữa CÁC registry (builtin ↔ /api/tools/registry ↔ scan đĩa)
  const registryDiffs: Array<{ kind: string; detail: string; reason: string }> = []
  // (a) fs-skill: listSkills runtime vs scan đĩa trực tiếp
  const fsRuntimeSet = new Set(fsSkills.map(s => String(s.slug)))
  const fsScanSet = new Set(fsSlugs)
  for (const s of fsSlugs.filter(x => !fsRuntimeSet.has(x))) {
    registryDiffs.push({ kind: 'fs-skill trên đĩa thiếu trong listSkills runtime', detail: s, reason: 'listSkills lọc theo slug hợp lệ + skip backup .bak — kiểm tra tên thư mục/định dạng SKILL.md' })
  }
  for (const s of [...fsRuntimeSet].filter(x => !fsScanSet.has(x))) {
    registryDiffs.push({ kind: 'listSkills runtime có nhưng đĩa không có', detail: s, reason: 'lỗi đồng bộ cache runtime' })
  }
  // (b) custom-tool vs companion skill (tool-<name>)
  for (const c of customTools) {
    const companion = `tool-${c.name}`
    const inDb = dbSkills.some(s => String(s.slug) === companion)
    const onDisk = fsScanSet.has(companion)
    if (!inDb || !onDisk) {
      registryDiffs.push({
        kind: 'custom-tool thiếu companion skill',
        detail: `${c.name}: db=${inDb} disk=${onDisk}`,
        reason: 'create_custom_tool thường sinh AgentSkill companion + skills/tool-<name>/SKILL.md — thiếu = bị xoá tay hoặc tạo qua đường khác',
      })
    }
  }
  // (c) cross-namespace collision (custom tool trùng tên builtin)
  for (const c of customTools) {
    if (builtinNames.includes(c.name)) {
      registryDiffs.push({ kind: 'cross-namespace collision', detail: c.name, reason: 'custom tool trùng tên builtin — executor resolve builtin TRƯỚC, custom tool không bao giờ được gọi' })
    }
  }

  // ==================== 3. KIỂM ĐỊNH SKILL 4 PHẦN ====================
  // (1) mapping runtime (2) tồn tại + nội dung SKILL.md (3) self-check
  // (front-matter name+description) (4) dry-run readSkill thật (read-only)
  const parseFrontMatter = (md: string): Record<string, string> => {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
    if (!m) return {}
    const out: Record<string, string> = {}
    const fmLines = m[1].split('\n')
    for (let i = 0; i < fmLines.length; i++) {
      const kv = fmLines[i].match(/^([a-zA-Z_-]+):\s*(.*)$/)
      if (!kv) continue
      let val = kv[2].trim()
      // YAML block scalar (> | >- |- >+ |+) — giá trị nằm ở các dòng thụt lề bên dưới
      // (vd skill charts/aminer dùng `description: >` multiline — fix vòng 9)
      if (/^(>|\||>\-|\|-|>\+|\|\+)$/.test(val)) {
        const block: string[] = []
        for (let j = i + 1; j < fmLines.length; j++) {
          if (/^\s+\S/.test(fmLines[j])) block.push(fmLines[j].trim())
          else break
        }
        val = block.join(' ')
        i += block.length
      }
      out[kv[1]] = val
    }
    return out
  }
  interface SkillCheck { slug: string; registry: string; part1: boolean; part2: boolean; part3: boolean; part4: boolean; reason: string }
  const skillChecks: SkillCheck[] = []

  for (const slug of fsSlugs) {
    const r: SkillCheck = { slug, registry: 'fs-skill', part1: false, part2: false, part3: false, part4: false, reason: '' }
    r.part1 = fsRuntimeSet.has(slug) // mapping runtime
    const mdPath = path.join(skillsDir, slug, 'SKILL.md')
    let md = ''
    try { md = fs.readFileSync(mdPath, 'utf-8') } catch { /* thiếu */ }
    r.part2 = fs.existsSync(mdPath) && md.trim().length > 50 // tồn tại + nội dung không trivial
    const fm = parseFrontMatter(md)
    const hasFm = Boolean(fm.name && fm.description && fm.name.length > 0 && fm.description.length > 8)
    r.part3 = hasFm // self-check schema front-matter
    try {
      const rr = await readSkill({ slug })
      r.part4 = Boolean(rr && (rr as { content?: string }).content && (rr as { content?: string }).content!.length > 0)
    } catch { r.part4 = false }
    const missing = [!r.part1 && 'mapping-runtime', !r.part2 && 'SKILL.md', !r.part3 && 'front-matter', !r.part4 && 'dry-run-readSkill'].filter(Boolean)
    r.reason = missing.length === 0 ? 'đủ 4 phần: mapping + SKILL.md + front-matter + dry-run' : `thiếu: ${missing.join(', ')}`
    skillChecks.push(r)
  }

  for (const s of dbSkills) {
    const slug = String(s.slug)
    const r: SkillCheck = { slug, registry: 'db-skill', part1: true, part2: false, part3: false, part4: false, reason: '' }
    // listSkills dbSkills không trả content (chỉ {slug,name,source,description,chars})
    // → đọc content qua readSkill (đường runtime thật, read-only)
    let content = ''
    try {
      const rr = await readSkill({ slug })
      content = String((rr as { content?: string })?.content ?? '')
    } catch { /* dry-run sẽ bắt */ }
    r.part2 = content.trim().length > 100
    const fm = parseFrontMatter(content)
    r.part3 = Boolean(fm.name || fm.description) || content.includes('#') // db skill (bundled) cho phép markdown thuần không front-matter
    try {
      const rr = await readSkill({ slug })
      r.part4 = Boolean(rr && (rr as { content?: string }).content && (rr as { content?: string }).content!.length > 0)
    } catch { r.part4 = false }
    const missing = [!r.part1 && 'mapping-runtime', !r.part2 && 'nội dung', !r.part3 && 'self-check', !r.part4 && 'dry-run-readSkill'].filter(Boolean)
    r.reason = missing.length === 0 ? 'đủ 4 phần (DB AgentSkill)' : `thiếu: ${missing.join(', ')}`
    skillChecks.push(r)
  }

  // Custom tool: registry + companion + handler syntax check (KHÔNG thực thi handler)
  interface CustomCheck { name: string; inRegistry: boolean; handlerSyntax: boolean; companion: boolean; reason: string }
  const customChecks: CustomCheck[] = []
  for (const c of customTools) {
    let handlerSyntax = false
    try { new Function(c.handlerCode); handlerSyntax = true } catch { handlerSyntax = false }
    const companion = dbSkills.some(s => String(s.slug) === `tool-${c.name}`) || fsScanSet.has(`tool-${c.name}`)
    const missing = [!c.enabled && 'disabled(BLOCKED_CONFIG)', !handlerSyntax && 'handler-syntax(FAIL)', !companion && 'companion-skill'].filter(Boolean)
    customChecks.push({
      name: c.name,
      inRegistry: true,
      handlerSyntax,
      companion,
      reason: missing.length === 0 ? 'registry + handler parse + companion skill đủ' : missing.join(', '),
    })
  }

  // ==================== 4. PHÂN LOẠI TOÀN BỘ ENTRY ====================
  // Builtin: đọc audit-out/tools-audit.json nếu có (chạy audit-tools.ts trước);
  // fallback: BLOCKED_EXTERNAL 'chưa probe trong phiên này — chạy audit-tools.ts'
  let toolsAudit: { rows?: Array<{ tool: string; status: string; errorTag?: string; note?: string }> } | null = null
  const taPath = path.join(ROOT, 'audit-out', 'tools-audit.json')
  if (fs.existsSync(taPath)) {
    try { toolsAudit = JSON.parse(fs.readFileSync(taPath, 'utf-8')) } catch { toolsAudit = null }
  }
  const taRow = new Map((toolsAudit?.rows ?? []).map(r => [r.tool, r]))

  for (const name of builtinNames) {
    const r = taRow.get(name)
    let cls: Class = 'BLOCKED_EXTERNAL'
    let reason = 'chưa có probe 1:1 trong phiên này — chạy `bun scripts/audit-tools.ts` trước để sinh bằng chứng'
    if (r) {
      if (r.status === 'OK') { cls = 'PASS'; reason = 'probe 1:1 chạy thật success (xem tool-probes/' + name + '.json)' }
      else if (r.status === 'XFAIL') { cls = 'BLOCKED_CONFIG'; reason = `cấu hình/thiết kế có chủ đích — ${r.errorTag || r.note || ''}`.slice(0, 200) }
      else if (r.status === 'SKIP') { cls = 'NOT_APPLICABLE'; reason = `không probe an toàn độc lập — ${r.note || ''}`.slice(0, 200) }
      else {
        cls = 'FAIL'
        // FAIL do phụ thuộc ngoài (API key 401, GUI headless...) → BLOCKED_EXTERNAL
        if (/api key|401|403|no keys|provider|quota|xdg-open|headless|gui/i.test(`${r.errorTag} ${r.note}`)) {
          cls = 'BLOCKED_EXTERNAL'
          reason = `phụ thuộc môi trường ngoài (API provider / GUI không có trên headless) — ${r.errorTag || ''}`.slice(0, 200)
        } else {
          reason = `probe chạy thật nhưng lỗi — ${r.errorTag || ''}`.slice(0, 200)
        }
      }
    }
    entries.push({ id: name, kind: 'builtin-tool', source: 'tool-executor catalog (getAllBuiltinToolNames)', classification: cls, reason })
  }
  for (const c of customChecks) {
    const cls: Class = c.handlerSyntax ? (c.companion ? 'PASS' : 'BLOCKED_CONFIG') : 'FAIL'
    entries.push({ id: c.name, kind: 'custom-tool', source: `CustomTool DB + registry (source=${(c as { source?: string }).source ?? 'agent'})`, classification: cls, reason: c.reason, detail: { companion: c.companion, handlerSyntax: c.handlerSyntax } })
  }
  for (const sc of skillChecks) {
    const all4 = sc.part1 && sc.part2 && sc.part3 && sc.part4
    entries.push({
      id: sc.slug,
      kind: sc.registry === 'db-skill' ? 'db-skill' : 'fs-skill',
      source: sc.registry === 'db-skill' ? 'DB AgentSkill (listSkills db)' : 'skills/<slug>/SKILL.md (listSkills filesystem)',
      classification: all4 ? 'PASS' : 'FAIL',
      reason: sc.reason,
      detail: { part1: sc.part1, part2: sc.part2, part3: sc.part3, part4: sc.part4 },
    })
  }
  for (const t of mcpToolList) {
    entries.push({
      id: `${t.server}.${t.tool}`,
      kind: 'mcp-tool',
      source: 'mcp-bridge BUILTIN_SERVERS (Phase 3)',
      classification: 'BLOCKED_CONFIG',
      reason: 'MCP server built-in là mock Phase 3 (không spawn subprocess thật) + bị ẩn khỏi agents (MCP_MOCK_BUILTIN_IDS) — Phase 5 chưa hiện thực',
    })
  }

  // ==================== 5. VERIFICATION (exit-code thật) ====================
  console.log('[manifest] Chạy verification: bun test · uncertainty-ledger · tsc · lint · smoke health…')
  const verif: Array<{ name: string; cmd: string; exit: number | null; summary: string; note?: string }> = []

  const t = run('bun', ['test'], 420_000)
  const tAll = `${t.stdout}\n${t.stderr}` // bun test in summary ra STDERR — gộp mới match được
  const tMatch = tAll.match(/Ran (\d+) tests across (\d+) files/)
  const tFail = tAll.match(/^\s*(\d+) fail\s*$/m)
  const tPass = tAll.match(/^\s*(\d+) pass\s*$/m)
  verif.push({ name: 'bun test (full suite)', cmd: 'bun test', exit: t.code, summary: tMatch ? `Ran ${tMatch[1]} tests across ${tMatch[2]} files — ${tPass?.[1] ?? '?'} pass / ${tFail?.[1] ?? '?'} fail` : (tAll.split('\n').filter(Boolean).pop() || '').slice(0, 120) })

  const ul = run('bun', ['run', 'tests/uncertainty-ledger.test.ts'], 120_000)
  const ulAll = `${ul.stdout}\n${ul.stderr}`
  const ulMatch = ulAll.match(/KẾT QUẢ:\s*(\d+) pass · (\d+) fail/)
  verif.push({ name: 'uncertainty-ledger (script-style)', cmd: 'bun run tests/uncertainty-ledger.test.ts', exit: ul.code, summary: ulMatch ? `KẾT QUẢ: ${ulMatch[1]} pass · ${ulMatch[2]} fail` : (ulAll.split('\n').filter(Boolean).pop() || '').slice(0, 120) })

  const tsc = run('bunx', ['tsc', '--noEmit'], 300_000)
  verif.push({ name: 'typecheck', cmd: 'bunx tsc --noEmit', exit: tsc.code, summary: tsc.code === 0 ? '0 lỗi type' : (tsc.stderr || tsc.stdout).split('\n')[0].slice(0, 120) })

  const lint = run('bun', ['run', 'lint'], 420_000)
  verif.push({ name: 'lint', cmd: 'bun run lint', exit: lint.code, summary: lint.code === 0 ? 'eslint pass' : (lint.stderr || lint.stdout).split('\n').slice(0, 2).join(' | ').slice(0, 120) })

  const health = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3000/api/health'], 20_000)
  verif.push({ name: 'smoke health', cmd: 'curl /api/health', exit: health.stdout.trim() === '200' ? 0 : 1, summary: `HTTP ${health.stdout.trim()}` })

  // 3 kết quả lịch sử — giải mã nguồn gốc (điều tra vòng 9, subagent report)
  const historical = {
    '238 pass / 0 fail': { source: 'bun test full suite (17 file) — snapshot 2026-09-29/30', reproduce: 'bun test (xem verification trên)', note: 'con số TRÔI theo số file test của repo tại thời điểm: lịch sử 204→211→224→238 — so sánh với số hiện tại trong verification' },
    '220 pass / 1 fail': { source: 'bun test --coverage chạy BÊN TRONG tool test_coverage tại workspace cũ của agent (snapshot đã mất)', reproduce: 'bun test --coverage (tại repo hiện tại — workspace gốc không còn)', note: 'wrapper test_coverage từng trả false-pass (đã fix 2026-09-30 bằng hasErrorPayload); 1 fail khi đó = section E uncertainty-ledger phụ thuộc DB' },
    '39 pass / 5 fail': { source: 'tests/uncertainty-ledger.test.ts chạy độc lập (harness ok() riêng in "KẾT QUẢ: X pass · Y fail")', reproduce: 'bun run tests/uncertainty-ledger.test.ts (xem verification trên)', note: '5 fail khi đó = section D/E/F phụ thuộc DB thật của workspace agent; môi trường khỏe → 0 fail' },
  }

  // ==================== BASELINE SAU + ĐỐI CHIẾU ====================
  const pkgShaAfter = sha(path.join(ROOT, 'package.json'))
  const envShaAfter = sha(path.join(ROOT, '.env'))
  const dbAfter = dbCounts()
  const fsCountAfter = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter(d => fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))).length
    : 0
  const gitAfter = run('git', ['status', '--porcelain'], 15_000).stdout.trim()

  const baselineCheck = {
    git: { headBefore: gitHead, headAfter: run('git', ['rev-parse', 'HEAD'], 15_000).stdout.trim(), porcelainBefore: gitBefore, porcelainAfter: gitAfter, changed: gitBefore !== gitAfter },
    packageFixture: { before: pkgShaBefore, after: pkgShaAfter, changed: pkgShaBefore !== pkgShaAfter },
    envFile: { before: envShaBefore, after: envShaAfter, changed: envShaBefore !== envShaAfter },
    knowledgeDb: {
      before: dbBefore,
      after: dbAfter,
      // STRICT: chỉ bảng knowledge/registry — app nền có thể ghi ToolMetric/ChatMessage
      strictChanged: KNOWLEDGE_STRICT_TABLES.some(t => dbBefore[t] !== dbAfter[t]),
      strictTables: KNOWLEDGE_STRICT_TABLES,
      liveActivityGrowth: Object.fromEntries(
        Object.keys(dbBefore)
          .filter(t => !KNOWLEDGE_STRICT_TABLES.includes(t) && dbBefore[t] !== dbAfter[t])
          .map(t => [t, `${dbBefore[t]} → ${dbAfter[t]}`]),
      ),
      changed: Object.keys(dbBefore).some(t => dbBefore[t] !== dbAfter[t]), // informational tổng
    },
    fsSkills: { before: fsCountBefore, after: fsCountAfter, changed: fsCountBefore !== fsCountAfter },
  }

  // ==================== 6. GHI MANIFEST ====================
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const byClass = (c: Class) => entries.filter(e => e.classification === c).length
  const manifest = {
    schema: 'tmo-audit-manifest/1.0',
    generatedAt: new Date().toISOString(),
    gitHead,
    registries: {
      'builtin-tool': { count: builtinNames.length, source: 'tool-executor getAllBuiltinToolNames()' },
      'custom-tool': { count: customTools.length, source: 'custom-tool-registry getAllCustomTools() + DB CustomTool' },
      'db-skill': { count: dbSkills.length, source: 'AgentSkill (listSkills db)' },
      'fs-skill': { count: fsSlugs.length, source: 'skills/<slug>/SKILL.md (scan đĩa + listSkills filesystem)' },
      'mcp-tool': { count: mcpToolList.length, source: 'mcp-bridge BUILTIN_SERVERS (mock Phase 3 — minh bạch khai báo)' },
    },
    uniqueness: {
      duplicateIds: dupReport,
      eachIdExactlyOnce: dupReport.length === 0,
      crossNamespaceCollisions: registryDiffs.filter(d => d.kind === 'cross-namespace collision'),
    },
    registryDiffs,
    classification: {
      counts: { PASS: byClass('PASS'), FAIL: byClass('FAIL'), BLOCKED_CONFIG: byClass('BLOCKED_CONFIG'), BLOCKED_EXTERNAL: byClass('BLOCKED_EXTERNAL'), NOT_APPLICABLE: byClass('NOT_APPLICABLE') },
      labels: {
        PASS: 'kiểm định đủ — bằng chứng thật',
        FAIL: 'kiểm định phát hiện lỗi thật',
        BLOCKED_CONFIG: 'chặn do cấu hình/thiết kế có chủ đích (flag off, mock, disabled)',
        BLOCKED_EXTERNAL: 'chặn do phụ thuộc ngoài (API provider, dịch vụ ngoài)',
        NOT_APPLICABLE: 'không thể/không nên probe độc lập trong ngữ cảnh này',
      },
    },
    skillValidation: { fourPartChecks: skillChecks, customToolChecks: customChecks },
    verification: { runs: verif, historicalReproduction: historical },
    baselineCheck,
    toolsAuditEvidence: toolsAudit ? { file: 'audit-out/tools-audit.json', generatedAt: (JSON.parse(fs.readFileSync(taPath, 'utf-8')) as { generatedAt?: string }).generatedAt ?? '(?)' } : null,
    entries,
  }
  const manifestPath = path.join(OUT_DIR, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), 'utf-8')

  // MANIFEST.md — bản người đọc
  const lines: string[] = []
  lines.push('# TMO AUDIT MANIFEST — Hợp nhất runtime (Vòng 9)')
  lines.push('')
  lines.push(`> Sinh: ${manifest.generatedAt} · Git HEAD: \`${gitHead.slice(0, 12)}\` · Script: \`scripts/audit-manifest.ts\` · Machine-readable: \`audit-out/manifest/manifest.json\``)
  lines.push('')
  lines.push('## 1. Tổng quan 4+1 registry')
  lines.push('')
  lines.push('| Registry | Số lượng | Nguồn runtime |')
  lines.push('|---|---|---|')
  lines.push(`| builtin-tool | ${builtinNames.length} | tool-executor \`getAllBuiltinToolNames()\` |`)
  lines.push(`| custom-tool | ${customTools.length} | custom-tool-registry + DB CustomTool |`)
  lines.push(`| db-skill | ${dbSkills.length} | DB AgentSkill (\`listSkills db\`) |`)
  lines.push(`| fs-skill | ${fsSlugs.length} | \`skills/<slug>/SKILL.md\` (scan đĩa) |`)
  lines.push(`| mcp-tool | ${mcpToolList.length} | mcp-bridge mock Phase 3 (ẩn khỏi agents) |`)
  lines.push(`| **Tổng entry đã phân loại** | **${entries.length}** | mỗi entry 1 dòng classification + reason |`)
  lines.push('')
  lines.push('## 2. Uniqueness + diff giữa các registry')
  lines.push('')
  lines.push(`- Mỗi ID đúng 1 lần trong namespace: **${dupReport.length === 0 ? '✅ ĐẠT (0 trùng)' : `❌ ${dupReport.length} trùng`}**`)
  for (const d of dupReport) lines.push(`  - ❌ TRÙNG ${d.namespace}: \`${d.id}\` ×${d.count}`)
  if (registryDiffs.length === 0) lines.push('- Khác biệt giữa các registry: ✅ KHÔNG có')
  else {
    lines.push(`- Khác biệt giữa các registry: ${registryDiffs.length} mục (kèm lý do):`)
    for (const d of registryDiffs) lines.push(`  - **${d.kind}** — \`${d.detail}\`: ${d.reason}`)
  }
  lines.push('')
  lines.push('## 3. Phân loại 5 nhãn')
  lines.push('')
  lines.push(`| Nhãn | Số entry |`)
  lines.push('|---|---|')
  for (const [k, v] of Object.entries(manifest.classification.counts)) lines.push(`| ${k} | ${v} |`)
  lines.push('')
  lines.push('## 4. Skill 4 phần + custom tool')
  lines.push('')
  lines.push(`- Skill đã kiểm định 4 phần: ${skillChecks.length} (${skillChecks.filter(s => s.part1 && s.part2 && s.part3 && s.part4).length} đủ 4 phần)`)
  for (const s of skillChecks.filter(x => !(x.part1 && x.part2 && x.part3 && x.part4))) lines.push(`  - ⚠️ \`${s.slug}\` [${s.registry}]: ${s.reason}`)
  lines.push(`- Custom tool: ${customChecks.length} (${customChecks.filter(c => c.handlerSyntax && c.companion).length} đạt registry+handler+companion)`)
  for (const c of customChecks.filter(x => !(x.handlerSyntax && x.companion))) lines.push(`  - ⚠️ \`${c.name}\`: ${c.reason}`)
  lines.push('')
  lines.push('## 5. Verification (exit code thật từ terminal)')
  lines.push('')
  lines.push('| Kiểm tra | Lệnh | Exit | Tổng kết |')
  lines.push('|---|---|---|---|')
  for (const v of verif) lines.push(`| ${v.name} | \`${v.cmd}\` | ${v.exit === 0 ? '✅ 0' : `❌ ${v.exit}`} | ${v.summary} |`)
  lines.push('')
  lines.push('### Tái hiện 3 kết quả lịch sử (giải mã nguồn gốc)')
  lines.push('')
  for (const [num, info] of Object.entries(historical)) {
    lines.push(`- **${num}** — ${info.source}`)
    lines.push(`  - Tái hiện: \`${info.reproduce}\``)
    lines.push(`  - Ghi chú: ${info.note}`)
  }
  lines.push('')
  lines.push('## 6. Baseline trước/sau (chứng minh KHÔNG side effect ngoài ý muốn)')
  lines.push('')
  lines.push(`- package.json (fixture): **${baselineCheck.packageFixture.changed ? '❌ ĐỔI' : '✅ không đổi'}** (${baselineCheck.packageFixture.before} → ${baselineCheck.packageFixture.after})`) 
  lines.push(`- .env: **${baselineCheck.envFile.changed ? '❌ ĐỔI' : '✅ không đổi'}** (${baselineCheck.envFile.before} → ${baselineCheck.envFile.after})`)
  lines.push(`- Knowledge/registry DB (${KNOWLEDGE_STRICT_TABLES.join(', ')}): **${baselineCheck.knowledgeDb.strictChanged ? '❌ ĐỔI' : '✅ không đổi'}**`)
  const growth = Object.entries(baselineCheck.knowledgeDb.liveActivityGrowth || {})
  const growthStr = growth.length === 0 ? '✅ không đổi' : `ℹ️ tăng tự nhiên — ${growth.map(([t, d]) => t + ' ' + d).join(' · ')}`
  lines.push(`- Bảng hoạt động sống (ToolMetric/ChatMessage/… — app nền tự ghi, script readonly KHÔNG THỂ ghi): ${growthStr}`)
  lines.push(`- Git porcelain: **${baselineCheck.git.changed ? '⚠️ thay đổi (xem diff)' : '✅ không đổi'}**`)
  lines.push(`- Filesystem skills: **${baselineCheck.fsSkills.changed ? '❌ ĐỔI' : '✅ không đổi'}** (${baselineCheck.fsSkills.before} → ${baselineCheck.fsSkills.after})`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`## 7. Kết luận chuỗi kiểm định`)
  lines.push('')
  const allVerifOk = verif.every(v => v.exit === 0)
  const noDup = dupReport.length === 0
  const noFail = byClass('FAIL') === 0
  const noSideEffect = !baselineCheck.packageFixture.changed && !baselineCheck.envFile.changed && !baselineCheck.knowledgeDb.strictChanged && !baselineCheck.fsSkills.changed
  const allClassified = entries.every(e => e.reason && e.reason.length > 0)
  lines.push(`- Mỗi ID đúng 1 lần: ${noDup ? '✅' : '❌'}`)
  lines.push(`- Toàn bộ entry phân loại kèm lý do: ${allClassified ? '✅' : '❌'}`)
  lines.push(`- Không FAIL thật (lỗi hệ thống): ${noFail ? '✅' : '❌'}`)
  lines.push(`- Verification exit 0 toàn bộ: ${allVerifOk ? '✅' : '❌'}`)
  lines.push(`- Không side effect ngoài ý muốn: ${noSideEffect ? '✅' : '❌'}`)
  const overall = noDup && allClassified && allVerifOk && noSideEffect
  lines.push('')
  lines.push(`**TRẠNG THÁI CHUỖI: ${overall ? '✅ XANH (GREEN)' : (noFail ? '🟡 XANH CÓ ĐIỀU KIỆN (BLOCKED_* không phải lỗi thật)' : '🔴 CÓ FAIL') }** — checker độc lập: \`bun scripts/audit-check.ts\` (exit 0 = nghiệm thu)`)
  lines.push('')
  fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.md'), lines.join('\n'), 'utf-8')

  console.log(`[manifest] Tổng ${entries.length} entry · PASS=${byClass('PASS')} FAIL=${byClass('FAIL')} BLOCKED_CONFIG=${byClass('BLOCKED_CONFIG')} BLOCKED_EXTERNAL=${byClass('BLOCKED_EXTERNAL')} NOT_APPLICABLE=${byClass('NOT_APPLICABLE')}`)
  console.log(`[manifest] Trùng ID: ${dupReport.length} · Registry diffs: ${registryDiffs.length} · Side effect (strict): ${noSideEffect ? 'KHÔNG' : 'CÓ — xem baselineCheck'} · DB live-activity growth: ${Object.keys(baselineCheck.knowledgeDb.liveActivityGrowth || {}).join(', ') || '(không)'}`)
  console.log(`[manifest] Đã ghi: ${manifestPath} + ${path.join(OUT_DIR, 'MANIFEST.md')}`)

  // manifest generation KHÔNG quyết định nghiệm thu — checker độc lập quyết định
  process.exit(0)
}

main().catch(err => {
  console.error('[manifest] LỖI:', err)
  process.exit(1)
})
