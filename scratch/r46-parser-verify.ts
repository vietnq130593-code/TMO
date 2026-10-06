/**
 * ROUND-46 verification — parser fixes 5a/5b/5c/5d trong src/lib/tool-calls.ts
 * Chạy: bun scratch/r46-parser-verify.ts
 */
import { extractToolCallsWithDiagnostics } from '../src/lib/tool-calls'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

// ── 5a: invoke lồng trong args của invoke trước KHÔNG bị parse 2 lần ──
console.log('5a — embedded invoke không double-parse:')
{
  // Agent viết file hướng dẫn chứa VÍ DỤ invoke shell (text trong args)
  const out = `<invoke name="todo_write">{"todos":[{"content":"Viết docs hướng dẫn tool-call <invoke name=\\"shell\\">{\\"cmd\\":\\"rm -rf /\\":</invoke> dạng văn bản","status":"pending"}]}</invoke>`
  const r = extractToolCallsWithDiagnostics(out)
  ok('chỉ 1 call (todo_write) — không execute invoke shell nhúng', r.calls.length === 1, `got ${r.calls.length}: ${r.calls.map(c => c.name).join(',')}`)
  ok('call duy nhất là todo_write', r.calls[0]?.name === 'todo_write')
  // args chứa đủ chuỗi ví dụ (không bị nuốt)
  const first = r.calls[0]?.args as { todos?: { content?: string }[] }
  ok('args giữ nguyên nội dung (chuỗi ví dụ không mất)', String(first?.todos?.[0]?.content || '').includes('rm -rf'))
}
{
  // XML form: <invoke name="file_write"><path>docs.md</path><content>...ví dụ invoke lồng...</content></invoke>
  const out2 = `<invoke name="file_write"><path>/tmp/docs.md</path><content>## Cách gọi tool\n<invoke name="shell">{"cmd":"echo hi"}</invoke>\nđây là ví dụ trong docs</content></invoke>`
  const r2 = extractToolCallsWithDiagnostics(out2)
  ok('XML form: chỉ 1 call file_write — invoke ví dụ trong content bị bỏ qua', r2.calls.length === 1 && r2.calls[0].name === 'file_write', `got ${r2.calls.length}: ${r2.calls.map(c => c.name).join(',')}`)
  // ROUND-46 vòng 2 (de-vacuous): JSON form — invoke ví dụ KHÔNG escape (name=shell
  // không có quote + args XML → JSON ngoài vẫn VALID, regex vẫn match được nhúng)
  const out3 = '<invoke name="todo_write">{"todos":[{"content":"Docs: gọi <invoke name=shell><cmd>echo hi</cmd></invoke> là ví dụ, đừng chạy","status":"pending"}]}</invoke>'
  const r3 = extractToolCallsWithDiagnostics(out3)
  ok('JSON form (unquoted embedded): 1 call todo_write — invoke ví dụ KHÔNG execute', r3.calls.length === 1 && r3.calls[0].name === 'todo_write', `got ${r3.calls.length}: ${r3.calls.map(c => c.name).join(',')}`)
  // ROUND-46 vòng 2: args JSON HỎNG chứa ví dụ invoke → shadow range phải chặn
  const out4 = '<invoke name="file_write">{"path":"/tmp/x.md","content":"Ví dụ: <invoke name=shell><cmd>rm -rf /</cmd></invoke> trong chuỗi có dấu \" kép hỏng JSON"}';
  const r4 = extractToolCallsWithDiagnostics(out4)
  ok('JSON hỏng chứa invoke ví dụ → KHÔNG parse shell thay thế (shadow range)', r4.calls.every(c => c.name !== 'shell'), `calls: ${r4.calls.map(c => c.name).join(',') || '(none)'}`)
}

// ── 5b: single-item XML todos → parser cho object 1-key (consumer normalize) ──
console.log('5b — single-item XML todos shape:')
{
  const out = `<invoke name="todo_write"><todos><item>Một việc duy nhất cần làm</item></todos></invoke>`
  const r = extractToolCallsWithDiagnostics(out)
  ok('1 call todo_write', r.calls.length === 1 && r.calls[0].name === 'todo_write')
  const todos = (r.calls[0]?.args as { todos?: unknown })?.todos
  ok('todos là object 1-key {item: string} (đúng dạng consumer normalize)', !!todos && typeof todos === 'object' && !Array.isArray(todos) && Object.keys(todos as object).length === 1, JSON.stringify(todos))
  // 2 items vẫn ra array như cũ
  const out2 = `<invoke name="todo_write"><todos><item>Việc A</item><item>Việc B</item></todos></invoke>`
  const r2 = extractToolCallsWithDiagnostics(out2)
  const todos2 = (r2.calls[0]?.args as { todos?: unknown })?.todos
  ok('2 items → array 2 phần tử (không hồi quy)', Array.isArray(todos2) && todos2.length === 2, JSON.stringify(todos2))
}

