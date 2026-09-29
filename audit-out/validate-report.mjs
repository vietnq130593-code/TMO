#!/usr/bin/env node
// ============================================================================
// validate-report.mjs — KIỂM ĐỊNH CHÉO AUDIT-REPORT.md
// ----------------------------------------------------------------------------
// Nguyên tắc: KHÔNG tin gen-audit-report.mjs. Validator tự đọc artifact JSON +
// quality-gate.txt + source, TỰ TÍNH LẠI từng giá trị, rồi so với giá trị
// đã in ra trong AUDIT-REPORT.md. Lệch bất kỳ số nào -> FAIL.
// Exit 0 = báo cáo trung thực với dữ liệu. Exit 1 = có sai lệch.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('.', import.meta.url).pathname;
const REPO = join(OUT, '..');
// Đường dẫn report: mặc định AUDIT-REPORT.md, cho phép trỏ sang bản sao để
// chạy kiểm thử âm (mutation test) mà không đụng file thật.
const _rep = process.argv[2];
const REPORT = _rep
  ? (_rep.startsWith('/') ? _rep : join(REPO, _rep))
  : join(REPO, 'AUDIT-REPORT.md');

const problems = [];
const checks = [];
const P = (s) => process.stdout.write(s + '\n');

const readJson = (n) => (existsSync(join(OUT, n)) ? JSON.parse(readFileSync(join(OUT, n), 'utf8')) : null);
const num = (t, k) => {
  const m = t.match(new RegExp(`(?:^|\\s)${k}=(-?\\d+)(?=\\s|$)`, 'm'));
  return m ? Number(m[1]) : null;
};

// --- tải nguồn (giống generator nhưng TÍNH LẠI, không dùng biến của generator) ---
const md = readFileSync(REPORT, 'utf8');
const matrix = readJson('e2e-matrix-unified.json');
const fm = readJson('failure-matrix.json');
const rf = readJson('reconcile-final.json');
const dbq = readJson('dbq-summary.json');
const el = readJson('e2e-lifecycle.json');
const es = readJson('e2e-skills-lifecycle.json');
const ui1 = readJson('agents-tools-tab.json');
const ui2 = readJson('tools-dialog-custom.json');
const ui3 = readJson('custom-tools-e2e.json');
const qgTxt = readFileSync(join(OUT, 'gate-final.txt'), 'utf8');

