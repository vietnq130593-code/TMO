#!/usr/bin/env bun
/**
 * scripts/close-issue-ledger.ts — VÒNG CUỐI: DISPOSITION SỔ ISSUE TOÀN HỆ THỐNG
 * ==========================================================================================
 * User directive 2026-09-30 (~23:20): "Kích hoạt vòng cuối để đóng nốt sổ issue"
 * + Opus FIX directive của review cuối cmuoxzvje002vkkz2xt1g3tpc (goal: "Đóng hồ
 * sơ quản trị của nhiệm vụ #15 bằng cách cập nhật Issue Ledger theo bằng chứng
 * mới, không thực hiện thêm kiểm thử vận hành"; budget: 1 chu kỳ — 1 cập nhật
 * ledger + 1 readback).
 *
 * Phạm vi disposition (20 issue, 3 session):
 *   A. Session mission #15 (sess_1790794466247_ipt33f) — 4 meta-issue đang open
 *      do review cuối mở ra ("Ledger vẫn giữ…") + CHỈNH NGỮ NGHĨA 4 issue gốc
 *      vừa bị auto-resolve 'fixed' → đúng quy tắc Opus acceptance #2 (vi phạm
 *      lịch sử = superseded-by-user-directive, KHÔNG ghi nhầm compliant;
 *      issue TODO mục tiêu = fixed theo bằng chứng SQL2).
 *   B. Session Omega cũ (sess_1790637110029_w1x31q) — 9 issue: session đã kết
 *      thúc, nội dung nghiệm thu/provenance/quality-gate kế thừa và HOÀN TẤT ở
 *      mission #15 (run sạch run_1790801258889_1 exit 0 C1-C7 + BÁO CÁO ĐÓNG
 *      BẰNG CHỨNG run_1790808560008_1 verified 0.97) → superseded.
 *   C. Session test tools/skills cũ (sess_1790717636620_zwqek9) — 7 issue:
 *      probe/skill/verification-chain kế thừa HOÀN TẤT ở mission #15 →
 *      superseded.
 *
 * Quy tắc trung thực (bất biến):
 *   - Vi phạm lịch sử được GHI NHẬN NGUYÊN VẸN trong note — đóng 'superseded'
 *     (bị thay thế bởi chỉ đạo/phạm vi/bằng chứng mới), KHÔNG BAO GIỜ ghi
 *     "run cũ đã tuân thủ".
 *   - 'fixed' chỉ dùng khi có bằng chứng máy trực tiếp cho đúng issue đó.
 *   - Secret-scan: bằng chứng máy MỚI của operator (30-09): 1904 git-tracked
 *     files, pattern sk-/ghp_/AKIA/private-key/api_key → 1 match = "AKIA"
 *     substring trong base64 JPEG data-URI (design template) = false positive.
 *
 * Usage:
 *   bun run scripts/close-issue-ledger.ts          # DRY-RUN (mặc định)
 *   bun run scripts/close-issue-ledger.ts --apply  # ÁP DỤNG + readback + receipt
 *
 * Receipt: audit-out/issue-ledger-closure/receipt-<ts>.json (before/after từng
 * issue + readback toàn hệ thống) — copy hash in ra stdout để đối chiếu.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const NOW = new Date()
const RECEIPT_DIR = path.join(process.cwd(), 'audit-out', 'issue-ledger-closure')
const RECEIPT_FILE = path.join(RECEIPT_DIR, `receipt-${Date.now()}.json`)

// ==================== DISPOSITION MAP (20 issue — tường minh theo ID) ====================

interface Disposition {
  id: string
  session: string
  /** trạng thái hiện tại kỳ vọng — mismatch → cảnh báo (không chặn, ghi vào receipt) */
  expectStatus: string
  toStatus: 'fixed' | 'superseded' | 'wont_fix'
  note: string
}

const S3 = 'sess_1790794466247_ipt33f' // mission #15
const S1 = 'sess_1790637110029_w1x31q' // Omega cũ
const S2 = 'sess_1790717636620_zwqek9' // test tools/skills cũ