// ── 5c: id duy nhất khi fence + invoke cùng output / cùng ms ──
console.log('5c — id không trùng:')
{
  const out = 'tool_call: file_write({"path":"/tmp/a.txt"})\n```\nNỘI DUNG FILE A\n```\n<invoke name="file_write"><path>/tmp/b.txt</path><content>NỘI DUNG B</content></invoke>'
  const r = extractToolCallsWithDiagnostics(out)
  ok('2 calls (fence + invoke)', r.calls.length >= 2, `got ${r.calls.length}`)
  const ids = r.calls.map(c => c.id)
  ok('id đều khác nhau', new Set(ids).size === ids.length, ids.join(', '))
}

// ── 5d: open_workspace + git_clone được công nhận (pattern-2/invoke) ──
console.log('5d — whitelist đủ tool:')
{
  const out = `<invoke name="open_workspace"><path>/home/z/tmo-app</path></invoke>`
  const r = extractToolCallsWithDiagnostics(out)
  ok('open_workspace qua invoke được parse', r.calls.length === 1 && r.calls[0].name === 'open_workspace', JSON.stringify(r.calls.map(c => c.name)))
  const out2 = `<invoke name="functions.git_clone">{"url":"https://github.com/x/y"}</invoke>`
  const r2 = extractToolCallsWithDiagnostics(out2)
  ok('git_clone (prefix functions.) qua invoke JSON được parse', r2.calls.length === 1 && r2.calls[0].name === 'git_clone', JSON.stringify(r2.calls.map(c => c.name)))
}

// ── Regression: các dạng cũ vẫn parse (round-44) ──
console.log('Regression — dạng cũ round-44:')
{
  const r = extractToolCallsWithDiagnostics('tool_call: shell({"cmd":"ls -la"})')
  ok('pattern-1 tool_call: shell({...})', r.calls.length === 1 && r.calls[0].name === 'shell')
  const r2 = extractToolCallsWithDiagnostics('Nãy giờ tôi sẽ đọc file. file_read({"path":"/tmp/x.ts"})')
  ok('pattern-2 direct invocation', r2.calls.length === 1 && r2.calls[0].name === 'file_read')
  const r3 = extractToolCallsWithDiagnostics('<invoke name="todo_write"><todos><item>A</item><item>B</item></todos></invoke>')
  ok('invoke XML multi-item vẫn parse', r3.calls.length === 1 && Array.isArray((r3.calls[0].args as { todos?: unknown[] }).todos))
  const r4 = extractToolCallsWithDiagnostics('}<]minimax[>[tool_call: shell({"cmd":"echo ok"})')
  ok('marker corruption strip trước parse vẫn hoạt động', r4.calls.length === 1 && r4.calls[0].name === 'shell')
}

// ── ROUND-46 vòng 2b: shadow range KHÔNG cắt cleaned — pattern-1 trong vùng
// invoke parse-fail vẫn được phục hồi (mixed-format recovery giữ hành vi cũ)
console.log('2b — shadow range không chặn pattern-1 recovery:')
{
  const out = '<invoke name="file_write">{"path":"/tmp/x.md","content":"dấu \" kép hỏng JSON"}' + '\n' + 'tool_call: shell({"cmd":"echo recovered"})'
  const r = extractToolCallsWithDiagnostics(out)
  ok('invoke hỏng không nuốt dòng tool_call: pattern-1 lân cận vẫn parse được', r.calls.some(c => c.name === 'shell' && (c.args as { cmd?: string }).cmd === 'echo recovered'), `calls: ${r.calls.map(c => c.name).join(',') || '(none)'}`)
  ok('invoke hỏng không execute nhúng (shadow chặn matched invoke trong vùng hỏng)', r.calls.every(c => c.name !== 'file_write' || JSON.stringify(c.args).includes('x.md')))
}

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
