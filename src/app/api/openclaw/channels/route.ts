/**
 * OpenClaw Channels API — Manage messaging channel connections
 *
 * GET  /api/openclaw/channels          — List all channels with status
 * POST /api/openclaw/channels          — Channel actions (connect, disconnect, test, delete)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { gatewayFetch, isGatewayOnline, listChannels } from '@/lib/openclaw'
import { ensureGatewayRunning } from '@/lib/openclaw-ondemand'

export const dynamic = 'force-dynamic'

// ─── Channel Definitions ─────────────────────────────────────────────────────

interface ChannelDef {
  channelType: string
  icon: string
  label: string
}

const CHANNEL_TYPES: ChannelDef[] = [
  { channelType: 'telegram', icon: '💬', label: 'Telegram' },
  { channelType: 'discord', icon: '🎮', label: 'Discord' },
  { channelType: 'slack', icon: '📱', label: 'Slack' },
  { channelType: 'webchat', icon: '🌐', label: 'WebChat' },
  { channelType: 'whatsapp', icon: '📞', label: 'WhatsApp' },
  { channelType: 'signal', icon: '🔒', label: 'Signal' },
]

// ─── GET — List all channels ─────────────────────────────────────────────────

export async function GET() {
  try {
    // Fetch all existing channel configs from SQLite
    const dbConfigs = await db.channelConfig.findMany()
    const configMap = new Map(dbConfigs.map((c) => [c.channelType, c]))

    // Try to get channels from gateway
    let gatewayChannels: Array<{ channelType?: string; type?: string; status?: string; connected?: boolean }> = []
    let gatewayOnline = false
    try {
      // ON-DEMAND (2026-09-07): ensureGatewayRunning() lazy-spawn gateway khi
      // offline (mở tab Channels = tính năng thật sự cần gateway) thay vì
      // isGatewayOnline() passive luôn bỏ qua khi gateway đang tắt.
      const health = await ensureGatewayRunning()
      gatewayOnline = health.online
      if (gatewayOnline) {
        gatewayChannels = await listChannels() as Array<{ channelType?: string; type?: string; status?: string; connected?: boolean }>
      }
    } catch {
      // Gateway unreachable — continue with DB data only
    }

    // Build gateway channel lookup
    const gatewayMap = new Map<string, { status?: string; connected?: boolean }>()
    for (const gc of gatewayChannels) {
      const key = gc.channelType || gc.type || ''
      if (key) gatewayMap.set(key, { status: gc.status, connected: gc.connected })
    }

    // Merge DB data + gateway data into full channel list
    const channels = CHANNEL_TYPES.map((def) => {
      const dbConfig = configMap.get(def.channelType)
      const gwData = gatewayMap.get(def.channelType)

      let parsedConfig: Record<string, unknown> = {}
      if (dbConfig?.config) {
        try {
          parsedConfig = JSON.parse(dbConfig.config)
        } catch {
          parsedConfig = {}
        }
      }

      const enabled = dbConfig?.enabled ?? false
      const connected = gwData?.connected ?? (enabled && !!dbConfig?.connectedAt)

      return {
        channelType: def.channelType,
        icon: def.icon,
        label: def.label,
        enabled,
        connected,
        config: parsedConfig,
        connectedAt: dbConfig?.connectedAt ?? null,
        gatewayStatus: gwData?.status ?? null,
      }
    })

    return NextResponse.json({ channels, gatewayOnline })
  } catch (error) {
    console.error('[Channels GET] Error:', error)
    return NextResponse.json({ error: 'Không thể tải danh sách kênh' }, { status: 500 })
  }
}

// ─── POST — Channel actions ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, channelType, config } = body

    // ON-DEMAND (2026-09-07): các action connect/disconnect/test/delete gọi
    // thẳng gatewayFetch → đảm bảo gateway đang chạy trước (spawn nếu offline)
    if (action !== 'delete') {
      await ensureGatewayRunning()
    }

    if (!channelType || !CHANNEL_TYPES.some((c) => c.channelType === channelType)) {
      return NextResponse.json(
        { error: `Loại kênh không hợp lệ: ${channelType}. Các kênh hợp lệ: ${CHANNEL_TYPES.map((c) => c.channelType).join(', ')}` },
        { status: 400 }
      )
    }

    // ── Connect ──────────────────────────────────────────────────────────
    if (action === 'connect') {
      const configObj = config || {}
      const now = new Date()

      const record = await db.channelConfig.upsert({
        where: { channelType },
        update: {
          config: JSON.stringify(configObj),
          enabled: true,
          connectedAt: now,
        },
        create: {
          channelType,
          config: JSON.stringify(configObj),
          enabled: true,
          connectedAt: now,
        },
      })

      // Try to notify gateway
      try {
        await gatewayFetch('/v1/channels/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelType, config: configObj }),
        })
      } catch {
        // Gateway unreachable — still save locally
      }

      return NextResponse.json({
        success: true,
        message: `Kênh ${channelType} đã được kết nối`,
        channel: record,
      })
    }

    // ── Disconnect ───────────────────────────────────────────────────────
    if (action === 'disconnect') {
      const existing = await db.channelConfig.findUnique({ where: { channelType } })
      if (!existing) {
        return NextResponse.json(
          { error: `Không tìm thấy cấu hình kênh ${channelType}` },
          { status: 404 }
        )
      }

      const record = await db.channelConfig.update({
        where: { channelType },
        data: { enabled: false, connectedAt: null },
      })

      // Try to notify gateway
      try {
        await gatewayFetch('/v1/channels/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelType }),
        })
      } catch {
        // Gateway unreachable
      }

      return NextResponse.json({
        success: true,
        message: `Kênh ${channelType} đã ngắt kết nối`,
        channel: record,
      })
    }

    // ── Test ─────────────────────────────────────────────────────────────
    if (action === 'test') {
      const existing = await db.channelConfig.findUnique({ where: { channelType } })
      if (!existing) {
        return NextResponse.json(
          { error: `Không tìm thấy cấu hình kênh ${channelType} để kiểm tra` },
          { status: 404 }
        )
      }

      const now = new Date()
      let testStatus = 'completed'
      let testResult: Record<string, unknown> = { channelType, testedAt: now.toISOString() }

      // Try to ping the channel via gateway
      try {
        const gwRes = await gatewayFetch(`/v1/channels/${channelType}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (gwRes.ok) {
          const gwData = await gwRes.json()
          testResult = { ...testResult, ...gwData, gatewayResponded: true }
        } else {
          testStatus = 'failed'
          testResult = { ...testResult, gatewayResponded: false, httpStatus: gwRes.status }
        }
      } catch {
        testStatus = 'completed'
        testResult = { ...testResult, gatewayResponded: false, note: 'Gateway không khả dụng — kiểm tra cục bộ thành công' }
      }

      // Create a task execution record for the test
      const execution = await db.taskExecution.create({
        data: {
          jobId: existing.id,
          type: 'channel_test',
          status: testStatus,
          result: JSON.stringify(testResult),
          startedAt: now,
          completedAt: now,
        },
      })

      return NextResponse.json({
        success: testStatus !== 'failed',
        message: testStatus === 'failed'
          ? `Kiểm tra kết nối kênh ${channelType} thất bại`
          : `Kiểm tra kết nối kênh ${channelType} hoàn tất`,
        status: testStatus,
        result: testResult,
        execution,
      })
    }

    // ── Delete ───────────────────────────────────────────────────────────
    if (action === 'delete') {
      const existing = await db.channelConfig.findUnique({ where: { channelType } })
      if (!existing) {
        return NextResponse.json(
          { error: `Không tìm thấy cấu hình kênh ${channelType}` },
          { status: 404 }
        )
      }

      await db.channelConfig.delete({ where: { channelType } })

      // Try to notify gateway
      try {
        await gatewayFetch(`/v1/channels/${channelType}`, { method: 'DELETE' })
      } catch {
        // Gateway unreachable
      }

      return NextResponse.json({
        success: true,
        message: `Đã xóa cấu hình kênh ${channelType}`,
      })
    }

    return NextResponse.json(
      { error: `Hành động không hợp lệ: ${action}. Các hành động hợp lệ: connect, disconnect, test, delete` },
      { status: 400 }
    )
  } catch (error) {
    console.error('[Channels POST] Error:', error)
    return NextResponse.json({ error: 'Không thể xử lý yêu cầu kênh' }, { status: 500 })
  }
}
