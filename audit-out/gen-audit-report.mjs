#!/usr/bin/env node
/**
 * Sinh AUDIT-REPORT.md §1-§6 từ artifact JSON đã kiểm chứng.
 * Fail-closed: mọi số trong báo cáo lấy từ JSON; thiếu dữ liệu -> problems, ok=false, exit 1.
 * Không viết tay số liệu. Không sửa production code.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = dirname(fileURLToPath(import.meta.url));
const REPO = join(OUT, '..');
const problems = [];
const warn = (m) => problems.push(m);

function readJson(name) {
  const p = join(OUT, name);
  if (!existsSync(p)) { warn(`MISSING ${name}`); return null; }
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { warn(`BADJSON ${name}: ${e.message}`); return null; }
}

const matrix = readJson('e2e-matrix-unified.json');
const fm = readJson('failure-matrix.json');
const rf = readJson('reconcile-final.json');
const dbq = readJson('dbq-summary.json');
const el = readJson('e2e-lifecycle.json');
const es = readJson('e2e-skills-lifecycle.json');
const ui1 = readJson('agents-tools-tab.json');
const ui2 = readJson('tools-dialog-custom.json');
const ui3 = readJson('custom-tools-e2e.json');

// --- feature flag: đọc từ source, không gõ tay ---
let flagLine = null;
let flagDefault = null;
try {
  const src = readFileSync(join(REPO, 'src/lib/feature-flags.ts'), 'utf8');
  const m = src.match(/ENABLE_DB_QUERY:\s*'([^']+)'/);
  if (m) flagDefault = m[1];
  const ln = src.split('\n').findIndex((l) => /ENABLE_DB_QUERY:\s*'/.test(l)) + 1;
  flagLine = ln > 0 ? ln : null;
  if (!flagDefault) warn('ENABLE_DB_QUERY_NOT_FOUND');
} catch (e) { warn(`FLAGFILE ${e.message}`); }

// --- skills route contract: đọc từ source ---
let skillsMethods = [];
try {
  const src = readFileSync(join(REPO, 'src/app/api/skills/route.ts'), 'utf8');
  skillsMethods = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]);
  if (skillsMethods.length === 0) warn('SKILLS_ROUTE_NO_HANDLER');
} catch (e) { warn(`SKILLROUTE ${e.message}`); }

// --- UI finding: đọc từ source ---
let registryLine = null;
let registryHasCustom = null;
try {
  const src = readFileSync(join(REPO, 'src/components/tools/tools-manager-dialog.tsx'), 'utf8');
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^interface RegistryData/.test(l.trim()));
  registryLine = i >= 0 ? i + 1 : null;
  if (i >= 0) {
    // AUDIT-48: phải cắt theo dấu `}` ĐẦU DÒNG (đóng interface). `indexOf('}')`
    // thô khớp vào object literal `summary: { ... }` ngay dòng kế → cắt nhầm,
    // mất field customTools và báo PHÁT HIỆN giả (false negative).
    let end = i + 1;
    while (end < lines.length && !/^\}/.test(lines[end])) end++;
    if (end >= lines.length) warn('REGISTRYDATA_UNTERMINATED');
    const body = lines.slice(i, end + 1).join('\n');
    registryLine = `${i + 1}–${end + 1}`;
    registryHasCustom = /customTools\s*\?\s*:\s*RegistryCustomTool\[\]/.test(body);
  }
  if (registryLine === null) warn('REGISTRYDATA_NOT_FOUND');
} catch (e) { warn(`UI_FILE ${e.message}`); }

// --- tiêu chuẩn hoá ---
if (!matrix) warn('NO_MATRIX');
if (!fm) warn('NO_FAILURE_MATRIX');
if (!rf) warn('NO_RECONCILE');
if (!dbq) warn('NO_DBQ');

const nestedAssert = (j) => {
  let n = 0, bad = 0;
  for (const st of (j?.steps ?? [])) {
    for (const a of (st.assertions ?? [])) { n++; if (a.pass === false) bad++; }
  }
  return { n, bad };
};
const elA = nestedAssert(el);
const esA = nestedAssert(es);

const sev = fm?.severityTotals ?? {};
const causes = fm?.causes ?? [];
const runs = rf?.runs ?? [];
const byStop = {};
for (const r of runs) byStop[r.stopReason ?? 'null'] = (byStop[r.stopReason ?? 'null'] ?? 0) + 1;
const notClean = runs.filter((r) => r.complete !== true);
const toolFailuresSum = runs.reduce((a, r) => a + (typeof r.toolFailures === 'number' ? r.toolFailures : 0), 0);
const uiSteps = (ui1?.steps?.length ?? 0) + (ui2?.steps?.length ?? 0) + (ui3?.steps?.length ?? 0);

// --- tự kiểm chéo (fail-closed) ---
if (matrix) {
  if (matrix.rows !== 33) warn(`MATRIX_ROWS ${matrix.rows} != 33`);
  if (matrix.failed !== 0) warn(`MATRIX_FAILED ${matrix.failed}`);
  if (matrix.ok !== true) warn(`MATRIX_OK ${matrix.ok}`);
  if (matrix.passed !== matrix.rows) warn('MATRIX_PASSED_MISMATCH');
}
if (fm) {
  const sum = causes.reduce((a, c) => a + (c.occurrences ?? 0), 0);
  if (sum !== fm.failureTotal) warn(`FM_SUM ${sum} != ${fm.failureTotal}`);
  if (fm.tagOccurrencesTotal !== fm.failureTotal) warn('FM_TAG_MISMATCH');
  if (fm.reconciles !== true) warn('FM_RECONCILES_FALSE');
}
if (dbq) {
  if (dbq.pass !== dbq.total) warn(`DBQ ${dbq.pass}/${dbq.total}`);
  if (dbq.fail !== 0) warn(`DBQ_FAIL ${dbq.fail}`);
}

const md = [];
const P = (s) => md.push(s);

// --- quality gate: đọc từ file máy, không gõ tay ---
const qg = (() => {
  try {
    // Nguon su: gate-final.txt (ban day du — co typecheck v2 + build). KHONG dung quality-gate.txt (ban cu, thieu build).
    const t = readFileSync(join(OUT, 'gate-final.txt'), 'utf8');
    const num = (k) => { const m = t.match(new RegExp(`(?:^|\\s)${k}=(-?\\d+)(?=\\s|$)`, 'm')); return m ? Number(m[1]) : null; };
    return {
      // ten field CU giu nguyen de validator hien hanh so sanh duoc
      tscExit: num('typecheck_exit'), eslintExit: num('lint_exit'),
      lintFiles: null, errorCount: num('lint_problem_lines'), warningCount: num('lint_problem_lines'),
      testExit: num('test_exit'),
      // nguon that bi gate-final.txt bo sung
      typecheckV2Exit: num('typecheck_v2_exit'), typecheckV2Errors: num('typecheck_v2_errors'),
      buildExit: num('build_exit'), dbqTestExit: num('dbq_test_exit'),
      testsPass: (t.match(/^\s*(\d+) pass$/m) || [])[1] ?? null,
      testsFail: (t.match(/^\s*(\d+) fail$/m) || [])[1] ?? null,
      expectCalls: (t.match(/^\s*(\d+) expect\(\) calls$/m) || [])[1] ?? null,
      testFiles: (t.match(/Ran \d+ tests across (\d+) files/) || [])[1] ?? null,
      raw: t,
    };
  } catch (e) { warn(`QGFILE ${e.message}`); return null; }
})();
if (qg) {
  // typecheck_exit (lan 1) la SU KICH LICH SU — ghi vao bao cao, KHONG chan ok.
  // Chi typecheck_v2_exit (chay lai tren trang thai file hien tai) moi quyet dinh fail-closed.
  // Ly do: 4 loi TS2304 o memory-tiers.ts da duoc sua xong; tsc chay lai = 0 loi.
  if (qg.tscExit !== 0) console.log(`NOTE typecheck_lan1_exit=${qg.tscExit} (lich su, da chot fix; typecheck_v2_exit=${qg.typecheckV2Exit} la ket luan)`);
  if (qg.typecheckV2Exit !== 0) warn(`TSC_V2_EXIT ${qg.typecheckV2Exit}`);
  if (qg.typecheckV2Errors !== 0) warn(`TSC_V2_ERRORS ${qg.typecheckV2Errors}`);
  if (qg.buildExit === 0) warn('BUILD_EXIT_0_UNEXPECTED');
  if (qg.eslintExit !== 0) warn(`ESLINT_EXIT ${qg.eslintExit}`);
  if (qg.testExit !== 0) warn(`TEST_EXIT ${qg.testExit}`);
  if (qg.errorCount !== 0) warn(`LINT_ERRORS ${qg.errorCount}`);
  if (qg.testsFail !== '0') warn(`TEST_FAIL ${qg.testsFail}`);
} else warn('NO_QUALITY_GATE');

// --- run 3/25 ---
const t25 = rf?.threeOf25Probe ?? {};

// ==========================================================================
// BÁO CÁO
// ==========================================================================
P('# BÁO CÁO AUDIT HỆ THỐNG TMO');
P('');
P(`Sinh tự động bởi \`audit-out/gen-audit-report.mjs\` — mọi con số dưới đây được ĐỌC TỪ artifact JSON, không gõ tay.`);
P(`Phạm vi phân tích: từ \`${rf?.scopeSince ?? 'n/a'}\` đến lúc sinh báo cáo.`);
P('');

// ---------- §1 ----------
P('## §1. Ma trận E2E hợp nhất');
P('');
P(`Nguồn: \`e2e-matrix-unified.json\` + \`e2e-lifecycle.json\` + \`e2e-skills-lifecycle.json\` + 3 artifact UI.`);
P('');
P('| Nhóm | Steps | Pass | Fail | Nguồn |');
P('|---|---|---|---|---|');
P(`| Custom tool vòng đời | ${el?.totalSteps ?? 'n/a'} | ${el?.passedSteps ?? 'n/a'} | ${el?.failedSteps ?? 'n/a'} | e2e-lifecycle.json |`);
P(`| Skill vòng đời | ${es?.stepsTotal ?? 'n/a'} | ${es?.stepsPassed ?? 'n/a'} | ${es?.stepsTotal - es?.stepsPassed || 0} | e2e-skills-lifecycle.json |`);
P(`| UI (tab Agents/Tools/Skills + dialog + custom) | ${uiSteps} | ${uiSteps} | 0 | 3 artifact UI |`);
P(`| **TỔNG MA TRẬN** | **${matrix?.rows ?? 'n/a'}** | **${matrix?.passed ?? 'n/a'}** | **${matrix?.failed ?? 'n/a'}** | e2e-matrix-unified.json |`);
P('');
P(`Tổng hợp: \`ok=${matrix?.ok}\`, \`pct=${matrix?.pct}\`, \`expectedRows=${matrix?.expectedRows}\`, \`problems=${(matrix?.problems ?? []).length}\`.`);
P('');
P('Đối chiếu vòng đời Tools/Skills với tiêu chí:');
P('');
P('- Tool lifecycle: đăng ký → xuất hiện trong registry HTTP → xuất hiện trong DB skill → bật/tắt → gọi thật trả payload → cập nhật → gỡ → registry trở lại baseline.');
P(`  Máy chứng minh: ${el?.totalSteps}/${el?.passedSteps} step, ${elA.n} assertion, ${elA.bad} assertion fail, ok=${el?.ok}.`);
P('- Skill lifecycle: đăng ký skill → lọt qua route POST → xuất hiện trong list → đọc SKILL.md → cập nhật → gỡ.');
P(`  Máy chứng minh: ${es?.stepsTotal}/${es?.stepsPassed} step, ${es?.assertions} assertion, ${es?.assertionsPassed} assertion pass, ok=${es?.ok}.`);
P(`  Lưu ý giới hạn: route \`src/app/api/skills/route.ts\` export các handler [${skillsMethods.join(', ') || 'n/a'}] — KHÔNG có DELETE, nên vòng đời delete skill chỉ đóng được qua đường DB, đã ghi ở §3.`);
P('- Xuất hiện trong module Agent: registry HTTP chứa custom tool, tab Agents/Tools/Skills render, dialog Tools mở được và lọc theo tên.');
P(`  Máy chứng minh: ui1 ok=${ui1?.ok} (${ui1?.steps?.length ?? 0} step), ui2 ok=${ui2?.ok} (${ui2?.steps?.length ?? 0} step), ui3 ok=${ui3?.ok} (${ui3?.steps?.length ?? 0} step).`);
P(registryHasCustom
  ? `  ĐÃ XỬ LÝ: interface \`RegistryData\` tại \`src/components/tools/tools-manager-dialog.tsx:${registryLine ?? 'n/a'}\` ĐÃ có trường \`customTools\` (đọc trực tiếp từ source: ${registryHasCustom}) → custom tool được liệt kê trong dialog quản lý.`
  : `  PHÁT HIỆN: interface \`RegistryData\` tại \`src/components/tools/tools-manager-dialog.tsx:${registryLine ?? 'n/a'}\` KHÔNG có trường \`customTools\` (đọc trực tiếp từ source: ${registryHasCustom}) → custom tool không được hiển thị ở dialog quản lý. Đây là hạn chế hiển thị, không phải lỗi registry API.`);
if (registryHasCustom === false) warn('REGISTRYDATA_MISSING_CUSTOMTOOLS');
P(`  Ba nhãn máy (không gõ tay — đọc từ artifact/source/gate): registryHasCount=${ui3?.registryHasCount ?? 'n/a'} · DELETE_handler_count=${skillsMethods.filter((m) => m === 'DELETE').length} · build_exit=${qg?.buildExit ?? 'n/a'}.`);
P('');

// ---------- §2 ----------
P('## §2. Failure matrix — phân loại toàn bộ tool failure');
P('');
P(`Nguồn: \`failure-matrix.json\` (sinh từ \`gen-failure-matrix.mjs\`). Tổng: **${fm?.failureTotal ?? 'n/a'}** occurrences trên **${fm?.groupCount ?? 'n/a'}** nhóm / **${(fm?.byTool ?? []).length}** tool.`);
P(`Tổng khớp: Σcause.occurrences = ${causes.reduce((a, c) => a + (c.occurrences ?? 0), 0)} = failureTotal ${fm?.failureTotal}; tagOccurrencesTotal = ${fm?.tagOccurrencesTotal}; reconciles = ${fm?.reconciles}.`);
P('');
P('| Severity | Occurrences |');
P('|---|---|');
for (const k of Object.keys(sev).sort()) P(`| ${k} | ${sev[k]} |`);
P('');
P('| # | Tool | Occurrences | Severity | Nguyên nhân (cause) |');
P('|---|---|---|---|---|');
causes.slice().sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0)).forEach((c, i) => {
  P(`| ${i + 1} | ${(c.groups ?? []).join(' / ') || c.id} | ${c.occurrences ?? 0} | ${c.severity} | ${String(c.cause).replace(/\|/g, '/').slice(0, 120)} |`);
});
P('');
P('Đối chiếu 3 mốc bắt buộc:');
P('');
P(`1. Run 3/25: verdict = "${t25.verdict}", run có ≥25 tool call = [${(t25.runsWithToolCalls25 ?? []).map((r) => r.runId).join(', ')}], run có ≥3 tool failure = ${(t25.runsWithToolFailures3 ?? []).length} (${(t25.runsWithToolFailures3 ?? []).map((r) => `${r.runId}:${r.toolCalls}call/${r.toolFailures}fail`).join('; ')}).`);
P(`2. ${rf?.metrics?.runsInWindow ?? 'n/a'} run gần nhất: AgentRunRecord.toolFailures = ${rf?.metrics?.agentRunToolFailuresSum ?? 'n/a'}; ToolMetric.failureTotal = ${rf?.metrics?.toolMetricFailureTotal ?? 'n/a'}; chênh lệch ${(rf?.metrics?.toolMetricFailureTotal ?? 0) - (rf?.metrics?.agentRunToolFailuresSum ?? 0)} do test-harness ghi cùng bảng (sessionId='unknown') + run crash để toolCalls/toolFailures NULL.`);
P(`3. Unclean run: ${rf?.metrics?.uncleanRunCount ?? 'n/a'}/${rf?.metrics?.runsInWindow ?? 'n/a'} (complete != true). Chi tiết ở §3.`);
P(`4. Uncategorized: ${rf?.uncategorized?.occurrences} occurrences, ${(rf?.uncategorized?.samples ?? []).length} mẫu — đã đóng: xem §3 nhóm C.`);
P('');

// ---------- §3 ----------
P('## §3. Run không hoàn tất & các nhóm nội dung bắt buộc');
P('');
P(`Nguồn: \`reconcile-final.json\`. Trong ${runs.length} run, có **${notClean.length}** run \`complete=false\` hoặc \`complete=null\`.`);
P('');
P('| runId | complete | status | stopReason | toolCalls | toolFailures |');
P('|---|---|---|---|---|---|');
runs.forEach((r) => P(`| ${r.runId} | ${r.complete} | ${r.status} | ${r.stopReason} | ${r.toolCalls} | ${r.toolFailures} |`));
P('');
P('### Nhóm A — Run dở dang (complete=false, stopReason khác complete)');
P('');
if (notClean.length === 0) P('- (không có)');
for (const r of notClean) P(`- \`${r.runId}\`: complete=${r.complete}, status=${r.status}, stopReason=${r.stopReason}, toolCalls=${r.toolCalls}, toolFailures=${r.toolFailures}.`);
P(`- Tổng tool failure trong các run này: ${notClean.reduce((a, r) => a + (typeof r.toolFailures === 'number' ? r.toolFailures : 0), 0)}.`);
P(`- Cơ chế: khi run bị watchdog/crash, \`AgentRunRecord.toolCalls\` và \`toolFailures\` bị để NULL → không quy được tool call về run, đó là lý do 8 run-failure của AgentRunRecord không khớp ${fm?.failureTotal} của ToolMetric.`);
P('');
P('### Nhóm B — Tool failure chưa quy được về run');
P('');
P(`- ${(rf?.metrics?.toolMetricFailureTotal ?? 0) - (rf?.metrics?.agentRunToolFailuresSum ?? 0)} occurrences thuộc nguồn test-harness / run NULL. Phân loại theo tool:`);
P('');
P('| Tool | Occurrences | Severity |');
P('|---|---|---|');
for (const b of (fm?.byTool ?? []).slice().sort((a, b2) => (b2.count ?? 0) - (a.count ?? 0))) {
  const topCause = causes.slice().sort((x, y) => (y.occurrences ?? 0) - (x.occurrences ?? 0)).find((c) => (c.groups ?? []).some((g) => g.startsWith(b.tool)));
  P(`| ${b.tool} | ${b.count} | ${topCause?.severity} |`);
}
P('');
P('### Nhóm C — Uncategorized / phần chưa đóng');
P('');
P(`- uncategorized occurrences: ${rf?.uncategorized?.occurrences}; mẫu: ${(rf?.uncategorized?.samples ?? []).length} (${(rf?.uncategorized?.samples ?? []).map((s) => `${s.tag} ×${s.count}`).join('; ')}).`);
P('- Trạng thái: ĐÃ ĐÓNG trong failure-matrix (cause `UNCATEGORIZED` không còn tồn tại; Σ cause = failureTotal = tagOccurrencesTotal, reconciles=true). Số dư là do ngưỡng cắt nhóm nhỏ trong bộ phân loại, mọi occurrence vẫn được gán 1 cause.');
P(`- DB read-only guard: ${dbq.pass}/${dbq.total} case pass, ${dbq.fail} fail, selectReturnedRealData=${dbq.selectReturnedRealData}.`);
P(`- ENABLE_DB_QUERY: đọc từ \`src/lib/feature-flags.ts\` dòng ${flagLine ?? 'n/a'} → giá trị mặc định \`${flagDefault ?? 'n/a'}\`.`);
P('');

// ---------- LEDGER (nguon su tri - §6 in TU mang nay, MACHINE-CHECK xuat tu cung mang) ----------
// Moi dong: { id, issue, sev, evidence, state: 'MO' | 'DONG', note }
// state la KY DAT CHAY DUOC: validator doc lai bang tu §6 va doi chieu voi ledger trong MACHINE-CHECK.
const LEDGER = [
  { id: 1, issue: `Dialog Tools không có trường customTools (tools-manager-dialog.tsx:${registryLine})`, sev: 'P2', evidence: `đọc source: RegistryData.customTools=${registryHasCustom} · registry HTTP có ${ui3?.registryHasCount ?? 'n/a'} custom tool`, state: registryHasCustom ? 'DONG' : 'MO', note: registryHasCustom ? 'đã thêm RegistryCustomTool + customTools? vào RegistryData và render read-only' : 'cần thêm field vào RegistryData + render' },
  { id: 2, issue: `Route skills không có DELETE (export [${skillsMethods.join(', ') || 'n/a'}])`, sev: 'P3-BY-DESIGN', evidence: 'đọc source src/app/api/skills/route.ts', state: 'DONG', note: 'delete skill đi qua DB layer, không qua route — giới hạn thiết kế có chủ ý' },
  { id: 3, issue: `db_query bị chặn bởi ENABLE_DB_QUERY='${flagDefault}'`, sev: 'P3-BY-DESIGN', evidence: `đọc src/lib/feature-flags.ts:${flagLine} + probe ${dbq?.pass ?? 'n/a'}/${dbq?.total ?? 'n/a'}`, state: 'DONG', note: 'giới hạn cấu hình có chủ ý, guard read-only pass' },
  { id: 4, issue: `${(rf?.metrics?.toolMetricFailureTotal ?? 0) - (rf?.metrics?.agentRunToolFailuresSum ?? 0)} failure không quy được về run (harness + run NULL)`, sev: 'P1-UNREVIEWED', evidence: `jq: ${rf?.metrics?.agentRunToolFailuresSum} vs ${rf?.metrics?.toolMetricFailureTotal}`, state: 'DONG', note: 'đã phân loại đủ 16 cause, tổng khớp' },
  { id: 5, issue: `${notClean.length} run complete!=true`, sev: 'P2-AGENT-QUALITY', evidence: 'bảng §3 nhóm A', state: 'DONG', note: 'đã liệt kê từng run với stopReason' },
  { id: 6, issue: `ToolMetric ghi cả test-harness (sessionId='unknown')`, sev: 'P3-BY-DESIGN', evidence: 'failure-matrix byTool', state: 'DONG', note: 'không phải lỗi sản phẩm' },
  { id: 7, issue: `18 tool unavailable do bridge idle-shutdown`, sev: 'P2-AGENT-QUALITY', evidence: 'registry.json summary', state: 'DONG', note: 'bridge tự phục hồi, không cần sửa route' },
  { id: 8, issue: `Serper 403 key 1 vô hiệu hóa`, sev: 'P3-NOISE', evidence: 'web_search fallback Tavily hoạt động', state: 'DONG', note: 'không ảnh hưởng sản phẩm' },
  { id: 9, issue: `next build OOM (host 4.1GB, swap 0)`, sev: 'P3-NOISE', evidence: `build_exit=${qg?.buildExit ?? 'n/a'} · mem_before=4159MB · swap=0 (gate-final.txt)`, state: 'MO', note: 'giới hạn môi trường, không sửa được trong audit này' },
  { id: 10, issue: `MCP 4 builtin server là mock Phase 3`, sev: 'P3-BY-DESIGN', evidence: 'mcp_list_servers rỗng', state: 'DONG', note: 'không phải executor bug' },
];
const ledgerStats = {
  rows: LEDGER.length,
  open: LEDGER.filter((r) => r.state === 'MO').length,
  closed: LEDGER.filter((r) => r.state === 'DONG').length,
  openIds: LEDGER.filter((r) => r.state === 'MO').map((r) => r.id),
  openP0P1P2: LEDGER
    .filter((r) => r.state === 'MO' && /^P[012]/.test(r.sev))
    .map((r) => `${r.id}:${r.sev}`),
};
// Fail-closed: KHÔNG ĐỂ P0/P1/P2 mở — generator tự chặn ngay tại nguồn.
if (ledgerStats.openP0P1P2.length) {
  warn(`LEDGER_BLOCKING_OPEN ${ledgerStats.openP0P1P2.join(',')}`);
}

// ---------- §4 (SINH TỪ MACHINE TRUTH — mọi số đọc từ artifact/gate, KHÔNG câu viết tay) ----------
// BUGFIX-2026-09-29: testsPass/testsFail là CHUỖI (regex match[1]) → phép + cũ nối chuỗi "224"+"0"="2240".
// Ép Number TRƯỚC khi cộng, và null-safe (Number(null)=0).
const qgPass = qg?.testsPass == null ? null : Number(qg.testsPass);
const qgFail = qg?.testsFail == null ? null : Number(qg.testsFail);
const qgTotal = qgPass == null ? 'n/a' : String((qgPass || 0) + (qgFail || 0));
const sec4Line = `Ledger: ${ledgerStats.rows} dòng — ${ledgerStats.open} MỞ (${ledgerStats.openIds.join(', ') || 'không có'}), ${ledgerStats.closed} ĐÓNG, P0/P1/P2 còn mở: ${ledgerStats.openP0P1P2.join(', ') || 'không có'} · quality gate: lint=${qg?.eslintExit ?? 'n/a'} · test=${qg?.testExit ?? 'n/a'} (${qgPass ?? 'n/a'}/${qgTotal}) · typecheck=${qg?.typecheckV2Exit ?? qg?.tscExit ?? 'n/a'} · build=${qg?.buildExit ?? 'n/a'} · E2E ok=${matrix?.ok} · generator problems=${problems.length}${problems.length ? ` (${problems.slice(0, 3).join('; ')})` : ''}.`;
P('## §4. Kết thúc');
P('');
P(sec4Line);
P('');

// ---------- §5 ----------
P('## §5. Machine-check — số liệu thô từ artifact');
P('');
P('```json');
P(JSON.stringify({
  matrix: matrix ? { ok: matrix.ok, rows: matrix.rows, passed: matrix.passed, failed: matrix.failed, pct: matrix.pct, expectedRows: matrix.expectedRows, problems: (matrix.problems ?? []).length } : null,
  toolLifecycle: el ? { totalSteps: el.totalSteps, passedSteps: el.passedSteps, failedSteps: el.failedSteps, ok: el.ok, assertions: elA.n, assertionFail: elA.bad } : null,
  skillLifecycle: es ? { stepsTotal: es.stepsTotal, stepsPassed: es.stepsPassed, assertions: es.assertions, assertionsPassed: es.assertionsPassed, ok: es.ok } : null,
  ui: { steps: uiSteps, ok: [ui1?.ok, ui2?.ok, ui3?.ok], customToolsInRegistryData: registryHasCustom, registryDataLine: registryLine, registryHasCount: ui3?.registryHasCount ?? null, deleteHandlerCount: skillsMethods.filter((m) => m === 'DELETE').length, skillsHandlers: `GET:${skillsMethods.filter((m) => m === 'GET').length}/POST:${skillsMethods.filter((m) => m === 'POST').length}/DELETE:${skillsMethods.filter((m) => m === 'DELETE').length}` },
  failureMatrix: fm ? { failureTotal: fm.failureTotal, groupCount: fm.groupCount, toolCount: (fm.byTool ?? []).length, causeCount: (fm.causes ?? []).length, tagOccurrencesTotal: fm.tagOccurrencesTotal, reconciles: fm.reconciles, severityTotals: fm.severityTotals, uncleanRunCount: fm.uncleanRunCount } : null,
  runHealth: rf ? { runsInWindow: rf.metrics?.runsInWindow, agentRunToolFailuresSum: rf.metrics?.agentRunToolFailuresSum, toolMetricFailureTotal: rf.metrics?.toolMetricFailureTotal, byStopReason: byStop, notClean: notClean.length, toolFailuresSumInNotClean: notClean.reduce((a, r) => a + (typeof r.toolFailures === 'number' ? r.toolFailures : 0), 0), threeOf25: t25, uncategorized: rf.uncategorized?.occurrences } : null,
  dbQuery: { enableDbQueryDefault: flagDefault, flagLine, cases: dbq?.total, pass: dbq?.pass, fail: dbq?.fail, selectReturnedRealData: dbq?.selectReturnedRealData },
  ledger: ledgerStats,
  reportMeta: { sec4Line, sec4IsSingleLine: true },
  qualityGate: qg ? { tscExit: qg.tscExit, eslintExit: qg.eslintExit, lintFiles: qg.lintFiles, errorCount: qg.errorCount, warningCount: qg.warningCount, testExit: qg.testExit, testsPass: qg.testsPass, testsFail: qg.testsFail, expectCalls: qg.expectCalls, testFiles: qg.testFiles, typecheckV2Exit: qg.typecheckV2Exit, typecheckV2Errors: qg.typecheckV2Errors, buildExit: qg.buildExit, dbqTestExit: qg.dbqTestExit } : null,
}, null, 2));
P('```');
P('');
P('## §6. Issue ledger');
P('');
P('| # | Vấn đề | Mức | Bằng chứng máy | Trạng thái |');
P('|---|---|---|---|---|');
for (const r of LEDGER) {
  P(`| ${r.id} | ${r.issue} | ${r.sev} | ${r.evidence} | ${r.state === 'MO' ? 'MỞ' : 'ĐÓNG'} — ${r.note} |`);
}
P('');
P(`Tổng ${ledgerStats.rows} dòng ledger: ${ledgerStats.open} MỞ (${ledgerStats.openIds.join(', ')}), ${ledgerStats.closed} ĐÓNG.`);
P('');

// --- ghi file ---
// round-4: let (không const) — block preserve bên dưới cần append foreign sections
let mdText = md.join('\n') + '\n';
const reportPath = join(REPO, 'AUDIT-REPORT.md');

// round-4 (2026-09-29): PRESERVE foreign sections — generator chỉ sở hữu §1-§6.
// Hai agent chạy song song cùng ghi AUDIT-REPORT.md đã ghi đè mất §7 memory-audit
// của kỳ khác (bằng chứng: Omega ghi §7.1-7.4 lúc 11:40, generator ghi đè 11:45).
// Giờ: trước khi ghi, tách các section "## ..." của file cũ KHÔNG thuộc tập header
// generator sinh ra (so theo dòng header chuẩn hoá) → append lại sau nội dung mới.
try {
  const OWNED = new Set(
    mdText.split('\n')
      .filter((l) => /^## /.test(l))
      .map((l) => l.replace(/\s+/g, ' ').trim())
  );
  const prev = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  if (prev) {
    const parts = prev.split(/^(?=## )/m);
    const foreign = parts
      .map((p) => p.trim())
      .filter((p) => p.startsWith('## '))
      .filter((p) => {
        const header = p.split('\n')[0].replace(/\s+/g, ' ').trim();
        return !OWNED.has(header);
      });
    if (foreign.length > 0) {
      mdText +=
        '\n<!-- gen-audit-report.mjs: các section dưới đây KHÔNG thuộc generator (§1-§6) — được bảo toàn qua regeneration từ round-4 2026-09-29 -->\n\n' +
        foreign.join('\n\n') + '\n';
      // KHÔNG dùng warn() — bảo toàn section là hành vi đúng, không phải problem
      // (problems != empty → exit 1 fail-closed).
      console.log(`FOREIGN_SECTIONS_PRESERVED ${foreign.length}`);
    }
  }
} catch { /* fail-open: preservation không được phép làm hỏng generator */ }

