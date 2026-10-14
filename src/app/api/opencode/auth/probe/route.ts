/**
 * OpenCode Account OAuth — Re-probe free tier
 * POST /api/opencode/auth/probe
 *
 * Đăng nhập rồi nhưng probe trước đó fail (policy Zen lật ngược nhiều lần —
 * xem worklog r72/r74/Task 28)? UI cho nút "Thử lại" gọi route này: probe
 * lại space-bunny-free với session (cả 2 endpoint /zen/v1 + /inference/v1),
 * cập nhật kết quả vào session store. Probe OK → xoá block-cache http model
 * free + ghi auth.json CLI (giống poll route).
 */

import { NextResponse } from 'next/server'
import { getValidZenSession, probeFreeTier, updateSessionFreeTier, writeAuthJsonForCli } from '@/lib/opencode-oauth'
import { clearZenFreeTierBlocks, probeZenFreeTierViaCli } from '@/lib/llm'
import { PROVIDER_MODELS } from '@/lib/agent-constants'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const session = await getValidZenSession()
    if (!session) {
      return NextResponse.json({ error: 'Chưa đăng nhập OpenCode account (hoặc session hết hạn + refresh fail) — POST /api/opencode/auth/login trước' }, { status: 400 })
    }
    const freeTier = await probeFreeTier(session.accessToken)
    const zenFreeModelIds = PROVIDER_MODELS.zen.map(m => m.id)
    if (freeTier.unlocked) {
      clearZenFreeTierBlocks('http', zenFreeModelIds)
      writeAuthJsonForCli(session)
    } else {
      // R6 (user report 2026-10-31) — HTTP probe fail → đo thêm transport CLI
      // trên MÁY CHẠY APP (cliOk): HTTP session có thể bị Zen từ chối nhưng lõi
      // free vẫn chạy qua CLI native — llm.ts tự failover, message phải nói đúng
      // "vẫn dùng được qua CLI" thay vì dead-end "bị chặn".
      try {
        writeAuthJsonForCli(session) // CLI probe dùng session hiện tại (như đã login opencode)
        const cli = await probeZenFreeTierViaCli(30_000)
        freeTier.cliOk = cli.ok
        if (cli.ok) {
          freeTier.detail += ' → transport CLI (opencode CLI) trên máy này probe OK — lõi free vẫn dùng được qua failover CLI tự động của llm.ts.'
          clearZenFreeTierBlocks('cli', zenFreeModelIds) // CLI sống lại — dọn block cũ để failover thật sự chạy
          console.log(`[OC-OAUTH] R6 cliOk=true — ${cli.reason}; đã xoá block-cache cli cho ${zenFreeModelIds.length} model free`)
        } else {
          freeTier.detail += ` Transport CLI cũng không chạy được (${cli.reason}).`
          console.warn(`[OC-OAUTH] R6 cliOk=false — ${cli.reason}`)
        }
      } catch (cliErr) {
        console.warn('[OC-OAUTH] R6 CLI probe lỗi (không chặn):', cliErr instanceof Error ? cliErr.message : String(cliErr))
      }
    }
    // Cập nhật kết quả probe mới nhất vào session store (status route đọc từ đó)
    // — đặt SAU enrich cliOk để store giữ nguyên bản message + cliOk cuối cùng.
    updateSessionFreeTier({ probedAt: Date.now(), ...freeTier })
    return NextResponse.json({ freeTier })
  } catch (err) {
    return NextResponse.json(
      { error: 'Probe thất bại', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
