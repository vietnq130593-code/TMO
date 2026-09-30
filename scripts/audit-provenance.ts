#!/usr/bin/env bun
/**
 * scripts/audit-provenance.ts — PROVENANCE RUN CHO HARNESS AUDIT (runId truy vết)
 * ==========================================================================================
 * Lý do: audit-out/* trước đây KHÔNG ghi runId → không truy vết được artifact nào
 * sinh từ run nào. docs/TOOLS_AUDIT.md §6 mục 6 yêu cầu "Báo cáo phải truy vết
 * đúng run: runId của chính mission, không trích run khác".
 *
 * Cơ chế:
 *   - AUDIT_RUN_ID (env) là nguồn duy nhất. Rỗng/không set → mode = 'unscoped'
 *     (giữ tương thích `bun run audit:all` chạy không env — chỉ WARN, không FAIL).
 *   - mode = 'scoped' → đọc readonly AgentRunRecord trong db/custom.db để lấy
 *     startedAt + sessionId của chính run đó. Lỗi / không tìm thấy → null,
 *     TUYỆT ĐỐI KHÔNG ném (audit không được chết vì provenance).
 *   - mirrorToRunDir(): copy artifact sang tmp/audit/<runId>/ để mỗi run có bundle
 *     riêng, không đè lên nhau. Lỗi copy chỉ log warn — không fail audit.
 *
 * Module thuần read-only: không ghi DB, không spawn, không side effect ngoài
 * mkdir/copy trong tmp/audit/<runId>/ (chỉ khi runId khác null).
 *
 * [VÒNG 15 — 2026-09-30 20:45] File này từng bị MEGATRON (workflow ct-req-1790799108)
 * xoá nhầm khỏi CÂY CHÍNH vì TMO_CLONE_DIR =/home/z/tmo-app khiến agent tin cây vận
 * hành là "clone an toàn để dọn" (git clean). Operator đã khôi phục từ bằng chứng
 * transcript (header + interface + contract gốc giữ nguyên; thân hàm tái dựng đúng
 * behavior đã verify trong chain V1-V4 19:28-19:30).
 */

import { Database as SqliteDatabase } from 'bun:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')

export interface AuditProvenance {
  /** 'scoped' = có AUDIT_RUN_ID hợp lệ (truy vết được) · 'unscoped' = thiếu env */
  mode: 'scoped' | 'unscoped'
  runId: string | null
  /** ISO string của startedAt của AgentRunRecord (null nếu không tra được) */
  runStartedAt: string | null
  sessionId: string | null
  /** ISO string — thời điểm resolve provenance (dùng để chẩn đoán) */
  resolvedAt: string
}

