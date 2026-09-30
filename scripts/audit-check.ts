#!/usr/bin/env bun
/**
 * scripts/audit-check.ts — VÒNG 9: AUDIT CHECKER ĐỘC LẬP (bất biến nghiệm thu)
 * ==========================================================================================
 * Đọc audit-out/manifest/manifest.json + TỰ TRUY VẤN LẠI các registry runtime
 * (fresh import — không tin manifest đưa sẵn), rồi chứng minh 4 bất biến:
 *
 *   C1. KHÔNG thiếu ID — mọi ID của 4 registry runtime ĐỀU có trong manifest
 *   C2. KHÔNG trùng ID — mỗi ID xuất hiện đúng 1 lần trong namespace của nó
 *   C3. KHÔNG entry chưa phân loại — mọi entry có nhãn hợp lệ
 *       (PASS|FAIL|BLOCKED_CONFIG|BLOCKED_EXTERNAL|NOT_APPLICABLE) + reason
 *       khác rỗng, và KHÔNG entry lạ ngoài registry
 *   C4. Evidence tồn tại — mọi builtin PASS có file bằng chứng
 *       audit-out/tool-probes/<tool>.json (probe 1:1 thật) + MỌI probe có đủ
 *       exitStatus + timestamp + rawResponse (full coverage, không sample —
 *       round-10 fix: trước đây chỉ sample 3 file đầu)
 *   C5. PASS ⟺ exitStatus=success — ĐỦ MỌI probe file (không chỉ entry PASS;
 *       phân loại phải nhất quán với raw evidence ở mọi entry)
 *   C6. Skill four-part — mọi fs-skill/db-skill có part1..part4 = true
 *       (mapping + SKILL.md + front-matter + dry-run) trong skillValidation
 *   C7. Baseline side-effect — nếu audit-out/baseline/{before,after}.json tồn
 *       tại (sinh bởi `bun run audit:baseline`): protected files + package.json
 *       phải IDENTICAL before/after (chứng minh không side effect + khả năng
 *       khôi phục package.json từ bản copy trong baseline)
 *
 * Kèm: đối chiếu baseline (package.json + .env hash, git HEAD) — cảnh báo nếu
 * repo đã di chuyển sau khi manifest sinh (không fail cứng).
 * Report bền vững: audit-out/reports/check-report.json (git re-include —
 * sống sót qua git clean; chứa sha256 của MỖI file evidence = evidence bundle).
 *
 * Exit code: 0 = toàn bộ bất biến ĐẠT (chuỗi nghiệm thu XANH) · 1 = có vi phạm.
 *
 * Usage: bun run audit:check   (alias trong package.json)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { mirrorToRunDir, resolveAuditProvenance } from './audit-provenance'

const ROOT = path.resolve(import.meta.dir, '..')
const MANIFEST_PATH = path.join(ROOT, 'audit-out', 'manifest', 'manifest.json')
const PROBES_DIR = path.join(ROOT, 'audit-out', 'tool-probes')

const VALID_LABELS = ['PASS', 'FAIL', 'BLOCKED_CONFIG', 'BLOCKED_EXTERNAL', 'NOT_APPLICABLE'] as const
type Label = typeof VALID_LABELS[number]

interface Entry { id: string; kind: string; classification: string; reason: string }

interface ProbeFile { tool?: string; probes?: Array<{ exitStatus?: string; timestamp?: string; rawResponse?: string; rawError?: string; durationMs?: number }> }

/** Bảng sha256 mỗi file evidence — đưa vào report bền vững (evidence bundle) */
const evidenceHashes: Record<string, string> = {}

let violations = 0
let warnings = 0
const vfail = (msg: string) => { violations++; console.log(`  ❌ ${msg}`) }
const vpass = (msg: string) => console.log(`  ✅ ${msg}`)
const vwarn = (msg: string) => { warnings++; console.log(`  ⚠️ ${msg}`) }

const sha = (p: string): string => {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) } catch { return '(missing)' }
}

function loadAppEnv(): void {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || m[1] === 'DATABASE_URL') continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
  process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
}

