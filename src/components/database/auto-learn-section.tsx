'use client'

// ========================================================================
// auto-learn-section — Tab Auto-Learn (Database)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useEffect } from 'react'
import { Database, Loader2, RefreshCw, Brain, GraduationCap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'


// ==================== AUTO-LEARN SECTION (Phase 4) ====================

export interface AutoLearnRecord {
  id: string
  agentName: string
  query: string
  answerPreview: string
  confidence: number
  provider: string
  model: string
  entitiesCount: number
  relationshipsCount: number
  chunkSaved: boolean
  neo4jSynced: boolean
  status: string
  errorMessage?: string
  createdAt: string
}


export interface AutoLearnStats {
  totalRecords: number
  completedRecords: number
  failedRecords: number
  pendingRecords: number
  totalEntities: number
  totalRelationships: number
  totalChunks: number
}


/**
 * FIX 2026-09-10: thống kê pipeline học THẬT — Smart KB Writeback chạy sau MỖI lượt
 * chat (conf > 0.5 auto-write; 0.3–0.5 chờ phê duyệt tại Smolab → Learning),
 * thay cho legacy AutoLearnRecord (chỉ còn là fallback khi writeback throw).
 */
export interface LearningStats {
  writebacks: { total: number; completed: number; pending: number; needsReview: number; partial: number; failed: number; rejected: number }
  memories: { active: number; total: number }
  insights: number
  learningLogs: number
  recentLogs: Array<{ id: string; eventType: string; kind: string; summary: string; agentId: string; createdAt: string }>
  kgAutoLearn: { entities: number; relationships: number; documents: number } | null
}


export function AutoLearnSection() {
  const [records, setRecords] = useState<AutoLearnRecord[]>([])
  const [stats, setStats] = useState<AutoLearnStats | null>(null)
  // Pipeline học thật (writeback saga + memory + Neo4j auto-learn) — FIX 2026-09-10:
  // legacy AutoLearnRecord đã bị thay bởi Smart KB Writeback từ 2026-08-21, tab này
  // trước đây chỉ đọc bảng chết → giờ hiển thị cả hai, ưu tiên pipeline thật.
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null)
  const [loading, setLoading] = useState(true)
  // Neo4j sync status (DATA-LOSS FIX 2026-08-31): make the Auto-Learn loop actionable —
  // show how much knowledge is buffered in SQLite and let the user push it to Neo4j.
  const [syncInfo, setSyncInfo] = useState<{
    connected: boolean
    unsyncedEntities: number
    unsyncedRels: number
    unsyncedResolved: number
  } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const formatNumber = (n: number) => n.toLocaleString('vi-VN')

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-learn')
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
        setStats(data.stats || null)
        setLearningStats(data.learningStats || null)
      }
    } catch (err) {
      console.error('[AutoLearn] Fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync-neo4j?action=status')
      if (res.ok) {
        const data = await res.json()
        setSyncInfo({
          connected: true,
          unsyncedEntities: data.buffer?.unsyncedEntities ?? 0,
          unsyncedRels: data.buffer?.unsyncedRels ?? 0,
          unsyncedResolved: data.buffer?.unsyncedResolvedEntities ?? 0,
        })
      } else {
        setSyncInfo({ connected: false, unsyncedEntities: 0, unsyncedRels: 0, unsyncedResolved: 0 })
      }
    } catch {
      setSyncInfo({ connected: false, unsyncedEntities: 0, unsyncedRels: 0, unsyncedResolved: 0 })
    }
  }, [])

  const handleSyncNeo4j = useCallback(async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/sync-neo4j?action=sync-all')
      const data = await res.json()
      if (data.error) {
        setSyncMsg(`❌ Lỗi sync: ${data.error}`)
      } else {
        const s = data.summary || {}
        const anchorNote = data.legacyAnchor?.anchored > 0 ? `, bảo vệ thêm ${formatNumber(data.legacyAnchor.anchored)} entities chưa neo` : ''
        setSyncMsg(`✅ Đã đồng bộ: +${formatNumber(s.totalNodesCreated ?? 0)} nodes, +${formatNumber(s.totalRelsCreated ?? 0)} relationships — ${data.documentsProcessed ?? 0} tài liệu, ${data.resolvedEntities?.synced ?? 0} resolved entities${anchorNote}${data.errors ? `, ${data.errors.length} lỗi` : ''}`)
        await Promise.all([fetchData(), fetchSyncStatus()])
      }
    } catch (err) {
      setSyncMsg(`❌ Lỗi sync: ${err instanceof Error ? err.message : 'Unknown'}`)
    } finally {
      setSyncing(false)
    }
  }, [fetchData, fetchSyncStatus])

  useEffect(() => {
    // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
    queueMicrotask(() => {
      fetchData()
      fetchSyncStatus()
    })
    const interval = setInterval(() => {
      fetchData()
      fetchSyncStatus()
    }, 10000)
    return () => clearInterval(interval)
  }, [fetchData, fetchSyncStatus])

  const statusColor: Record<string, string> = {
    completed: 'text-emerald-400',
    failed: 'text-red-400',
    pending: 'text-amber-400',
  }
  const statusBg: Record<string, string> = {
    completed: 'bg-emerald-950/50',
    failed: 'bg-red-950/50',
    pending: 'bg-amber-950/50',
  }

  return (
    <div className="nc-wrap nc-lime">
    <Card className="nc-panel nc-md nc-border-lime">
      <CardHeader className="pb-1">
        <div className="flex flex-col items-center gap-1">
          <CardTitle className="text-base font-bold tracking-widest text-center text-white">AUTO-LEARN</CardTitle>
          <p className="text-[10px] text-stone-400">Smart KB Writeback — Agent tự học từ mỗi lượt chat, ghi vào Qdrant + Neo4j + Memory (conf &gt; 0.5)</p>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-3">
          {/* Stats Overview — pipeline học THẬT (writeback) + legacy để đối chiếu */}
          {learningStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="Số batch writeback hoàn thành đầy đủ (Qdrant + Neo4j + Memory + Insight + Log)">
                <p className="text-lg font-bold text-emerald-400">{formatNumber(learningStats.writebacks.completed)}</p>
                <p className="text-[9px] text-stone-400">WB hoàn thành</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="Tri thức vùng xám (conf 0.3–0.5) đang chờ bạn phê duyệt — xem module Smolab → tab Learning">
                <p className="text-lg font-bold text-amber-400">{formatNumber(learningStats.writebacks.needsReview)}</p>
                <p className="text-[9px] text-stone-400">Chờ phê duyệt</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="Entities Agent tự học từ chat, đang sống trong Neo4j graph (source=auto-learn)">
                <p className="text-lg font-bold text-cyan-400">{learningStats.kgAutoLearn ? formatNumber(learningStats.kgAutoLearn.entities) : '—'}</p>
                <p className="text-[9px] text-stone-400">Entities đã học (Neo4j)</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="Relationships Agent tự học từ chat trong Neo4j graph (source=auto-learn)">
                <p className="text-lg font-bold text-violet-400">{learningStats.kgAutoLearn ? formatNumber(learningStats.kgAutoLearn.relationships) : '—'}</p>
                <p className="text-[9px] text-stone-400">Rels đã học (Neo4j)</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="AgentMemory đang active — được đưa vào context mỗi lượt chat qua recallMemories">
                <p className="text-lg font-bold text-pink-400">{formatNumber(learningStats.memories.active)}</p>
                <p className="text-[9px] text-stone-400">Memories active</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="AgentInsight — insight trích xuất từ chat (hiển thị ở Smolab → Learning)">
                <p className="text-lg font-bold text-orange-400">{formatNumber(learningStats.insights)}</p>
                <p className="text-[9px] text-stone-400">Insights</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center" title="Bản ghi legacy autoLearnFromAnswer — chỉ chạy khi writeback lỗi (trước 2026-08-21 là đường chính)">
                <p className="text-lg font-bold text-stone-400">{stats ? formatNumber(stats.totalRecords) : '—'}</p>
                <p className="text-[9px] text-stone-400">Legacy records</p>
              </div>
            </div>
          )}

          {/* How it works — cập nhật 2026-09-10 theo pipeline hiện tại (writeback saga) */}
          <div className="nc-panel nc-sm nc-border-lime p-3">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="h-3.5 w-3.5 text-rose-400" />
              <span className="text-xs font-semibold text-stone-300">Cách hoạt động</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-stone-400">
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">1</span>
                <span>Sau mỗi lượt chat có giá trị → LLM trích xuất <span className="text-cyan-400">entities</span> + <span className="text-violet-400">relationships</span> kèm <span className="text-amber-400">confidence</span></span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">2</span>
                <span>conf <span className="text-emerald-400">&gt; 0.5</span> tự ghi vào <span className="text-green-400">Qdrant</span> + <span className="text-orange-400">Neo4j</span> + <span className="text-pink-400">AgentMemory</span>; vùng xám 0.3–0.5 xếp hàng chờ phê duyệt</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">3</span>
                <span>Phê duyệt vùng xám + timeline học: module <span className="text-lime-400">Smolab → tab Learning</span> (Mỗi batch có saga PendingWriteback đối soát)</span>
              </div>
            </div>
          </div>

          {/* Neo4j Sync — push buffered knowledge to the graph (DATA-LOSS FIX 2026-08-31) */}
          <div className="nc-panel nc-sm nc-border-lime p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="h-3.5 w-3.5 text-lime-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-stone-300">Đồng bộ Neo4j</span>
              {syncInfo && (
                <span className="text-[10px] text-stone-400" title="Số lượng tri thức đang chờ trong SQLite buffer, chưa đẩy lên Neo4j">
                  {syncInfo.connected
                    ? `Buffer chưa sync: ${formatNumber(syncInfo.unsyncedEntities)} entities · ${formatNumber(syncInfo.unsyncedRels)} rels · ${formatNumber(syncInfo.unsyncedResolved)} resolved`
                    : 'Neo4j chưa kết nối — kiểm tra NEO4J_URI / NEO4J_PASSWORD trong .env'}
                </span>
              )}
              <button
                onClick={handleSyncNeo4j}
                disabled={syncing || (syncInfo ? !syncInfo.connected : false)}
                className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold bg-gradient-to-r from-lime-600/90 to-emerald-600/90 text-white hover:from-lime-500 hover:to-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {syncing ? 'Đang đồng bộ...' : 'Sync to Neo4j'}
              </button>
            </div>
            {syncMsg && (
              <p className={`mt-2 text-[10px] rounded px-2 py-1.5 border ${syncMsg.startsWith('✅') ? 'text-emerald-300 bg-emerald-950/30 border-emerald-500/20' : 'text-red-300 bg-red-950/30 border-red-500/20'}`}>{syncMsg}</p>
            )}
          </div>

          {/* Recent Learning Activity — LearningLog thật từ writeback saga (FIX 2026-09-10) */}
          <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
            <div className="flex items-center gap-2 mb-0 px-3 py-2 bg-slate-950/60 border-b border-cyan-400/35">
              <GraduationCap className="h-3.5 w-3.5 text-stone-400" />
              <span className="text-xs font-semibold text-stone-300">Hoạt động học gần đây</span>
              <span className="text-[10px] text-stone-500 ml-auto">Tự cập nhật mỗi 10s</span>
            </div>
            {loading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-stone-400" />
                <span className="text-xs text-stone-500">Đang tải...</span>
              </div>
            ) : !learningStats || learningStats.recentLogs.length === 0 ? (
              <div className="py-6 text-center">
                <Brain className="h-8 w-8 mx-auto mb-2 text-stone-600" />
                <p className="text-xs text-stone-500">Chưa có hoạt động học nào được ghi lại.</p>
                <p className="text-[10px] text-stone-600 mt-1">
                  Học xảy ra tự động sau mỗi lượt chat có giá trị: conf &gt; 0.5 tự ghi vào KB, vùng xám 0.3–0.5 chờ phê duyệt (Smolab → Learning).
                </p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto dialog-scrollbar">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-950/80 backdrop-blur-sm z-10">
                    <tr className="border-b border-cyan-400/35">
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Loại</th>
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Nội dung</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Agent</th>
                      <th className="py-2 px-2 text-right font-semibold text-stone-300">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {learningStats.recentLogs.map((log, idx) => {
                      const timeAgo = Math.round((Date.now() - new Date(log.createdAt).getTime()) / 60000)
                      const timeStr = timeAgo < 60 ? `${timeAgo}m` : timeAgo < 1440 ? `${Math.round(timeAgo / 60)}h` : `${Math.round(timeAgo / 1440)}d`
                      const isWriteback = log.kind === 'kb-writeback'
                      return (
                        <tr key={log.id} className={`${idx % 2 === 0 ? 'bg-cyan-950/10' : ''} hover:bg-slate-950/50 transition-colors border-b border-stone-700/30`}>
                          <td className="py-2 px-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${isWriteback ? 'bg-emerald-950/50 text-emerald-400' : 'bg-stone-950/50 text-stone-400'}`}>
                              {isWriteback ? 'KB Writeback' : log.eventType}
                            </span>
                          </td>
                          <td className="py-2 px-2">
                            <span className="text-[10px] text-stone-300" title={log.summary}>{log.summary}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="text-[10px] text-stone-400 truncate max-w-[80px] inline-block align-middle" title={log.agentId}>{log.agentId}</span>
                          </td>
                          <td className="py-2 px-2 text-right">
                            <span className="text-[10px] text-stone-500 tabular-nums">{timeStr}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Legacy Auto-Learn records — chỉ hiện khi có dữ liệu (fallback path, trước 2026-08-21) */}
          {records.length > 0 && (
            <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
              <div className="flex items-center gap-2 mb-0 px-3 py-2 bg-slate-950/60 border-b border-stone-700/40">
                <GraduationCap className="h-3.5 w-3.5 text-stone-500" />
                <span className="text-xs font-semibold text-stone-400">Legacy Auto-Learn records</span>
                <span className="text-[9px] text-stone-600 px-1.5 py-0.5 rounded bg-stone-950/60 border border-stone-700/40">đường cũ — chỉ chạy khi writeback lỗi</span>
              </div>
              <div className="max-h-72 overflow-y-auto dialog-scrollbar">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-950/80 backdrop-blur-sm z-10">
                    <tr className="border-b border-stone-700/40">
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Agent</th>
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Query</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Conf</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Ent</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Rel</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Status</th>
                      <th className="py-2 px-2 text-right font-semibold text-stone-300">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((rec, idx) => {
                      const timeAgo = Math.round((Date.now() - new Date(rec.createdAt).getTime()) / 60000)
                      const timeStr = timeAgo < 60 ? `${timeAgo}m` : timeAgo < 1440 ? `${Math.round(timeAgo / 60)}h` : `${Math.round(timeAgo / 1440)}d`
                      return (
                        <tr key={rec.id} className={`${idx % 2 === 0 ? 'bg-cyan-950/5' : ''} hover:bg-slate-950/50 transition-colors border-b border-stone-700/20`}>
                          <td className="py-2 px-2">
                            <span className="text-[10px] font-medium text-white truncate max-w-[80px] inline-block align-middle">{rec.agentName}</span>
                          </td>
                          <td className="py-2 px-2">
                            <span className="text-[10px] text-stone-300 truncate max-w-[150px] inline-block align-middle" title={rec.query}>{rec.query}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className={`text-[10px] font-semibold tabular-nums ${rec.confidence >= 0.7 ? 'text-emerald-400' : rec.confidence >= 0.5 ? 'text-amber-400' : 'text-red-400'}`}>
                              {(rec.confidence * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="text-[10px] tabular-nums text-cyan-400">{rec.entitiesCount || '—'}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="text-[10px] tabular-nums text-violet-400">{rec.relationshipsCount || '—'}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${statusBg[rec.status] || 'bg-stone-950/50'} ${statusColor[rec.status] || 'text-stone-400'} font-medium`}>
                              {rec.status === 'completed' ? '✓' : rec.status === 'failed' ? '✗' : '…'}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-right">
                            <span className="text-[10px] text-stone-500 tabular-nums">{timeStr}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
    </div>
  )
}

