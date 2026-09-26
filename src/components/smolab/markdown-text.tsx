'use client'

// ========================================================================
// markdown-text — MarkdownText: renderer markdown NHẸ cho nội dung báo cáo
// agent (Task 23-a). KHÔNG dependency ngoài, KHÔNG dangerouslySetInnerHTML
// (React tự escape text — an toàn XSS). Text thuần không markdown render ra
// đúng y hệt <p whitespace-pre-wrap> cũ (giữ line break + blank line).
// Hỗ trợ đủ dùng cho báo cáo agents: fence code block, heading, **bold**,
// `code`, *italic* (quy tắc chặt), list ul/ol, [link](http…).
// ========================================================================

import React from 'react'

// ==================== BLOCK PARSING ====================

/** 1 khối markdown sau khi tách theo dòng: code fence / heading / list / bảng / đoạn văn */
type Block =
  | { type: 'code'; content: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'ulist'; items: string[] }
  | { type: 'olist'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'para'; text: string }

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+)$/
const ULIST_RE = /^\s{0,3}[-*]\s+(.+)$/
const OLIST_RE = /^\s{0,3}\d{1,9}\.\s+(.+)$/
// Bảng pipe: dòng |...| + dòng phân cách |---|---| (cho phép :---:)
const TABLE_ROW_RE = /^\s{0,3}\|.*\|\s*$/
const TABLE_SEP_RE = /^\s{0,3}\|[\s:|-]+\|\s*$/

/** Tách 1 dòng bảng |a|b|c| → ['a','b','c'] (bỏ ống đầu/cuối, trim từng ô) */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

/** Dòng fence đóng: toàn bộ là ký tự fence cùng loại, dài bằng fence mở */
function isClosingFence(line: string, marker: string, openLen: number): boolean {
  const t = line.trim()
  return t.length >= openLen && t[0] === marker && [...t].every(c => c === marker)
}

/** Tách content thành block theo dòng — fence ưu tiên cao nhất, list gom nhóm liên tiếp */
function parseBlocks(content: string): Block[] {
  const lines = content.split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  // Đóng đoạn văn đang mở: bỏ dòng trống 2 ĐẦU/CUỐI (khoảng cách do margin khối
  // lo), nhưng GIỮ nguyên dòng trống ở GIỮA → text thuần hiển thị y như trước.
  const flushPara = () => {
    while (para.length && /^\s*$/.test(para[0])) para.shift()
    while (para.length && /^\s*$/.test(para[para.length - 1])) para.pop()
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') })
    para = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 1. Fence code block: ``` hoặc ~~~ (phần sau fence trên dòng mở là info
    //    string như ```ts — bỏ đi, không thuộc nội dung code)
    const fence = line.match(FENCE_RE)
    if (fence) {
      flushPara()
      const marker = fence[1][0]
      const openLen = fence[1].length
      const body: string[] = []
      i++
      while (i < lines.length && !isClosingFence(lines[i], marker, openLen)) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // bỏ qua dòng fence đóng (nếu có — EOF vẫn hợp lệ)
      blocks.push({ type: 'code', content: body.join('\n') })
      continue
    }

    // 2. Heading: # → ###### (yêu cầu space sau #; ### trở xuống cỡ text-xs)
    const heading = line.match(HEADING_RE)
    if (heading) {
      flushPara()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    // 2.5. Bảng pipe (Task 23-c fix #2 — E2E run 4 lộ bảng render thô): dòng
    //     header |...| + dòng phân cách |---| → gom body đến khi hết dòng |
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara()
      const header = splitTableRow(line)
      i += 2 // bỏ header + dòng phân cách
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    // 3+4. List: dòng liên tiếp `- `/`* ` (ul) hoặc `1. `/`2. `… (ol) —
    //      dòng khác loại hoặc trống thì hết list
    const ulMatch = line.match(ULIST_RE)
    const olMatch = ulMatch ? null : line.match(OLIST_RE)
    if (ulMatch || olMatch) {
      flushPara()
      const isUl = Boolean(ulMatch)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(isUl ? ULIST_RE : OLIST_RE)
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push(isUl ? { type: 'ulist', items } : { type: 'olist', items })
      continue
    }

    // 5. Còn lại: góp vào đoạn văn (blank line ở giữa được giữ)
    para.push(line)
    i++
  }
  flushPara()
  return blocks
}

// ==================== INLINE PARSING ====================

/** Ký tự "từ" — dùng cho boundary check của _italic_ / __bold__ (chống nuốt snake_case) */
const WORD_CHAR = /[A-Za-z0-9_]/