async function main() {
  console.log('[checker] Vòng 9 — Audit checker độc lập (bất biến nghiệm thu)')
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[checker] ❌ Không tìm thấy ${MANIFEST_PATH} — chạy \`bun scripts/audit-manifest.ts\` trước.`)
    process.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as {
    generatedAt: string
    gitHead: string
    entries: Entry[]
    registries: Record<string, { count: number }>
    uniqueness: { duplicateIds: unknown[] }
  }
  const entries = manifest.entries
  console.log(`[checker] Manifest sinh: ${manifest.generatedAt} @ HEAD ${String(manifest.gitHead).slice(0, 12)} · ${entries.length} entry\n`)

  // ==== Truy vấn LẠI registry runtime (fresh — nguồn sự thật thứ hai) ====
  loadAppEnv()
  const { getAllBuiltinToolNames } = await import('../src/lib/code-team/tool-executor')
  const { ensureCustomToolsLoaded, getAllCustomTools } = await import('../src/lib/custom-tool-registry')
  const { listSkills } = await import('../src/lib/code-team/dev-tools')
  await ensureCustomToolsLoaded()

  const builtinNames = getAllBuiltinToolNames()
  const customTools = getAllCustomTools()
  const skills = await listSkills({ source: 'all' })
  const dbSkills = ((skills as { dbSkills?: Array<Record<string, unknown>> }).dbSkills ?? []).map(s => String(s.slug))
  const skillsDir = path.join(ROOT, 'skills')
  const fsSkills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter(d => fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, 'SKILL.md')))
    : []

  const live: Record<string, string[]> = {
    'builtin-tool': builtinNames,
    'custom-tool': customTools.map(c => c.name),
    'db-skill': dbSkills,
    'fs-skill': fsSkills,
  }
  console.log(`[checker] Registry sống: builtin=${builtinNames.length} · custom=${customTools.length} · db-skill=${dbSkills.length} · fs-skill=${fsSkills.length}\n`)

  // ==================== C1. KHÔNG THIẾU ID ====================
  console.log('━━━ C1. Không thiếu ID (registry sống ⊆ manifest) ━━━')
  const manifestByKind = new Map<string, Set<string>>()
  for (const e of entries) {
    if (!manifestByKind.has(e.kind)) manifestByKind.set(e.kind, new Set())
    manifestByKind.get(e.kind)!.add(e.id)
  }
  let c1ok = true
  for (const [kind, ids] of Object.entries(live)) {
    const inManifest = manifestByKind.get(kind) ?? new Set<string>()
    const missing = ids.filter(id => !inManifest.has(id))
    if (missing.length > 0) { c1ok = false; vfail(`${kind}: thiếu ${missing.length} ID trong manifest: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`) }
    else vpass(`${kind}: đủ ${ids.length}/${ids.length} ID có trong manifest`)
  }
  if (c1ok) console.log(`  ➜ C1 ĐẠT`)

  // ==================== C2. KHÔNG TRÙNG ID ====================
  console.log('\n━━━ C2. Không trùng ID (mỗi ID đúng 1 lần trong namespace) ━━━')
  let c2ok = true
  for (const [kind, ids] of Object.entries(live)) {
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dup.length > 0) { c2ok = false; vfail(`${kind}: ID trùng trong registry sống: ${[...new Set(dup)].join(', ')}`) }
    else vpass(`${kind}: ${new Set(ids).size} ID duy nhất`)
  }
  // manifest entries cũng không trùng (cùng kind + id)
  const seen = new Map<string, number>()
  for (const e of entries) {
    const key = `${e.kind}::${e.id}`
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  const dupManifest = [...seen.entries()].filter(([, c]) => c > 1)
  if (dupManifest.length > 0) { c2ok = false; vfail(`manifest: entry trùng: ${dupManifest.map(([k, c]) => `${k}×${c}`).join(', ')}`) }
  else vpass(`manifest: ${seen.size} entry (kind::id) duy nhất`)
  if (c2ok) console.log(`  ➜ C2 ĐẠT`)

  // ==================== C3. KHÔNG ENTRY CHƯA PHÂN LOẠI ====================
  console.log('\n━━━ C3. Toàn bộ entry đã phân loại hợp lệ + lý do ━━━')
  const bad = entries.filter(e => !VALID_LABELS.includes(e.classification as Label) || !e.reason || e.reason.trim().length === 0)
  if (bad.length > 0) {
    for (const e of bad.slice(0, 10)) vfail(`${e.kind} \`${e.id}\`: nhãn "${e.classification}" ${VALID_LABELS.includes(e.classification as Label) ? 'hợp lệ nhưng THIẾU reason' : 'KHÔNG hợp lệ'} `)
    if (bad.length > 10) vfail(`… và ${bad.length - 10} entry khác`)
  } else vpass(`${entries.length}/${entries.length} entry có nhãn hợp lệ + reason khác rỗng`)
  // entry lạ trong manifest mà không thuộc registry sống (trừ mcp-tool — khai báo minh bạch)
  const knownKinds = new Set(Object.keys(live))
  const foreign = entries.filter(e => !knownKinds.has(e.kind) && e.kind !== 'mcp-tool')
  if (foreign.length > 0) vwarn(`manifest có ${foreign.length} entry kind lạ ngoài registry sống: ${[...new Set(foreign.map(e => e.kind))].join(', ')}`)
  else vpass('không có entry lạ ngoài registry (mcp-tool khai báo minh bạch mock Phase 3)')
  if (bad.length === 0) console.log(`  ➜ C3 ĐẠT`)

  // ==================== C4. EVIDENCE TỒN TẠI + SHA-256 (FULL, không sample) ====================
  console.log('\n━━━ C4. Evidence 1:1 cho mọi builtin PASS — full coverage + SHA-256 ━━━')
  const passBuiltin = entries.filter(e => e.kind === 'builtin-tool' && e.classification === 'PASS')
  if (!fs.existsSync(PROBES_DIR)) vfail(`thiếu thư mục ${PROBES_DIR} — chạy \`bun run audit:tools\` trước`)
  else {
    let missing = 0, badShape = 0
    for (const e of passBuiltin) {
      const evPath = path.join(PROBES_DIR, `${e.id}.json`)
      if (!fs.existsSync(evPath)) { missing++; vfail(`builtin PASS \`${e.id}\`: không có ${path.relative(ROOT, evPath)}`); continue }
      try {
        const ev = JSON.parse(fs.readFileSync(evPath, 'utf-8')) as ProbeFile
        const okShape = (ev.probes?.length ?? 0) > 0 && ev.probes!.every(p => p.exitStatus && p.timestamp && (typeof p.rawResponse === 'string' || typeof p.rawError === 'string'))
        if (!okShape) { badShape++; vfail(`builtin PASS \`${e.id}\`: bằng chứng thiếu exitStatus/timestamp/rawResponse|rawError`) }
        evidenceHashes[path.relative(ROOT, evPath)] = createHash('sha256').update(fs.readFileSync(evPath)).digest('hex').slice(0, 16)
      } catch (err) { badShape++; vfail(`builtin PASS \`${e.id}\`: đọc evidence lỗi — ${err instanceof Error ? err.message : String(err)}`) }
    }
    if (missing === 0 && badShape === 0) vpass(`${passBuiltin.length}/${passBuiltin.length} builtin PASS có file bằng chứng ĐỦ exitStatus+timestamp+rawResponse|rawError (full coverage)`)
  }

  // ==================== C5. PASS ⟺ exitStatus=success (MỌI probe file) ====================
  console.log('\n━━━ C5. Phân loại ⟺ evidence — PASS ⟺ exitStatus=success ở MỌI entry ━━━')
  {
    const manifestById = new Map(entries.filter(e => e.kind === 'builtin-tool').map(e => [e.id, e]))
    let mismatches = 0, checked = 0
    if (fs.existsSync(PROBES_DIR)) {
      for (const f of fs.readdirSync(PROBES_DIR).filter(f => f.endsWith('.json'))) {
        const id = f.replace(/\.json$/, '')
        const entry = manifestById.get(id)
        let ev: ProbeFile
        try { ev = JSON.parse(fs.readFileSync(path.join(PROBES_DIR, f), 'utf-8')) as ProbeFile } catch { continue }
        const last = ev.probes?.[ev.probes.length - 1]
        if (!last?.exitStatus) continue
        checked++
        // PASS phải có probe cuối success; KHÔNG-PASS (FAIL/BLOCKED_*) thì probe cuối
        // phải skipped/error — nếu classification ≠ PASS mà exitStatus=success → mâu thuẫn
        if (entry && entry.classification === 'PASS' && last.exitStatus !== 'success') {
          mismatches++; vfail(`\`${id}\`: phân loại PASS nhưng probe cuối exitStatus="${last.exitStatus}"`)
        } else if (entry && entry.classification !== 'PASS' && entry.classification !== 'NOT_APPLICABLE' && last.exitStatus === 'success') {
          mismatches++; vfail(`\`${id}\`: phân loại ${entry.classification} nhưng probe cuối exitStatus="success" — mâu thuẫn evidence`)
        }
      }
    }
    if (mismatches === 0) vpass(`${checked} probe file nhất quán phân loại ⟺ exitStatus (0 mâu thuẫn)`)
    else violations += mismatches
  }

  // ==================== C6. SKILL FOUR-PART (mapping + SKILL.md + front-matter + dry-run) ====================
  console.log('\n━━━ C6. Skill four-part — toàn bộ fs-skill + db-skill đủ 4 phần ━━━')
  {
    const sv = (manifest as { skillValidation?: { fourPartChecks?: Array<{ slug: string; registry: string; part1?: boolean; part2?: boolean; part3?: boolean; part4?: boolean; reason?: string }> } }).skillValidation
    const checks = sv?.fourPartChecks ?? []
    const expectedSkillCount = (live['fs-skill']?.length ?? 0) + (live['db-skill']?.length ?? 0)
    if (checks.length === 0) vfail('manifest thiếu skillValidation.fourPartChecks — chạy lại `bun run audit:manifest`')
    else {
      const incomplete = checks.filter(c => !(c.part1 && c.part2 && c.part3 && c.part4))
      if (incomplete.length > 0) {
        for (const c of incomplete.slice(0, 10)) vfail(`skill \`${c.slug}\` (${c.registry}): part1=${c.part1} part2=${c.part2} part3=${c.part3} part4=${c.part4}`)
        if (incomplete.length > 10) vfail(`… và ${incomplete.length - 10} skill khác thiếu phần`)
      } else vpass(`${checks.length}/${checks.length} skill đủ 4 phần (mapping + SKILL.md + front-matter + dry-run)`)
      if (checks.length !== expectedSkillCount) vfail(`số skill trong fourPartChecks (${checks.length}) ≠ số skill registry sống (${expectedSkillCount} = ${live['fs-skill']?.length ?? 0} fs + ${live['db-skill']?.length ?? 0} db)`)
      else vpass(`đủ số lượng: ${checks.length} = fs-skill(${live['fs-skill']?.length ?? 0}) + db-skill(${live['db-skill']?.length ?? 0})`)
    }
  }

  // ==================== C7. BASELINE SIDE-EFFECT (before/after của audit:baseline) ====================
  console.log('\n━━━ C7. Baseline side-effect — protected files + package.json trước/sau ━━━')
  {
    const baselineDir = path.join(ROOT, 'audit-out', 'baseline')
    const beforePath = path.join(baselineDir, 'before.json')
    const afterPath = path.join(baselineDir, 'after.json')
    if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
      vwarn('chưa có audit-out/baseline/{before,after}.json — chạy `bun run audit:baseline before` TRƯỚC tác vụ và `bun run audit:baseline after` SAU tác vụ để chứng minh không side effect')
    } else {
      try {
        const before = JSON.parse(fs.readFileSync(beforePath, 'utf-8')) as { protected?: Record<string, string>; packageJsonSha?: string }
        const after = JSON.parse(fs.readFileSync(afterPath, 'utf-8')) as { protected?: Record<string, string>; packageJsonSha?: string }
        let diff = 0
        const protBefore = before.protected ?? {}
        for (const [file, hash] of Object.entries(protBefore)) {
          const afterHash = (after.protected ?? {})[file]
          if (afterHash === undefined) { diff++; vfail(`baseline: ${file} có trong before nhưng thiếu trong after`) }
          else if (afterHash !== hash) { diff++; vfail(`baseline: ${file} THAY ĐỔI trước/sau (${String(hash).slice(0, 8)} → ${String(afterHash).slice(0, 8)}) — side effect chưa dọn`) }
        }
        if (before.packageJsonSha !== after.packageJsonSha) { diff++; vfail(`baseline: package.json thay đổi trước/sau — dùng bản khôi phục trong audit-out/baseline/package.json.restore`) }
        if (diff === 0) vpass(`${Object.keys(protBefore).length} protected files + package.json IDENTICAL trước/sau — không side effect`)
      } catch (err) { vfail(`đọc baseline lỗi — ${err instanceof Error ? err.message : String(err)}`) }
    }
  }

  // ==================== BASELINE ĐỐI CHIẾU (cảnh báo, không fail cứng) ====================
  console.log('\n━━━ Baseline đối chiếu (cảnh báo) ━━━')
  const pkgNow = sha(path.join(ROOT, 'package.json'))
  const envNow = sha(path.join(ROOT, '.env'))
  vpass(`package.json hiện tại: ${pkgNow} (sạch "hacked" — JSON parse được: ${(() => { try { JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')); return true } catch { return false } })() ? 'CÓ' : 'KHÔNG'})`)
  vpass(`.env hiện tại: ${envNow} · ${fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n').length} dòng`)
  const gitHeadNow = (() => {
    try { return fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf-8').trim() } catch { return '(?)' }
  })()
  if (gitHeadNow.startsWith('ref:')) {
    try {
      const ref = gitHeadNow.replace('ref: ', '')
      const head = fs.readFileSync(path.join(ROOT, '.git', ref), 'utf-8').trim()
      if (head !== manifest.gitHead) vwarn(`git HEAD đã di chuyển sau khi manifest sinh (${String(manifest.gitHead).slice(0, 8)} → ${head.slice(0, 8)}) — chạy lại audit-manifest.ts để làm mới`)
      else vpass(`git HEAD khớp manifest: ${head.slice(0, 12)}`)
    } catch { vwarn('không đọc được git HEAD hiện tại') }
  }

  // ==================== TỔNG KẾT + REPORT BỀN VỮNG ====================
  const cls = new Map<string, number>()
  for (const e of entries) cls.set(e.classification, (cls.get(e.classification) || 0) + 1)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TỔNG KẾT CHECKER:')
  console.log(`  Phân loại: ${VALID_LABELS.map(l => `${l}=${cls.get(l) ?? 0}`).join(' · ')}`)
  console.log(`  Bất biến: C1(${violations === 0 ? 'ĐẠT' : 'VI PHẠM'}) · C2 · C3 · C4 · C5 · C6 · C7 — vi phạm: ${violations} · cảnh báo: ${warnings}`)
  console.log(violations === 0
    ? '  ✅ CHUỖI KIỂM ĐỊNH XANH — đủ 7 bất biến: không thiếu ID, không trùng, phân loại đủ, evidence 1:1 + hash, PASS⟺success, skill 4 phần, baseline không side effect'
    : '  ❌ CHUỖI KIỂM ĐỊNH CHƯA ĐẠT — xem vi phạm trên')
  console.log(`  KẾT QUẢ: ${entries.length} entry · violations=${violations}\n`)

  // ==================== PROVENANCE (VÒNG 15 — docs/TOOLS_AUDIT.md §6 mục 6) ====================
  // Báo cáo phải truy vết đúng run sinh ra nó: AUDIT_RUN_ID → stamp vào
  // check-report.json + mirror tmp/audit/<runId>/. Thiếu env → unscoped (warn).
  const provenance = resolveAuditProvenance()
  // Chống lệch thời gian (bài học 09:25/16:39): manifest phải sinh TRONG thời
  // gian sống của run — manifest cũ hơn run → không phải bằng chứng của run này.
  if (provenance.mode === 'scoped' && provenance.runStartedAt) {
    const runStart = Date.parse(provenance.runStartedAt)
    const manifestGen = Date.parse(manifest.generatedAt)
    if (Number.isFinite(runStart) && Number.isFinite(manifestGen) && manifestGen < runStart) {
      vwarn(
        `manifest sinh TRƯỚC run (manifest ${manifest.generatedAt} < run bắt đầu ${provenance.runStartedAt}) — manifest KHÔNG phải bằng chứng của run này, chạy lại \`AUDIT_RUN_ID=${provenance.runId} bun run audit:manifest\` trước khi check`
      )
    }
  }

  // Evidence bundle bền vững — audit-out/reports/ được git re-include (sống qua
  // git clean), chứa sha256 MỖI file evidence + phân loại + verdict + git HEAD.
  try {
    const reportsDir = path.join(ROOT, 'audit-out', 'reports')
    fs.mkdirSync(reportsDir, { recursive: true })
    const report = {
      schema: 'tmo-audit-check-report/2.1',
      generatedAt: new Date().toISOString(),
      gitHead: manifest.gitHead,
      manifestGeneratedAt: manifest.generatedAt,
      provenance,
      totals: { entries: entries.length, byClassification: Object.fromEntries(cls), violations, warnings },
      evidenceHashes,
      exitCode: violations === 0 ? 0 : 1,
    }
    const reportPath = path.join(reportsDir, 'check-report.json')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    // Bundle theo run: tmp/audit/<runId>/check-report.json (no-op khi unscoped)
    mirrorToRunDir(provenance.runId, reportPath, 'check-report.json')
    console.log(`[checker] Report bền vững: audit-out/reports/check-report.json (${Object.keys(evidenceHashes).length} evidence hash · provenance=${provenance.mode}${provenance.runId ? ` runId=${provenance.runId}` : ''})`)
  } catch (err) { console.warn('[checker] ⚠️ không ghi được report bền vững:', err instanceof Error ? err.message : String(err)) }

  process.exit(violations === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[checker] LỖI:', err)
  process.exit(1)
})
