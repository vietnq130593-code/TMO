/**
 * resolve-cwd — CANONICAL cwd validator for every child-process call site.
 *
 * Bug (2026-10-13..14): 8+ `ErrorOccurrence` in Neo4j carried
 * `[spawn error: spawn /bin/bash ENOENT]` with cwd `/home/z/tmo-app/E:\APP\TMO-clone`
 * — a Linux path polluted with a Windows drive letter + backslashes.
 * A plain `fs.existsSync()` guard is NOT enough: that malformed directory was
 * literally created on disk, so existence checks passed and spawn kept failing.
 *
 * Call sites (src/lib/code-team/dev-tools.ts:3436, :3687) use the LEGACY shape:
 *     resolveCwd({ requested, base, label })  -> { ok, cwd, message, ... }
 * This module accepts BOTH the legacy and the newer shape so every call site can
 * converge on one helper.
 *
 * Contract: never throws; never returns a relative/empty path; never returns a
 * path outside the allow-list. A bad cwd is downgraded to a safe fallback and a
 * structured log line with a machine-readable reason code is emitted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Machine-readable rejection codes — surfaced in structured logs / Neo4j. */
export type CwdRejectReason =
  | 'EMPTY'
  | 'NULL_BYTE'
  | 'TRAVERSAL'
  | 'DRIVE_LETTER'
  | 'FOREIGN_SEPARATOR'
  | 'RELATIVE_AFTER_RESOLVE'
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'OUTSIDE_ALLOWED_ROOT';

export interface ResolveCwdLegacyOptions {
  /** Raw cwd requested by the caller. */
  requested?: string | null;
  /** Allow-listed root (usually the workspace root). */
  base?: string;
  /** Human label used in messages/logs. */
  label?: string;
}

export interface ResolveCwdOptions {
  /** Newer shape. */
  input?: string | null;
  allowedRoots?: readonly string[];
  fallback?: string;
  requestId?: string;
  callSite?: string;
  logger?: (line: string) => void;
}

export type ResolveCwdInput = ResolveCwdLegacyOptions & ResolveCwdOptions;

export interface ResolveCwdResult {
  /** The cwd value SAFE to pass to spawn(). Always an absolute existing dir. */
  cwd: string;
  /** Alias of `cwd` for call sites that expect `.value` / `.path`. */
  value: string;
  path: string;
  /** false when the requested cwd was rejected and a fallback was used. */
  ok: boolean;
  rejected: boolean;
  /** Human-readable explanation (legacy call sites render this). */
  message: string;
  /** Machine-readable code, only when rejected. */
  reason?: CwdRejectReason;
  /** The offending input, for debugging. */
  raw?: string;
}

const DRIVE_LETTER_RE = /^[a-zA-Z]:[\\/]/;
/** R11 (test "REJECTS the exact malformed production path"): drive-letter segment
 * nằm GIỮA đường dẫn (vd "/home/z/tmo-app/E:\APP\TMO-clone" — đúng dạng bug
 * production) cũng là DRIVE_LETTER (trước đây chỉ khớp prefix → rơi
 * FOREIGN_SEPARATOR → sai reason code cho telemetry). */
const DRIVE_LETTER_SEGMENT_RE = /(?:^|[\\/])[a-zA-Z]:[\\/]?/;
const UNC_RE = /^\\\\/;

const REASON_TEXT: Record<CwdRejectReason, string> = {
  EMPTY: 'cwd rỗng / không được cung cấp',
  NULL_BYTE: 'cwd chứa null byte',
  TRAVERSAL: 'cwd chứa traversal ".."',
  DRIVE_LETTER: 'cwd chứa Windows drive-letter (separator lạ trên POSIX)',
  FOREIGN_SEPARATOR: 'cwd chứa separator "\\" không hợp lệ trên POSIX',
  RELATIVE_AFTER_RESOLVE: 'cwd không resolve được thành đường dẫn tuyệt đối',
  NOT_FOUND: 'cwd không tồn tại trên filesystem',
  NOT_A_DIRECTORY: 'cwd tồn tại nhưng không phải directory',
  OUTSIDE_ALLOWED_ROOT: 'cwd nằm ngoài thư mục gốc được phép',
};

function emit(
  reason: CwdRejectReason,
  raw: string | undefined,
  label: string,
  requestId: string | undefined,
  fallback: string,
  logger?: (l: string) => void,
): void {
  const line = JSON.stringify({
    event: 'cwd_rejected',
    reason,
    callSite: label,
    requestId: requestId ?? null,
    raw: raw ?? null,
    fallback,
  });
  try {
    (logger ?? ((l: string) => console.warn(l)))(line);
  } catch {
    /* logging must never break the caller */
  }
}