const flagSrc = readFileSync(join(REPO, 'src/lib/feature-flags.ts'), 'utf8');
const flagDefault = (flagSrc.match(/ENABLE_DB_QUERY:\s*'([^']+)'/) || [])[1] ?? null;
const flagLine = flagSrc.split('\n').findIndex((l) => /ENABLE_DB_QUERY:\s*'/.test(l)) + 1;

// --- 1. cấu trúc báo cáo ---
for (const s of ['## §1.', '## §2.', '## §3.', '## §4.', '## §5.', '## §6.']) {
  if (!md.includes(s)) problems.push(`MISSING_SECTION ${s}`);
  else checks.push(s);
}
P(`SECTIONS ${['§1','§2','§3','§4','§5','§6'].filter((x) => md.includes(`## ${x}.`)).length}/6`);

// --- 2. §4 đúng 1 câu ---
// tách theo heading ĐẦY ĐỦ (kèm phần tiêu đề sau dấu chấm) để không nuốt
// đuôi " Kết thúc" vào body — dùng regex + \n thay vì split chuỗi thô
const sec4 = (md.split(/## §4\.[^\n]*\n/)[1] || '').split(/## §5\./)[0];
const sec4Body = sec4.split('\n').map((l) => l.trim()).filter(Boolean);
P(`SEC4_LINES ${sec4Body.length} :: ${sec4Body.join(' | ')}`);
if (sec4Body.length !== 1) problems.push(`SEC4_NOT_ONE_SENTENCE lines=${sec4Body.length}`);

// --- 3. không placeholder ---
const ph = md.match(/\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|\{\{|\}\}/g) || [];
P(`PLACEHOLDERS ${ph.length}`);
if (ph.length) problems.push(`PLACEHOLDER ${ph.join(',')}`);
// "n/a" chỉ chấp nhận nếu nằm trong mô tả văn xuôi, không được trong bảng số
const naTable = md.split('\n').filter((l) => /^\|.*\|\s*n\/a\s*\|/.test(l));
P(`NA_IN_TABLE ${naTable.length}`);
if (naTable.length) problems.push(`NA_IN_TABLE_ROWS ${naTable.length}`);

// --- 4. khối MACHINE-CHECK: parse JSON, so TỪNG FIELD với nguồn ---
const mcRaw = (md.split('```json')[1] || '').split('```')[0] || '{}';
let mc = {};
try { mc = JSON.parse(mcRaw); } catch (e) { problems.push(`MC_NOT_JSON ${e.message}`); }
P(`MC_KEYS ${Object.keys(mc).length}`);

const eq = (label, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push(label);
  if (!ok) problems.push(`MISMATCH ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  return ok;
};

// matrix
eq('matrix.ok', matrix?.ok, mc.matrix?.ok);
eq('matrix.rows', matrix?.rows, mc.matrix?.rows);
eq('matrix.passed', matrix?.passed, mc.matrix?.passed);
eq('matrix.failed', matrix?.failed, mc.matrix?.failed);
eq('matrix.problems', (matrix?.problems ?? []).length, mc.matrix?.problems);

// toolLifecycle — tự đếm assertion từ semantics/steps
// SENTINEL-FIX-1: trước đây assertions/assertionFail chỉ được in ra report mà KHÔNG
// có ai đối chiếu lại (lỗ hổng kiểm định). Nay tự đếm độc lập từ
// steps[].assertions[] rồi so với giá trị đã in.
const countNested = (j) => {
  let n = 0, bad = 0;
  for (const st of (j?.steps ?? [])) {
    for (const a of (st?.assertions ?? [])) { n++; if (a?.pass === false) bad++; }
  }
  return { n, bad };
};
const elSteps = el?.steps ?? [];
const elFail = elSteps.filter((s) => s.pass !== true).length;
const elA = countNested(el);
const esA = countNested(es);
eq('tool.totalSteps', el?.totalSteps, mc.toolLifecycle?.totalSteps);
eq('tool.passedSteps', el?.passedSteps, mc.toolLifecycle?.passedSteps);
eq('tool.failedSteps', elFail, mc.toolLifecycle?.failedSteps);
eq('tool.assertions', elA.n, mc.toolLifecycle?.assertions);
eq('tool.assertionFail', elA.bad, mc.toolLifecycle?.assertionFail);
eq('tool.ok', elSteps.length > 0 && elFail === 0 ? true : (el?.ok ?? null), mc.toolLifecycle?.ok);

// skillLifecycle
eq('skill.stepsTotal', es?.stepsTotal, mc.skillLifecycle?.stepsTotal);
eq('skill.stepsPassed', es?.stepsPassed, mc.skillLifecycle?.stepsPassed);
eq('skill.assertions', es?.assertions, mc.skillLifecycle?.assertions);
eq('skill.assertionsPassed', es?.assertionsPassed, mc.skillLifecycle?.assertionsPassed);
eq('skill.ok', es?.ok, mc.skillLifecycle?.ok);
// SENTINEL-FIX-2: đối chiếu chéo con số top-level với số đếm từ steps[].assertions[]
// — fail nếu artifact tự khai 41 nhưng thực tế lưu 40 assertion.
eq('skill.assertionsNested', esA.n, es?.assertions);
eq('skill.assertionsPassedNested', esA.n - esA.bad, es?.assertionsPassed);

// ui
// ui.steps = TỔNG số step của 3 artifact UI (5+3+2=10), không phải số file
const uiStepsReal = (ui1?.steps?.length ?? 0) + (ui2?.steps?.length ?? 0) + (ui3?.steps?.length ?? 0);
eq('ui.steps', uiStepsReal, mc.ui?.steps);
eq('ui.ok', [ui1?.ok, ui2?.ok, ui3?.ok], mc.ui?.ok);

// failureMatrix — tự cộng
const causeSum = (fm?.causes ?? []).reduce((a, c) => a + (c.occurrences ?? 0), 0);
const sevReal = {};
for (const c of fm?.causes ?? []) sevReal[c.severity] = (sevReal[c.severity] ?? 0) + (c.occurrences ?? 0);
eq('fm.failureTotal', fm?.failureTotal, mc.failureMatrix?.failureTotal);
eq('fm.groupCount', fm?.groupCount, mc.failureMatrix?.groupCount);
eq('fm.toolCount', (fm?.byTool ?? []).length, mc.failureMatrix?.toolCount);
eq('fm.causeCount', (fm?.causes ?? []).length, mc.failureMatrix?.causeCount);
eq('fm.tagOccurrencesTotal', fm?.tagOccurrencesTotal, mc.failureMatrix?.tagOccurrencesTotal);
eq('fm.severityTotals', sevReal, mc.failureMatrix?.severityTotals);
eq('fm.reconciles', causeSum === fm?.failureTotal, mc.failureMatrix?.reconciles);

// runHealth — tự tính từ runs
const runs = rf?.runs ?? [];
const notClean = runs.filter((r) => r.complete !== true);
const failSum = notClean.reduce((a, r) => a + (typeof r.toolFailures === 'number' ? r.toolFailures : 0), 0);
const byStop = {};
for (const r of runs) byStop[r.stopReason ?? 'null'] = (byStop[r.stopReason ?? 'null'] ?? 0) + 1;
eq('rh.runsInWindow', rf?.metrics?.runsInWindow, mc.runHealth?.runsInWindow);
eq('rh.agentRunToolFailuresSum', rf?.metrics?.agentRunToolFailuresSum, mc.runHealth?.agentRunToolFailuresSum);
eq('rh.toolMetricFailureTotal', rf?.metrics?.toolMetricFailureTotal, mc.runHealth?.toolMetricFailureTotal);
eq('rh.byStopReason', byStop, mc.runHealth?.byStopReason);
eq('rh.notClean', notClean.length, mc.runHealth?.notClean);
eq('rh.toolFailuresSumInNotClean', failSum, mc.runHealth?.toolFailuresSumInNotClean);
eq('rh.threeOf25', rf?.threeOf25Probe, mc.runHealth?.threeOf25);
eq('rh.uncategorized', rf?.uncategorized?.occurrences, mc.runHealth?.uncategorized);

// dbQuery — tự đọc flag + guard
eq('dbq.flag', flagDefault, mc.dbQuery?.enableDbQueryDefault);
eq('dbq.flagLine', flagLine, mc.dbQuery?.flagLine);
eq('dbq.total', dbq?.total, mc.dbQuery?.cases);
eq('dbq.pass', dbq?.pass, mc.dbQuery?.pass);
eq('dbq.fail', dbq?.fail, mc.dbQuery?.fail);
eq('dbq.selectReturnedRealData', dbq?.selectReturnedRealData, mc.dbQuery?.selectReturnedRealData);
// guard read-only: mọi case có errorMsg null hoặc verdict hợp lệ
const caseArr = dbq?.cases ?? [];
const badCase = caseArr.filter((c) => c.pass !== true);
P(`DBQ_CASES ${caseArr.length} bad=${badCase.length}`);
if (badCase.length) problems.push(`DBQ_BAD_CASE ${badCase.length}`);

// qualityGate — TU PARSE gate-final.txt (key THAT: typecheck_exit, typecheck_v2_exit,
// lint_exit, lint_problem_lines, test_exit, build_exit, dbq_test_exit). KHONG tinh lai tu generator.
const qgLint = num(qgTxt, 'lint_problem_lines');
eq('qg.tscExit', num(qgTxt, 'typecheck_exit'), mc.qualityGate?.tscExit);
eq('qg.typecheckV2Exit', num(qgTxt, 'typecheck_v2_exit'), mc.qualityGate?.typecheckV2Exit);
eq('qg.typecheckV2Errors', num(qgTxt, 'typecheck_v2_errors'), mc.qualityGate?.typecheckV2Errors);
eq('qg.eslintExit', num(qgTxt, 'lint_exit'), mc.qualityGate?.eslintExit);
eq('qg.errorCount', qgLint, mc.qualityGate?.errorCount);
eq('qg.warningCount', qgLint, mc.qualityGate?.warningCount);
eq('qg.testExit', num(qgTxt, 'test_exit'), mc.qualityGate?.testExit);
eq('qg.dbqTestExit', num(qgTxt, 'dbq_test_exit'), mc.qualityGate?.dbqTestExit);
eq('qg.buildExit', num(qgTxt, 'build_exit'), mc.qualityGate?.buildExit);
eq('qg.testsPass', (qgTxt.match(/^\s*(\d+) pass$/m) || [])[1] ?? null, mc.qualityGate?.testsPass);
eq('qg.testsFail', (qgTxt.match(/^\s*0 fail$/m) || [])[0] ? '0' : null, mc.qualityGate?.testsFail);

// BA NHAN MAY phai khop doc lap voi ba nguon su khac nhau:
//  (a) ba so nay PHAI xuat hien trong chinh AUDIT-REPORT.md
//  (b) registryHasCount phai khop file JSON artifact (custom-tools-e2e.json)
//  (c) DELETE_handler_count phai khop dem lai truc tiep tren source skills/route.ts
//  (d) build_exit phai khop gate-final.txt
const skillsRoute = readFileSync(join(REPO, 'src/app/api/skills/route.ts'), 'utf8');
const deleteHandlerCount = (skillsRoute.match(/export (?:async function|const) DELETE/g) || []).length;
const getHandlerCount = (skillsRoute.match(/export (?:async function|const) GET/g) || []).length;
const postHandlerCount = (skillsRoute.match(/export (?:async function|const) POST/g) || []).length;
if (!/registryHasCount/.test(md)) problems.push('TEXT_MISSING registryHasCount');
if (!/DELETE_handler_count/.test(md)) problems.push('TEXT_MISSING DELETE_handler_count');
if (!/build_exit=/.test(md)) problems.push('TEXT_MISSING build_exit=');
eq('ui.registryHasCount', ui3?.registryHasCount, mc.ui?.registryHasCount);
eq('ui.registryHasCountInText', String(ui3?.registryHasCount), (md.match(/registryHasCount=(\d+)/) || [])[1]);
eq('src.deleteHandlerCount', deleteHandlerCount, mc.ui?.deleteHandlerCount);
eq('src.deleteHandlerCountInText', String(deleteHandlerCount), (md.match(/DELETE_handler_count=(\d+)/) || [])[1]);
eq('src.skillsHandlers', `GET:${getHandlerCount}/POST:${postHandlerCount}/DELETE:${deleteHandlerCount}`, mc.ui?.skillsHandlers);
eq('qg.buildExitInText', String(num(qgTxt, 'build_exit')), (md.match(/build_exit=(-?\d+)/) || [])[1]);

// --- 4b. §6 issue ledger: TU DEM LAI bang markdown, so voi MACHINE-CHECK.ledger ---
// KHONG tin ca bang §6 len nua: doc chinh text, dem dong / MO / DONG / id MO,
// roi so voi khoa ledger. Xoá 1 dong ledger -> van du dem 9 -> FAIL.
const sec6 = md.split(/## §6\.[^\n]*\n/)[1] || '';
const ledgerRows = sec6.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
const ledOpen = ledgerRows.filter((l) => /\|\s*MỞ\s/.test(l));
const ledClosed = ledgerRows.filter((l) => /\|\s*ĐÓNG\s/.test(l));
const ledOpenIds = ledOpen
  .map((l) => Number((l.match(/^\|\s*(\d+)\s*\|/) || [])[1]))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
P(`LEDGER_ROWS ${ledgerRows.length} open=${ledOpen.length} closed=${ledClosed.length} openIds=${ledOpenIds.join(',')}`);
eq('ledger.rows', ledgerRows.length, mc.ledger?.rows);
eq('ledger.open', ledOpen.length, mc.ledger?.open);
eq('ledger.closed', ledClosed.length, mc.ledger?.closed);
eq('ledger.openIds', ledOpenIds, mc.ledger?.openIds);
// dong tong ket trong §6 cung phai khop (fail-closed khi sua 1 dong bang nhung giu tong)
const ledSum = sec6.match(/Tổng\s+(\d+)\s+dòng ledger:\s*(\d+)\s*MỞ\s*\(([^)]*)\),\s*(\d+)\s*ĐÓNG/);
if (!ledSum) {
  problems.push('LEDGER_SUMMARY_MISSING');
} else {
  eq('ledger.summaryRows', Number(ledSum[1]), ledgerRows.length);
  eq('ledger.summaryOpen', Number(ledSum[2]), ledOpen.length);
  eq('ledger.summaryClosed', Number(ledSum[4]), ledClosed.length);
  eq('ledger.summaryOpenIds', ledSum[3].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)).sort((a, b) => a - b), ledOpenIds);
}

// --- 5. số liệu trong §1-§3 phải khớp nguồn ---
const mustContain = [
  ['MATRIX_ROWS', `${matrix?.rows}`],
  ['MATRIX_PASSED', `${matrix?.passed}`],
  ['MATRIX_FAILED', `${matrix?.failed}`],
  ['FM_TOTAL', `${fm?.failureTotal}`],
  ['FM_GROUPS', `${fm?.groupCount}`],
  ['DBQ_PASS', `${dbq?.pass}/${dbq?.total}`],
  ['FLAG', `dòng ${flagLine}`],
];
for (const [lbl, needle] of mustContain) {
  if (!md.includes(needle)) problems.push(`TEXT_MISSING ${lbl} "${needle}"`);
  else checks.push(lbl);
}

// --- 6. claim "mọi số lấy từ artifact" phải đúng với MACHINE-CHECK ---
if (mc.matrix?.ok !== true || mc.failureMatrix?.reconciles !== true) {
  problems.push('CLAIM_BROKEN ok hoặc reconciles không phải true');
}

P(`CHECKS_PASSED ${checks.length}`);
P(`PROBLEMS ${problems.length}`);
for (const p of problems) P('PROBLEM ' + p);
P(`ok=${problems.length === 0}`);
process.exit(problems.length === 0 ? 0 : 1);
