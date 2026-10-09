/**
 * Smolab Chat Attachments — helpers phân loại/sanitize tệp đính kèm (r73).
 *
 * Tách ra lib (không nằm trong route) để:
 *   (1) unit-test trực tiếp (route file chỉ export HTTP handlers — Next.js
 *       không cho export tùy tiện),
 *   (2) tái dùng nếu sau này cần attachment ở module khác.
 *
 * HARDCODE (nguyên tắc hardcode > prompt — chặn ở tầng mã, không dạy):
 *   - Tên tệp: strip path traversal + ký tự điều khiển, cap 120 ký tự
 *   - Đuôi mở rộng → MIME fallback (không tin MIME client một mình)
 *   - kind: image | audio | video | text | pdf | docx | other
 */

import path from 'path'

export const SMOLAB_ATTACHMENT_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml', 'xml',
  'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'sql',
  'toml', 'ini', 'cfg', 'conf',
])

export const SMOLAB_ATTACHMENT_EXT_MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  py: 'text/x-python', sh: 'text/x-sh', bash: 'text/x-sh', sql: 'application/sql',
  toml: 'text/toml', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
  mp4: 'video/mp4', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export interface SmolabAttachmentKindResult {
  kind: 'image' | 'audio' | 'video' | 'text' | 'pdf' | 'docx' | 'other'
  ext: string
  mime: string
}

/** MIME generic — coi như "client không cung cấp MIME" (curl/API client hay
 * gửi octet-stream) → phân loại theo ĐUÔI hardcode thay vì tin nó. */
const GENERIC_CLIENT_MIMES = new Set(['', 'application/octet-stream', 'application/binary'])

/** Phân loại tệp theo đuôi + MIME — đuôi (hardcode) thắng MIME client bịa
 * hoặc generic (octet-stream). */
export function classifySmolabAttachment(fileName: string, mimeType: string): SmolabAttachmentKindResult {
  const safeName = (fileName || '').toLowerCase()
  const ext = safeName.includes('.') ? safeName.split('.').pop()! : ''
  const clientMime = (mimeType || '').trim()
  const mime = clientMime.includes('/') && !GENERIC_CLIENT_MIMES.has(clientMime.toLowerCase())
    ? clientMime
    : (SMOLAB_ATTACHMENT_EXT_MIME[ext] || 'application/octet-stream')
  let kind: SmolabAttachmentKindResult['kind'] = 'other'
  if (ext === 'pdf' || mime === 'application/pdf') kind = 'pdf'
  else if (ext === 'docx') kind = 'docx'
  else if (mime.startsWith('image/')) kind = 'image'
  else if (mime.startsWith('audio/')) kind = 'audio'
  else if (mime.startsWith('video/')) kind = 'video'
  else if (mime.startsWith('text/') || SMOLAB_ATTACHMENT_TEXT_EXTS.has(ext)) kind = 'text'
  return { kind, ext, mime }
}

/** Sanitize tên hiển thị: strip path + ký tự nguy hiểm, cap 120 ký tự. */
export function sanitizeSmolabAttachmentName(name: string): string {
  const base = path.basename(name || 'file')
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*\\]/g, '_').trim()
  return (cleaned || 'file').slice(0, 120)
}

/** Cap văn bản chưng cất — kèm marker cắt để agent biết đọc bản gốc. */
export function capSmolabAttachmentText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  const t = s.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…[đã cắt tại ${max} ký tự — bản đầy đủ nằm trong tệp gốc]`
}
