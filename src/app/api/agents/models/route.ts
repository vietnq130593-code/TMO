/**
 * Agent Models API — Provider & Model list for Agent creation
 *
 * GET /api/agents/models           — List all providers with their models
 * GET /api/agents/models?provider=nvidia  — List models for specific provider
 *
 * r74 (BUG2-033 — dropdown model "nói thật"): model của provider zen được gắn
 * thêm `blockedTransports` (['http'] / ['http','cli']) đọc TỪ CHÍNH free-tier
 * block cache mà tầng vận hành llm.ts đang dùng để skip transport — dropdown
 * hiển thị badge ⚠ + ghi chú fallback thay vì để user chọn model rồi âm thầm
 * chuyển tiếp về space-bunny-free (policy Zen lật ngược nhiều lần: 09-27 chặn
 * → r72 mở → r74 chặn lại — trạng thái sống thực thay vì hardcode tĩnh).
 * Model KHÔNG có trường blockedTransports = chưa gặp lỗi (không kết luận).
 */

import { NextRequest, NextResponse } from 'next/server'
import { PROVIDER_DATA, PROVIDER_MODELS } from '@/lib/agent-constants'
import { zenModelBlockSummary } from '@/lib/llm'

export const dynamic = 'force-dynamic'

/** Gắn blockedTransports cho từng model zen từ block-cache sống (r74). */
function augmentZenModels<T extends { id: string }>(models: T[]): Array<T & { blockedTransports?: string[] }> {
  const blocks = zenModelBlockSummary()
  if (blocks.length === 0) return models
  const blockedByModel = new Map<string, Set<string>>()
  for (const b of blocks) {
    if (!blockedByModel.has(b.model)) blockedByModel.set(b.model, new Set())
    blockedByModel.get(b.model)!.add(b.transport)
  }
  return models.map(m => {
    const bt = blockedByModel.get(m.id)
    return bt && bt.size > 0 ? { ...m, blockedTransports: Array.from(bt) } : m
  })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const provider = searchParams.get('provider')

    if (provider) {
      // Return models for specific provider
      const providerData = PROVIDER_DATA.find(p => p.key === provider)
      if (!providerData) {
        return NextResponse.json(
          { error: `Provider "${provider}" không tồn tại. Khả dụng: ${PROVIDER_DATA.map(p => p.key).join(', ')}` },
          { status: 400 }
        )
      }
      return NextResponse.json({
        provider: providerData,
        models: provider === 'zen' ? augmentZenModels(PROVIDER_MODELS[provider]) : PROVIDER_MODELS[provider],
      })
    }

    // Return all providers with their models — zen được gắn live block state (r74)
    return NextResponse.json({
      providers: PROVIDER_DATA.map(p =>
        p.key === 'zen'
          ? { ...p, models: augmentZenModels(p.models) }
          : p
      ),
      totalProviders: PROVIDER_DATA.length,
      totalModels: PROVIDER_DATA.reduce((sum, p) => sum + p.models.length, 0),
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list models', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
