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
import { getTopQAdvice, agentRuntimeStateKey } from '@/lib/learning/q-table'
// R5 (2026-10-14): catalog zen = overlay đồng bộ tự động (models.dev/CLI)
// LÊN catalog tĩnh — model free mới xuất hiện sẽ vào dropdown ngay không
// cần đợi sửa code; kèm trạng thái sync (lastSyncAt/diff) cho UI.
import { getZenFreeModelCatalog, getSyncStatus } from '@/lib/free-models-sync'

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

/**
 * P6-M4 (BLUEPRINT-STATS-LEARNING §P6-M4): lời khuyên Q học được cho state
 * runtime agent — top model theo Q-value (chỉ entry đã học visits>0).
 * Fail-open: lỗi DB → top rỗng (dropdown không hiện badge — không đỏ).
 */
async function buildQAdvice(): Promise<{ stateKey: string; top: Array<{ model: string; q: number; visits: number }> }> {
  const stateKey = agentRuntimeStateKey()
  try {
    const top = await getTopQAdvice(stateKey, 5)
    return { stateKey, top: top.map(t => ({ model: t.action, q: t.q, visits: t.visits })) }
  } catch {
    return { stateKey, top: [] }
  }
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
        // R5: zen đi qua catalog merge (tĩnh + đồng bộ tự động); provider khác giữ nguyên
        models: provider === 'zen' ? augmentZenModels(getZenFreeModelCatalog()) : PROVIDER_MODELS[provider],
        // P6-M4 — advice kèm response provider-specific (dropdown zen là nơi dùng)
        ...(provider === 'zen' ? { advice: await buildQAdvice() } : {}),
        ...(provider === 'zen' ? { freeModelsSync: getSyncStatus() } : {}),
      })
    }

    // Return all providers with their models — zen được gắn live block state (r74)
    // + Q advice (P6-M4) cho dropdown badge "Q học được đề xuất"
    // R5 (2026-10-14): danh sách model zen = catalog merge (đồng bộ tự động)
    // + trạng thái sync freeModelsSync cho UI (nút Đồng bộ ngay / lastSyncAt).
    const zenCatalog = augmentZenModels(getZenFreeModelCatalog())
    return NextResponse.json({
      providers: PROVIDER_DATA.map(p =>
        p.key === 'zen'
          ? { ...p, models: zenCatalog }
          : p
      ),
      totalProviders: PROVIDER_DATA.length,
      totalModels: PROVIDER_DATA.reduce((sum, p) => sum + (p.key === 'zen' ? zenCatalog.length : p.models.length), 0),
      advice: await buildQAdvice(),
      freeModelsSync: getSyncStatus(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list models', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
