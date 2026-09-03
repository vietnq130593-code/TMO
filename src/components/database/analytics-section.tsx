'use client'

// ========================================================================
// analytics-section — Tab Analytics (Database) — recharts + Neo4jVerification
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend as RechartsLegend } from 'recharts'
import { Database, Network, Cpu, CheckCircle2, XCircle, Loader2, RefreshCw, Zap, Activity, AlertTriangle, Info, Shield, Trash2, Search, GitBranch, BookOpen, BarChart3, Lightbulb, Target, TrendingUp, X, PieChart as PieChartIcon, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { HealthResponse, DocumentRecord, EmbeddingStatus, DOMAIN_LABELS, DBStats, formatTokenCount } from '@/components/app-shared'


// ==================== ENTITY TYPE COLORS ====================

export const ENTITY_TYPE_COLORS: Record<string, string> = {
  Concept: '#10b981',
  Algorithm: '#f59e0b',
  Language: '#f43f5e',
  Tool: '#06b6d4',
  System: '#f97316',
  Technique: '#8b5cf6',
  Vulnerability: '#ef4444',
  Principle: '#64748b',
  Domain: '#a855f7',
  Document: '#0ea5e9',
  Person: '#d946ef',
}


// ==================== ENTITIES SECTION ====================

// Entities and Relationships tabs removed — their data is now available in Analytics tab

// ==================== ANALYTICS SECTION ====================

export const DOMAIN_CHART_COLORS: Record<string, string> = {
  programming: '#14b8a6',
  algorithm: '#f59e0b',
  ml: '#8b5cf6',
  meta_cognitive: '#ec4899',
  linux: '#f97316',
  security: '#ef4444',
  mixed: '#6b7280',
}


export const REL_TYPE_COLORS: Record<string, string> = {
  USES: '#14b8a6',
  IMPLEMENTED_IN: '#f59e0b',
  RELATED_TO: '#8b5cf6',
  DEPENDS_ON: '#f97316',
  PART_OF: '#ec4899',
  ENABLES: '#06b6d4',
  SUPPORTS: '#10b981',
  CONTAINS: '#64748b',
  EXTENDS: '#d946ef',
  APPLIES_TO: '#84cc16',
  CONTRASTS_WITH: '#dc2626',
  EXPLOITS: '#ef4444',
  MITIGATES: '#22c55e',
  RUNS_ON: '#0ea5e9',
}


export interface AnalyticsData {
  documents: DocumentRecord[]
  embeddingStatus: EmbeddingStatus | null
  loading: boolean
  dbStats: DBStats | null
  // FIX #8 (display bug): pass parent's health down so Neo4jVerification can
  // react to fetchHealth() updates instead of having its own stale internal state.
  health?: HealthResponse | null
}


export function AnalyticsSection({ data, onRefreshStats }: { data: AnalyticsData; onRefreshStats?: () => void }) {
  const { documents, embeddingStatus, loading, dbStats, health } = data
  const [reconcileLoading, setReconcileLoading] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<{ removed: number; merged: number } | null>(null)

  const handleReconcileOrphans = useCallback(async () => {
    setReconcileLoading(true)
    setReconcileResult(null)
    try {
      const res = await fetch('/api/query?action=reconcile-orphans')
      const result = await res.json()
      if (result.success) {
        setReconcileResult({ removed: result.orphans_deleted || 0, merged: result.selfrefs_deleted || 0 })
        onRefreshStats?.()
      }
    } catch (err) {
      console.error('Reconcile failed:', err)
    } finally {
      setReconcileLoading(false)
    }
  }, [onRefreshStats])

  // Compute overview stats — use DB stats (accurate, always available from API)
  const stats = useMemo(() => {
    const totalDocs = dbStats?.totalDocuments ?? documents.length
    const totalEntities = dbStats?.totalEntities ?? 0
    const totalRelationships = dbStats?.totalRelationships ?? 0

    // Real embedding %
    const realEmbedRatio = embeddingStatus ? embeddingStatus.realRatio : 0

    // Average confidence — use DB value
    const avgConfidence = dbStats?.avgConfidence ?? 0

    // Knowledge Graph Density — use DB value
    const graphDensity = dbStats?.graphDensity ?? (totalEntities > 1 ? totalRelationships / ((totalEntities * (totalEntities - 1)) / 2) : 0)

    return { totalDocs, totalEntities, totalRelationships, realEmbedRatio, avgConfidence, graphDensity }
  }, [documents, embeddingStatus, dbStats])

  // Domain coverage data — from DB stats
  const domainData = useMemo(() => {
    const allDomains = ['programming', 'algorithm', 'ml', 'meta_cognitive', 'linux', 'security', 'mixed']
    return allDomains.map(d => ({
      domain: DOMAIN_LABELS[d] || d,
      count: dbStats?.domainDistribution?.[d] || 0,
      fill: DOMAIN_CHART_COLORS[d],
    }))
  }, [dbStats])

  // Entity type distribution data — from DB stats
  const entityTypeData = useMemo(() => {
    if (!dbStats?.entityTypeDistribution) return []
    return Object.entries(dbStats.entityTypeDistribution)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({
        name: type,
        value: count,
        fill: ENTITY_TYPE_COLORS[type] || '#9ca3af',
      }))
  }, [dbStats])

  // Relationship type distribution data — from DB stats
  const relTypeData = useMemo(() => {
    if (!dbStats?.relTypeDistribution) return []
    return Object.entries(dbStats.relTypeDistribution)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({
        type,
        count,
        fill: REL_TYPE_COLORS[type] || '#94a3b8',
      }))
  }, [dbStats])

  // Quality metrics
  const qualityMetrics = useMemo(() => {
    // Embedding quality: real vs pseudo
    const embedTotal = embeddingStatus ? embeddingStatus.total : 0
    const embedReal = embeddingStatus ? embeddingStatus.real : 0
    const embedPseudo = embeddingStatus ? embeddingStatus.pseudo : 0
    const embedQuality = embedTotal > 0 ? embedReal / embedTotal : 0

    // Extraction confidence: average confidence (from DB stats)
    const avgConf = stats.avgConfidence

    // Graph connectivity: percentage of entities that appear in at least one relationship
    const entitiesInRels = dbStats?.entitiesInRelationships ?? 0
    const totalEnts = dbStats?.totalEntities ?? 0
    const connectivity = totalEnts > 0 ? entitiesInRels / totalEnts : 0

    // Orphan entities: use ACCURATE count from DB stats (entities not in any relationship)
    // NOT the old formula (totalEnts - resolvedEntities) which was WRONG — it counted unresolved duplicates
    const orphanCount = dbStats?.orphanEntityCount ?? 0

    return { embedTotal, embedReal, embedPseudo, embedQuality, avgConf, connectivity, orphanCount }
  }, [embeddingStatus, stats, dbStats])

  // Gap analysis — use DB stats when available (accurate)
  const gapAnalysis = useMemo(() => {
    const gaps: Array<{ severity: 'warning' | 'info' | 'suggestion'; message: string }> = []

    // Domains with few entities — use DB stats
    const allDomains = ['programming', 'algorithm', 'ml', 'meta_cognitive', 'linux', 'security', 'mixed']
    const domainCounts: Record<string, number> = {}
    allDomains.forEach(d => { domainCounts[d] = dbStats?.domainDistribution?.[d] ?? 0 })
    allDomains.forEach(d => {
      if (domainCounts[d] === 0) {
        gaps.push({ severity: 'warning', message: `Domain "${DOMAIN_LABELS[d]}" chưa có entity nào` })
      } else if (domainCounts[d] <= 2) {
        gaps.push({ severity: 'warning', message: `Domain "${DOMAIN_LABELS[d]}" chỉ có ${domainCounts[d]} entities` })
      }
    })

    // Entity types with few instances — use DB stats
    const typeCounts: Record<string, number> = {}
    const knownTypes = Object.keys(ENTITY_TYPE_COLORS)
    knownTypes.forEach(t => { typeCounts[t] = dbStats?.entityTypeDistribution?.[t] ?? 0 })
    knownTypes.forEach(t => {
      if (!typeCounts[t] || typeCounts[t] === 0) {
        gaps.push({ severity: 'info', message: `Entity type "${t}" chưa có instance nào` })
      } else if (typeCounts[t] === 1) {
        gaps.push({ severity: 'info', message: `Entity type "${t}" chỉ có 1 instance` })
      }
    })

    // Suggestions
    if (qualityMetrics.orphanCount > 0) {
      gaps.push({ severity: 'suggestion', message: `Có ${qualityMetrics.orphanCount} orphan entities — cân nhắc thêm relationships để kết nối chúng` })
    }
    if (qualityMetrics.embedQuality < 0.5 && qualityMetrics.embedTotal > 0) {
      gaps.push({ severity: 'suggestion', message: 'Tỷ lệ real embedding thấp — hãy tạo embedding thật để cải thiện Vector Search' })
    }
    if (stats.graphDensity < 0.01 && stats.totalEntities > 0) {
      gaps.push({ severity: 'suggestion', message: 'Độ dày graph thấp — thêm relationships để tạo Knowledge Graph phong phú hơn' })
    }
    const weakDomains = allDomains.filter(d => domainCounts[d] <= 2)
    if (weakDomains.length > 0) {
      gaps.push({ severity: 'suggestion', message: `Cân nhắc thêm tài liệu cho: ${weakDomains.map(d => DOMAIN_LABELS[d]).join(', ')}` })
    }

    return gaps
  }, [qualityMetrics, stats, dbStats])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-3 text-sm text-muted-foreground">Đang tải dữ liệu Analytics...</span>
      </div>
    )
  }

  if (stats.totalEntities === 0 && stats.totalDocs === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-20" />
        <p className="text-sm font-medium">Chưa có dữ liệu Analytics</p>
        <p className="text-xs mt-1">Tải lên và xử lý tài liệu để xem thống kê</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* A. Overview Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-950/50"><BookOpen className="h-4 w-4 text-teal-400" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{dbStats?.documentsByStatus ? ((dbStats.documentsByStatus['extracted'] || 0) + (dbStats.documentsByStatus['indexed'] || 0)) + '/' + stats.totalDocs : stats.totalDocs}</p>
              <p className="text-[10px] text-stone-400">Tài liệu</p>
            </div>
          </div>
        </Card></div>
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-950/50"><Zap className="h-4 w-4 text-amber-500" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{dbStats?.dailyTokens ? formatTokenCount(dbStats.dailyTokens.tokens) : '0'}</p>
              <p className="text-[10px] text-stone-400">Token hôm nay</p>
            </div>
          </div>
        </Card></div>
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-950/50"><GitBranch className="h-4 w-4 text-orange-400" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{stats.totalRelationships}</p>
              <p className="text-[10px] text-stone-400">Relationships</p>
            </div>
          </div>
        </Card></div>
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-950/50"><TrendingUp className="h-4 w-4 text-teal-400" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{(stats.realEmbedRatio * 100).toFixed(0)}%</p>
              <p className="text-[10px] text-stone-400">Real Embed</p>
            </div>
          </div>
        </Card></div>
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-950/50"><Target className="h-4 w-4 text-amber-500" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{stats.avgConfidence.toFixed(2)}</p>
              <p className="text-[10px] text-stone-400">Confidence TB</p>
            </div>
          </div>
        </Card></div>
        <div className="nc-wrap nc-amber"><Card className="nc-panel nc-sm nc-border-amber metric-sparkle p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-violet-950/50"><Network className="h-4 w-4 text-violet-400" /></div>
            <div>
              <p className="text-xl font-bold tracking-tight text-stone-100">{(stats.graphDensity * 100).toFixed(1)}%</p>
              <p className="text-[10px] text-stone-400">Graph Density</p>
            </div>
          </div>
        </Card></div>
      </div>

      {/* B. Domain Coverage + C. Entity Type Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Domain Coverage Bar Chart */}
        <div className="nc-wrap nc-amber">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600"><BarChart3 className="h-4 w-4 text-white" /></div>
              <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Domain Coverage</CardTitle>
            </div>
            <CardDescription className="text-xs text-stone-400">Số lượng entities theo từng lĩnh vực</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={domainData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
                  <XAxis dataKey="domain" tick={{ fontSize: 10, fill: '#a8a29e' }} angle={-20} textAnchor="end" height={50} />
                  <YAxis tick={{ fontSize: 10, fill: '#a8a29e' }} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #44403c', backgroundColor: '#292524', color: '#d6d3d1' }}
                    formatter={(value: number, name: string) => [value, 'Entities']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {domainData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        </div>

        {/* Entity Type Distribution Pie Chart */}
        <div className="nc-wrap nc-amber">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600"><PieChartIcon className="h-4 w-4 text-white" /></div>
              <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Entity Type Distribution</CardTitle>
            </div>
            <CardDescription className="text-xs text-stone-400">Phân bổ theo loại entity</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={entityTypeData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => ({ value: `${name} ${(percent * 100).toFixed(0)}%`, fill: '#d6d3d1', fontSize: 10 } as unknown as React.ReactNode)}
                  >
                    {entityTypeData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #44403c', backgroundColor: '#292524', color: '#d6d3d1' }}
                    formatter={(value: number, name: string) => [value, name]}
                  />
                  <RechartsLegend
                    wrapperStyle={{ fontSize: 10, color: '#a8a29e' }}
                    iconSize={8}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>

      {/* D. Relationship Type Distribution + E. Quality Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Relationship Type Distribution - Horizontal Bar Chart */}
        <div className="nc-wrap nc-amber">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600"><GitBranch className="h-4 w-4 text-white" /></div>
              <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Relationship Types</CardTitle>
            </div>
            <CardDescription className="text-xs text-stone-400">Số lượng theo loại quan hệ</CardDescription>
          </CardHeader>
          <CardContent>
            {relTypeData.length === 0 ? (
              <div className="flex items-center justify-center h-[200px] text-muted-foreground text-xs">
                Chưa có relationship nào
              </div>
            ) : (
              <div className="h-[Math.max(200, relTypeData.length * 36)]px" style={{ height: Math.max(200, relTypeData.length * 36) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={relTypeData} layout="vertical" margin={{ top: 5, right: 20, left: 60, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#44403c" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#a8a29e' }} allowDecimals={false} />
                    <YAxis dataKey="type" type="category" tick={{ fontSize: 10, fill: '#a8a29e' }} width={55} />
                    <RechartsTooltip
                      contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #44403c', backgroundColor: '#292524', color: '#d6d3d1' }}
                      formatter={(value: number) => [value, 'Count']}
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {relTypeData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
        </div>

        {/* Quality Metrics */}
        <div className="nc-wrap nc-amber">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600"><Activity className="h-4 w-4 text-white" /></div>
              <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Quality Metrics</CardTitle>
            </div>
            <CardDescription className="text-xs text-stone-400">Chất lượng dữ liệu Knowledge Base</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Embedding Quality */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-stone-200">Embedding Quality</span>
                  <span className="text-xs text-muted-foreground">
                    {qualityMetrics.embedReal} real / {qualityMetrics.embedPseudo} pseudo
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress value={qualityMetrics.embedQuality * 100} className="h-2.5 flex-1" />
                  <span className="text-xs font-semibold w-10 text-right text-stone-200">{(qualityMetrics.embedQuality * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Extraction Confidence */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-stone-200">Extraction Confidence</span>
                  <span className="text-xs text-muted-foreground">Trung bình</span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress value={qualityMetrics.avgConf * 100} className="h-2.5 flex-1" />
                  <span className="text-xs font-semibold w-10 text-right text-stone-200">{(qualityMetrics.avgConf * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Graph Connectivity */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-stone-200">Graph Connectivity</span>
                  <span className="text-xs text-muted-foreground">Entities có relationship</span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress value={qualityMetrics.connectivity * 100} className="h-2.5 flex-1" />
                  <span className="text-xs font-semibold w-10 text-right text-stone-200">{(qualityMetrics.connectivity * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Orphan Entities */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-stone-200">Orphan Entities</span>
                  <div className="flex items-center gap-1.5">
                    {qualityMetrics.orphanCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] px-2 border-amber-700 text-amber-400 hover:bg-amber-900/40 btn-glow"
                        onClick={handleReconcileOrphans}
                        disabled={reconcileLoading}
                      >
                        {reconcileLoading ? (
                          <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Đang dọn...</>
                        ) : (
                          <><Trash2 className="h-3 w-3 mr-1" /> Dọn dẹp</>
                        )}
                      </Button>
                    )}
                    <Badge variant={qualityMetrics.orphanCount > 0 ? 'destructive' : 'secondary'} className="text-[10px] h-4 px-1.5">
                      {qualityMetrics.orphanCount}
                    </Badge>
                  </div>
                </div>
                {reconcileResult && (
                  <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/55 text-xs text-emerald-400 mb-2">
                    <CheckCircle2 className="h-3 w-3 inline mr-1" />
                    Đã xóa {reconcileResult.removed} orphan entities, {reconcileResult.merged} self-reference relationships
                  </div>
                )}
                {qualityMetrics.orphanCount > 0 && (
                  <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/55 text-xs text-amber-400">
                    <AlertTriangle className="h-3 w-3 inline mr-1" />
                    {qualityMetrics.orphanCount} entities không có relationship nào
                    {dbStats && (
                      <span className="block mt-1 text-[10px] text-amber-500">
                        ({dbStats.entitiesInRelationships}/{dbStats.totalEntities} entities có relationship, {dbStats.orphanResolvedCount} resolved entities bị cô lập)
                      </span>
                    )}
                  </div>
                )}
                {qualityMetrics.orphanCount === 0 && (
                  <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/55 text-xs text-emerald-400">
                    <CheckCircle2 className="h-3 w-3 inline mr-1" /> Tất cả entities đều có relationship
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>

      {/* F. Data Tier Verification */}
      <div className="nc-wrap nc-amber">
      <Card className="nc-panel nc-md nc-border-amber">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600"><Shield className="h-4 w-4 text-white" /></div>
            <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Kiểm tra Dữ liệu 3 Tầng</CardTitle>
          </div>
          <CardDescription className="text-xs text-stone-400">Xác minh dữ liệu đã được ghi vào Qdrant, Neo4j và Vector Embeddings</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Qdrant Tier */}
            <div className="p-4 rounded-xl border border-teal-500/55 bg-teal-950/30 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Database className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-semibold text-cyan-400">Qdrant (Vector + Document)</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Tài liệu:</span><span className="font-medium text-stone-200">{stats.totalDocs}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Raw Entities:</span><span className="font-medium text-stone-200">{stats.totalEntities}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Resolved Entities:</span><span className="font-medium text-stone-200">{dbStats?.totalResolvedEntities ?? (stats.totalEntities > 0 ? `~${Math.round(stats.totalEntities / 2.7)}` : 0)} <span className="text-muted-foreground text-[9px]">(sau hợp nhất)</span></span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Relationships:</span><span className="font-medium text-stone-200">{stats.totalRelationships}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Real Embeddings:</span><span className="font-medium text-stone-200">{qualityMetrics.embedReal}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Pseudo Embeddings:</span><span className="font-medium text-stone-200">{qualityMetrics.embedPseudo}</span></div>
              </div>
              {stats.totalDocs > 0 && stats.totalEntities > 0 ? (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Dữ liệu OK</div>
              ) : (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-500"><AlertTriangle className="h-3 w-3" /> Chưa có đủ dữ liệu</div>
              )}
            </div>

            {/* Neo4j Tier */}
            <div className="p-4 rounded-xl border border-violet-500/55 bg-violet-950/30 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Network className="h-4 w-4 text-violet-400" />
                <span className="text-xs font-semibold text-violet-400">Neo4j (Graph)</span>
              </div>
              <Neo4jVerification health={health} />
            </div>

            {/* Vector Tier */}
            <div className="p-4 rounded-xl border border-emerald-500/55 bg-emerald-950/30 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="h-4 w-4 text-teal-400" />
                <span className="text-xs font-semibold text-teal-400">Vector Embeddings</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Tổng embeddings:</span><span className="font-medium text-stone-200">{qualityMetrics.embedTotal}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Real (2048-dim):</span><span className="font-medium text-stone-200">{qualityMetrics.embedReal}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Pseudo (hash):</span><span className="font-medium text-stone-200">{qualityMetrics.embedPseudo}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Chất lượng:</span><span className="font-medium text-stone-200">{(qualityMetrics.embedQuality * 100).toFixed(0)}%</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Dimension:</span><span className="font-medium text-stone-200">{embeddingStatus?.dimension || 2048}</span></div>
              </div>
              {qualityMetrics.embedReal > 0 ? (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Vector Search sẵn sàng</div>
              ) : (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-500"><AlertTriangle className="h-3 w-3" /> Chỉ có pseudo-embedding</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* G. Gap Analysis */}
      <div className="nc-wrap nc-amber">
      <Card className="nc-panel nc-md nc-border-amber">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600"><AlertCircle className="h-4 w-4 text-white" /></div>
            <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Gap Analysis</CardTitle>
          </div>
          <CardDescription className="text-xs text-stone-400">Khoảng trống kiến thức và đề xuất cải thiện</CardDescription>
        </CardHeader>
        <CardContent>
          {gapAnalysis.length === 0 ? (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/55 text-xs text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 inline mr-1" /> Knowledge Base đang cân bằng — không phát hiện khoảng trống đáng kể
            </div>
          ) : (
            <div className="space-y-2 max-h-[280px] overflow-y-auto custom-scrollbar pr-1">
              {gapAnalysis.map((gap, i) => (
                <div key={i} className={`p-3 rounded-xl border flex items-start gap-2 text-xs ${
                  gap.severity === 'warning' ? 'bg-amber-950/40 border-amber-500/55 text-amber-400' :
                  gap.severity === 'info' ? 'bg-teal-950/40 border-teal-500/55 text-teal-400' :
                  'bg-emerald-950/40 border-emerald-500/55 text-emerald-400'
                }`}>
                  {gap.severity === 'warning' && <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                  {gap.severity === 'info' && <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                  {gap.severity === 'suggestion' && <Lightbulb className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                  <span>{gap.message}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}


// ==================== NEO4J VERIFICATION COMPONENT ====================

export function Neo4jVerification({ health }: { health?: HealthResponse | null }) {
  // Local fallback state — used when parent's `health` prop hasn't loaded yet
  // (e.g. user just switched to the analytics tab and fetchHealth() hasn't
  // returned). Once parent's health arrives, we prefer it over localData.
  const [localData, setLocalData] = useState<{ nodeCount: number; relationshipCount: number; labels: string[]; connected: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  // FIX #8 (display bug): accept a `force` flag to bypass the 20s Neo4j health cache.
  // Used by the "Làm mới" button and after cleanup so the panel shows fresh counts
  // immediately after a "Tiếp tục" pipeline writes new nodes/relationships to Neo4j.
  const checkNeo4j = useCallback(async (force: boolean = false) => {
    try {
      const res = await fetch('/api/health' + (force ? '?force=true' : ''))
      if (!res.ok) throw new Error('Health API không khả dụng')
      const data = await res.json()
      const neo4j = data.services?.neo4j
      if (neo4j?.connected) {
        setLocalData({
          connected: true,
          nodeCount: neo4j.nodeCount ?? 0,
          relationshipCount: neo4j.relationshipCount ?? 0,
          labels: neo4j.labels ?? [],
        })
      } else {
        setLocalData({ connected: false, nodeCount: 0, relationshipCount: 0, labels: [] })
      }
    } catch {
      setLocalData({ connected: false, nodeCount: 0, relationshipCount: 0, labels: [] })
    }
    setLoading(false)
  }, [])

  // Fetch once on mount (covers the initial load before parent's health arrives).
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  useEffect(() => { queueMicrotask(() => { checkNeo4j() }) }, [checkNeo4j])

  // FIX #8: auto-refresh every 30s. 30s > 20s cache TTL → each call returns fresh
  // data without forcing (no extra Aura load). This catches writes that happen
  // while the analytics tab is open but the user isn't actively pressing buttons.
  useEffect(() => {
    const interval = setInterval(() => { checkNeo4j() }, 30000)
    return () => clearInterval(interval)
  }, [checkNeo4j])

  // FIX #8: prefer parent's `health` prop (which updates every 10s via fetchHealth()
  // and immediately with force=true after a pipeline finishes — see handleProcessDoc
  // .finally() block). This is the primary fix: without it, the panel only updates
  // on its own 30s interval and the user sees "no change" right after Tiếp tục.
  const neo4jHealth = health?.services?.neo4j
  const neo4jData = neo4jHealth?.connected
    ? {
        connected: true,
        nodeCount: neo4jHealth.nodeCount ?? 0,
        relationshipCount: neo4jHealth.relationshipCount ?? 0,
        labels: neo4jHealth.labels ?? [],
      }
    : neo4jHealth // parent's health loaded but Neo4j not connected
      ? { connected: false, nodeCount: 0, relationshipCount: 0, labels: [] }
      : localData // parent's health not yet loaded — fall back to local fetch

  const handleRefreshNeo4j = useCallback(async () => {
    setRefreshing(true)
    await checkNeo4j(true) // force=true — bypass 20s cache for immediate refresh
    setRefreshing(false)
  }, [checkNeo4j])

  const handleCleanNeo4j = useCallback(async () => {
    if (!confirm('Xóa toàn bộ dữ liệu Neo4j và đồng bộ lại? Điều này sẽ xóa tất cả nodes và relationships hiện có.')) return
    setCleaning(true)
    try {
      const res = await fetch('/api/setup/neo4j?action=clean', { method: 'DELETE' })
      const data = await res.json()
      if (data.success) {
        const backupNote = data.backup?.file
          ? `\n\n🛡️ Backup an toàn đã lưu: ${data.backup.file} (${data.backup.nodes} nodes, ${data.backup.rels} rels) — xem trong thư mục db/`
          : (data.backup?.error ? `\n\n⚠️ Backup thất bại: ${data.backup.error}` : '')
        alert(`Đã dọn dẹp Neo4j: ${data.before.relationships}→${data.after.relationships} relationships, ${data.documentsReset} tài liệu cần đồng bộ lại${backupNote}`)
        await checkNeo4j(true) // force=true — bypass cache after cleanup
      } else {
        alert(`Lỗi: ${data.error}`)
      }
    } catch (err) {
      alert(`Lỗi: ${err instanceof Error ? err.message : 'Unknown'}`)
    }
    setCleaning(false)
  }, [checkNeo4j])

  if (loading && !neo4jData) {
    return (
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">Kết nối:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Nodes:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Relationships:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
      </div>
    )
  }

  if (!neo4jData?.connected) {
    return (
      <div className="space-y-1.5 text-xs">
        <div className="mt-2 flex items-center gap-1 text-[10px] text-red-400"><XCircle className="h-3 w-3" /> Không kết nối được Neo4j</div>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-6 text-[10px] mt-1 border-cyan-400/35 hover:bg-cyan-900/40 hover:text-cyan-300 hover:border-cyan-300"
          onClick={handleRefreshNeo4j}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Làm mới
        </Button>
      </div>
    )
  }

  // Detect abnormal rels/nodes ratio (normal is ~2-5x, buggy was ~41x)
  const relsPerNode = neo4jData.nodeCount > 0 ? neo4jData.relationshipCount / neo4jData.nodeCount : 0
  const isAbnormalRatio = relsPerNode > 15

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex justify-between"><span className="text-muted-foreground">Kết nối:</span><span className="font-medium text-emerald-400">✓</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Nodes:</span><span className="font-medium text-stone-200">{neo4jData.nodeCount.toLocaleString()}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Relationships:</span><span className={`font-medium text-stone-200 ${isAbnormalRatio ? 'text-red-400' : ''}`}>{neo4jData.relationshipCount.toLocaleString()}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Entity Types:</span><span className="font-medium text-stone-200">{neo4jData.labels.length}</span></div>
      {isAbnormalRatio && (
        <div className="mt-1 p-1.5 rounded bg-red-950/50 border border-red-500/55 text-[10px] text-red-400">
          <div className="flex items-center gap-1 font-semibold mb-0.5"><AlertTriangle className="h-3 w-3" /> Rels/Nodes bất thường ({relsPerNode.toFixed(1)}x)</div>
          <div>Quan hệ bị phồng do lỗi cross-product. Nhấn &quot;Dọn dẹp&quot; để sửa.</div>
        </div>
      )}
      {neo4jData.nodeCount > 0 && !isAbnormalRatio ? (
        <div className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Graph có dữ liệu</div>
      ) : neo4jData.nodeCount === 0 ? (
        <div className="flex items-center gap-1 text-[10px] text-amber-500"><AlertTriangle className="h-3 w-3" /> Graph trống</div>
      ) : null}
      {neo4jData.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {neo4jData.labels.slice(0, 8).map(label => (
            <Badge key={label} className="text-[8px] h-3.5 px-1 bg-violet-950/50 text-violet-400">{label}</Badge>
          ))}
          {neo4jData.labels.length > 8 && <Badge className="text-[8px] h-3.5 px-1 bg-stone-950/50 text-stone-400">+{neo4jData.labels.length - 8}</Badge>}
        </div>
      )}
      {/* FIX #8: "Làm mới" button — bypasses 20s cache with ?force=true so the
          user can manually refresh after a Tiếp tục/processing pipeline. */}
      <Button
        variant="outline"
        size="sm"
        className="w-full h-6 text-[10px] mt-1 border-cyan-400/35 hover:bg-cyan-900/40 hover:text-cyan-300 hover:border-cyan-300"
        onClick={handleRefreshNeo4j}
        disabled={refreshing}
      >
        {refreshing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
        Làm mới
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="w-full h-6 text-[10px] mt-1 border-cyan-400/35 hover:bg-red-900/40 hover:text-red-400 hover:border-red-300 btn-glow"
        onClick={handleCleanNeo4j}
        disabled={cleaning}
      >
        {cleaning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1" />}
        Dọn dẹp &amp; Đồng bộ lại Neo4j
      </Button>
    </div>
  )
}