/**
 * Render markdown inline của 1 đoạn text: quét trái→phải theo vị trí xuất hiện,
 * ưu tiên: `code` → **bold** → [link](url) → *italic*. Nội dung code span là
 * literal (không parse tiếp). Text không match gì → giữ nguyên chuỗi gốc.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let plain = ''
  let i = 0
  let seq = 0

  const flush = () => {
    if (plain !== '') {
      nodes.push(plain)
      plain = ''
    }
  }
  const push = (node: React.ReactElement) => {
    flush()
    nodes.push(<React.Fragment key={`${keyPrefix}-${seq++}`}>{node}</React.Fragment>)
  }

  while (i < text.length) {
    const ch = text[i]

    // `code` — nội dung literal, KHÔNG parse markdown bên trong
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        let inner = text.slice(i + 1, end)
        if (!inner.includes('\n')) {
          // CommonMark: bỏ 1 space 2 đầu nếu có (`` ` x ` `` → `x`)
          if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
            inner = inner.slice(1, -1)
          }
          push(<code className="text-[0.9em] font-mono bg-stone-800/80 text-emerald-300 px-1 py-px">{inner}</code>)
          i = end + 1
          continue
        }
      }
      plain += ch
      i++
      continue
    }

    // **bold** / __bold__ — __ thêm boundary 2 bên (chống nuốt some__var__name)
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const close = text.indexOf(ch + ch, i + 2)
      const inner = close === -1 ? '' : text.slice(i + 2, close)
      if (close !== -1 && inner !== '' && !inner.includes('\n')) {
        const prev = i > 0 ? text[i - 1] : ''
        const next = close + 2 < text.length ? text[close + 2] : ''
        if (ch === '*' || (!WORD_CHAR.test(prev) && !WORD_CHAR.test(next))) {
          push(
            <strong className="font-semibold text-stone-50">
              {renderInline(inner, `${keyPrefix}-b${seq}`)}
            </strong>
          )
          i = close + 2
          continue
        }
      }
      // không đóng được / sai boundary → rơi xuống nhánh italic đơn hoặc literal
    }

    // [text](http…) — chỉ nhận URL http/https (không javascript:…), mở tab mới
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        const url = closeParen === -1 ? '' : text.slice(closeBracket + 2, closeParen)
        if (closeParen !== -1 && /^https?:\/\//.test(url) && !/\s/.test(url)) {
          const linkText = text.slice(i + 1, closeBracket)
          push(
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">
              {renderInline(linkText, `${keyPrefix}-a${seq}`)}
            </a>
          )
          i = closeParen + 1
          continue
        }
      }
      plain += ch
      i++
      continue
    }

    // *italic* / _italic_ — quy tắc CHẶT:
    //   • nội dung không space ở 2 đầu, không chứa \n
    //   • `_`: 2 bên phải là boundary + nội dung KHÔNG chứa `_` (chống snake_case some_var_name)
    //   • `*`: boundary 2 bên (chống nuốt phép nhân 2*3*4, ký tự * rơi vãi)
    if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1)
      const inner = end === -1 ? '' : text.slice(i + 1, end)
      if (end > i + 1 && inner !== '' && !inner.includes('\n')) {
        const prev = i > 0 ? text[i - 1] : ''
        const next = end + 1 < text.length ? text[end + 1] : ''
        const boundaryOk = !WORD_CHAR.test(prev) && !WORD_CHAR.test(next)
        const innerOk = ch === '*' || !inner.includes('_')
        if (boundaryOk && innerOk && !/^\s|\s$/.test(inner)) {
          push(<em className="italic">{renderInline(inner, `${keyPrefix}-i${seq}`)}</em>)
          i = end + 1
          continue
        }
      }
      plain += ch
      i++
      continue
    }

    plain += ch
    i++
  }

  flush()
  return nodes
}

// ==================== COMPONENT ====================

/** Render 1 block đã parse — heading đầu tiên (block 0) không có margin-top */
function renderBlock(block: Block, index: number, key: number): React.ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre key={key} className="bg-slate-950/80 border border-stone-700/50 p-2 my-1 text-[0.85em] font-mono text-stone-300 overflow-x-auto whitespace-pre custom-scrollbar">
          {block.content}
        </pre>
      )
    case 'heading': {
      // # và ## → text-sm; ### trở xuống → text-xs
      const size = block.level <= 2 ? 'text-sm' : 'text-xs'
      return (
        <div key={key} className={`font-semibold text-stone-100 ${size} mb-1${index === 0 ? '' : ' mt-2'}`}>
          {renderInline(block.text, `h${key}`)}
        </div>
      )
    }
    case 'ulist':
      return (
        <ul key={key} className="list-disc list-inside space-y-0.5 my-1">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item, `u${key}-${j}`)}</li>
          ))}
        </ul>
      )
    case 'olist':
      return (
        <ol key={key} className="list-decimal list-inside space-y-0.5 my-1">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item, `o${key}-${j}`)}</li>
          ))}
        </ol>
      )
    case 'table':
      return (
        <div key={key} className="my-1 overflow-x-auto custom-scrollbar">
          <table className="w-full border-collapse text-[0.92em]">
            <thead>
              <tr>
                {block.header.map((cell, j) => (
                  <th key={j} className="border border-stone-700/60 bg-stone-800/50 px-2 py-1 text-left font-semibold text-stone-200 whitespace-nowrap">
                    {renderInline(cell, `th${key}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, j) => (
                    <td key={j} className="border border-stone-700/40 px-2 py-1 text-stone-300">
                      {renderInline(cell, `td${key}-${r}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'para':
      return (
        <p key={key} className="whitespace-pre-wrap">{renderInline(block.text, `p${key}`)}</p>
      )
  }
}

export interface MarkdownTextProps {
  content: string
  className?: string
}

/**
 * MarkdownText — hiển thị nội dung báo cáo agent: markdown render sạch (bold,
 * code, heading, list, link), text thuần giữ nguyên line break / blank line
 * như <p whitespace-pre-wrap> cũ. className đặt cỡ chữ / màu nền cho toàn bộ.
 */
export default function MarkdownText({ content, className }: MarkdownTextProps) {
  const blocks = React.useMemo(() => parseBlocks(content), [content])
  return (
    <div className={className}>
      {blocks.map((block, i) => renderBlock(block, i, i))}
    </div>
  )
}
