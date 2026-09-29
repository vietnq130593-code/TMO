#!/usr/bin/env node
/*
 * Kiem thu AM cho validate-report.mjs (fail-closed proof).
 * Moi bien the chay tren BAN SAO trong /tmp — KHONG bao gio chinh AUDIT-REPORT.md.
 * Tien do chi duoc xac nhan khi actual_exit === expect_exit.
 *
 * Luu y: bang §6 va cac bang §3 deu dung dinh dang `| N | ...` nen bien the §6
 * PHAI duoc gioi han trong block `## §6.` truoc khi mutate — neu khong regex se
 * an nham vao dong dang dau tien o §3 va §6 hoan toan khong doi (test vo dung).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPORT = 'AUDIT-REPORT.md';
const VAL = 'audit-out/validate-report.mjs';
const out = [];
const log = (s) => out.push(s);
const KEEP = /SEC4|MISSING|PLACEHOLDER|ok=|PROBLEMS|MISMATCH|CHECKS_PASSED|DBQ_CASES|MC_KEYS|LEDGER/;

/** Mutate CHI trong block §6 (tu `## §6.` den truoc `## ` ke tiep theo). */
function mutateInSec6(s, fn) {
  const start = s.search(/^## §6\./m);
  if (start < 0) return s;
  const tail = s.slice(start);
  const relEnd = tail.slice(1).search(/^## /m);
  const endAbs = relEnd < 0 ? s.length : start + 1 + relEnd;
  const block = s.slice(start, endAbs);
  const mutated = fn(block);
  if (mutated === block) return s; // khong doi -> se bi canh o runVariant
  return s.slice(0, start) + mutated + s.slice(endAbs);
}

function runVariant(name, mutate, expectExit, allowNoMutation = false) {
  const p = `/tmp/neg-${name}.md`;
  const raw = readFileSync(REPORT, 'utf8');
  const src = mutate(raw);
  // allowNoMutation=true chi dung cho baseline (van control) — bien the that
  // khong doi duoc 1 byte nao thi KHONG co bang chung fail-closed, phai FAIL.
  if (src === raw && !allowNoMutation) {
    log(`--- ${name}: expect_exit=${expectExit} actual_exit=NO_MUTATION => FAIL`);
    log('    signals: mutation khong lam doi 1 byte nao — bien the vo dung, KHONG co bang chung fail-closed');
    return false;
  }
  writeFileSync(p, src);
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [VAL, p], { encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? -1;
    stdout = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const pass = code === expectExit;
  log(`--- ${name}: expect_exit=${expectExit} actual_exit=${code} => ${pass ? 'PASS' : 'FAIL'}`);
  log(`    signals: ${stdout.trim().split('\n').filter((l) => KEEP.test(l)).join(' / ')}`);
  return pass;
}

log('===== 10. KIEM THU AM — validator co that su fail-closed? =====');
log('(moi bien the chay tren ban sao /tmp, KHONG sua AUDIT-REPORT.md)');
log('(bien the §6 duoc gioi han trong block "## §6." truoc khi mutate)');
log('');

const results = [];
results.push(['baseline (khong bien doi)', runVariant('baseline', (s) => s, 0, true)]);
results.push([
  '§4 them 1 cau thu hai',
  runVariant('sec4', (s) => s.replace(/(## §4\.[^\n]*\n)/, '$1Một câu thứ hai cố tình thêm.\n'), 1),
]);
results.push([
  'xoa hoan toan §3',
  runVariant('sec3', (s) => s.replace(/## §3\.[\s\S]*?(?=## §4\.)/, ''), 1),
]);
results.push([
  'chen placeholder TODO vao §2',
  runVariant('todo', (s) => s.replace('## §2.', '## §2.\n\nTODO: viết tiếp phần này.'), 1),
]);
results.push([
  'sai so lieu may (matrix.rows 33 -> 34)',
  runVariant('rows', (s) => s.replace('"rows": 33', '"rows": 34'), 1),
]);
// Bien the §6: xoa 1 dong ledger (dong 9 - dang MO) ma GIU nguyen dong tong ket.
// Validator phai FAIL ca bang (rows 9 vs 10) ca dong tong ket (10 vs 9).
results.push([
  '§6 xoa 1 dong ledger (dong 9, dang MO)',
  runVariant('ledger', (s) => mutateInSec6(s, (b) => b.replace(/^\| 9 \|[^\n]*\n/m, '')), 1),
]);
// Bien the §6: doi trang thai 1 dong DONG -> MO (khong doi so dong).
// Validator phai FAIL bang dem MO/DONG va openIds.
results.push([
  '§6 doi trang thai dong 10 ĐÓNG -> MỞ',
  runVariant('ledgerstate', (s) => mutateInSec6(s, (b) => b.replace(/^(\| 10 \| .*\| )ĐÓNG/m, '$1MỞ')), 1),
]);
// Bien the §6: them 1 dong ledger gia (rows 11) — validator phai FAIL bang rows.
results.push([
  '§6 them 1 dong ledger gia (dong 11 ĐÓNG)',
  runVariant('ledgeradd', (s) => mutateInSec6(s, (b) =>
    b.replace(/^(\| 10 \|[^\n]*\n)/m, '$1| 11 | Dong ledger gia them vao | P3-NOISE | may | ĐÓNG — bien the |\n')), 1),
]);

log('');
const failed = results.filter(([, ok]) => !ok);
log(`NEG_TOTAL ${results.length} NEG_FAILED ${failed.length}`);
log('VERDICT: ' + (failed.length === 0
  ? 'PASS — moi bien the am tra exit nhu mong doi (validator fail-closed that)'
  : `FAIL — ${failed.map(([n]) => n).join(', ')}`));
log('');

writeFileSync('audit-out/NEGATIVE-TESTS.txt', out.join('\n'));
console.log(`negative tests: total=${results.length} failed=${failed.length}`);
// Fail-closed: bo kiem thu AM co FAIL thi chinh no phai exit != 0.
process.exit(failed.length === 0 ? 0 : 1);