const DISPOSITIONS: Disposition[] = [
  // ── A1. Session #15 — 4 meta-issue đang open (mở bởi review cuối cmuoxzvje002) ──
  {
    id: 'cmuoxzvji002wkkz2q9wxhegq', session: S3, expectStatus: 'open', toStatus: 'fixed',
    note:
      'operator disposition theo Opus FIX directive (review cuối cmuoxzvje002): issue gốc cmuona1910 (blocking exactly-once) đã đóng superseded-by-user-directive — vi phạm lịch sử run_1790803610471_1 (4 todo_write) ghi nhận NGUYÊN VẸN; căn cứ thay thế: run sạch run_1790806753214_2 đúng 1 todo_write trong 3 lệnh (tool-log 22:19:12-41, SQL1 run_1790808560008_1 rowCount=3 không cắt)',
  },
  {
    id: 'cmuoxzvjj002xkkz2v7lzc9kw', session: S3, expectStatus: 'open', toStatus: 'fixed',
    note:
      'operator disposition theo Opus FIX directive: issue gốc cmuona1920 (chạy lệnh sau chỉ đạo dừng) đã đóng superseded-by-user-directive — vi phạm lịch sử (commandsRun=14, 7+ lệnh shell sau chỉ đạo dừng) ghi nhận NGUYÊN VẸN, run cũ KHÔNG compliant; phạm vi thay thế bằng run bằng chứng do user chủ động mở (run_1790808560008_1: đúng 2 db_query, không lệnh ngoài)',
  },
  {
    id: 'cmuoxzvjk002ykkz2ny9pk06v', session: S3, expectStatus: 'open', toStatus: 'fixed',
    note:
      'operator disposition theo Opus FIX directive: issue gốc cmuona1930m đã đóng fixed với bằng chứng máy SQL2 run_1790808560008_1 — readback 3/3 ID mục tiêu (cmuomcj56, cmuomcj5m, cmuojdxka) status=completed, content chứa receipt, cùng lần ghi 22:19:34, truncated=false',
  },
  {
    id: 'cmuoxzvjl002zkkz272o70rfm', session: S3, expectStatus: 'open', toStatus: 'fixed',
    note:
      'operator disposition theo Opus FIX directive: issue gốc cmuona1930k (minor) đã đóng superseded — tuyên bố 98% của báo cáo cũ thiếu cơ sở (evaluatorConfidence=0.01) ghi nhận nguyên vẹn; thay thế bởi báo cáo đóng run_1790808560008_1 (confidence 0.97, 2 SQL output máy-verify không cắt)',
  },

  // ── A2. Session #15 — CHỈNH NGỮ NGHĨA 4 issue gốc vừa auto-resolve (theo Opus acceptance #2) ──
  {
    id: 'cmuona19100mbkk6anl6ey6oz', session: S3, expectStatus: 'fixed', toStatus: 'superseded',
    note:
      'superseded-by-user-directive (phương án B, 21:56:55): vi phạm lịch sử run_1790803610471_1 (4 todo_write, 1 sai schema) KHÔNG xóa — run cũ không được coi là compliant; căn cứ thay thế: run sạch run_1790806753214_2 thực thi đúng chuẩn exactly-once (1 todo_write / 3 lệnh) được kiểm chứng máy qua run_1790808560008_1 (verified 0.97)',
  },
  {
    id: 'cmuona19200mckk6at7evvsya', session: S3, expectStatus: 'fixed', toStatus: 'superseded',
    note:
      'superseded-by-user-directive: vi phạm lịch sử (lệnh điều tra + shell sau chỉ đạo kết thúc) ghi nhận nguyên vẹn — không tuyên bố run cũ tuân thủ; phạm vi được user thay thế bằng các run bằng chứng chủ động mở sau đó (22:19 protocol, 22:49 báo cáo đóng)',
  },
  {
    id: 'cmuona19300mdkk6abcwpdr1l', session: S3, expectStatus: 'fixed', toStatus: 'fixed',
    note:
      'operator xác nhận theo bằng chứng máy SQL2 run_1790808560008_1: đúng 3 ID mục tiêu (cmuomcj56, cmuomcj5m, cmuojdxka) đều completed + receipt cùng lần ghi 22:19:34 — đối chiếu protocol run_1790806753214_2',
  },
  {
    id: 'cmuona19300mekk6atz2zh02c', session: S3, expectStatus: 'fixed', toStatus: 'superseded',
    note:
      'superseded: mức tin 98% của báo cáo cũ thiếu cơ sở (evaluatorConfidence=0.01, complete=false) — ghi nhận nguyên vẹn làm bằng chứng quá khứ; báo cáo đóng mới run_1790808560008_1 confidence 0.97 có bằng chứng máy tương ứng',
  },

  // ── B. Session Omega cũ — 9 issue (nội dung kế thừa hoàn tất ở mission #15) ──
  {
    id: 'cmummp68r01exkkskqrufqzwq', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: session đã kết thúc, nhiệm vụ nghiệm thu kế thừa HOÀN TẤT ở mission #15 — BÁO CÁO ĐÓNG BẰNG CHỨNG run_1790808560008_1 (evaluator verified 0.97, complete) + audit bundle chuẩn tmp/audit/run_1790801258889_1/ (exit 0, C1-C7 xanh)',
  },
  {
    id: 'cmummp68s01eykkskusgjd9fr', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: quality gate XANH trên run sạch mission #15 (clean-pass exit 0, mirror đầy đủ); dữ liệu STALE được chuẩn hóa trong audit-tools.ts (commit 41a79f7) + chuỗi TOOLS_AUDIT.md mới (4f02747)',
  },
  {
    id: 'cmummp68s01ezkkskbgeirn1w', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: provenance runId hoàn thiện toàn hệ thống — audit-provenance.ts (commit 4f02747) ép mọi artifact gắn runId receipt từng lệnh; kiểm chứng XANH trên run sạch mission #15 (C1-C7)',
  },
  {
    id: 'cmumxn6gg005skkylqwy76003', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: run SENTINEL cũ đã qua nhiều vòng restart, không thể truy vết lại tool-log; hệ thống thay thế tốt hơn: skill-checker harness mission #15 kiểm chứng từng skill có receipt + provenance runId',
  },
  {
    id: 'cmuma2dz200k6kkm107e6auao', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: tool-audit mission #15 (TOOLS_AUDIT.md, commit 4f02747) chẩn đoán + phân loại toàn bộ tool failures trên chuỗi chạy thật có receipt từng lệnh',
  },
  {
    id: 'cmummp68t01f0kkskkoh0ifyf', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: ma trận lifecycle 74 tool + skills được chứng minh qua probe runner + skill checker mission #15 — C1-C7 xanh trên run sạch run_1790801258889_1',
  },
  {
    id: 'cmummp68u01f1kkskfhll9llp', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: db_query đã được phân loại trong TOOLS_AUDIT.md (native, read-only sqlite, infra-guard chặn ghi trực tiếp db/custom.db — kiểm chứng hoạt động 22:04-22:08 worklog round-16)',
  },
  {
    id: 'cmummp68v01f2kkskvuu5r1g5', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: lỗi "báo cáo dừng sai" của run cũ là lịch sử không thể sửa đổi; cơ chế dừng/báo cáo đã được thay thế hoàn chỉnh (evaluator v2 + stop pipeline); đóng theo user directive đóng nốt sổ',
  },
  {
    id: 'cmumxn6gk005tkkylupp1b1ux', session: S1, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded KÈM BẰNG CHỨNG MÁY MỚI (operator scan 30-09): 1904 git-tracked files quét pattern secret (sk-/ghp_/AKIA/private-key/api_key) → đúng 1 match = "AKIA" substring nằm trong base64 JPEG data-URI của design template (social-carousel.html:631) = FALSE POSITIVE — không có secret thật trong Git',
  },

  // ── C. Session test tools/skills cũ — 7 issue (nội dung kế thừa hoàn tất ở mission #15) ──
  {
    id: 'cmunq3t400006kkpa4kkzgkap', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: probe exhaustive toàn bộ tool HOÀN TẤT ở mission #15 — probe runner run_1790801258889_1: 74 tool có receipt từng lệnh, exit 0, C1-C7 xanh trên run sạch',
  },
  {
    id: 'cmunq3t420007kkpa9y3gp58q', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: kiểm chứng từng skill HOÀN TẤT ở mission #15 — skill checker có provenance runId + mirror đầy đủ (run_1790801258889_1)',
  },
  {
    id: 'cmuo3a9da00lgkkwnoiv0obps', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: chuỗi kiểm định mới XANH có bằng chứng máy — run sạch mission #15 exit 0, C1-C7 pass, baseline trước/sau không side-effect (tmp/audit/run_1790801258889_1/)',
  },
  {
    id: 'cmuo3a9dc00lhkkwnat3vzoi5', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: crash của run cũ là lịch sử; năng lực crash-resilience đã hoàn thiện và KIỂM CHỨNG THẬT: orphan sweep → requeue → RESUME checkpoint → re-dispatch hoạt động đúng (22:04-22:08, worklog round-16)',
  },
  {
    id: 'cmunq3t430009kkpa8eidt1sa', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: usability từng tool được phân loại đầy đủ trong TOOLS_AUDIT.md mission #15 (native/builtin/skill, phụ thuộc ngoài + skip lý do ghi rõ từng dòng)',
  },
  {
    id: 'cmunq3t44000akkpawg2wxl9f', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: artifact bền vững chuẩn đã có — tmp/audit/run_1790801258889_1/ (bundle nghiệm thu, không xóa) + reports git-included (commit 4f02747); cleanup đối chiếu qua audit:baseline check (C7)',
  },
  {
    id: 'cmunq3t44000bkkparm7ncy3h', session: S2, expectStatus: 'open', toStatus: 'superseded',
    note:
      'superseded: chuẩn provenance runId áp dụng toàn hệ thống (audit-provenance.ts, 4f02747) — mọi báo cáo/artifact truy vết được về run sinh ra nó, kiểm chứng XANH C1-C7',
  },
]

