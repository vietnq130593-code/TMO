'use client'

// ========================================================================
// token-usage-section — Tab Token (Database) — calendar + NVIDIA key config
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useEffect } from 'react'
import { RefreshCw, AlertTriangle, Key, Calendar } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Calendar as CalendarPicker } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { format } from 'date-fns'
import { toast } from '@/hooks/use-toast'
import { HealthResponse, useTokenStream, TokenUsageData } from '@/components/app-shared'


/** NVIDIA NIM model configuration (user directive 2026-11-30, cập nhật
 *  2026-10-13 theo request user "thêm Deepseek v4.1 flash vào ô Agent"):
 *  NIM chỉ giữ: embed (hiển thị ở section khác) + extraction nemotron-550b
 *  (chính — fallback qua chuỗi Zen space-bunny-free) + 2 lõi agent/chat:
 *  kimi-k3 (lựa chọn tạm thời, chậm ~2 phút/call) + deepseek-v4.1-flash
 *  (⚡ nhanh ~2s/call — live-probe Task 28; đồng thời là NIM rescue tier của
 *  toàn chuỗi Zen — token đo qua callModelWithKeyRotation xoay 4 key NIM).
 *  Dòng EOL 410 đã bỏ (live-probe 2026-11-30): minimax-m3, deepseek-v4-pro-
 *  0813, deepseek-v4-flash-0731 (bản v4.0 — KHÔNG phải v4.1-flash),
 *  gpt-oss-120b. */