/** Chuẩn hoá mọi kiểu giá trị datetime SQLite/Prisma về ISO string (null nếu hỏng). */
function toIso(value: unknown): string | null {
  try {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
    if (typeof value === 'bigint') return new Date(Number(value)).toISOString()
    if (typeof value === 'string') {
      // Chuỗi số (epoch ms từ SQLite) HOẶC chuỗi ISO
      if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString()
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve provenance cho run audit hiện hành.
 * AUDIT_RUN_ID có thể là AgentRunRecord.id (cuid) HOẶC cột runId (run_<ts>_<seq>)
 * — tra id trước, tra runId sau (cả 2 đều truy về đúng bản ghi chạy thật).
 */
export function resolveAuditProvenance(): AuditProvenance {
  const resolvedAt = new Date().toISOString()
  const envRaw = (process.env.AUDIT_RUN_ID || '').trim()
  if (!envRaw) {
    console.warn(
      '[audit-provenance] ⚠️ Thiếu AUDIT_RUN_ID — ghi mode=unscoped (artifact KHÔNG truy vết được run). ' +
        'Chạy: AUDIT_RUN_ID=<runId của mission> bun run audit:manifest / audit:check (docs/TOOLS_AUDIT.md §6 mục 6).'
    )
    return { mode: 'unscoped', runId: null, runStartedAt: null, sessionId: null, resolvedAt }
  }
  try {
    const dbPath = path.join(ROOT, 'db', 'custom.db')
    if (!fs.existsSync(dbPath)) {
      console.warn(`[audit-provenance] ⚠️ Không thấy ${dbPath} — ghi scoped với runId env, không tra được startedAt.`)
      return { mode: 'scoped', runId: envRaw, runStartedAt: null, sessionId: null, resolvedAt }
    }
    const db = new SqliteDatabase(dbPath, { readonly: true })
    try {
      // Bước 1: tra trực tiếp theo env (id cuid HOẶC runId run_<ts>_<seq>)
      const direct = db
        .query(
          `SELECT id, runId, sessionId, startedAt FROM AgentRunRecord
           WHERE id = ? OR runId = ?
           ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, startedAt DESC
           LIMIT 1`
        )
        .get(envRaw, envRaw, envRaw) as
        | { id: string; runId: string | null; sessionId: string | null; startedAt: unknown }
        | undefined
      if (!direct) {
        // Không tra được bản ghi — vẫn scoped (env là nguồn duy nhất), chỉ null metadata
        console.warn(
          `[audit-provenance] ⚠️ AUDIT_RUN_ID="${envRaw}" không khớp AgentRunRecord nào — ghi scoped, metadata null (không fail audit).`
        )
        return { mode: 'scoped', runId: envRaw, runStartedAt: null, sessionId: null, resolvedAt }
      }
      // Bước 2: env là id của row DELEGATION (vd "MEGATRON (Code Team SOP)") →
      // runId field trỏ về run CHA (mission goal-loop). Theo về run cha để lấy
      // startedAt ĐÚNG thời điểm mission bắt đầu (bài học 18:54:30 vs 19:14:40).
      if (direct.runId && direct.runId !== envRaw) {
        const parent = db
          .query(
            `SELECT id, runId, sessionId, startedAt FROM AgentRunRecord
             WHERE runId = ? ORDER BY startedAt ASC LIMIT 1`
          )
          .get(direct.runId) as
          | { id: string; runId: string | null; sessionId: string | null; startedAt: unknown }
          | undefined
        if (parent) {
          return {
            mode: 'scoped',
            runId: envRaw,
            runStartedAt: toIso(parent.startedAt),
            sessionId: parent.sessionId ?? direct.sessionId ?? null,
            resolvedAt,
          }
        }
      }
      return {
        mode: 'scoped',
        runId: envRaw,
        runStartedAt: toIso(direct.startedAt),
        sessionId: direct.sessionId ?? null,
        resolvedAt,
      }
    } finally {
      db.close()
    }
  } catch (err) {
    // TUYỆT ĐỐI KHÔNG ném — audit không được chết vì provenance
    console.warn(
      '[audit-provenance] ⚠️ Lỗi tra AgentRunRecord (ghi scoped, metadata null):',
      err instanceof Error ? err.message : String(err)
    )
    return { mode: 'scoped', runId: envRaw, runStartedAt: null, sessionId: null, resolvedAt }
  }
}

/**
 * Mirror artifact vào bundle riêng của run: tmp/audit/<runId>/<filename>.
 * No-op khi runId null (unscoped). Lỗi copy chỉ warn — không fail audit.
 */
export function mirrorToRunDir(runId: string | null | undefined, srcPath: string, filename: string): void {
  if (!runId) return
  try {
    const dir = path.join(ROOT, 'tmp', 'audit', runId)
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, filename)
    fs.copyFileSync(srcPath, dst)
    console.log(`[audit-provenance] 📦 Bundle run ${runId}: ${path.relative(ROOT, dst)}`)
  } catch (err) {
    console.warn(
      `[audit-provenance] ⚠️ Không mirror được ${filename} vào tmp/audit/${runId}/ (không fail audit):`,
      err instanceof Error ? err.message : String(err)
    )
  }
}