// ==================== THI HÀNH ====================

async function main() {
  console.log(`━`.repeat(80))
  console.log(`VÒNG CUỐI — DISPOSITION SỔ ISSUE (${APPLY ? 'APPLY — THI HÀNH THẬT' : 'DRY-RUN — không ghi'})`)
  console.log(`Thời điểm: ${NOW.toISOString()} | Số disposition: ${DISPOSITIONS.length}`)
  console.log(`Căn cứ: user directive "đóng nốt sổ issue" + Opus FIX directive cmuoxzvje002 (budget 1 chu kỳ)`)
  console.log(`━`.repeat(80))

  const { db } = await import('../src/lib/db')

  const receipt: Array<Record<string, unknown>> = []
  let mismatches = 0
  let applied = 0

  for (const d of DISPOSITIONS) {
    const row = await db.issueLedger.findUnique({ where: { id: d.id } })
    if (!row) {
      console.error(`✗ KHÔNG TÌM THẤY issue ${d.id} (${d.session}) — BỎ QUA (receipt ghi lỗi)`)
      receipt.push({ id: d.id, session: d.session, error: 'not-found' })
      mismatches++
      continue
    }
    const mismatch = row.status !== d.expectStatus
    if (mismatch) mismatches++

    const before = { status: row.status, resolvedBy: row.resolvedBy }
    const after = { status: d.toStatus, resolvedBy: `operator: ${d.note}` }

    const tag = mismatch ? `⚠ (kỳ vọng ${d.expectStatus}, thực tế ${row.status})` : ''
    console.log(
      `${APPLY ? '✎' : '·'} ${d.id.slice(0, 12)} [${row.severity}] ${row.status} → ${d.toStatus} ${tag}`
    )
    console.log(`    ${(row.title || '').slice(0, 76)}`)
    if (APPLY) {
      await db.issueLedger.update({
        where: { id: d.id },
        data: { status: d.toStatus, resolvedAt: row.resolvedAt ?? NOW, resolvedBy: after.resolvedBy },
      })
      applied++
    }
    receipt.push({
      id: d.id, session: d.session, severity: row.severity, title: row.title,
      before, after: APPLY ? after : null, mismatch,
    })
  }

  // ── READBACK: đếm open theo session + toàn hệ thống ──
  console.log(`━`.repeat(80))
  console.log(`READBACK ${APPLY ? '(SAU APPLY)' : '(TRƯỚC APPLY)'}`)
  const openAll = await db.issueLedger.findMany({ where: { status: 'open' } })
  const bySession = new Map<string, number>()
  for (const r of openAll) bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + 1)
  for (const [sid, n] of [...bySession.entries()].sort()) {
    console.log(`  ${sid}: ${n} open`)
  }
  const totalOpen = openAll.length
  console.log(`  TỔNG OPEN TOÀN HỆ THỐNG: ${totalOpen}`)

  if (APPLY) {
    if (totalOpen !== 0) {
      console.error(`✗ READBACK KHÔNG SẠCH — còn ${totalOpen} issue open!`)
    } else {
      console.log(`✓ SỔ ISSUE SẠCH HOÀN TOÀN — 0 issue open toàn hệ thống`)
    }
    fs.mkdirSync(RECEIPT_DIR, { recursive: true })
    const payload = {
      closedAt: NOW.toISOString(),
      mode: 'apply',
      authority: 'user directive "Kích hoạt vòng cuối để đóng nốt sổ issue" (2026-09-30) + Opus FIX directive review cmuoxzvje002vkkz2xt1g3tpc',
      stats: { dispositions: DISPOSITIONS.length, applied, mismatches, openAfter: totalOpen },
      dispositions: receipt,
    }
    fs.writeFileSync(RECEIPT_FILE, JSON.stringify(payload, null, 2))
    const sha = createHash('sha256').update(fs.readFileSync(RECEIPT_FILE)).digest('hex')
    console.log(`Receipt: ${RECEIPT_FILE}`)
    console.log(`sha256:  ${sha}`)
  } else {
    console.log(`(DRY-RUN — chạy lại với --apply để thi hành)`)
  }

  await db.$disconnect()
  if (mismatches > 0) console.warn(`⚠ ${mismatches} disposition lệch trạng thái kỳ vọng — xem chi tiết ở trên`)
}

main().catch(err => {
  console.error('LỖI:', err)
  process.exit(1)
})
