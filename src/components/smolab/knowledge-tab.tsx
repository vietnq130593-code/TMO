'use client'

// ========================================================================
// knowledge-tab — Tab Knowledge Bridge (Smolab)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useEffect } from 'react'
import { Database, Network, Cpu, Loader2, ChevronDown, ChevronRight, ChevronUp, Activity, Play, Shield, MessageSquare, Eye, Search, Layers, GitBranch, X, AlertCircle, Settings, Table } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/hooks/use-toast'


// ==================== KNOWLEDGE TAB CONTENT ====================

export function KnowledgeTabContent() {
  // Schema data — matches the actual /api/openclaw/knowledge/schema response
  const [schemaData, setSchemaData] = useState<{
    prisma: {
      models: string[]
      details: Record<string, { fields: string[]; indexes: string[]; rowCount: number }>
    }
    neo4j: { labels: string[]; relationshipTypes: string[]; nodeCount: number; relationshipCount: number }
    qdrant: { collections: Array<{ name: string; pointCount: number; vectorSize: number; status: string }> }
  } | null>(null)

  // Query simulator state
  const [queryType, setQueryType] = useState<'cypher' | 'sql'>('cypher')
  const [queryString, setQueryString] = useState('')
  const [queryResult, setQueryResult] = useState<{ columns: string[]; records: Record<string, unknown>[]; count: number } | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState('')

  // Context config
  const [contextConfig, setContextConfig] = useState<{
    autoKBSearch: boolean; injectSchemaIntoSystemPrompt: boolean; knowledgeSources: string; topK: number; maxContextLength: string
  } | null>(null)
  const [contextPreview, setContextPreview] = useState<string | null>(null)
  const [showContextPreview, setShowContextPreview] = useState(false)

  // Access policy
  const [policy, setPolicy] = useState<{
    allowRead: boolean; allowWrite: boolean; allowDelete: boolean; allowedCollections: string; allowedLabels: string
  } | null>(null)
  const [policySaving, setPolicySaving] = useState(false)

  // Schema browser expand/collapse
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleModel = (key: string) => {
    setExpandedModels(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Preset queries
  const PRESET_QUERIES = [
    { label: 'Cypher — Tất cả Entity', type: 'cypher' as const, query: 'MATCH (e:Entity) RETURN e.name, e.type LIMIT 10' },
    { label: 'Cypher — Mối quan hệ', type: 'cypher' as const, query: 'MATCH (e:Entity)-[r]->(n) RETURN e.name, type(r), n.name LIMIT 20' },
    { label: 'SQL — Entity gần đây', type: 'sql' as const, query: 'SELECT entityName, entityType, domain FROM LocalEntity LIMIT 10' },
    { label: 'SQL — Quan hệ gần đây', type: 'sql' as const, query: 'SELECT sourceEntityName, relationshipType, targetEntityName FROM LocalRelationship LIMIT 10' },
  ]

  // Fetch schema data on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/openclaw/knowledge/schema')
        if (res.ok) {
          const data = await res.json()
          setSchemaData(data)
        }
      } catch {}

      try {
        const res = await fetch('/api/openclaw/knowledge/context')
        if (res.ok) {
          const data = await res.json()
          setContextConfig(data.config)
        }
      } catch {}

      try {
        const res = await fetch('/api/openclaw/knowledge/policy')
        if (res.ok) {
          const data = await res.json()
          setPolicy(data.policy)
        }
      } catch {}
    }
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [])

  // Run query
  const runQuery = async () => {
    if (!queryString.trim()) return
    setQueryRunning(true)
    setQueryError(null)
    setQueryResult(null)
    try {
      const res = await fetch('/api/openclaw/knowledge/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: queryType, query: queryString }),
      })
      const data = await res.json()
      if (res.ok) {
        setQueryResult({ columns: data.columns, records: data.records, count: data.count })
      } else {
        setQueryError(data.error || 'Truy vấn thất bại')
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Lỗi kết nối')
    }
    setQueryRunning(false)
  }

  // Load context preview
  const loadContextPreview = async () => {
    if (showContextPreview) {
      setShowContextPreview(false)
      return
    }
    try {
      const res = await fetch('/api/openclaw/knowledge/context', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setContextPreview(data.preview)
        setShowContextPreview(true)
      }
    } catch {}
  }

  // Save policy
  const savePolicy = async () => {
    if (!policy) return
    setPolicySaving(true)
    try {
      const res = await fetch('/api/openclaw/knowledge/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      })
      if (res.ok) {
        toast({ title: 'Đã lưu chính sách truy cập', description: 'Cập nhật thành công' })
      }
    } catch {}
    setPolicySaving(false)
  }

  // Format value for display
  const formatValue = (val: unknown): string => {
    if (val === null || val === undefined) return '—'
    if (typeof val === 'object') return JSON.stringify(val).substring(0, 80)
    return String(val)
  }

  return (
    <div className="space-y-4">

      {/* ===== 1. LIVE STATS ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">Thống kê Knowledge Base</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Neo4j Nodes */}
            <div className="p-2.5 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Network className="h-4 w-4 mx-auto text-cyan-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{schemaData?.neo4j.nodeCount ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Neo4j Nodes</p>
            </div>
            {/* Neo4j Relationships */}
            <div className="p-2.5 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <GitBranch className="h-4 w-4 mx-auto text-cyan-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{schemaData?.neo4j.relationshipCount ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Neo4j Relations</p>
            </div>
            {/* Qdrant Vectors */}
            <div className="p-2.5 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Layers className="h-4 w-4 mx-auto text-cyan-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">
                {schemaData?.qdrant.collections.reduce((sum, c) => sum + c.pointCount, 0) ?? '—'}
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Qdrant Vectors</p>
            </div>
            {/* SQLite Entities */}
            <div className="p-2.5 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Database className="h-4 w-4 mx-auto text-cyan-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{schemaData?.prisma.details.LocalEntity?.rowCount ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">SQLite Entities</p>
            </div>
          </div>
          {/* Connection status */}
          <div className="mt-2 flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${(schemaData?.neo4j.nodeCount ?? -1) >= 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
              <span className="text-stone-400">Neo4j {(schemaData?.neo4j.nodeCount ?? -1) >= 0 ? 'Sẵn sàng' : 'Ngoại tuyến'}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${(schemaData?.qdrant.collections.length ?? 0) > 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
              <span className="text-stone-400">Qdrant {(schemaData?.qdrant.collections.length ?? 0) > 0 ? 'Sẵn sàng' : 'Ngoại tuyến'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* ===== RAG PIPELINE VISUALIZER ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">RAG Pipeline</span>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
            {[
              { label: 'Query', icon: <Search className="h-3.5 w-3.5 text-cyan-300" /> },
              { label: 'Embed', icon: <Cpu className="h-3.5 w-3.5 text-emerald-300" /> },
              { label: 'Qdrant Search', icon: <Layers className="h-3.5 w-3.5 text-sky-300" /> },
              { label: 'Neo4j Expand', icon: <Network className="h-3.5 w-3.5 text-violet-300" /> },
              { label: 'RRF Fusion', icon: <GitBranch className="h-3.5 w-3.5 text-amber-300" /> },
              { label: 'LLM Generate', icon: <Cpu className="h-3.5 w-3.5 text-rose-300" /> },
              { label: 'Answer', icon: <MessageSquare className="h-3.5 w-3.5 text-teal-300" /> },
            ].map((step, i, arr) => (
              <div key={step.label} className="flex items-center gap-1 shrink-0">
                <div className="flex flex-col items-center gap-1 px-2.5 py-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg min-w-[80px]">
                  {step.icon}
                  <span className="text-[9px] text-stone-300 text-center leading-tight">{step.label}</span>
                </div>
                {i < arr.length - 1 && (
                  <ChevronRight className="h-3.5 w-3.5 text-cyan-500/50 shrink-0" />
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[9px] text-stone-500">NVIDIA Embedding → Qdrant Vector Search → Neo4j Graph Expansion → Reciprocal Rank Fusion → LLM Generation</p>
        </div>
      </div>

      {/* ===== 2. SCHEMA BROWSER ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">Schema Browser</span>
          </div>

          {/* SQLite Models */}
          <div className="mb-2">
            <button
              onClick={() => toggleSection('sqlite')}
              className="w-full flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg hover:bg-slate-950/80 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Database className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-xs font-medium text-stone-200">SQLite Models</span>
                <Badge className="text-[9px] h-4 px-1.5 bg-cyan-950/50 text-cyan-400 border-cyan-400/35">{schemaData?.prisma.models.length ?? 0}</Badge>
              </div>
              {expandedSections.has('sqlite') ? <ChevronUp className="h-3.5 w-3.5 text-stone-400" /> : <ChevronDown className="h-3.5 w-3.5 text-stone-400" />}
            </button>
            {expandedSections.has('sqlite') && (
              <div className="mt-1.5 space-y-1 max-h-64 overflow-y-auto pl-1" style={{ scrollbarWidth: 'thin' }}>
                {schemaData?.prisma.models.map(modelName => {
                  const detail = schemaData?.prisma.details[modelName]
                  if (!detail) return null
                  return (
                  <div key={modelName} className="border border-cyan-400/25 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleModel(modelName)}
                      className="w-full flex items-center justify-between p-2 hover:bg-slate-950/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Table className="h-3 w-3 text-stone-400" />
                        <span className="text-[11px] font-mono text-stone-200">{modelName}</span>
                        <span className="text-[9px] text-stone-500">{detail.fields.length} fields · {detail.rowCount} rows</span>
                      </div>
                      {expandedModels.has(modelName) ? <ChevronUp className="h-3 w-3 text-stone-400" /> : <ChevronDown className="h-3 w-3 text-stone-400" />}
                    </button>
                    {expandedModels.has(modelName) && (
                      <div className="px-2 pb-2 space-y-0.5">
                        {detail.fields.map(field => (
                          <div key={field} className="flex items-center justify-between text-[10px] py-0.5 px-1">
                            <span className="font-mono text-stone-300">{field}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Neo4j Schema */}
          <div className="mb-2">
            <button
              onClick={() => toggleSection('neo4j')}
              className="w-full flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg hover:bg-slate-950/80 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Network className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-xs font-medium text-stone-200">Neo4j Schema</span>
                <Badge className="text-[9px] h-4 px-1.5 bg-cyan-950/50 text-cyan-400 border-cyan-400/35">{schemaData?.neo4j.labels.length ?? 0} labels</Badge>
              </div>
              {expandedSections.has('neo4j') ? <ChevronUp className="h-3.5 w-3.5 text-stone-400" /> : <ChevronDown className="h-3.5 w-3.5 text-stone-400" />}
            </button>
            {expandedSections.has('neo4j') && (
              <div className="mt-1.5 p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg space-y-2">
                <div>
                  <span className="text-[10px] text-stone-500 uppercase">Node Labels</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(schemaData?.neo4j.labels.length ?? 0) > 0 ? schemaData?.neo4j.labels.map(label => (
                      <Badge key={label} className="text-[9px] h-4 px-1.5 bg-cyan-950/50 text-cyan-400 border-cyan-400/35">{label}</Badge>
                    )) : <span className="text-[10px] text-stone-500">Không có label</span>}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-stone-500 uppercase">Relationship Types</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(schemaData?.neo4j.relationshipTypes.length ?? 0) > 0 ? schemaData?.neo4j.relationshipTypes.map(rel => (
                      <Badge key={rel} className="text-[9px] h-4 px-1.5 bg-teal-950/50 text-teal-400 border-teal-400/35">{rel}</Badge>
                    )) : <span className="text-[10px] text-stone-500">Không có relationship type</span>}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Qdrant Collections */}
          <div>
            <button
              onClick={() => toggleSection('qdrant')}
              className="w-full flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg hover:bg-slate-950/80 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-xs font-medium text-stone-200">Qdrant Collections</span>
                <Badge className="text-[9px] h-4 px-1.5 bg-cyan-950/50 text-cyan-400 border-cyan-400/35">{schemaData?.qdrant.collections.length ?? 0}</Badge>
              </div>
              {expandedSections.has('qdrant') ? <ChevronUp className="h-3.5 w-3.5 text-stone-400" /> : <ChevronDown className="h-3.5 w-3.5 text-stone-400" />}
            </button>
            {expandedSections.has('qdrant') && (
              <div className="mt-1.5 space-y-1">
                {(schemaData?.qdrant.collections.length ?? 0) > 0 ? schemaData?.qdrant.collections.map(col => (
                  <div key={col.name} className="p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono text-stone-200">{col.name}</span>
                      <Badge className={`text-[9px] h-4 px-1.5 ${col.status === 'green' ? 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35' : 'bg-amber-950/50 text-amber-400 border-amber-400/35'}`}>{col.status}</Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-stone-400">
                      <span>{col.pointCount} points</span>
                      <span>{col.vectorSize}-dim</span>
                    </div>
                  </div>
                )) : <span className="text-[10px] text-stone-500 p-2">Không có collection</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 3. QUERY SIMULATOR ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Search className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">Truy vấn</span>
          </div>

          <div className="space-y-3">
            {/* Query type + preset row */}
            <div className="flex items-center gap-2">
              <Select value={queryType} onValueChange={(v: 'cypher' | 'sql') => { setQueryType(v); setQueryString(''); setQueryResult(null); setQueryError(null) }}>
                <SelectTrigger className="w-[170px] h-8 text-xs rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/80 border-cyan-400/35">
                  <SelectItem value="cypher" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Cypher (Neo4j)</SelectItem>
                  <SelectItem value="sql" className="text-stone-200 focus:text-white focus:bg-stone-800/80">SQL (SQLite)</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedPreset} onValueChange={(v) => {
                setSelectedPreset(v)
                const preset = PRESET_QUERIES.find(p => p.label === v)
                if (preset) {
                  setQueryType(preset.type)
                  setQueryString(preset.query)
                  setQueryResult(null)
                  setQueryError(null)
                }
              }}>
                <SelectTrigger className="flex-1 h-8 text-xs rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200">
                  <SelectValue placeholder="Truy vấn mẫu..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/80 border-cyan-400/35">
                  {PRESET_QUERIES.map(p => (
                    <SelectItem key={p.label} value={p.label} className="text-stone-200 focus:text-white focus:bg-stone-800/80">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Query textarea */}
            <textarea
              value={queryString}
              onChange={e => setQueryString(e.target.value)}
              placeholder={queryType === 'cypher' ? 'MATCH (e:Entity) RETURN e.name, e.type LIMIT 10' : 'SELECT entityName, entityType FROM LocalEntity LIMIT 10'}
              className="w-full h-20 px-3 py-2 text-xs font-mono bg-slate-950/60 border border-cyan-400/40 text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-cyan-500/50 rounded-lg resize-none"
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery() } }}
            />

            {/* Run button + safety note */}
            <div className="flex items-center justify-between">
              <Button
                onClick={runQuery}
                disabled={queryRunning || !queryString.trim()}
                className="chamfer-sm h-8 px-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white border-0 text-xs"
              >
                {queryRunning ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Đang chạy...</> : <><Play className="mr-1.5 h-3.5 w-3.5" /> Chạy</>}
              </Button>
              <span className="text-[9px] text-stone-500 flex items-center gap-1">
                <Shield className="h-3 w-3" />
                Chỉ cho phép truy vấn đọc (MATCH/SELECT)
              </span>
            </div>

            {/* Query error */}
            {queryError && (
              <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/55 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 inline mr-1.5" />{queryError}
              </div>
            )}

            {/* Query results */}
            {queryResult && (
              <div className="border border-cyan-500/15 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between p-2 bg-slate-950/50 border-b border-cyan-400/25">
                  <span className="text-[10px] text-stone-400">Kết quả: {queryResult.count} hàng</span>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-stone-400 hover:text-stone-200" onClick={() => { setQueryResult(null) }}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <div className="max-h-64 overflow-auto" style={{ scrollbarWidth: 'thin' }}>
                  <table className="w-full text-[10px]">
                    <thead className="sticky top-0 bg-slate-950/80">
                      <tr>
                        {queryResult.columns.map(col => (
                          <th key={col} className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-cyan-400/25">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.records.map((record, i) => (
                        <tr key={i} className="hover:bg-slate-950/30">
                          {queryResult.columns.map(col => (
                            <td key={col} className="px-2 py-1 text-stone-300 border-b border-cyan-500/5 font-mono max-w-[200px] truncate">{formatValue(record[col])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 4. CONTEXT CONFIG ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Settings className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">Cấu hình Context</span>
          </div>

          <div className="space-y-2.5">
            {/* Auto KB Search */}
            <div className="flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <div>
                <span className="text-xs text-stone-200">Tự động tìm KB</span>
                <p className="text-[9px] text-stone-500">Tìm kiếm Knowledge Base trước khi trả lời</p>
              </div>
              <Switch
                checked={contextConfig?.autoKBSearch ?? false}
                onCheckedChange={(checked) => {
                  setContextConfig(prev => prev ? { ...prev, autoKBSearch: checked } : prev)
                  toast({ title: 'Đã cập nhật cấu hình', description: checked ? 'Tự động tìm KB: Bật' : 'Tự động tìm KB: Tắt' })
                }}
                className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
              />
            </div>

            {/* Inject Schema */}
            <div className="flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <div>
                <span className="text-xs text-stone-200">Chèn Schema vào System Prompt</span>
                <p className="text-[9px] text-stone-500">Thêm cấu trúc KB vào ngữ cảnh cho Agent</p>
              </div>
              <Switch
                checked={contextConfig?.injectSchemaIntoSystemPrompt ?? false}
                onCheckedChange={(checked) => {
                  setContextConfig(prev => prev ? { ...prev, injectSchemaIntoSystemPrompt: checked } : prev)
                  toast({ title: 'Đã cập nhật cấu hình', description: checked ? 'Chèn Schema: Bật' : 'Chèn Schema: Tắt' })
                }}
                className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
              />
            </div>

            {/* Knowledge Sources */}
            <div className="flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <span className="text-xs text-stone-200">Nguồn Knowledge</span>
              <span className="text-[11px] text-cyan-400 font-mono">{contextConfig?.knowledgeSources ?? '—'}</span>
            </div>

            {/* Top-K */}
            <div className="flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <span className="text-xs text-stone-200">Top-K Results</span>
              <Input
                type="number"
                min={1}
                max={20}
                value={contextConfig?.topK ?? 5}
                onChange={(e) => {
                  const val = Math.min(20, Math.max(1, parseInt(e.target.value) || 1))
                  setContextConfig(prev => prev ? { ...prev, topK: val } : prev)
                  toast({ title: 'Đã cập nhật cấu hình', description: `Top-K: ${val}` })
                }}
                className="w-16 h-7 text-[11px] text-center font-mono bg-slate-950/60 border-cyan-400/35 text-stone-200 rounded-md"
              />
            </div>

            {/* Max Context Length */}
            <div className="flex items-center justify-between p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <span className="text-xs text-stone-200">Độ dài Context tối đa</span>
              <Select
                value={contextConfig?.maxContextLength ?? '4000'}
                onValueChange={(val) => {
                  setContextConfig(prev => prev ? { ...prev, maxContextLength: val } : prev)
                  toast({ title: 'Đã cập nhật cấu hình', description: `Độ dài Context: ~${val} tokens` })
                }}
              >
                <SelectTrigger className="w-[140px] h-7 text-[11px] rounded-md border-cyan-400/35 bg-slate-950/60 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/80 border-cyan-400/35">
                  <SelectItem value="2000" className="text-stone-200 focus:text-white focus:bg-stone-800/80">~2,000 tokens</SelectItem>
                  <SelectItem value="4000" className="text-stone-200 focus:text-white focus:bg-stone-800/80">~4,000 tokens</SelectItem>
                  <SelectItem value="8000" className="text-stone-200 focus:text-white focus:bg-stone-800/80">~8,000 tokens</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Preview button */}
            <Button
              variant="outline"
              onClick={loadContextPreview}
              className="chamfer-sm w-full h-8 text-xs border-cyan-400/35 bg-slate-950/60 text-stone-200 hover:bg-slate-950/80 hover:text-cyan-400"
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              {showContextPreview ? 'Ẩn System Prompt' : 'Xem System Prompt'}
            </Button>

            {/* Context preview */}
            {showContextPreview && contextPreview && (
              <div className="p-3 bg-slate-950/60 border border-cyan-500/15 rounded-lg max-h-48 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                <pre className="text-[10px] text-stone-300 font-mono whitespace-pre-wrap">{contextPreview}</pre>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 5. ACCESS POLICY ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          <div className="flex items-center gap-2 mb-3">
            <Shield className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-stone-100">Chính sách truy cập</span>
          </div>

          <div className="space-y-2.5">
            {/* Permission grid */}
            <div className="grid grid-cols-3 gap-2">
              <div className="p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg flex flex-col items-center gap-1.5">
                <span className="text-[10px] text-stone-500">Đọc</span>
                <Switch
                  checked={policy?.allowRead ?? true}
                  onCheckedChange={(checked) => {
                    setPolicy(prev => prev ? { ...prev, allowRead: checked } : prev)
                  }}
                  className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                />
              </div>
              <div className="p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg flex flex-col items-center gap-1.5">
                <span className="text-[10px] text-stone-500">Ghi</span>
                <Switch
                  checked={policy?.allowWrite ?? true}
                  onCheckedChange={(checked) => {
                    setPolicy(prev => prev ? { ...prev, allowWrite: checked } : prev)
                  }}
                  className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                />
              </div>
              <div className="p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg flex flex-col items-center gap-1.5">
                <span className="text-[10px] text-stone-500">Xóa</span>
                <Switch
                  checked={policy?.allowDelete ?? false}
                  onCheckedChange={(checked) => {
                    setPolicy(prev => prev ? { ...prev, allowDelete: checked } : prev)
                  }}
                  className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                />
              </div>
            </div>

            {/* Collections */}
            <div className="flex items-center justify-between gap-2 p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <span className="text-xs text-stone-200 shrink-0">Collections được phép</span>
              <Input
                value={policy?.allowedCollections ?? ''}
                onChange={(e) => {
                  setPolicy(prev => prev ? { ...prev, allowedCollections: e.target.value } : prev)
                }}
                placeholder="* (tất cả)"
                className="h-7 text-[10px] font-mono bg-slate-950/60 border-cyan-400/35 text-cyan-400 rounded-md max-w-[200px]"
              />
            </div>

            {/* Labels */}
            <div className="flex items-center justify-between gap-2 p-2 bg-slate-950/50 border border-cyan-400/25 rounded-lg">
              <span className="text-xs text-stone-200 shrink-0">Neo4j Labels</span>
              <Input
                value={policy?.allowedLabels ?? ''}
                onChange={(e) => {
                  setPolicy(prev => prev ? { ...prev, allowedLabels: e.target.value } : prev)
                }}
                placeholder="* (tất cả)"
                className="h-7 text-[10px] font-mono bg-slate-950/60 border-cyan-400/35 text-cyan-400 rounded-md max-w-[200px]"
              />
            </div>

            {/* Save button */}
            <Button
              onClick={savePolicy}
              disabled={policySaving}
              className="chamfer-sm w-full h-8 text-xs bg-gradient-to-r from-cyan-500 to-sky-600 hover:from-cyan-600 hover:to-sky-700 text-white border-0"
            >
              {policySaving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Đang lưu...</> : <><Shield className="mr-1.5 h-3.5 w-3.5" /> Lưu chính sách</>}
            </Button>
          </div>
        </div>
      </div>

    </div>
  )
}

