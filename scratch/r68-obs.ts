// scratch/r68-obs.ts — helper quan sát gọn cho jsonl agent-run (r68 — giao thức quan sát + bug.md)
// Dùng: bun scratch/r68-obs.ts <file.jsonl> [fromIndex] [timeline|full <idx>]
// - timeline: mỗi event 1 dòng gọn + tự cờ đỏ các vấn đề quan sát được
// - full <idx>: in nguyên văn event thứ idx (cắt 6000 chars)
import { readFileSync } from 'fs'
const file = process.argv[2]
const from = parseInt(process.argv[3] || '0', 10)
const mode = process.argv[4] || 'timeline'
const lines = readFileSync(file, 'utf8').trim().split('\n')

// Cờ đỏ 1: dạng tool-call (đúng/méo) xuất hiện trong thought
const TOOL_CALL_RE =
  /<(todo_write|file_read|file_write|file_search|grep|glob|shell|git_commit|data_map|browser|knowledge|memory|db_query|\w+_read|\w+_write)[ >{"\]]|todo_write"|invoke name=/

// Cờ đỏ 2: nội dung dài mà không có dấu tiếng Việt
function viRatio(s: string): number {
  const vi = s.match(/[àáạảãâầấậẩẵăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/g)
  const letters = (s.match(/[A-Za-z]/g) || []).length
  return letters > 20 ? (vi?.length ?? 0) / letters : 1
}

if (mode.startsWith('full')) {
  const idx = parseInt(mode.split(' ')[1] || '0', 10)
  console.log(JSON.stringify(JSON.parse(lines[idx]), null, 1).slice(0, 6000))
  process.exit(0)
}

let flags = 0
for (let i = from; i < lines.length; i++) {
  let j: any
  try {
    j = JSON.parse(lines[i])
  } catch {
    console.log(`${i} ✗PARSE-ERR ${lines[i].slice(0, 100)}`)
    flags++
    continue
  }
  const ts = new Date(j.ts).toISOString().slice(11, 19)
  const t = j.type || '?'
  let prev = ''
  let flag = ''
  if (t === 'thought') {
    const c = String(j.text || j.content || j.thought || '')
    prev = c.replace(/\s+/g, ' ').slice(0, 150)
    if (TOOL_CALL_RE.test(c)) flag = ' ⚠️TOOL-CALL-TRONG-THOUGHT'
    const r = viRatio(c)
    if (c.length > 60 && r < 0.01) flag += ` ⚠️KHÔNG-DẤU-TIẾNG-VIỆT(r=${r.toFixed(3)})`
  } else if (t === 'tool') {
    prev = `${j.tool}(${JSON.stringify(j.args ?? j.arguments ?? {}).slice(0, 80)})`
  } else if (t === 'tool_result' || t === 'toolResult') {
    prev = String(JSON.stringify(j.result ?? j.output ?? '')).slice(0, 90)
  } else if (t === 'run_end' || t === 'error') {
    prev = JSON.stringify(j).slice(0, 200)
    flag = ' 🛑'
  } else {
    prev = JSON.stringify(j).slice(0, 100)
  }
  if (flag) flags++
  console.log(
    `${String(i).padStart(3)} ${ts} ${(t + (j.iteration !== undefined ? '·it' + j.iteration : '')).padEnd(14)}${flag} ${prev}`
  )
}
console.log(`--- events ${from}..${lines.length - 1} · cờ đỏ: ${flags}`)