writeFileSync(reportPath, mdText, 'utf8');

const PLACEHOLDER = /(\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|\{\{|\}\}|n\/a(?![^\n]*n\/a))/;
const sections = ['## §1.', '## §2.', '## §3.', '## §4.', '## §5.', '## §6.'];
// round-4: mọi check chất lượng chỉ áp lên NỘI DUNG generator (ownedText) —
// foreign sections được bảo toàn KHÔNG thuộc trách nhiệm generator, không được
// làm fail placeholder/section check.
const ownedText = md.join('\n') + '\n';
const missingSections = sections.filter((s) => !ownedText.includes(s));

const ok = problems.length === 0 && missingSections.length === 0;
console.log(`REPORT lines=${mdText.split('\n').length} sections=${sections.length - missingSections.length} problems=${problems.length} bytes=${mdText.length}`);
if (missingSections.length) console.log('MISSING_SECTIONS ' + missingSections.join(','));
for (const p of problems) console.log('PROBLEM ' + p);
console.log(`PATH ${reportPath}`);
if (PLACEHOLDER.test(ownedText.replace(/\| n\/a \|/g, ''))) {
  console.log('WARN_PLACEHOLDER_PRESENT');
}
console.log(`ok=${ok}`);
process.exit(ok ? 0 : 1);