function build(
  cwd: string,
  ok: boolean,
  reason: CwdRejectReason | undefined,
  raw: string | undefined,
): ResolveCwdResult {
  return {
    cwd,
    value: cwd,
    path: cwd,
    ok,
    rejected: !ok,
    message: ok ? 'cwd hợp lệ' : `${REASON_TEXT[reason as CwdRejectReason]}`,
    ...(reason ? { reason } : {}),
    ...(raw === undefined ? {} : { raw }),
  };
}

/** First candidate that exists AND is a directory. Last resort os.tmpdir(). */
function safeDefault(candidates: readonly (string | undefined)[]): string {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return path.resolve(c);
    } catch {
      /* keep looking */
    }
  }
  for (const c of [process.cwd(), os.homedir(), os.tmpdir()]) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return path.resolve(c);
    } catch {
      /* keep looking */
    }
  }
  return os.tmpdir();
}

function isDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function abs(p: string): string {
  try {
    return path.resolve(path.normalize(p));
  } catch {
    return '';
  }
}

/**
 * Validate order:
 *  1. non-empty
 *  2. no NUL byte, no `..` segment
 *  3. reject drive-letter / UNC / backslash on POSIX (NEVER silently convert —
 *     silent conversion hides the upstream config bug)
 *  4. normalize + resolve (must be absolute)
 *  5. existsSync
 *  6. statSync().isDirectory
 *  7. containment inside the allow-listed root
 */
export function resolveCwd(opts: ResolveCwdInput = {}): ResolveCwdResult {
  const label = opts.label ?? opts.callSite ?? 'unknown';
  const raw = opts.input !== undefined ? opts.input : opts.requested;
  const roots = (
    opts.allowedRoots ?? (opts.base ? [opts.base] : [process.cwd(), os.homedir(), os.tmpdir()])
  ).filter((r): r is string => typeof r === 'string' && r.length > 0);

  const fallback = safeDefault([
    opts.fallback,
    ...roots,
    process.cwd(),
    os.homedir(),
  ]);

  const rejectWith = (reason: CwdRejectReason, offending?: string) => {
    emit(reason, offending, label, opts.requestId, fallback, opts.logger);
    return build(fallback, false, reason, offending);
  };

  // 1. non-empty
  if (typeof raw !== 'string' || raw.trim() === '') {
    return rejectWith('EMPTY', typeof raw === 'string' ? raw : undefined);
  }
  const trimmed = raw.trim();

  // 2. NUL byte + traversal
  if (trimmed.includes('\0')) return rejectWith('NULL_BYTE', trimmed);
  if (trimmed.split(/[\\/]/).includes('..')) return rejectWith('TRAVERSAL', trimmed);

  // 3. foreign path syntax on POSIX
  if (path.sep === '/') {
    if (DRIVE_LETTER_RE.test(trimmed) || UNC_RE.test(trimmed) || DRIVE_LETTER_SEGMENT_RE.test(trimmed)) {
      return rejectWith('DRIVE_LETTER', trimmed);
    }
    if (trimmed.includes('\\')) return rejectWith('FOREIGN_SEPARATOR', trimmed);
  }

  // 4. normalize + absolutise
  const candidate = abs(trimmed);
  if (!candidate || !path.isAbsolute(candidate)) {
    return rejectWith('RELATIVE_AFTER_RESOLVE', trimmed);
  }
  if (candidate.split(path.sep).includes('..')) return rejectWith('TRAVERSAL', trimmed);

  // 5 + 6. exists and is a directory
  if (!isDir(candidate)) {
    let exists = false;
    try {
      exists = fs.existsSync(candidate);
    } catch {
      exists = false;
    }
    return rejectWith(exists ? 'NOT_A_DIRECTORY' : 'NOT_FOUND', trimmed);
  }

  // 7. containment inside the allow-list
  const normalizedRoots = roots.map(abs).filter(Boolean);
  const contained =
    normalizedRoots.length === 0 ||
    normalizedRoots.some((root) => {
      if (candidate === root) return true;
      const rel = path.relative(root, candidate);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  if (!contained) return rejectWith('OUTSIDE_ALLOWED_ROOT', trimmed);

  return build(candidate, true, undefined, trimmed);
}

/** Convenience wrapper returning just the string. */
export function resolveCwdString(opts: ResolveCwdInput = {}): string {
  return resolveCwd(opts).cwd;
}

export default resolveCwd;