export const NVIDIA_CORE_CONFIG = {
  extraction: {
    label: 'Trích xuất',
    icon: '📄',
    color: 'text-cyan-400',
    headerBg: 'bg-cyan-950/60',
    barColor: '#22d3ee',
    models: [
      { key: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b (chính)' },
    ],
  },
  agent: {
    label: 'Agent / Chat',
    icon: '🤖',
    color: 'text-amber-400',
    headerBg: 'bg-amber-950/60',
    barColor: '#f59e0b',
    models: [
      { key: 'moonshotai/kimi-k3', label: 'kimi-k3 (lựa chọn tạm thời — NVIDIA NIM)' },
      { key: 'deepseek-ai/deepseek-v4.1-flash', label: 'deepseek-v4.1-flash (⚡ nhanh — NIM rescue)' },
    ],
  },
} as const


/** OpenCode Zen model configuration — Phiên 7 (user directive 2026-09-28:
 *  "đổi 2 lõi Nemotron + Muse Spark thành Space-Bunny-Free, đo được token")
 *  Toàn bộ 13 agents = space-bunny-free — model free DUY NHẤT Zen mở cho
 *  oc_sk API key (nemotron-ultra/muse-spark → 403 FreeTierError — verify cả
 *  sandbox lẫn máy user). Token đo ở CẢ 2 đường: provider 'zen' (HTTP trực
 *  tiếp — đường chính) + 'zen-cli' (OpenCode CLI subprocess — fallback). */
export const ZEN_CORE_CONFIG = {
  bunny: {
    label: 'Space-Bunny-Free',
    icon: '🐰',
    color: 'text-emerald-400',
    headerBg: 'bg-emerald-950/60',
    barColor: '#10b981',
    model: 'space-bunny-free',
    role: 'Toàn bộ 13 agents — TL / Omega / Opus / MEGATRON / NEMESIS + G1-G3 / ALISTA',
  },
} as const

/** NVIDIA key color map */
export const KEY_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f97316']


export function TokenUsageSection({ health }: { health: HealthResponse | null }) {
  // Real-time today's data from SSE stream (no polling needed)
  const todayUsage = useTokenStream()
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedDateUsage, setSelectedDateUsage] = useState<TokenUsageData | null>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [tokenLoading, setTokenLoading] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)

  // Mark loading as done once SSE data arrives
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  useEffect(() => {
    queueMicrotask(() => { if (todayUsage) setTokenLoading(false) })
  }, [todayUsage])

  // Fetch usage for a specific date (still uses REST API — SSE only for today)
  const fetchDateUsage = useCallback(async (dateStr: string) => {
    try {
      const res = await fetch(`/api/token-usage?date=${dateStr}`)
      if (res.ok) {
        const data = await res.json()
        setSelectedDateUsage(data)
      }
    } catch {
      // ignore
    }
  }, [])

  // Handle date selection
  const handleDateSelect = useCallback((date: Date | undefined) => {
    setSelectedDate(date)
    setCalendarOpen(false)
    if (date) {
      const dateStr = format(date, 'yyyy-MM-dd')
      fetchDateUsage(dateStr)
    } else {
      setSelectedDateUsage(null)
    }
  }, [fetchDateUsage])

  // Format number with commas
  const formatNumber = (n: number) => n.toLocaleString('vi-VN')

  // Determine which data to show (selected date or today)
  const displayData = selectedDate ? selectedDateUsage : todayUsage

  // Get models data from display data (per-provider)
  // Phiên 7: space-bunny-free gọi TRỰC TIẾP qua HTTP → provider 'zen';
  // 'zen-cli' = OpenCode CLI subprocess (đường fallback). Gộp 2 nguồn.
  const nvidiaModels = displayData?.models?.['nvidia'] || {}
  const zenHttpModels = displayData?.models?.['zen'] || {}
  const zenCliModels = displayData?.models?.['zen-cli'] || {}
  const zenAllModels: Record<string, number> = {}
  for (const [m, t] of Object.entries(zenHttpModels)) zenAllModels[m] = (zenAllModels[m] || 0) + t
  for (const [m, t] of Object.entries(zenCliModels)) zenAllModels[m] = (zenAllModels[m] || 0) + t

  // Calculate per-group totals
  const extractionTotal = NVIDIA_CORE_CONFIG.extraction.models.reduce(
    (sum, m) => sum + (nvidiaModels[m.key] || 0), 0
  )
  const agentTotal = NVIDIA_CORE_CONFIG.agent.models.reduce(
    (sum, m) => sum + (nvidiaModels[m.key] || 0), 0
  )
  const zenBunnyHttpTokens = zenHttpModels['space-bunny-free'] || 0
  const zenBunnyCliTokens = zenCliModels['space-bunny-free'] || 0
  const zenBunnyTokens = zenBunnyHttpTokens + zenBunnyCliTokens
  const zenTotal = Object.values(zenAllModels).reduce((a, b) => a + b, 0)
  // Models cũ (nemotron/muse phiên 5-6) — chỉ còn trong dữ liệu lịch sử ngày trước
  const zenOtherTokens = zenTotal - zenBunnyTokens

  // Get NVIDIA key data
  const nvidiaKeys = displayData?.slots?.['nvidia'] || {}
  const nvidiaKeyTotal = Object.values(nvidiaKeys).reduce((a, b) => a + b, 0)

  // NVIDIA key diagnostics from health
  const nvidiaDiagnostics = health?.providerDiagnostics?.['NVIDIA']
  const nvidiaQuota = health?.dailyQuotaStatus?.['NVIDIA']
  const hasRateLimitedKeys = nvidiaDiagnostics ? nvidiaDiagnostics.keys.some(k => k.rateLimited) : false
  const hasExhaustedKeys = nvidiaDiagnostics ? nvidiaDiagnostics.availableCount < nvidiaDiagnostics.keyCount : false

  return (
    <div className="nc-wrap nc-lime">
    <Card className="nc-panel nc-md nc-border-lime">
      <CardHeader className="pb-1">
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-950/50 border border-green-500/55" />
            <CardTitle className="text-base font-bold tracking-widest text-center text-white">TOKEN USAGE</CardTitle>
            <span className="text-[10px] font-semibold text-green-400 bg-green-950/50 px-2 py-0.5 rounded-full border border-green-500/55">NVIDIA NIM</span>
          </div>
          {/* Date picker + Reset buttons */}
          <div className="flex items-center gap-2">
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 px-4 text-xs rounded-lg border-cyan-400/35 bg-slate-950/60 hover:bg-purple-900/40 hover:text-purple-400 hover:border-purple-500/55 btn-glow">
                  <Calendar className="h-3.5 w-3.5 mr-1.5 text-stone-200" /> <span className="text-stone-200">Xem theo ngày</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="center">
                <CalendarPicker
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDateSelect}
                  disabled={(date) => date > new Date()}
                  defaultMonth={new Date()}
                />
              </PopoverContent>
            </Popover>
            {!selectedDate && (
              <Button variant="outline" size="sm" className="h-8 px-3 text-xs rounded-lg border-cyan-400/35 bg-slate-950/60 hover:bg-red-900/40 hover:text-red-400 hover:border-red-500/55 btn-glow" onClick={async () => {
                try {
                  const res = await fetch('/api/token-usage?action=reset', { method: 'POST' })
                  if (res.ok) { toast({ title: 'Đã reset token', description: 'Bộ đếm token đã về 0 — SSE sẽ tự cập nhật', duration: 2000 }) }
                } catch {}
              }}>
                <RefreshCw className="h-3 w-3 mr-1 text-stone-200" /> <span className="text-stone-200">Reset</span>
              </Button>
            )}
            {selectedDate && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-muted-foreground hover:text-purple-400 btn-glow" onClick={() => { setSelectedDate(undefined); setSelectedDateUsage(null) }}>
                ← Hôm nay
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-3">

          {/* Total tokens + 4 API Keys overview */}
          <div className="grid grid-cols-5 gap-2">
            {/* Total tokens card */}
            <div className="nc-panel nc-sm nc-border-lime p-3 col-span-1 flex flex-col items-center justify-center">
              <p className="text-2xl font-bold tabular-nums text-stone-100">{displayData ? formatNumber(displayData.tokens) : '0'}</p>
              <p className="text-[9px] text-stone-400 mt-0.5">{selectedDate ? `Token ngày ${format(selectedDate, 'dd/MM')}` : 'Tổng token hôm nay'}</p>
              <div className="flex gap-1 mt-2">
                <span className="text-[8px] text-cyan-400 bg-cyan-950/40 px-1.5 py-0.5 rounded">{formatNumber(extractionTotal)} trích</span>
                <span className="text-[8px] text-amber-400 bg-amber-950/40 px-1.5 py-0.5 rounded">{formatNumber(agentTotal)} agent</span>
              </div>
              <p className="text-[8px] text-stone-500 mt-1.5">{selectedDate ? 'Dữ liệu lịch sử' : '4 keys × 4 docs = 16 tối đa'}</p>
            </div>
            {/* 4 API Keys */}
            {[0, 1, 2, 3].map(keyIdx => {
              const keyTokens = nvidiaKeys[keyIdx] || 0
              const keyInfo = nvidiaDiagnostics?.keys?.[keyIdx]
              const isRateLimited = keyInfo?.rateLimited ?? false
              const isExhausted = keyInfo?.exhausted ?? false
              const isAvailable = !isRateLimited && !isExhausted
              const keyColor = KEY_COLORS[keyIdx]
              const statusColor = isExhausted ? '#ef4444' : isRateLimited ? '#f97316' : keyColor
              const statusLabel = isExhausted ? 'Hết' : isRateLimited ? 'Giới hạn' : 'Sẵn sàng'
              const keyPct = nvidiaKeyTotal > 0 ? (keyTokens / nvidiaKeyTotal) * 100 : 0

              return (
                <div key={keyIdx} className="nc-panel nc-sm nc-border-lime p-2.5 flex flex-col">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full transition-colors" style={{ backgroundColor: statusColor, boxShadow: isAvailable ? `0 0 4px ${keyColor}40` : 'none' }} />
                      <span className="text-[10px] font-semibold text-stone-300">Key {keyIdx + 1}</span>
                    </div>
                    <span className={`text-[8px] px-1.5 py-0.5 rounded font-medium ${isExhausted ? 'bg-red-950/50 text-red-400' : isRateLimited ? 'bg-orange-950/50 text-orange-400' : 'bg-green-950/50 text-green-400'}`}>{statusLabel}</span>
                  </div>
                  <p className="text-sm font-bold tabular-nums text-stone-200">{keyTokens > 0 ? formatNumber(keyTokens) : '—'}</p>
                  <p className="text-[8px] text-stone-500">token · 4 docs/key</p>
                  {keyTokens > 0 && (
                    <div className="mt-1.5 w-full h-1 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(keyPct, 3)}%`, backgroundColor: keyColor }} />
                    </div>
                  )}
                  {keyInfo && (
                    <div className="mt-1.5 flex justify-between text-[8px] text-stone-500">
                      <span>{keyInfo.dailyTokensUsed > 0 ? formatNumber(keyInfo.dailyTokensUsed) : '—'}/ngày</span>
                      <span>{keyInfo.dailyRequestCount > 0 ? `${keyInfo.dailyRequestCount} req` : ''}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Rate-limit / exhaustion warning for NVIDIA keys — only show for today's data */}
          {!selectedDate && (hasRateLimitedKeys || hasExhaustedKeys) && nvidiaDiagnostics && (
            <div className="nc-panel nc-sm p-2.5 border border-amber-500/40 bg-amber-950/20">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-[10px] font-semibold text-amber-300 tracking-wide">TRẠNG THÁI KEY NVIDIA</span>
                <span className="text-[9px] text-stone-400 ml-auto">{nvidiaDiagnostics.availableCount}/{nvidiaDiagnostics.keyCount} key khả dụng</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {nvidiaDiagnostics.keys.map((key, idx) => {
                  const isActive = !key.rateLimited && !key.exhausted && !key.dailyQuotaExhausted
                  if (isActive) return null
                  return (
                    <div key={idx} className={`rounded border p-2 ${key.exhausted || key.dailyQuotaExhausted ? 'border-red-500/40 bg-red-950/20' : 'border-orange-500/40 bg-orange-950/20'}`}>
                      <div className="flex items-center gap-1 mb-1">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${key.exhausted || key.dailyQuotaExhausted ? 'bg-red-500 animate-pulse' : 'bg-orange-500'}`} />
                        <span className="text-[9px] font-semibold text-stone-300">Key {idx + 1}</span>
                      </div>
                      <div className="text-[8px] text-stone-400 space-y-0.5">
                        {key.rateLimited && <p className="text-orange-400">Rate-limited</p>}
                        {key.exhausted && !key.dailyQuotaExhausted && <p className="text-red-400">Key hết hạn</p>}
                        {key.dailyQuotaExhausted && <p className="text-red-400">Hết hạn mức ngày</p>}
                        {key.failureCount > 0 && <p>Lỗi: {key.failureCount} lần</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* OpenCode Zen provider — 2 free models (nemotron + muse-spark) */}
          <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
            <div className="px-3 py-2.5 bg-emerald-950/60 border-b border-emerald-400/35">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">🌿</span>
                  <span className="text-xs font-bold text-emerald-400">OpenCode Zen</span>
                  <span className="text-[9px] text-stone-500">(space-bunny-free — 13 agents)</span>
                </div>
                <span className="text-[10px] font-bold tabular-nums text-stone-300">{zenTotal > 0 ? formatNumber(zenTotal) : '—'}</span>
              </div>
            </div>
            <div className="divide-y divide-stone-700/50">
              {Object.values(ZEN_CORE_CONFIG).map((cfg) => {
                const tokens = zenBunnyTokens
                const pct = zenTotal > 0 ? (tokens / zenTotal) * 100 : 0
                return (
                  <div key={cfg.model} className="px-3 py-2.5 hover:bg-slate-950/60 transition-colors">
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm flex-shrink-0">{cfg.icon}</span>
                        <div className="min-w-0">
                          <p className="text-[10px] text-stone-300 truncate font-medium" title={cfg.model}>{cfg.label}</p>
                          <p className="text-[8px] text-stone-500 truncate" title={cfg.role}>{cfg.role}</p>
                        </div>
                      </div>
                      <span className={`text-[10px] font-semibold tabular-nums flex-shrink-0 ${tokens > 0 ? 'text-stone-200' : 'text-stone-500'}`}>
                        {tokens > 0 ? formatNumber(tokens) : '—'}
                      </span>
                    </div>
                    {tokens > 0 && (
                      <div className="mt-1.5 w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(pct, 3)}%`, backgroundColor: cfg.barColor }} />
                      </div>
                    )}
                    {/* 2 đường gọi của space-bunny-free: HTTP trực tiếp + CLI fallback */}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="rounded-md bg-slate-950/50 border border-emerald-500/20 px-2 py-1.5 flex items-center justify-between gap-1">
                        <span className="text-[8px] text-stone-500 truncate">⚡ HTTP trực tiếp</span>
                        <span className={`text-[9px] font-semibold tabular-nums flex-shrink-0 ${zenBunnyHttpTokens > 0 ? 'text-emerald-400' : 'text-stone-600'}`}>
                          {zenBunnyHttpTokens > 0 ? formatNumber(zenBunnyHttpTokens) : '—'}
                        </span>
                      </div>
                      <div className="rounded-md bg-slate-950/50 border border-emerald-500/20 px-2 py-1.5 flex items-center justify-between gap-1">
                        <span className="text-[8px] text-stone-500 truncate">🛡 CLI fallback</span>
                        <span className={`text-[9px] font-semibold tabular-nums flex-shrink-0 ${zenBunnyCliTokens > 0 ? 'text-emerald-400' : 'text-stone-600'}`}>
                          {zenBunnyCliTokens > 0 ? formatNumber(zenBunnyCliTokens) : '—'}
                        </span>
                      </div>
                    </div>
                    {/* Models cũ (nemotron/muse) — chỉ còn ở dữ liệu lịch sử các ngày trước */}
                    {zenOtherTokens > 0 && (
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[8px] text-stone-600 truncate" title="nemotron-3-ultra-free / muse-spark-1.3-contributor-free (phiên 5-6)">+ models cũ phiên 5-6 (lịch sử)</span>
                        <span className="text-[9px] font-semibold tabular-nums text-stone-500">{formatNumber(zenOtherTokens)}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="px-3 py-1.5 bg-slate-950/40 border-t border-stone-700/40">
              <p className="text-[8px] text-stone-500">
                Provider: OpenCode Zen — space-bunny-free gọi trực tiếp qua HTTP (oc_sk key, không 403); CLI (zen-cli) là đường fallback. Token gộp cả 2 đường.
              </p>
            </div>
          </div>

          {/* Token theo nhóm lõi — 2 cột: Trích xuất + Agent/Chat */}
          <div className="grid grid-cols-2 gap-3">
            {/* Trích xuất column */}
            <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
              <div className={`px-3 py-2.5 ${NVIDIA_CORE_CONFIG.extraction.headerBg} border-b border-cyan-400/35`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{NVIDIA_CORE_CONFIG.extraction.icon}</span>
                    <span className={`text-xs font-bold ${NVIDIA_CORE_CONFIG.extraction.color}`}>{NVIDIA_CORE_CONFIG.extraction.label}</span>
                    <span className="text-[9px] text-stone-500">({NVIDIA_CORE_CONFIG.extraction.models.length} lõi)</span>
                  </div>
                  <span className="text-[10px] font-bold tabular-nums text-stone-300">{extractionTotal > 0 ? formatNumber(extractionTotal) : '—'}</span>
                </div>
              </div>
              <div className="divide-y divide-stone-700/50">
                {NVIDIA_CORE_CONFIG.extraction.models.map((model) => {
                  const tokens = nvidiaModels[model.key] || 0
                  const pct = extractionTotal > 0 ? (tokens / extractionTotal) * 100 : 0
                  return (
                    <div key={model.key} className="px-3 py-2.5 hover:bg-slate-950/60 transition-colors">
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[10px] text-stone-300 truncate font-medium" title={model.key}>{model.label}</span>
                        <span className={`text-[10px] font-semibold tabular-nums flex-shrink-0 ${tokens > 0 ? 'text-stone-200' : 'text-stone-500'}`}>
                          {tokens > 0 ? formatNumber(tokens) : '—'}
                        </span>
                      </div>
                      {tokens > 0 && (
                        <div className="mt-1.5 w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.max(pct, 3)}%`, backgroundColor: NVIDIA_CORE_CONFIG.extraction.barColor }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Agent / Chat column */}
            <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
              <div className={`px-3 py-2.5 ${NVIDIA_CORE_CONFIG.agent.headerBg} border-b border-cyan-400/35`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{NVIDIA_CORE_CONFIG.agent.icon}</span>
                    <span className={`text-xs font-bold ${NVIDIA_CORE_CONFIG.agent.color}`}>{NVIDIA_CORE_CONFIG.agent.label}</span>
                    <span className="text-[9px] text-stone-500">({NVIDIA_CORE_CONFIG.agent.models.length} lõi)</span>
                  </div>
                  <span className="text-[10px] font-bold tabular-nums text-stone-300">{agentTotal > 0 ? formatNumber(agentTotal) : '—'}</span>
                </div>
              </div>
              <div className="divide-y divide-stone-700/50">
                {NVIDIA_CORE_CONFIG.agent.models.map((model) => {
                  const tokens = nvidiaModels[model.key] || 0
                  const pct = agentTotal > 0 ? (tokens / agentTotal) * 100 : 0
                  return (
                    <div key={model.key} className="px-3 py-2.5 hover:bg-slate-950/60 transition-colors">
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[10px] text-stone-300 truncate font-medium" title={model.key}>{model.label}</span>
                        <span className={`text-[10px] font-semibold tabular-nums flex-shrink-0 ${tokens > 0 ? 'text-stone-200' : 'text-stone-500'}`}>
                          {tokens > 0 ? formatNumber(tokens) : '—'}
                        </span>
                      </div>
                      {tokens > 0 && (
                        <div className="mt-1.5 w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.max(pct, 3)}%`, backgroundColor: NVIDIA_CORE_CONFIG.agent.barColor }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

        </div>
      </CardContent>
    </Card>
    </div>
  )
}

