/**
 * sanitizeEnvPath — chuẩn hóa + kiểm định đường dẫn lấy từ biến môi trường
 * TRƯỚC khi dùng làm `cwd` cho spawn/exec hoặc làm workspace root.
 *
 * BUG-2026-10-14 (spawn /bin/bash ENOENT lặp): file cấu hình môi trường của máy
 * dev chứa TMO_DEFAULT_WORKSPACE=E:\APP\TMO-clone và TMO_CLONE_DIR=E:\APP\TMO-clone
 * — đường dẫn Windows bị commit vào repo. Trên Linux chuỗi này KHÔNG phải
 * absolute path; path.resolve() gộp nó với process.cwd() tạo ra
 * "/home/z/tmo-app/E:\APP\TMO-clone" — một thư mục LITERAL có dấu backslash.
 * spawn('/bin/bash', { cwd }) với cwd đó ném `spawn /bin/bash ENOENT`, lặp lại
 * mang tính hệ thống (mỗi lần bootstrap lại lại ghi giá trị hỏng vào DB).
 *
 * NGUYÊN TẮC: KHÔNG đoán/sửa — chỉ chuẩn hóa an toàn rồi từ chối. Giá trị sai
 * trả `path: null` + warnings để caller no-op (đúng hành vi sẵn có của
 * ensureDefaultWorkspace khi env rỗng) thay vì mkdir thêm thư mục rác.
 *
 * Blast radius: đây là CHẶN CỬA DUY NHẤT cho mọi call site đọc workspace path
 * từ biến môi trường. Không bypass.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

/** "C:\x" hoặc "C:/x" — absolute path kiểu Windows. */
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/
/** "\\server\share" — UNC path. */
const UNC_RE = /^\\\\/

export interface SanitizedEnvPathResult {
  /** Đường dẫn đã resolve + đã kiểm định tồn tại & là directory; null nếu không dùng được. */
  path: string | null
  warnings: string[]
}

/**
 * @param raw   giá trị biến môi trường thô (chưa trim)
 * @param label tên biến để hiện trong log cảnh báo
 */
export function sanitizeEnvPath(
  raw: string | undefined | null,
  label = 'env path'
): SanitizedEnvPathResult {
  const warnings: string[] = []
  const reject = (reason: string): SanitizedEnvPathResult => {
    warnings.push(
      `[${label}] BỎ QUA giá trị "${raw}" — ${reason}. ` +
        `Trên Linux phải dùng đường dẫn POSIX tuyệt đối, ví dụ /home/<user>/TMO-clone.`
    )
    return { path: null, warnings }
  }

  let value = (raw || '').trim()
  if (!value) return { path: null, warnings }

  // (1) NUL byte — luôn đuôi mọi API path.
  if (value.indexOf('\0') !== -1) return reject('chứa ký tự NUL')

  // (2) Bỏ dấu nháy bao quanh (đôi khi còn sót trong file cấu hình).
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim()
    if (!value) return { path: null, warnings }
  }

  // (3) CHẶN WINDOWS-PATH LỌT VÀO POSIX — nguyên nhân gốc của ENOENT.
  //    Trên Linux "E:\APP\TMO-clone" là tên thư mục HỢP LỆ về mặt ký tự,
  //    nên path.resolve KHÔNG báo lỗi — nó chỉ âm thầm tạo ra path sai.
  if (path.sep === '/') {
    if (WINDOWS_ABS_RE.test(value) || UNC_RE.test(value)) {
      return reject('là đường dẫn WINDOWS (kèm separator backslash) không dùng được trên POSIX')
    }
    if (value.indexOf('\\') !== -1) {
      return reject('chứa separator backslash kiểu Windows; hãy dùng dấu "/" trên Linux')
    }
  }

  // (3b) Đường dẫn trộn cả hai kiểu separator — canonicalize về "/".
  value = value.replace(/\\/g, path.sep)

  // (4) Mở rộng "~" — tránh tạo thư mục rác tên "~".
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (value === '~') {
    if (!home) return reject('dùng "~" nhưng không có biến HOME/USERPROFILE')
    value = home
  } else if (value.slice(0, 2) === '~/') {
    if (!home) return reject('dùng "~/..." nhưng không có biến HOME/USERPROFILE')
    value = home + value.slice(1)
  }

  // (5) Phải là absolute — relative phụ thuộc cwd của process (nguồn lỗi
  //     "path phụ thuộc nơi chạy"), và cũng là cửa để Windows path lọt vào.
  if (!path.isAbsolute(value)) {
    return reject('không phải đường dẫn tuyệt đối (relative path phụ thuộc cwd của process)')
  }

  // (6) Resolve + kiểm tra tỒN TẠI THẬT trên đĩa trước khi ai đó spawn vào đó.
  const resolved = path.resolve(value)
  let stat
  try {
    stat = statSync(resolved)
  } catch {
    return reject('đường dẫn không tồn tại trên đĩa (resolved: ' + resolved + ')')
  }
  if (!stat.isDirectory()) {
    return reject('không phải thư mục (resolved: ' + resolved + ')')
  }

  return { path: resolved, warnings }
}
