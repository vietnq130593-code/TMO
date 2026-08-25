'use client'

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend as RechartsLegend,
  LineChart, Line, AreaChart, Area,
} from 'recharts'
import {
  Database, Network, Cpu, CheckCircle2, XCircle, Loader2, RefreshCw,
  Brain, Zap, ArrowRight, Copy, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Activity,
  AlertTriangle, ExternalLink, FolderOpen, Key, Play, Pause, Info, HardDrive, Server,
  Shield, Globe, ShieldOff, Clock, MessageSquare, Send, Upload, FileText,
  Trash2, Eye, Search, Filter, Layers, GitBranch, BookOpen, Sparkles,
  FolderUp, ListChecks, BarChart3, Bot, MessageCircle, Lightbulb, Target,
  Network as GraphIcon, Route, TrendingUp, Cable, ZoomIn, ZoomOut, Maximize,
  X, PieChart as PieChartIcon, AlertCircle, ChevronsLeft, ChevronsRight, Calendar,
  ThumbsUp, ThumbsDown, Settings, Wrench, Radio, BookMarked, Zap as ZapIcon, Plus, CircleDot, Table,
  Download, Upload as UploadIcon, FileJson, GraduationCap, RotateCcw, FileDown, FileUp, Edit3, Pencil, Users, User,
  Code2, Terminal as TerminalIcon, FolderTree, FileCode, Bug, RefreshCw as RefreshCwIcon, Monitor,
  Play as PlayIcon, Square, ScrollText, ArrowRight as ArrowRightIcon, Cpu as CpuIcon, Cable as CableIcon,
  GitCommit, History, Minimize2, ExternalLink as ExternalLinkIcon, GripHorizontal, ArrowDownToLine,
  Wifi, WifiOff,
  Flame, Archive, Snowflake, Thermometer, FlaskConical
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Calendar as CalendarPicker } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip as StatusTooltip, TooltipTrigger as StatusTooltipTrigger, TooltipContent as StatusTooltipContent } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { format } from 'date-fns'
import { toast } from '@/hooks/use-toast'
import { authedFetch } from '@/lib/api-auth'
import { toast as sonnerToast } from 'sonner'
import {
  AVATAR_OPTIONS,
  PROVIDER_OPTIONS,
  TEAM_OPTIONS,
  POSITION_LABELS,
  TEAM_POSITIONS,
  CODE_POSITIONS,
  RESEARCH_POSITIONS,
  PROVIDER_BADGE_COLORS,
  TEAM_BADGE_COLORS,
  AGENT_COLORS,
  POSITION_COLORS,
} from '@/lib/agent-constants'
import { CodeEditor, detectLanguage, type OpenFile } from '@/components/code-editor/CodeEditor'
import { DiffViewer } from '@/components/code-editor/DiffViewer'
import { PendingEditModal } from '@/components/code-editor/PendingEditModal'
import { SearchPanel } from '@/components/code-editor/SearchPanel'

// ==================== TYPES ====================

interface HealthResponse {
  status: 'healthy' | 'degraded'
  responseTimeMs: number
  timestamp: string
  services: {
    qdrant: QdrantHealth
    neo4j: Neo4jHealth
    sqlite: SqliteHealth
    r2: R2Health
    supabase: SupabaseHealth
    llm: Record<string, LLMHealthItem>
  }
  providerDiagnostics?: Record<string, ProviderDiagnostic>
  dailyQuotaStatus?: Record<string, DailyQuotaInfo>
}

interface QdrantHealth { connected: boolean; version?: string; error?: string; documentsCollection?: { exists: boolean; pointCount?: number }; chunksCollection?: { exists: boolean; pointCount?: number; vectorCount?: number } }
interface Neo4jHealth { connected: boolean; nodeCount: number; relationshipCount: number; labels: string[]; error?: string }
interface SqliteHealth { connected: boolean; error?: string; tableCount?: number }
interface R2Health { configured: boolean; connected: boolean; bucket?: string; objectCount?: number; error?: string }
interface SupabaseHealth { configured: boolean; connected: boolean; tableCount?: number; error?: string }
interface LLMHealthItem { available: boolean; model: string; error?: string; geoBlocked?: boolean }
interface ProviderDiagnostic {
  keyCount: number; availableCount: number; totalTokensUsed: number; totalDailyTokensUsed: number; totalDailyRequests: number; dailyTokenLimit: number; dailyQuotaExhaustedCount: number
  keys: Array<{ index: number; available: boolean; rateLimited: boolean; exhausted: boolean; dailyQuotaExhausted: boolean; dailyQuotaResetAt: number; failureCount: number; totalTokensUsed: number; dailyTokensUsed: number; dailyRequestCount: number; dailyRequestDate: string }>
}
interface DailyQuotaInfo {
  totalKeys: number; availableKeys: number; dailyQuotaExhaustedKeys: number
  dailyTokensUsed: number; dailyTokenLimit: number
  dailyRequestsUsed: number; dailyRequestLimit: number
  keys: Array<{ index: number; dailyQuotaExhausted: boolean; dailyQuotaResetAt: number; dailyTokensUsed: number; dailyRequestCount: number; minutesUntilReset: number }>
}

interface ProcessingStep {
  name: string; label: string; status: 'pending' | 'running' | 'completed' | 'error'
  startedAt: string | null; completedAt: string | null; detail: string | null
}

interface ChunkCoverage {
  total: number; extracted: number; missing: number; entityCount?: number; relationshipCount?: number
}

interface DocumentRecord {
  id: string; title: string; file_path: string; domain: string
  page_count: number | null; status: string; error_message: string | null
  processing_steps: ProcessingStep[]; processing_percent: number
  created_at: string; updated_at: string
  chunk_coverage?: ChunkCoverage
}

interface EntityRecord {
  id: string; document_id: string; chunk_id: string; entity_name: string
  entity_type: string; description: string; properties: Record<string, unknown>
  confidence_score: number; source: string; domain: string
  resolved_entity_id: string | null; resolved?: Record<string, unknown>
}

interface RelationshipRecord {
  id: string; document_id: string; source_entity_id: string; target_entity_id: string
  relationship_type: string; description: string; confidence_score: number; source: string
  source_entity?: { entity_name: string; entity_type: string }
  target_entity?: { entity_name: string; entity_type: string }
}

interface QueryResult {
  answer: string; sources: QuerySource[]; reasoning: string; confidence: number
  queryType: string; provider: string; model: string
  vectorResultsCount: number; graphResultsCount: number; durationMs: number
  followUpQuestions?: string[]
}

interface QuerySource {
  type: 'chunk' | 'entity' | 'relationship'
  content: string; documentTitle?: string; entityName?: string; similarity?: number
}

interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; timestamp: Date
  queryResult?: QueryResult
}

interface EmbeddingStatus {
  total: number; real: number; pseudo: number; realRatio: number; dimension?: number
}

// ==================== GRAPH TYPES ====================

interface GraphNode extends d3.SimulationNodeDatum {
  id: string
  name: string
  type: string
  domain: string
  description: string
  occurrences: number
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  id: string
  relType: string
}

// ==================== ENTITY TYPE COLORS ====================

const ENTITY_TYPE_COLORS: Record<string, string> = {
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

const ENTITY_TYPE_BG_COLORS: Record<string, string> = {
  Concept: 'bg-emerald-950/50 text-emerald-400',
  Algorithm: 'bg-amber-950/50 text-amber-400',
  Language: 'bg-rose-950/50 text-rose-400',
  Tool: 'bg-cyan-950/50 text-cyan-400',
  System: 'bg-orange-950/50 text-orange-400',
  Technique: 'bg-violet-950/50 text-violet-400',
  Vulnerability: 'bg-red-950/50 text-red-400',
  Principle: 'bg-slate-800/50 text-slate-400',
  Domain: 'bg-purple-950/50 text-purple-400',
  Document: 'bg-sky-950/50 text-sky-400',
  Person: 'bg-fuchsia-950/50 text-fuchsia-400',
}

// ==================== STATUS HELPERS ====================

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-slate-950/50 text-stone-300 border-cyan-400/35',
  parsing: 'bg-amber-950/50 text-amber-400 border-amber-500/55',
  chunking: 'bg-teal-950/50 text-teal-400 border-teal-500/55',
  chunked: 'bg-teal-950/50 text-teal-400 border-teal-500/55',
  extracting: 'bg-violet-950/50 text-violet-400 border-violet-500/55',
  embedding: 'bg-cyan-950/50 text-cyan-400 border-cyan-500/55',
  indexing: 'bg-blue-950/50 text-blue-400 border-blue-500/55',
  extracted: 'bg-emerald-950/50 text-emerald-400 border-emerald-500/55',
  indexed: 'bg-emerald-950/50 text-emerald-400 border-emerald-500/55',
  partial: 'bg-amber-950/50 text-amber-400 border-amber-500/55',
  error: 'bg-red-950/50 text-red-400 border-red-500/55',
}
const STATUS_LABELS: Record<string, string> = {
  uploaded: 'Đã tải lên', parsing: 'Đang phân tích', chunking: 'Đang chia chunks', chunked: 'Đã chia chunks',
  extracting: 'Đang trích xuất', embedding: 'Đang tạo embedding', indexing: 'Đang đánh chỉ mục',
  extracted: 'Đã trích xuất', indexed: 'Đã đánh chỉ mục',
  partial: 'Tạm dừng', error: 'Lỗi',
}
const DOMAIN_LABELS: Record<string, string> = {
  programming: 'Lập trình', algorithm: 'Thuật toán', ml: 'Machine Learning',
  meta_cognitive: 'Siêu nhận thức', linux: 'Linux', security: 'Bảo mật', ux_ui: 'Thiết kế UX/UI', mixed: 'Tổng hợp',
}
const DOMAIN_COLORS: Record<string, string> = {
  programming: 'bg-teal-950/50 text-teal-400 border-teal-500/55', algorithm: 'bg-violet-950/50 text-violet-400 border-violet-500/55',
  ml: 'bg-fuchsia-950/50 text-fuchsia-400 border-fuchsia-500/55', meta_cognitive: 'bg-pink-950/50 text-pink-400 border-pink-500/55',
  linux: 'bg-orange-950/50 text-orange-400 border-orange-500/55', security: 'bg-red-950/50 text-red-400 border-red-500/55',
  ux_ui: 'bg-lime-950/50 text-lime-400 border-lime-500/55', mixed: 'bg-slate-950/50 text-stone-400 border-cyan-400/35',
}
const QUERY_TYPE_LABELS: Record<string, string> = {
  factual: 'Thực tế', relational: 'Quan hệ', analytical: 'Phân tích', exploratory: 'Khám phá',
}
const QUERY_TYPE_COLORS: Record<string, string> = {
  factual: 'bg-cyan-950/50 text-cyan-400 border-cyan-500/55', relational: 'bg-orange-950/50 text-orange-400 border-orange-500/55',
  analytical: 'bg-violet-950/50 text-violet-400 border-violet-500/55', exploratory: 'bg-teal-950/50 text-teal-400 border-teal-500/55',
}

// ==================== UPLOAD SECTION ====================

function UploadSection({ onUploadComplete, existingDocNames }: { onUploadComplete: (uploadedDocIds: string[]) => void; existingDocNames: Set<string> }) {
  const [uploading, setUploading] = useState(false)
  const [selectedDomain, setSelectedDomain] = useState<string>('auto')
  const [uploadResult, setUploadResult] = useState<{
    documents: Array<{ id: string; title: string; status: string; domain: string }>
    totalUploaded: number; totalErrors: number; errors?: Array<{ file: string; error: string }>
  } | null>(null)
  /** Tracks per-file upload progress: "Uploading 3/7..." */
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  /** Duplicate file names detected before upload — shown as a blocking warning */
  const [duplicateWarning, setDuplicateWarning] = useState<string[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Helper: read the actual error message from a non-OK response */
  const readServerError = async (res: Response): Promise<string> => {
    let serverError = `Lỗi server (${res.status})`
    try {
      const text = await res.text()
      try {
        const errData = JSON.parse(text)
        if (errData.error) serverError = errData.error
        else if (errData.message) serverError = errData.message
      } catch {
        // Response is not JSON — might be HTML from Next.js framework error
        if (text) serverError = text.slice(0, 200)
      }
    } catch {}
    if (res.status === 413) serverError = 'File quá lớn — vượt giới hạn tải lên'
    return serverError
  }

  const handleUpload = async () => {
    const files = fileInputRef.current?.files
    if (!files || files.length === 0) return

    // Clear previous duplicate warning
    setDuplicateWarning(null)

    // Client-side file validation
    const MAX_CLIENT_SIZE = 100 * 1024 * 1024 // 100MB per file
    const oversizedFiles: string[] = []
    const nonPdfFiles: string[] = []
    const duplicates: string[] = []
    for (let i = 0; i < files.length; i++) {
      if (!files[i].name.toLowerCase().endsWith('.pdf') && files[i].type !== 'application/pdf') {
        nonPdfFiles.push(files[i].name)
      }
      if (files[i].size > MAX_CLIENT_SIZE) {
        oversizedFiles.push(`${files[i].name} (${(files[i].size / 1024 / 1024).toFixed(1)}MB)`)
      }
      // Check for duplicate document names
      if (existingDocNames.has(files[i].name)) {
        duplicates.push(files[i].name)
      }
    }

    // Show validation errors (non-PDF, oversized)
    if (nonPdfFiles.length > 0 || oversizedFiles.length > 0) {
      const errors: Array<{ file: string; error: string }> = []
      nonPdfFiles.forEach(f => errors.push({ file: f, error: 'Chỉ hỗ trợ file PDF' }))
      oversizedFiles.forEach(f => errors.push({ file: f, error: 'File quá lớn (tối đa 100MB/file)' }))
      setUploadResult({ documents: [], totalUploaded: 0, totalErrors: errors.length, errors })
    }

    // Show duplicate warning and block those files from uploading
    if (duplicates.length > 0) {
      setDuplicateWarning(duplicates)
      // If ALL files are duplicates, stop here
      if (duplicates.length === files.length) return
    }

    setUploading(true)
    setUploadResult(null)

    // Upload files ONE AT A TIME to avoid body size limit issues.
    // Sending all files in a single request creates a large multipart body
    // that can exceed Next.js's internal limits and cause 400 errors.
    // SKIP files that are duplicates — they are already shown in the warning.
    const allUploaded: Array<{ id: string; title: string; status: string; domain: string }> = []
    const allErrors: Array<{ file: string; error: string }> = []
    const duplicateSet = new Set(duplicates)
    const filesToUpload = Array.from(files).filter(f => !duplicateSet.has(f.name))

    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i]
      setUploadProgress(`Đang tải ${i + 1}/${filesToUpload.length}: ${file.name}`)

      try {
        const formData = new FormData()
        formData.append('files', file)
        if (selectedDomain !== 'auto') formData.append('domain', selectedDomain)

        const res = await fetch('/api/ingestion/upload', { method: 'POST', body: formData })
        if (!res.ok) {
          const serverError = await readServerError(res)
          allErrors.push({ file: file.name, error: serverError })
          continue
        }
        const data = await res.json()
        if (data.documents && data.documents.length > 0) {
          allUploaded.push(...data.documents)
        }
        if (data.errors && data.errors.length > 0) {
          allErrors.push(...data.errors)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        allErrors.push({ file: file.name, error: message })
      }
    }

    setUploadProgress(null)
    setUploadResult({
      documents: allUploaded,
      totalUploaded: allUploaded.length,
      totalErrors: allErrors.length,
      errors: allErrors.length > 0 ? allErrors : undefined,
    })
    // Sonner toast notifications for upload results
    if (allUploaded.length > 0) {
      sonnerToast.success('Tải lên thành công', {
        description: `Đã tải ${allUploaded.length} tài liệu lên hệ thống`,
        duration: 4000,
      })
      onUploadComplete(allUploaded.map(d => d.id))
    }
    if (allErrors.length > 0) {
      sonnerToast.error('Tải lên thất bại', {
        description: `${allErrors.length} file không thể tải lên`,
        duration: 6000,
      })
    }
    setUploading(false)
  }

  return (
    <div className="space-y-2">
      {/* Upload toolbar — file input + domain select + Tải lên button (compact, inline) */}
      <div className="flex gap-2 items-center flex-wrap">
        <Input ref={fileInputRef} type="file" accept=".pdf" multiple disabled={uploading}
          className="flex-1 min-w-[180px] text-xs h-9 text-stone-200 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gradient-to-r file:from-emerald-900/40 file:to-teal-900/40 file:text-teal-400 hover:file:from-emerald-800/40 hover:file:to-teal-800/40 rounded-lg border-cyan-400/35 focus:border-emerald-600 focus:ring-emerald-600/20" />
        <Select value={selectedDomain} onValueChange={setSelectedDomain}>
          <SelectTrigger className="w-[150px] h-9 text-xs rounded-lg border-cyan-400/35 text-stone-200 focus:border-emerald-600"><SelectValue placeholder="Phân loại" /></SelectTrigger>
          <SelectContent className="bg-slate-950/80 border-cyan-400/35">
            <SelectItem value="auto" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Tự động phân loại</SelectItem>
            <SelectItem value="programming" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Lập trình</SelectItem>
            <SelectItem value="algorithm" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Thuật toán</SelectItem>
            <SelectItem value="ml" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Machine Learning</SelectItem>
            <SelectItem value="meta_cognitive" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Siêu nhận thức</SelectItem>
            <SelectItem value="linux" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Linux</SelectItem>
            <SelectItem value="security" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Bảo mật</SelectItem>
            <SelectItem value="ux_ui" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Thiết kế UX/UI</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={handleUpload} disabled={uploading} size="sm" className="lens-flare chamfer-sm h-9 px-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm border-0">
          {uploading ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {uploadProgress || 'Đang tải...'}</> : <><FolderUp className="mr-1.5 h-3.5 w-3.5" /> Tải lên</>}
        </Button>
      </div>
      {/* Per-file upload progress indicator */}
      {uploadProgress && (
        <div className="flex items-center gap-2 p-2 rounded-xl bg-teal-950/40 border border-teal-500/55 text-xs text-teal-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
          <span className="truncate">{uploadProgress}</span>
        </div>
      )}
      {/* Duplicate name warning */}
      {duplicateWarning && duplicateWarning.length > 0 && (
        <div className="p-2 rounded-xl bg-amber-950/40 border border-amber-500/55 text-xs text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold">Trùng tên tài liệu!</span>
              <span className="ml-1 text-amber-400">Không thể tải lên {duplicateWarning.length} file:</span>
              <div className="mt-1.5 space-y-1 max-h-24 overflow-y-auto">
                {duplicateWarning.map((name, i) => (
                  <div key={i} className="flex items-center gap-1.5 p-1 rounded bg-amber-900/40">
                    <FileText className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{name}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-amber-400">Vui lòng đổi tên file hoặc xóa tài liệu cũ trước khi tải lại.</p>
                  <Button variant="outline" size="sm" className="mt-2 h-6 px-2 text-[10px] rounded-md border-amber-700 text-amber-400 hover:bg-amber-900/40" onClick={() => setDuplicateWarning(null)}>Đóng</Button>
                </div>
              </div>
            </div>
          )}
          {uploadResult && (
            <div className="space-y-2">
              {uploadResult.totalUploaded > 0 && (
                <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/55 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 inline mr-1" /> Đã tải lên {uploadResult.totalUploaded} tài liệu
                  <div className="mt-2 space-y-1.5">
                    {uploadResult.documents.map(doc => (
                      <div key={doc.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-950/50">
                        <FileText className="h-3 w-3 text-stone-300" /><span className="truncate max-w-[200px] text-stone-200">{doc.title}</span>
                        <Badge className={`text-[9px] h-4 px-1.5 ${DOMAIN_COLORS[doc.domain] || 'bg-stone-950/50 text-stone-400'}`}>{DOMAIN_LABELS[doc.domain] || doc.domain}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {uploadResult.errors && uploadResult.errors.length > 0 && (
                <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/55 text-xs text-red-400">
                  <XCircle className="h-3.5 w-3.5 inline mr-1" />{uploadResult.totalErrors} lỗi:
                  {uploadResult.errors.map((err, i) => <div key={i} className="mt-1">{err.file}: {err.error}</div>)}
                </div>
              )}
            </div>
          )}
    </div>
  )
}

// ==================== DOCUMENTS LIST ====================

function DocumentsList({ documents, onProcessDoc, onDeleteDoc, onPauseDoc, onReExtractDoc, onForceRecover, processingIds, extractingDocIds, pausedDocIds, userPausedDocIds, docPage, docTotal, docPageSize, onPageChange, docStatusBreakdown, docLoading, autoMode, onToggleAuto, onRegenerateEmbeddings, embeddingPseudoCount, uploadSlot, onEmbedOnlyDoc }: {
  documents: DocumentRecord[]; onProcessDoc: (id: string) => void; onDeleteDoc: (id: string) => void; onPauseDoc: (id: string) => void; onReExtractDoc: (id: string) => void; onForceRecover: () => void; processingIds: Set<string>; extractingDocIds: Set<string>; pausedDocIds: Set<string>; userPausedDocIds: Set<string>; docPage: number; docTotal: number; docPageSize: number; onPageChange: (page: number) => void; docStatusBreakdown: Record<string, number>; docLoading: boolean; autoMode: boolean; onToggleAuto: () => void; onRegenerateEmbeddings: () => void; embeddingPseudoCount: number; uploadSlot?: React.ReactNode; onEmbedOnlyDoc?: (id: string) => void
}) {
  // Track which document's extraction details are expanded
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null)

  // Calculate processing progress — use docStatusBreakdown for accurate totals across ALL pages
  const totalDocs = docTotal
  const completedDocs = (docStatusBreakdown['extracted'] || 0) + (docStatusBreakdown['indexed'] || 0)
  const errorDocs = docStatusBreakdown['error'] || 0
  // Subtract docs that are paused by the user OR stale (backend died) from the processing count.
  // A doc in pausedDocIds might still show as 'parsing'/'chunked'/'extracting' in the DB
  // if the PATCH hasn't propagated yet, or if reconciliation skipped 'extracting' docs.
  // Stale docs (in 'extracting' but NOT in extractingDocIds) are also not actively processing.
  // These should be counted as "Tạm dừng" (paused), not "Đang xử lý" (processing).
  // 'partial' docs that are auto-continuing (in extractingDocIds but NOT in userPausedDocIds)
  // are counted as "Đang xử lý" (processing), not paused.
  const rawProcessingDocs = (docStatusBreakdown['parsing'] || 0) + (docStatusBreakdown['chunked'] || 0) + (docStatusBreakdown['extracting'] || 0)
  const staleDocsCount = documents.filter(d => ['extracting', 'parsing', 'chunked'].includes(d.status) && !extractingDocIds.has(d.id) && !pausedDocIds.has(d.id)).length
  const autoContinuingDocs = documents.filter(d => d.status === 'partial' && extractingDocIds.has(d.id) && !userPausedDocIds.has(d.id)).length
  const processingDocs = Math.max(0, rawProcessingDocs - pausedDocIds.size - staleDocsCount) + autoContinuingDocs
  const uploadedDocs = docStatusBreakdown['uploaded'] || 0
  const progressPercent = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0
  const isProcessing = processingDocs > 0 || processingIds.size > 0

  // Helper: format timestamp to HH:mm:ss
  const formatTime = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // Helper: calculate duration between two ISO timestamps
  const formatDuration = (start: string | null, end: string | null) => {
    if (!start) return ''
    const s = new Date(start).getTime()
    const e = end ? new Date(end).getTime() : Date.now()
    const sec = Math.round((e - s) / 1000)
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  // Check if a document is currently being processed (show progress)
  // A paused doc or stale doc is NOT considered "processing" — it should show "Tạm dừng" status
  const isDocProcessing = (doc: DocumentRecord) =>
    !pausedDocIds.has(doc.id) && extractingDocIds.has(doc.id) && (['parsing', 'chunking', 'chunked', 'extracting', 'embedding', 'indexing'].includes(doc.status) || processingIds.has(doc.id))

  // Get progress percent for a document — smarter calculation
  const getDocPercent = (doc: DocumentRecord) => {
    if (doc.status === 'indexed' || doc.status === 'extracted') return 100
    if (doc.processing_percent > 0) return doc.processing_percent
    // Estimate progress from status if no processing_percent
    if (doc.status === 'parsing') return 5
    if (doc.status === 'chunking' || doc.status === 'chunked') return 20
    if (doc.status === 'extracting') return 30
    if (doc.status === 'embedding') return 70
    if (doc.status === 'indexing') return 85
    return 0
  }

  // Get extraction detail from processing_steps (e.g., "3/10 chunks")
  const getExtractDetail = (doc: DocumentRecord): string | null => {
    const steps = doc.processing_steps || []
    const extractStep = steps.find(s => s.name === 'extract')
    return extractStep?.detail || null
  }

  // Get step status icon
  const StepIcon = ({ status }: { status: string }) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
      case 'running': return <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
      case 'error': return <XCircle className="h-3 w-3 text-red-500" />
      default: return <div className="h-3 w-3 rounded-full border border-muted-foreground/30" />
    }
  }

  // Pipeline step definitions for the compact step indicator
  const PIPELINE_STEPS = ['uploaded', 'parsing', 'chunked', 'extracting', 'embedding', 'indexed'] as const
  const PIPELINE_LABELS: Record<string, string> = {
    uploaded: 'Tải lên', parsing: 'Phân tích', chunked: 'Chia chunks',
    extracting: 'Trích xuất', embedding: 'Embedding', indexed: 'Hoàn thành',
  }
  // Map document status to the pipeline step index
  const getPipelineStepIndex = (status: string): number => {
    if (status === 'error') return -1
    if (status === 'partial') return 3 // partial = paused during extracting
    if (status === 'extracted') return 5 // extracted is essentially done (like indexed)
    if (status === 'indexing') return 4 // indexing = embedding step
    if (status === 'chunking') return 2 // chunking = chunked step
    const idx = PIPELINE_STEPS.indexOf(status as typeof PIPELINE_STEPS[number])
    return idx >= 0 ? idx : 0
  }

  /** Compact horizontal pipeline step indicator for a document */
  const PipelineIndicator = ({ doc }: { doc: DocumentRecord }) => {
    const currentIdx = getPipelineStepIndex(doc.status)
    const isError = doc.status === 'error'
    const isProcessing = isDocProcessing(doc)

    return (
      <div className="flex items-center gap-0 mt-2" title={`Trạng thái: ${STATUS_LABELS[doc.status] || doc.status}`}>
        {PIPELINE_STEPS.map((step, idx) => {
          const isCompleted = !isError && currentIdx > idx
          const isCurrent = !isError && currentIdx === idx
          const isErrorStep = isError && idx === (doc.processing_steps?.find(s => s.status === 'error') ? PIPELINE_STEPS.indexOf(doc.processing_steps.find(s => s.status === 'error')!.name as typeof PIPELINE_STEPS[number]) : -1)

          return (
            <div key={step} className="flex items-center">
              {/* Step dot */}
              <div className="flex flex-col items-center">
                <div
                  className={`h-2.5 w-2.5 rounded-full border transition-all duration-300 ${
                    isCompleted
                      ? 'bg-emerald-500 border-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]'
                      : isCurrent && isProcessing
                        ? 'bg-amber-400 border-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)] animate-pulse'
                        : isCurrent
                          ? 'bg-amber-400/60 border-amber-400'
                          : isErrorStep
                            ? 'bg-red-500 border-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]'
                            : isError && idx <= 1
                              ? 'bg-red-400/30 border-red-400/30'
                              : 'bg-transparent border-stone-600'
                  }`}
                />
                <span className={`text-[8px] mt-0.5 leading-none ${
                  isCompleted ? 'text-emerald-500' : isCurrent ? 'text-amber-400 font-medium' : isErrorStep ? 'text-red-400' : 'text-stone-500'
                }`}>
                  {PIPELINE_LABELS[step]}
                </span>
              </div>
              {/* Connector line between steps */}
              {idx < PIPELINE_STEPS.length - 1 && (
                <div className={`h-px w-3 mx-0.5 mb-2.5 ${
                  isCompleted ? 'bg-emerald-500/60' : isCurrent && isProcessing ? 'bg-amber-400/40' : 'bg-stone-700'
                }`} />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const partialDocs = (docStatusBreakdown['partial'] || 0) + staleDocsCount

  return (
    <div className="nc-wrap nc-cyan nc-corner-glow">
    <Card className="nc-panel nc-md nc-border-cyan">
      <CardHeader className="pb-1">
        <div className="flex items-center gap-2.5"><div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600"><BookOpen className="h-4 w-4 text-white" /></div><CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Tài liệu</CardTitle><Badge variant="secondary" className="text-[10px] text-stone-200">{docTotal}</Badge></div>
        {/* Status counts */}
        {totalDocs > 0 && (
          <div className="mt-1 flex items-center gap-3 text-[9px] text-stone-400">
            {completedDocs > 0 && <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />Hoàn thành {completedDocs}</span>}
            {partialDocs > 0 && <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />Tạm dừng {partialDocs}</span>}
            {processingDocs > 0 && <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />Đang xử lý {processingDocs}</span>}
            {uploadedDocs > 0 && <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-stone-500" />Đang chờ {uploadedDocs}</span>}
            {errorDocs > 0 && <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400" />Lỗi {errorDocs}</span>}
          </div>
        )}
        {/* Action buttons under title */}
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className={`h-7 px-2.5 text-[10px] rounded-lg border-cyan-400/35 btn-glow transition-all ${autoMode ? 'bg-emerald-950/50 border-emerald-300 text-emerald-400 hover:bg-emerald-900/40' : 'bg-slate-950/60 text-stone-200 hover:bg-slate-950/80'}`}
            onClick={onToggleAuto}
            title={autoMode ? 'Tắt chế độ tự động' : 'Bật chế độ tự động: 4 API key × 4 tài liệu = 16 đồng thời, ưu tiên trích xuất dở trước'}
          >
            <Zap className="h-3 w-3 mr-1" />
            Tự động
            {autoMode && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
          </Button>
          {embeddingPseudoCount > 0 && (
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow" onClick={onRegenerateEmbeddings} title="Tạo real embeddings thay thế pseudo embeddings">
              <TrendingUp className="h-3 w-3 mr-1" /> Tạo Embedding
            </Button>
          )}
          {(rawProcessingDocs > 0 || errorDocs > 0) && (
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow hover:bg-orange-900/40 hover:text-orange-400 hover:border-orange-500/55" onClick={onForceRecover} title="Phục hồi tất cả tài liệu bị kẹt (extracting/parsing/chunked/error) → partial/uploaded">
              <RefreshCw className="h-3 w-3 mr-1" /> Phục hồi
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {uploadSlot && (
          <div className="px-4 pt-3 pb-2 border-b border-cyan-400/15">
            {uploadSlot}
          </div>
        )}
        {docTotal === 0 ? (
          <div className="text-center py-10 text-stone-300 text-xs px-6 sparkle-container chamfer-md"><FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-20" /><p className="font-medium">Chưa có tài liệu nào</p><p className="mt-1">Tải lên PDF để bắt đầu</p></div>
        ) : docLoading ? (
          <div className="flex items-center justify-center py-16 text-stone-300 text-xs gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
            <span>Đang tải trang {docPage}...</span>
          </div>
        ) : (
          <div className="overflow-auto max-h-[520px]">
            <div className="space-y-3 p-4 pt-1">
              {documents.map(doc => {
                const percent = getDocPercent(doc)
                const showProgress = isDocProcessing(doc) || (doc.processing_steps && doc.processing_steps.length > 0 && doc.processing_steps.some(s => s.status === 'running' || s.status === 'completed'))
                const steps = doc.processing_steps || []
                const hasSteps = steps.length > 0

                return (
                  <div key={doc.id} className={`p-4 rounded-xl border shadow-sm min-w-0 transition-all duration-300 hover:shadow-md ${doc.status === 'error' && !extractingDocIds.has(doc.id) ? 'border-red-500/55 bg-red-950/20' : doc.status === 'partial' && !extractingDocIds.has(doc.id) && !userPausedDocIds.has(doc.id) ? 'border-amber-500/55 bg-amber-950/20' : doc.status === 'partial' && userPausedDocIds.has(doc.id) ? 'border-orange-500/55 bg-orange-950/20' : doc.status === 'indexed' || doc.status === 'extracted' ? 'border-emerald-500/55 bg-emerald-950/20' : isDocProcessing(doc) ? 'border-amber-500/55 bg-amber-950/20' : 'border-cyan-400/35 bg-slate-950/50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-stone-300" />
                          <button
                            className="text-xs font-medium truncate text-left text-stone-200 hover:text-primary hover:underline cursor-pointer flex items-center gap-1 transition-colors"
                            title={doc.title}
                            onClick={() => setExpandedDocId(expandedDocId === doc.id ? null : doc.id)}
                          >
                            {expandedDocId === doc.id
                              ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-stone-300" />
                              : <ChevronRight className="h-3 w-3 flex-shrink-0 text-stone-300" />
                            }
                            <span className="truncate">{doc.title}</span>
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          <Badge className={`text-[9px] h-4 px-1.5 ${userPausedDocIds.has(doc.id) && doc.status === 'partial' ? 'bg-orange-900/60 text-orange-300' : pausedDocIds.has(doc.id) || (['extracting', 'parsing', 'chunked'].includes(doc.status) && !extractingDocIds.has(doc.id)) ? STATUS_COLORS['partial'] : (extractingDocIds.has(doc.id) && doc.status === 'partial' ? STATUS_COLORS['extracting'] : (STATUS_COLORS[doc.status] || 'bg-stone-950/50 text-stone-400'))}`}>{userPausedDocIds.has(doc.id) && doc.status === 'partial' ? 'Tạm dừng' : pausedDocIds.has(doc.id) || (['extracting', 'parsing', 'chunked'].includes(doc.status) && !extractingDocIds.has(doc.id)) ? STATUS_LABELS['partial'] : (extractingDocIds.has(doc.id) && doc.status === 'partial' ? STATUS_LABELS['extracting'] : (STATUS_LABELS[doc.status] || doc.status))}</Badge>
                          <Badge className={`text-[9px] h-4 px-1.5 ${DOMAIN_COLORS[doc.domain] || 'bg-stone-950/50 text-stone-400'}`}>{DOMAIN_LABELS[doc.domain] || doc.domain}</Badge>
                          {doc.page_count && <span className="text-[10px] text-stone-300">{doc.page_count} trang</span>}
                          {doc.chunk_coverage && ['indexed', 'extracted', 'partial', 'extracting'].includes(doc.status) && (
                            <span className={`text-[10px] ${doc.chunk_coverage.missing > 0 ? 'text-amber-500 font-medium' : 'text-emerald-400'}`} title={`${doc.chunk_coverage.extracted}/${doc.chunk_coverage.total} chunks đã trích xuất`}>
                              {doc.chunk_coverage.missing > 0 ? `${doc.chunk_coverage.extracted}/${doc.chunk_coverage.total} chunks` : `${doc.chunk_coverage.total} chunks ✓`}
                            </span>
                          )}
                          {doc.chunk_coverage && (doc.chunk_coverage.entityCount ?? 0) > 0 && ['indexed', 'extracted', 'partial', 'extracting'].includes(doc.status) && (
                            <span className="text-[10px] text-cyan-400" title={`${doc.chunk_coverage.entityCount} entities, ${doc.chunk_coverage.relationshipCount ?? 0} quan hệ`}>
                              {doc.chunk_coverage.entityCount}E/{doc.chunk_coverage.relationshipCount ?? 0}R
                            </span>
                          )}
                        </div>
                        {doc.error_message && !doc.error_message.includes('Auto-recovered') && <p className="text-[10px] text-red-400 mt-1 line-clamp-2" title={doc.error_message}>{doc.error_message}</p>}
                        {/* Compact pipeline step indicator — always visible for processing/processed docs */}
                        {doc.status !== 'uploaded' && <PipelineIndicator doc={doc} />}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {doc.status === 'uploaded' && !extractingDocIds.has(doc.id) && !pausedDocIds.has(doc.id) && (
                          <Button size="sm" variant="outline" className="h-7 px-2.5 text-[10px] rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow hover:bg-emerald-900/40 hover:text-emerald-400 hover:border-emerald-500/55" onClick={() => { sonnerToast.info('Bắt đầu xử lý', { description: `Đang xử lý tài liệu "${doc.title}"`, duration: 3000 }); onProcessDoc(doc.id) }} disabled={processingIds.has(doc.id)}>
                            {processingIds.has(doc.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Play className="h-3 w-3 mr-1" /> Xử lý</>}
                          </Button>
                        )}
                        {/* Show "Tạm dừng" (Pause) button for actively processing docs — NOT for paused or partial docs.
                            When a doc is in 'partial' status (timed out / auto-stopped), the Continue button should show
                            instead of Pause — even if extractingDocIds still has the doc (stale state from auto-chain).
                            Also NOT for stale docs: if a doc is in 'extracting' but NOT in extractingDocIds,
                            it means the backend has died and the doc is stuck — show Continue instead. */}
                        {!pausedDocIds.has(doc.id) && doc.status !== 'partial' && (doc.status === 'parsing' || doc.status === 'chunked' || doc.status === 'extracting') && extractingDocIds.has(doc.id) && !['indexed', 'extracted', 'error'].includes(doc.status) && (
                          <Button size="sm" className="h-7 px-2.5 text-[10px] bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 rounded-lg shadow-sm btn-glow" onClick={() => onPauseDoc(doc.id)}>
                            <Pause className="h-3 w-3 mr-1" /> Tạm dừng
                          </Button>
                        )}
                        {/* "Đang tiếp tục..." (Auto-continue) — doc is 'partial' AND in extractingDocIds (auto-continue active),
                            NOT user-paused. Show disabled button with spinner to indicate auto-continue is in progress. */}
                        {doc.status === 'partial' && extractingDocIds.has(doc.id) && !userPausedDocIds.has(doc.id) && (
                          <Button size="sm" className="h-7 px-2.5 text-[10px] bg-gradient-to-r from-violet-500 to-purple-500 text-white border-0 rounded-lg shadow-sm opacity-80 cursor-not-allowed" disabled>
                            <Loader2 className="h-3 w-3 animate-spin mr-1" /> Đang tiếp tục...
                          </Button>
                        )}
                        {doc.status === 'indexed' && !extractingDocIds.has(doc.id) && !pausedDocIds.has(doc.id) && (
                          <div className="flex items-center gap-0.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                            {doc.chunk_coverage && doc.chunk_coverage.missing > 0 && (
                              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-amber-500 hover:text-amber-400 hover:bg-amber-900/40 rounded" onClick={() => onReExtractDoc(doc.id)} disabled={processingIds.has(doc.id)} title={`Trích xuất lại ${doc.chunk_coverage.missing} chunks thiếu`}>
                                <RefreshCw className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        )}
                        {doc.status === 'extracted' && !extractingDocIds.has(doc.id) && !pausedDocIds.has(doc.id) && (
                          <div className="flex items-center gap-0.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" title="Đã trích xuất entities (lưu trong Neo4j)" />
                            {onEmbedOnlyDoc && (
                              <Button size="sm" variant="outline" className="h-7 px-2.5 text-[10px] rounded-lg border-violet-400/45 bg-violet-950/40 text-violet-200 btn-glow hover:bg-violet-900/50 hover:text-violet-300 hover:border-violet-500/65" onClick={() => onEmbedOnlyDoc(doc.id)} disabled={processingIds.has(doc.id)} title="Tạo embeddings (vector) cho tài liệu này — bỏ qua LLM vì entities đã có sẵn trong Neo4j. Cần thiết để kích hoạt Vector Search.">
                                {processingIds.has(doc.id) ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />} Tạo Embedding
                              </Button>
                            )}
                            {doc.chunk_coverage && doc.chunk_coverage.missing > 0 && (
                              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-amber-500 hover:text-amber-400 hover:bg-amber-900/40 rounded" onClick={() => onReExtractDoc(doc.id)} disabled={processingIds.has(doc.id)} title={`Trích xuất lại ${doc.chunk_coverage.missing} chunks thiếu`}>
                                <RefreshCw className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        )}
                        {/* "Tiếp tục" (Continue) button for user-paused or stale docs.
                            Shows when: (a) doc is 'partial' AND user explicitly paused it (userPausedDocIds),
                            OR (b) doc is in 'extracting'/'parsing'/'chunked' but NOT in extractingDocIds
                            (stale — backend process has died, doc is stuck in transitional state),
                            OR (c) pausedDocIds has this doc (optimistic pause).
                            NOT shown when doc is 'partial' AND in extractingDocIds (auto-continue active) —
                            that case shows "Đang tiếp tục..." instead. */}
                        {((doc.status === 'partial' && userPausedDocIds.has(doc.id)) || (doc.status === 'partial' && !extractingDocIds.has(doc.id) && !userPausedDocIds.has(doc.id)) || pausedDocIds.has(doc.id) || (['extracting', 'parsing', 'chunked'].includes(doc.status) && !extractingDocIds.has(doc.id))) && (
                          <div className="flex items-center gap-1">
                            <Button size="sm" className="h-7 px-2.5 text-[10px] bg-gradient-to-r from-orange-400 to-amber-500 hover:from-orange-500 hover:to-amber-600 text-white border-0 rounded-lg shadow-sm btn-glow" onClick={() => onProcessDoc(doc.id)} disabled={processingIds.has(doc.id)}>
                              {processingIds.has(doc.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Play className="h-3 w-3 mr-1" /> Tiếp tục</>}
                            </Button>
                            {doc.chunk_coverage && doc.chunk_coverage.missing > 0 && (
                              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-amber-500 hover:text-amber-400 hover:bg-amber-900/40 rounded" onClick={() => onReExtractDoc(doc.id)} disabled={processingIds.has(doc.id)} title={`Trích xuất lại ${doc.chunk_coverage.missing} chunks thiếu`}>
                                <RefreshCw className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        )}
                        {doc.status === 'error' && !extractingDocIds.has(doc.id) && !pausedDocIds.has(doc.id) && (
                          <Button size="sm" className="h-7 px-2.5 text-[10px] bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 text-white border-0 rounded-lg shadow-sm btn-glow" onClick={() => { sonnerToast.info('Đang thử lại...', { description: `Xử lý lại tài liệu "${doc.title}"`, duration: 3000 }); onProcessDoc(doc.id) }} disabled={processingIds.has(doc.id)}>
                            {processingIds.has(doc.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <><RefreshCw className="h-3 w-3 mr-1" /> Thử lại</>}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-300 hover:text-red-400 hover:bg-red-900/40 rounded-lg btn-glow" onClick={() => {
                          if (window.confirm(`Xóa tài liệu "${doc.title}"? Tất cả dữ liệu liên quan sẽ bị xóa vĩnh viễn.`)) {
                            onDeleteDoc(doc.id)
                          }
                        }} title="Xóa tài liệu">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Per-document progress bar with step timeline */}
                    {/* Show when: processing, partial, or expanded by user click */}
                    {(isDocProcessing(doc) || doc.status === 'partial' || expandedDocId === doc.id) && (
                      <div className="mt-2.5 space-y-2">
                        {/* Progress bar */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-stone-300 font-medium">
                              {isDocProcessing(doc)
                                ? (doc.status === 'extracting' || extractingDocIds.has(doc.id))
                                  ? `Đang trích xuất ${getExtractDetail(doc) || '...'}`
                                  : doc.status === 'chunking' || doc.status === 'chunked'
                                    ? 'Đang chia chunks — chuẩn bị trích xuất...'
                                    : doc.status === 'embedding'
                                      ? 'Đang tạo vector embeddings...'
                                      : doc.status === 'indexing'
                                        ? 'Đang đánh chỉ mục...'
                                        : doc.status === 'parsing'
                                          ? 'Đang phân tích PDF...'
                                          : 'Đang xử lý...'
                                : doc.status === 'indexed' ? 'Hoàn thành!' : doc.status === 'partial' ? `Chờ tiếp tục — ${getExtractDetail(doc) || 'chưa hoàn thành'}` : doc.status === 'error' ? 'Lỗi!' : 'Sẵn sàng xử lý'}
                            </span>
                            <span className={`font-bold tabular-nums ${percent === 100 ? 'text-emerald-400' : percent > 0 ? 'text-amber-500' : 'text-stone-400'}`}>{percent}%</span>
                          </div>
                          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/10 backdrop-blur-sm">
                            <div
                              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out ${percent === 100 ? 'bg-gradient-to-r from-emerald-400 to-teal-500' : (doc.status === 'partial' && extractingDocIds.has(doc.id)) ? 'bg-gradient-to-r from-violet-300 to-purple-400' : (doc.status === 'partial' && !extractingDocIds.has(doc.id)) ? 'bg-gradient-to-r from-amber-300 to-yellow-400' : percent >= 30 ? 'bg-gradient-to-r from-violet-300 to-purple-400' : 'bg-gradient-to-r from-amber-300 to-amber-400'}`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>

                        {/* Step timeline (if steps exist) */}
                        {hasSteps ? (
                          <div className="space-y-1 ml-0.5">
                            {steps.map((step, idx) => (
                              <div key={`${step.name}-${idx}`} className="flex items-start gap-2">
                                {/* Vertical line connector */}
                                <div className="flex flex-col items-center">
                                  <StepIcon status={step.status} />
                                  {idx < steps.length - 1 && (
                                    <div className={`w-px h-3 ${step.status === 'completed' ? 'bg-emerald-300' : 'bg-stone-600'}`} />
                                  )}
                                </div>
                                {/* Step content */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between">
                                    <span className={`text-[10px] ${step.status === 'completed' ? 'text-emerald-400 font-medium' : step.status === 'running' ? 'text-amber-400 font-medium' : step.status === 'error' ? 'text-red-400 font-medium' : 'text-stone-400'}`}>
                                      {step.label}
                                    </span>
                                    <div className="flex items-center gap-2 text-[9px] text-stone-400">
                                      {step.startedAt && <span>{formatTime(step.startedAt)}</span>}
                                      {step.startedAt && <span>({formatDuration(step.startedAt, step.completedAt)})</span>}
                                    </div>
                                  </div>
                                  {step.name === 'extract' && step.detail && (step.status === 'running' || step.status === 'completed') ? (() => {
                                    // Parse chunk progress from detail string
                                    // Formats: "40/445 chunks", "[Key 1/4] Chunk 40/445 — ..."
                                    // Use "Chunk X/Y" or "X/Y chunks" pattern, skip "[Key X/Y]" by requiring context after
                                    const chunkMatch = step.detail.match(/Chunk\s*(\d+)\/(\d+)/) || step.detail.match(/(\d+)\/(\d+)\s*chunks/)
                                    const entityMatch = step.detail.match(/(\d+)\s*entities/)
                                    const relMatch = step.detail.match(/(\d+)\s*quan\s*hệ/)
                                    const keyMatch = step.detail.match(/\[Key\s*(\d+)\/(\d+)\]/)
                                    const processedChunks = chunkMatch ? parseInt(chunkMatch[1]) : 0
                                    const totalChunks = chunkMatch ? parseInt(chunkMatch[2]) : 0
                                    const entityCount = entityMatch ? parseInt(entityMatch[1]) : 0
                                    const relCount = relMatch ? parseInt(relMatch[1]) : 0
                                    const chunkPercent = totalChunks > 0 ? Math.round((processedChunks / totalChunks) * 100) : 0
                                    const isRunning = step.status === 'running'
                                    const isCompleted = step.status === 'completed'

                                    return (
                                      <div className="mt-1.5 space-y-1.5">
                                        {/* Key indicator */}
                                        {keyMatch && (
                                          <span className="inline-flex items-center gap-1 text-[9px] text-amber-300 bg-amber-500/10 rounded px-1.5 py-0.5">
                                            Key {keyMatch[1]}/{keyMatch[2]}
                                          </span>
                                        )}
                                        {/* Chunk progress bar (running) */}
                                        {isRunning && totalChunks > 0 && (
                                          <div>
                                            <div className="flex items-center justify-between text-[9px] mb-0.5">
                                              <span className="text-amber-300">Chunk {processedChunks}/{totalChunks}</span>
                                              <span className="text-amber-400 tabular-nums">{chunkPercent}%</span>
                                            </div>
                                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                              <div
                                                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-400 transition-all duration-500"
                                                style={{ width: `${chunkPercent}%` }}
                                              />
                                            </div>
                                          </div>
                                        )}
                                        {/* Entity/relationship counts (running or completed) */}
                                        {(entityCount > 0 || relCount > 0) && (
                                          <div className="flex items-center gap-3 text-[9px]">
                                            {entityCount > 0 && (
                                              <span className="flex items-center gap-1 text-cyan-400">
                                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
                                                {entityCount} entities
                                              </span>
                                            )}
                                            {relCount > 0 && (
                                              <span className="flex items-center gap-1 text-violet-400">
                                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
                                                {relCount} quan hệ
                                              </span>
                                            )}
                                          </div>
                                        )}
                                        {/* Completed summary with chunk info */}
                                        {isCompleted && totalChunks > 0 && (
                                          <p className="text-[9px] text-emerald-400/70">
                                            {processedChunks}/{totalChunks} chunks processed
                                          </p>
                                        )}
                                        {/* Fallback: show raw detail if no structured data parsed */}
                                        {!chunkMatch && !entityMatch && !relMatch && (
                                          <p className={`text-[9px] ${step.status === 'error' ? 'text-red-500' : 'text-stone-400'}`}>
                                            {step.detail}
                                          </p>
                                        )}
                                      </div>
                                    )
                                  })() : step.detail ? (
                                    <p className={`text-[9px] mt-0.5 ${step.status === 'error' ? 'text-red-500' : 'text-stone-400'}`}>
                                      {step.detail}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          /* No steps — show simple summary */
                          <div className="text-[10px] text-stone-400 space-y-0.5 pl-0.5">
                            {doc.status === 'indexed' && <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> Đã xử lý hoàn tất</p>}
                            {doc.status === 'uploaded' && <p className="flex items-center gap-1"><Info className="h-3 w-3" /> Chờ xử lý</p>}
                            {doc.page_count && <p>{doc.page_count} trang</p>}
                            {getExtractDetail(doc) && <p>Trích xuất: {getExtractDetail(doc)}</p>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {/* Pagination controls */}
        {docTotal > docPageSize && (
          <div className="flex items-center justify-center gap-1.5 px-5 py-3 border-t border-cyan-400/35 bg-slate-950/60 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow"
              onClick={() => onPageChange(1)}
              disabled={docPage <= 1 || docLoading}
              title="Trang đầu"
            >
              <ChevronsLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow"
              onClick={() => onPageChange(docPage - 1)}
              disabled={docPage <= 1 || docLoading}
              title="Trang trước"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {/* Page number buttons */}
            {(() => {
              const totalPages = Math.ceil(docTotal / docPageSize)
              const pages: number[] = []
              // Show at most 5 page numbers around the current page
              const start = Math.max(1, docPage - 2)
              const end = Math.min(totalPages, docPage + 2)
              for (let i = start; i <= end; i++) pages.push(i)
              return pages.map(p => (
                <Button
                  key={p}
                  variant={p === docPage ? 'default' : 'outline'}
                  size="sm"
                  className={`h-7 w-7 p-0 rounded-lg text-[11px] ${p === docPage ? 'bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-500' : 'border-cyan-400/35 bg-slate-950/60 text-stone-200'}`}
                  onClick={() => onPageChange(p)}
                  disabled={docLoading}
                >
                  {docLoading && p === docPage ? <Loader2 className="h-3 w-3 animate-spin" /> : p}
                </Button>
              ))
            })()}
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow"
              onClick={() => onPageChange(docPage + 1)}
              disabled={docPage >= Math.ceil(docTotal / docPageSize) || docLoading}
              title="Trang sau"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 rounded-lg border-cyan-400/35 bg-slate-950/60 text-stone-200 btn-glow"
              onClick={() => onPageChange(Math.ceil(docTotal / docPageSize))}
              disabled={docPage >= Math.ceil(docTotal / docPageSize) || docLoading}
              title="Trang cuối"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[11px] text-stone-300 tabular-nums ml-1">
              {docTotal} tài liệu
            </span>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  )
}

// ==================== CHAT SECTION ====================

const MAX_CHAT_HISTORY = 10
const CHAT_HISTORY_CONTEXT_SIZE = 5

function ChatSection() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const buildChatHistory = useCallback((msgs: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> => {
    // Include last N messages as context for the query service
    const recent = msgs.slice(-CHAT_HISTORY_CONTEXT_SIZE * 2) // *2 because user+assistant pairs
    return recent.map(m => ({ role: m.role, content: m.content }))
  }, [])

  const sendMessage = useCallback(async (queryText?: string) => {
    const text = queryText || input.trim()
    if (!text || loading) return
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: new Date() }
    setMessages(prev => {
      const updated = [...prev, userMsg]
      // Keep only last MAX_CHAT_HISTORY messages
      if (updated.length > MAX_CHAT_HISTORY) return updated.slice(-MAX_CHAT_HISTORY)
      return updated
    })
    if (!queryText) setInput('')
    setLoading(true)

    try {
      // Build chat history from messages before this one (last 5 messages as context)
      const chatHistory = buildChatHistory([...messages, userMsg].slice(0, -1))

      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          options: { chatHistory },
        }),
      })
      if (!res.ok) {
        let errorMsg = 'Query API error'
        try { const errData = await res.json(); errorMsg = errData.error || errData.message || errorMsg } catch {}
        throw new Error(errorMsg)
      }
      const data = await res.json() as QueryResult

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.answer || 'Không thể tạo câu trả lời.',
        timestamp: new Date(),
        queryResult: data,
      }
      setMessages(prev => {
        const updated = [...prev, assistantMsg]
        if (updated.length > MAX_CHAT_HISTORY) return updated.slice(-MAX_CHAT_HISTORY)
        return updated
      })
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(), role: 'assistant',
        content: `Lỗi khi truy vấn: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, errorMsg])
    }
    setLoading(false)
  }, [input, loading, messages, buildChatHistory])

  const clearChat = useCallback(() => {
    setMessages([])
    setInput('')
  }, [])

  // Smooth scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  return (
    <div className="flex flex-col h-[600px]">
      {/* Header with Clear Chat button */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600">
            <MessageCircle className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-stone-100">Conversation</span>
          {messages.length > 0 && (
            <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
              {messages.filter(m => m.role === 'user').length} messages
            </Badge>
          )}
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive rounded-lg btn-glow"
            onClick={clearChat}>
            <Trash2 className="h-3 w-3 mr-1" /> Xóa
          </Button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1 pb-2 scroll-smooth">
        {messages.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Bot className="h-14 w-14 mx-auto mb-4 opacity-15" />
            <p className="text-base font-semibold tracking-tight text-stone-100">GraphRAG Chat</p>
            <p className="text-xs mt-1.5">Đặt câu hỏi về Knowledge Base để bắt đầu</p>
            <div className="flex flex-wrap gap-2 justify-center mt-5">
              {['QuickSort là gì?', 'Mối quan hệ giữa ML và Neural Network', 'Các kỹ thuật bảo mật phổ biến'].map(q => (
                <Button key={q} variant="outline" size="sm" className="text-xs h-8 rounded-full border-cyan-400/35 bg-slate-950/60 hover:border-emerald-300 hover:bg-emerald-900/40 hover:text-emerald-400 btn-glow"
                  onClick={() => sendMessage(q)}>{q}</Button>
              ))}
            </div>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2.5`}>
            {/* Bot icon for assistant messages */}
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-emerald-900 to-teal-900 flex items-center justify-center mt-1 shadow-sm">
                <Brain className="h-3.5 w-3.5 text-emerald-400" />
              </div>
            )}
            <div className={`max-w-[80%] rounded-2xl p-3.5 shadow-sm ${msg.role === 'user' ? 'bg-gradient-to-r from-emerald-600 to-teal-700 text-white' : 'bg-slate-950/50 border border-cyan-400/35 border-l-2 border-l-emerald-400'}`}>
              {msg.role === 'user' && (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] opacity-80">Bạn</span>
                </div>
              )}
              {msg.role === 'assistant' && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[10px] text-stone-400 font-medium">GraphRAG Assistant</span>
                  {msg.queryResult && (
                    <>
                      <Badge className={`text-[8px] h-3.5 px-1 ${QUERY_TYPE_COLORS[msg.queryResult.queryType] || 'bg-stone-950/50 text-stone-400'}`}>
                        {QUERY_TYPE_LABELS[msg.queryResult.queryType] || msg.queryResult.queryType}
                      </Badge>
                      <Badge variant="outline" className="text-[8px] h-3.5 px-1">
                        {(msg.queryResult.confidence * 100).toFixed(0)}%
                      </Badge>
                    </>
                  )}
                </div>
              )}
              <p className="text-xs whitespace-pre-wrap leading-relaxed text-stone-300">{msg.content}</p>
              {msg.queryResult && (
                <div className="mt-2 pt-2 border-t border-cyan-400/35">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[8px] h-3.5 px-1">
                      <Zap className="h-2.5 w-2.5 mr-0.5" /> {(msg.queryResult.durationMs / 1000).toFixed(1)}s
                    </Badge>
                    <Badge variant="outline" className="text-[8px] h-3.5 px-1">
                      <Database className="h-2.5 w-2.5 mr-0.5" /> {msg.queryResult.vectorResultsCount} vector
                    </Badge>
                    <Badge variant="outline" className="text-[8px] h-3.5 px-1">
                      <GitBranch className="h-2.5 w-2.5 mr-0.5" /> {msg.queryResult.graphResultsCount} graph
                    </Badge>
                    <Badge variant="outline" className="text-[8px] h-3.5 px-1">
                      {msg.queryResult.provider}/{msg.queryResult.model.slice(0, 15)}
                    </Badge>
                  </div>
                  {msg.queryResult.sources && msg.queryResult.sources.length > 0 && (
                    <details className="mt-1.5">
                      <summary className="text-[9px] text-stone-400 cursor-pointer hover:text-stone-300">Nguồn ({msg.queryResult.sources.length})</summary>
                      <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                        {msg.queryResult.sources.map((s, i) => (
                          <div key={i} className="text-[9px] text-muted-foreground flex items-start gap-1">
                            <Badge className="text-[7px] h-3 px-0.5 bg-stone-950/50 text-stone-400">{s.type === 'chunk' ? '📄' : s.type === 'entity' ? '🏷️' : '🔗'}</Badge>
                            <span className="truncate">{s.content.slice(0, 80)}{s.documentTitle && <span className="text-[8px]"> ({s.documentTitle})</span>}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {msg.queryResult.reasoning && (
                    <details className="mt-1">
                      <summary className="text-[9px] text-stone-400 cursor-pointer hover:text-stone-300">Chuỗi suy luận</summary>
                      <p className="text-[9px] text-stone-400 mt-0.5">{msg.queryResult.reasoning}</p>
                    </details>
                  )}
                  {/* Follow-up Questions */}
                  {msg.queryResult.followUpQuestions && msg.queryResult.followUpQuestions.length > 0 && (
                    <div className="mt-2 pt-1.5 border-t border-cyan-400/35">
                      <div className="flex items-center gap-1 mb-1.5">
                        <Lightbulb className="h-3 w-3 text-amber-500" />
                        <span className="text-[9px] text-stone-400">Câu hỏi liên quan</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.queryResult.followUpQuestions.map((q, i) => (
                          <button
                            key={i}
                            onClick={() => sendMessage(q)}
                            className="text-[10px] px-2.5 py-1 rounded-full border border-cyan-400/35 bg-slate-950/50 text-stone-400 hover:bg-emerald-900/40 hover:border-emerald-300 hover:text-emerald-400 transition-colors cursor-pointer"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* User icon for user messages */}
            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-emerald-900 to-teal-900 flex items-center justify-center mt-1 shadow-sm">
                <MessageSquare className="h-3.5 w-3.5 text-emerald-400" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex justify-start gap-2.5">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-emerald-900 to-teal-900 flex items-center justify-center mt-1 shadow-sm">
              <Brain className="h-3.5 w-3.5 text-emerald-400" />
            </div>
            <div className="bg-slate-950/50 border border-cyan-400/35 border-l-2 border-l-emerald-400 rounded-2xl p-3.5 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                <span className="text-xs text-stone-400">Đang tìm kiếm & phân tích...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="mt-3 flex gap-2">
        <Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
          placeholder="Đặt câu hỏi về Knowledge Base..." className="text-xs h-10 rounded-xl border-cyan-400/35 focus:border-emerald-600 focus:ring-emerald-600/20" disabled={loading} />
        <Button onClick={() => sendMessage()} disabled={loading || !input.trim()} size="sm" className="h-10 px-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm border-0 rounded-xl btn-glow">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

// ==================== KNOWLEDGE EXPLORER ====================

function KnowledgeExplorer() {
  // Graph data state
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>([])
  const [selectedEntity, setSelectedEntity] = useState<{
    entity: { name: string; type: string; domain: string; description: string } | null
    neighbors: Array<{ name: string; type: string; domain: string; description: string }>
    relationships: Array<{ source: string; type: string; target: string }>
  } | null>(null)
  const [pathFrom, setPathFrom] = useState('')
  const [pathTo, setPathTo] = useState('')
  const [paths, setPaths] = useState<Array<{ nodes: string[]; edges: Array<{ source: string; type: string; target: string }>; length: number }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphMode, setGraphMode] = useState<'2d' | '3d'>('2d')
  const [highlightSearch, setHighlightSearch] = useState('')
  const [pathHighlight, setPathHighlight] = useState<string[]>([])

  // D3 refs
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null)
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)

  // Track node/link IDs for dedup
  const nodeIdsRef = useRef<Set<string>>(new Set())
  const linkIdsRef = useRef<Set<string>>(new Set())

  // Entity type colors
  const getNodeColor = (type: string) => ENTITY_TYPE_COLORS[type] || '#9ca3af'
  const getNodeRadius = (occurrences: number) => Math.max(8, Math.min(28, 6 + occurrences * 4))

  // Load initial graph data
  const loadInitialGraph = useCallback(async () => {
    setGraphLoading(true)
    try {
      // Fetch entities
      const entRes = await fetch('/api/ingestion/entities?limit=150')
      const entData = await entRes.json()
      const entities: EntityRecord[] = entData.entities || []

      // Fetch relationships
      const relRes = await fetch('/api/ingestion/relationships?limit=500')
      const relData = await relRes.json()
      const rels: RelationshipRecord[] = relData.relationships || []

      // Build nodes from entities
      const newNodes: GraphNode[] = []
      const newNodeIds = new Set<string>()
      entities.forEach(e => {
        const name = e.entity_name
        if (!newNodeIds.has(name)) {
          newNodeIds.add(name)
          const occ = e.resolved && typeof (e.resolved as Record<string, unknown>).occurrence_count === 'number'
            ? (e.resolved as Record<string, unknown>).occurrence_count as number : 1
          newNodes.push({
            id: name, name, type: e.entity_type, domain: e.domain,
            description: e.description, occurrences: occ,
          })
        }
      })

      // Build links from relationships
      const newLinks: GraphLink[] = []
      const newLinkIds = new Set<string>()
      rels.forEach(r => {
        const srcName = r.source_entity?.entity_name
        const tgtName = r.target_entity?.entity_name
        if (srcName && tgtName && newNodeIds.has(srcName) && newNodeIds.has(tgtName)) {
          const linkId = `${srcName}->${r.relationship_type}->${tgtName}`
          if (!newLinkIds.has(linkId)) {
            newLinkIds.add(linkId)
            newLinks.push({
              id: linkId, source: srcName, target: tgtName, relType: r.relationship_type,
            })
          }
        }
      })

      // Add nodes that appear in relationships but not in entities list
      rels.forEach(r => {
        const srcName = r.source_entity?.entity_name
        const tgtName = r.target_entity?.entity_name
        if (srcName && !newNodeIds.has(srcName)) {
          newNodeIds.add(srcName)
          newNodes.push({
            id: srcName, name: srcName, type: r.source_entity?.entity_type || 'Concept',
            domain: '', description: '', occurrences: 1,
          })
        }
        if (tgtName && !newNodeIds.has(tgtName)) {
          newNodeIds.add(tgtName)
          newNodes.push({
            id: tgtName, name: tgtName, type: r.target_entity?.entity_type || 'Concept',
            domain: '', description: '', occurrences: 1,
          })
        }
        // Also add links for these newly added nodes
        if (srcName && tgtName) {
          const linkId = `${srcName}->${r.relationship_type}->${tgtName}`
          if (!newLinkIds.has(linkId)) {
            newLinkIds.add(linkId)
            newLinks.push({
              id: linkId, source: srcName, target: tgtName, relType: r.relationship_type,
            })
          }
        }
      })

      nodeIdsRef.current = newNodeIds
      linkIdsRef.current = newLinkIds
      setGraphNodes(newNodes)
      setGraphLinks(newLinks)
    } catch (err) {
      console.error('Failed to load graph data:', err)
    }
    setGraphLoading(false)
  }, [])

  // Expand node neighborhood
  const expandNode = useCallback(async (entityName: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/query?action=graph-explore&entity=${encodeURIComponent(entityName)}`)
      if (!res.ok) {
        let errorMsg = 'Graph explore API error'
        try { const errData = await res.json(); errorMsg = errData.error || errData.message || errorMsg } catch {}
        throw new Error(errorMsg)
      }
      const data = await res.json()
      setSelectedEntity(data)

      if (data.entity) {
        // Add the entity node if not present
        const newNodes = [...graphNodes]
        const newLinks = [...graphLinks]
        const newNodeIds = new Set(nodeIdsRef.current)
        const newLinkIds = new Set(linkIdsRef.current)

        if (!newNodeIds.has(data.entity.name)) {
          newNodeIds.add(data.entity.name)
          newNodes.push({
            id: data.entity.name, name: data.entity.name, type: data.entity.type,
            domain: data.entity.domain || '', description: data.entity.description || '', occurrences: 1,
          })
        }

        // Add neighbor nodes
        ;(data.neighbors || []).forEach((n: { name: string; type: string; domain: string; description: string }) => {
          if (!newNodeIds.has(n.name)) {
            newNodeIds.add(n.name)
            newNodes.push({
              id: n.name, name: n.name, type: n.type, domain: n.domain || '',
              description: n.description || '', occurrences: 1,
            })
          }
        })

        // Add relationship links
        ;(data.relationships || []).forEach((r: { source: string; type: string; target: string }) => {
          const linkId = `${r.source}->${r.type}->${r.target}`
          if (!newLinkIds.has(linkId)) {
            newLinkIds.add(linkId)
            newLinks.push({
              id: linkId, source: r.source, target: r.target, relType: r.type,
            })
          }
        })

        nodeIdsRef.current = newNodeIds
        linkIdsRef.current = newLinkIds
        setGraphNodes(newNodes)
        setGraphLinks(newLinks)
      }
    } catch (err) {
      console.error('Failed to expand node:', err)
    }
    setLoading(false)
  }, [graphNodes, graphLinks])

  // Search entity in graph and expand
  const searchEntities = useCallback(async () => {
    if (!highlightSearch.trim()) return
    await expandNode(highlightSearch.trim())
  }, [highlightSearch, expandNode])

  // Find paths between entities
  const findPaths = useCallback(async () => {
    if (!pathFrom.trim() || !pathTo.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/query?action=graph-path&from=${encodeURIComponent(pathFrom)}&to=${encodeURIComponent(pathTo)}`)
      if (!res.ok) {
        let errorMsg = 'Graph path API error'
        try { const errData = await res.json(); errorMsg = errData.error || errData.message || errorMsg } catch {}
        throw new Error(errorMsg)
      }
      const data = await res.json()
      const foundPaths = data.paths || []
      setPaths(foundPaths)

      // Highlight path nodes
      if (foundPaths.length > 0) {
        const pathNodeNames = new Set<string>()
        foundPaths.forEach((p: { nodes: string[] }) => p.nodes.forEach((n: string) => pathNodeNames.add(n)))
        setPathHighlight(Array.from(pathNodeNames))

        // Make sure all path nodes are in the graph
        const newNodes = [...graphNodes]
        const newNodeIds = new Set(nodeIdsRef.current)
        foundPaths.forEach((p: { nodes: string[] }) => {
          p.nodes.forEach((n: string) => {
            if (!newNodeIds.has(n)) {
              newNodeIds.add(n)
              newNodes.push({ id: n, name: n, type: 'Concept', domain: '', description: '', occurrences: 1 })
            }
          })
        })

        // Add path edges
        const newLinks = [...graphLinks]
        const newLinkIds = new Set(linkIdsRef.current)
        foundPaths.forEach((p: { edges: Array<{ source: string; type: string; target: string }> }) => {
          ;(p.edges || []).forEach((e: { source: string; type: string; target: string }) => {
            const linkId = `${e.source}->${e.type}->${e.target}`
            if (!newLinkIds.has(linkId)) {
              newLinkIds.add(linkId)
              newLinks.push({ id: linkId, source: e.source, target: e.target, relType: e.type })
            }
          })
        })

        nodeIdsRef.current = newNodeIds
        linkIdsRef.current = newLinkIds
        setGraphNodes(newNodes)
        setGraphLinks(newLinks)
      }
    } catch { setPaths([]) }
    setLoading(false)
  }, [pathFrom, pathTo, graphNodes, graphLinks])

  // D3 force simulation setup
  useEffect(() => {
    if (!svgRef.current || graphNodes.length === 0) return

    const svg = d3.select(svgRef.current)
    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth
    const height = Math.max(450, Math.min(600, window.innerHeight - 300))

    svg.attr('width', width).attr('height', height)

    // Clear previous content
    svg.selectAll('*').remove()

    // Add defs for arrow markers
    const defs = svg.append('defs')
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#94a3b8')

    // Glow filter for selected nodes
    const filter = defs.append('filter').attr('id', 'glow')
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur')
    const feMerge = filter.append('feMerge')
    feMerge.append('feMergeNode').attr('in', 'coloredBlur')
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    // Setup zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })
    zoomRef.current = zoom
    svg.call(zoom)

    const g = svg.append('g')
    gRef.current = g

    // Prepare simulation data
    const simNodes: GraphNode[] = graphNodes.map(n => ({ ...n }))
    const simLinks: GraphLink[] = graphLinks.map(l => ({
      ...l,
      source: l.source as string,
      target: l.target as string,
    }))

    // Create force simulation
    const simulation = d3.forceSimulation<GraphNode>(simNodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(simLinks)
        .id(d => d.id)
        .distance(100)
        .strength(0.5))
      .force('charge', d3.forceManyBody<GraphNode>().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<GraphNode>().radius(d => getNodeRadius(d.occurrences) + 5))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05))

    simulationRef.current = simulation

    // Draw links
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.6)
      .attr('marker-end', 'url(#arrowhead)')

    // Draw link labels
    const linkLabel = g.append('g')
      .attr('class', 'link-labels')
      .selectAll<SVGTextElement, GraphLink>('text')
      .data(simLinks)
      .join('text')
      .text(d => d.relType)
      .attr('font-size', 7)
      .attr('fill', '#94a3b8')
      .attr('text-anchor', 'middle')
      .attr('dy', -4)
      .style('pointer-events', 'none')
      .style('user-select', 'none')

    // Draw node groups
    const nodeGroup = g.append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(simNodes, d => d.id)
      .join('g')
      .style('cursor', 'pointer')

    // Node circles
    nodeGroup.append('circle')
      .attr('r', d => getNodeRadius(d.occurrences))
      .attr('fill', d => getNodeColor(d.type))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.8)

    // Node labels
    nodeGroup.append('text')
      .text(d => d.name.length > 14 ? d.name.slice(0, 12) + '...' : d.name)
      .attr('dy', d => getNodeRadius(d.occurrences) + 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', 9)
      .attr('fill', '#334155')
      .attr('font-weight', 500)
      .style('pointer-events', 'none')
      .style('user-select', 'none')

    // Drag behavior
    const drag = d3.drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
      })

    nodeGroup.call(drag)

    // Click handler
    nodeGroup.on('click', (_event, d) => {
      _event.stopPropagation()
      void expandNode(d.name)
    })

    // Double-click to expand
    nodeGroup.on('dblclick', (_event, d) => {
      _event.stopPropagation()
      void expandNode(d.name)
    })

    // Hover tooltip
    nodeGroup.on('mouseenter', (_event, d) => {
      if (tooltipRef.current) {
        tooltipRef.current.style.display = 'block'
        tooltipRef.current.innerHTML = `<div class="font-medium text-xs text-stone-200">${d.name}</div><div class="text-[10px] text-stone-400">${d.type}${d.domain ? ' · ' + d.domain : ''}</div>`
      }
      // Highlight node
      d3.select(_event.currentTarget as SVGGElement).select('circle')
        .attr('stroke', '#f97316')
        .attr('stroke-width', 3)
        .attr('filter', 'url(#glow)')
    })

    nodeGroup.on('mousemove', (_event) => {
      if (tooltipRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        tooltipRef.current.style.left = `${_event.clientX - rect.left + 12}px`
        tooltipRef.current.style.top = `${_event.clientY - rect.top - 10}px`
      }
    })

    nodeGroup.on('mouseleave', (_event, d) => {
      if (tooltipRef.current) {
        tooltipRef.current.style.display = 'none'
      }
      // Reset highlight unless selected
      const isSelected = selectedEntity?.entity?.name === d.name
      d3.select(_event.currentTarget as SVGGElement).select('circle')
        .attr('stroke', isSelected ? '#f97316' : '#fff')
        .attr('stroke-width', isSelected ? 3 : 2)
        .attr('filter', isSelected ? 'url(#glow)' : 'none')
    })

    // Simulation tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as GraphNode).x ?? 0)
        .attr('y1', d => (d.source as GraphNode).y ?? 0)
        .attr('x2', d => (d.target as GraphNode).x ?? 0)
        .attr('y2', d => (d.target as GraphNode).y ?? 0)

      linkLabel
        .attr('x', d => ((d.source as GraphNode).x ?? 0 + (d.target as GraphNode).x ?? 0) / 2)
        .attr('y', d => ((d.source as GraphNode).y ?? 0 + (d.target as GraphNode).y ?? 0) / 2)

      nodeGroup.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    // Initial zoom to fit
    setTimeout(() => {
      const bounds = (g.node() as SVGGElement)?.getBBox()
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        const scale = Math.min(
          width / (bounds.width + 80),
          height / (bounds.height + 80),
          1.5
        ) * 0.9
        const tx = width / 2 - (bounds.x + bounds.width / 2) * scale
        const ty = height / 2 - (bounds.y + bounds.height / 2) * scale
        svg.transition().duration(750).call(
          zoom.transform,
          d3.zoomIdentity.translate(tx, ty).scale(scale)
        )
      }
    }, 1200)

    return () => {
      simulation.stop()
      simulationRef.current = null
    }
  }, [graphNodes, graphLinks])

  // Update highlights when search or path changes
  useEffect(() => {
    if (!gRef.current) return
    const g = gRef.current

    // Update node highlights
    g.select('.nodes').selectAll<SVGGElement, GraphNode>('g').each(function (d) {
      const circle = d3.select(this).select('circle')
      const isSearchMatch = highlightSearch && d.name.toLowerCase().includes(highlightSearch.toLowerCase())
      const isPathNode = pathHighlight.includes(d.name)
      const isSelected = selectedEntity?.entity?.name === d.name

      if (isSelected) {
        circle.attr('stroke', '#f97316').attr('stroke-width', 3).attr('filter', 'url(#glow)')
      } else if (isPathNode) {
        circle.attr('stroke', '#f59e0b').attr('stroke-width', 3).attr('filter', 'url(#glow)')
      } else if (isSearchMatch) {
        circle.attr('stroke', '#10b981').attr('stroke-width', 3).attr('filter', 'url(#glow)')
      } else {
        circle.attr('stroke', '#fff').attr('stroke-width', 2).attr('filter', 'none')
      }

      // Dim non-matching nodes when searching
      const shouldDim = (highlightSearch || pathHighlight.length > 0) && !isSearchMatch && !isPathNode && !isSelected
      d3.select(this).attr('opacity', shouldDim ? 0.25 : 1)
    })

    // Update link highlights for path
    g.select('.links').selectAll<SVGLineElement, GraphLink>('line').each(function (d) {
      const srcName = typeof d.source === 'string' ? d.source : (d.source as GraphNode).name
      const tgtName = typeof d.target === 'string' ? d.target : (d.target as GraphNode).name
      const isPathLink = pathHighlight.includes(srcName) && pathHighlight.includes(tgtName)
      d3.select(this)
        .attr('stroke', isPathLink ? '#f59e0b' : '#cbd5e1')
        .attr('stroke-width', isPathLink ? 3 : 1.5)
        .attr('stroke-opacity', isPathLink ? 1 : 0.6)
    })
  }, [highlightSearch, pathHighlight, selectedEntity, graphNodes, graphLinks])

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    if (svgRef.current && zoomRef.current) {
      d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5)
    }
  }, [])

  const handleZoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) {
      d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67)
    }
  }, [])

  const handleFitToScreen = useCallback(() => {
    if (!svgRef.current || !zoomRef.current || !gRef.current || !containerRef.current) return
    const svg = d3.select(svgRef.current)
    const container = containerRef.current
    const width = container.clientWidth
    const height = Math.max(450, Math.min(600, window.innerHeight - 300))
    const bounds = (gRef.current.node() as SVGGElement)?.getBBox()
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      const scale = Math.min(
        width / (bounds.width + 80),
        height / (bounds.height + 80),
        1.5
      ) * 0.9
      const tx = width / 2 - (bounds.x + bounds.width / 2) * scale
      const ty = height / 2 - (bounds.y + bounds.height / 2) * scale
      svg.transition().duration(750).call(
        zoomRef.current.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      )
    }
  }, [])

  // Load initial data on mount
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      void loadInitialGraph()
    }
  }, [loadInitialGraph])

  // Get unique entity types for legend
  const entityTypesInGraph = [...new Set(graphNodes.map(n => n.type))].filter(Boolean)

  return (
    <div className="space-y-4">
      {/* Search & Path Finder Bar */}
      <div className="nc-wrap nc-magenta">
      <Card className="nc-panel nc-md nc-border-magenta">
        <CardContent className="pt-5 pb-5 space-y-4">
          <div className="flex gap-2 items-center">
            <div className="flex-1 flex gap-2">
              <Input value={highlightSearch} onChange={e => setHighlightSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void searchEntities()}
                placeholder="Tìm & highlight entity trong graph..." className="text-xs h-9 flex-1" />
              <Button onClick={() => void searchEntities()} disabled={loading} variant="outline" size="sm" className="h-9 px-4 border-cyan-400/35 bg-slate-950/60 hover:bg-emerald-900/40 hover:text-emerald-400 hover:border-emerald-500/55 btn-glow">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          {/* Path Finder */}
          <div className="nc-wrap nc-cyan-soft">
          <div className="nc-panel nc-sm nc-border-cyan-soft p-3">
            <p className="text-[11px] font-medium mb-1.5 flex items-center gap-1 text-stone-300"><Route className="h-3 w-3" /> Tìm đường đi giữa 2 entities</p>
            <div className="flex gap-2 items-center">
              <Input value={pathFrom} onChange={e => setPathFrom(e.target.value)} placeholder="Entity 1" className="text-xs h-8 flex-1" />
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <Input value={pathTo} onChange={e => setPathTo(e.target.value)} placeholder="Entity 2" className="text-xs h-8 flex-1" />
              <Button onClick={() => void findPaths()} variant="outline" size="sm" className="h-8 px-3 text-xs border-cyan-400/35 bg-slate-950/60 hover:bg-orange-900/40 hover:text-orange-400 hover:border-orange-500/55 btn-glow">Tìm</Button>
            </div>
            {paths && paths.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {paths.map((path, i) => (
                  <div key={i} className="p-2.5 rounded-xl bg-slate-950/50 border border-cyan-400/35 text-xs shadow-sm">
                    <div className="flex items-center gap-1 flex-wrap">
                      {path.nodes.map((node, j) => (
                        <span key={j} className="flex items-center gap-1">
                          <Badge variant="outline" className="text-[9px] h-4 px-1">{node}</Badge>
                          {j < path.nodes.length - 1 && <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />}
                        </span>
                      ))}
                      <Badge className="text-[8px] h-3.5 px-1 bg-orange-950/50 text-orange-400">{path.length} bước</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {paths && paths.length === 0 && <p className="text-[10px] text-muted-foreground mt-1">Không tìm thấy đường đi</p>}
          </div>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* Main Layout: Graph + Side Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Graph Visualization */}
        <div className="lg:col-span-2">
          <div className="nc-wrap nc-magenta">
          <Card className="nc-panel nc-md nc-border-magenta">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600"><GraphIcon className="h-4 w-4 text-white" /></div>
                  <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Knowledge Graph</CardTitle>
                  <Badge variant="secondary" className="text-[10px]">{graphNodes.length} nodes · {graphLinks.length} edges</Badge>
                </div>
                {/* Zoom Controls + 2D/3D Toggle */}
                <div className="flex items-center gap-1">
                  {/* 2D/3D Mode Toggle */}
                  <div className="flex items-center rounded-lg border border-magenta-400/35 overflow-hidden mr-1">
                    <button
                      onClick={() => setGraphMode('2d')}
                      className={`px-2 h-7 text-[10px] font-medium transition-colors ${graphMode === '2d' ? 'bg-magenta-600/40 text-white' : 'bg-slate-950/60 text-stone-400 hover:text-stone-200'}`}
                      title="2D view (D3 force-directed)"
                    >2D</button>
                    <button
                      onClick={() => setGraphMode('3d')}
                      className={`px-2 h-7 text-[10px] font-medium transition-colors ${graphMode === '3d' ? 'bg-magenta-600/40 text-white' : 'bg-slate-950/60 text-stone-400 hover:text-stone-200'}`}
                      title="3D view (glowing nodes + light connections)"
                    >3D</button>
                  </div>
                  <Button variant="outline" size="icon" className="h-7 w-7 btn-glow" onClick={handleZoomIn} title="Zoom In">
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 btn-glow" onClick={handleZoomOut} title="Zoom Out">
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 btn-glow" onClick={handleFitToScreen} title="Fit to Screen">
                    <Maximize className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 btn-glow" onClick={() => void loadInitialGraph()} title="Reload">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 relative">
              {graphLoading ? (
                <div className="flex items-center justify-center" style={{ height: 500 }}>
                  <div className="text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Đang tải graph data...</p>
                  </div>
                </div>
              ) : graphNodes.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height: 500 }}>
                  <div className="text-center text-muted-foreground">
                    <GraphIcon className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm font-medium">Chưa có dữ liệu graph</p>
                    <p className="text-xs mt-1">Tải lên và xử lý tài liệu để tạo entities & relationships</p>
                  </div>
                </div>
              ) : (
                <div ref={containerRef} className="relative w-full border-t" style={{ minHeight: 450 }}>
                  {graphMode === '3d' ? (
                    <KnowledgeGraph3D
                      nodes={graphNodes}
                      links={graphLinks}
                      getNodeColor={getNodeColor}
                      getNodeRadius={getNodeRadius}
                      onNodeClick={(name) => void expandNode(name)}
                    />
                  ) : (
                    <>
                      <svg ref={svgRef} className="w-full" style={{ height: 500, background: 'transparent' }} />
                      {/* Tooltip */}
                      <div ref={tooltipRef} className="absolute hidden pointer-events-none z-50 bg-slate-950/80 rounded-lg shadow-lg border border-cyan-400/40 px-3 py-2" />
                    </>
                  )}
                </div>
              )}
              {/* Legend */}
              {entityTypesInGraph.length > 0 && (
                <div className="px-4 py-2 border-t bg-muted/30 flex flex-wrap gap-x-3 gap-y-1">
                  {entityTypesInGraph.map(type => (
                    <div key={type} className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: getNodeColor(type) }} />
                      <span className="text-[10px] text-muted-foreground">{type}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Instructions */}
              <div className="px-4 py-1.5 border-t text-[9px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5">
                <span>💡 Click: Select & expand</span>
                <span>🖱️ Double-click: Expand neighborhood</span>
                <span>↔️ Drag: Move nodes</span>
                <span>🔍 Scroll: Zoom</span>
                <span>✋ Drag background: Pan</span>
              </div>
            </CardContent>
          </Card>
          </div>
        </div>

        {/* Side Panel: Entity Details */}
        <div className="space-y-4">
          {selectedEntity?.entity ? (
            <div className="nc-wrap nc-magenta">
            <Card className="nc-panel nc-md nc-border-magenta">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600"><Lightbulb className="h-4 w-4 text-white" /></div>
                    <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">{selectedEntity.entity.name}</CardTitle>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 -mt-1 btn-glow" onClick={() => setSelectedEntity(null)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  <Badge variant="outline" className="text-[9px] h-4 px-1">{selectedEntity.entity.type}</Badge>
                  {selectedEntity.entity.domain && (
                    <Badge className={`text-[9px] h-4 px-1 ${DOMAIN_COLORS[selectedEntity.entity.domain] || ''}`}>
                      {DOMAIN_LABELS[selectedEntity.entity.domain] || selectedEntity.entity.domain}
                    </Badge>
                  )}
                </div>
                {selectedEntity.entity.description && (
                  <CardDescription className="text-xs mt-2 text-stone-400">{selectedEntity.entity.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* Neighbors */}
                  <div>
                    <p className="text-xs font-medium mb-2 flex items-center gap-1 text-stone-300">
                      <GraphIcon className="h-3 w-3" /> Entities liên quan ({selectedEntity.neighbors.length})
                    </p>
                    <ScrollArea className="max-h-52">
                      <div className="space-y-1 pr-2">
                        {selectedEntity.neighbors.map(n => (
                          <div key={n.name} className="p-2 rounded-lg border border-cyan-400/35 hover:border-stone-300 bg-slate-950/50 hover:shadow-sm cursor-pointer transition-all"
                            onClick={() => { setHighlightSearch(n.name); void expandNode(n.name) }}>
                            <div className="flex items-center gap-1.5">
                              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getNodeColor(n.type) }} />
                              <span className="text-xs font-medium truncate text-stone-200">{n.name}</span>
                              <Badge variant="outline" className="text-[8px] h-3 px-0.5 flex-shrink-0">{n.type}</Badge>
                            </div>
                          </div>
                        ))}
                        {selectedEntity.neighbors.length === 0 && <p className="text-[10px] text-muted-foreground">Không có neighbors</p>}
                      </div>
                    </ScrollArea>
                  </div>
                  {/* Relationships */}
                  <div>
                    <p className="text-xs font-medium mb-2 flex items-center gap-1 text-stone-300">
                      <Cable className="h-3 w-3" /> Quan hệ ({selectedEntity.relationships.length})
                    </p>
                    <ScrollArea className="max-h-52">
                      <div className="space-y-1 pr-2">
                        {selectedEntity.relationships.map((r, i) => (
                          <div key={i} className="p-2 rounded-lg border border-cyan-400/35 bg-slate-950/50">
                            <div className="flex items-center gap-1 text-[10px] flex-wrap">
                              <Badge variant="outline" className="text-[8px] h-3.5 px-0.5 max-w-[80px] truncate">{r.source}</Badge>
                              <ArrowRight className="h-2.5 w-2.5 text-orange-400 flex-shrink-0" />
                              <Badge className="text-[8px] h-3.5 px-0.5 bg-orange-950/50 text-orange-400">{r.type}</Badge>
                              <ArrowRight className="h-2.5 w-2.5 text-orange-400 flex-shrink-0" />
                              <Badge variant="outline" className="text-[8px] h-3.5 px-0.5 max-w-[80px] truncate">{r.target}</Badge>
                            </div>
                          </div>
                        ))}
                        {selectedEntity.relationships.length === 0 && <p className="text-[10px] text-muted-foreground">Không có relationships</p>}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              </CardContent>
            </Card>
            </div>
          ) : (
            <div className="nc-wrap nc-magenta">
            <Card className="nc-panel nc-md nc-border-magenta">
              <CardContent className="pt-6 pb-6">
                <div className="text-center text-muted-foreground">
                  <Target className="h-12 w-12 mx-auto mb-3 opacity-15" />
                  <p className="text-sm font-semibold tracking-tight text-stone-300">Chọn một entity</p>
                  <p className="text-xs mt-1">Click vào node trong graph để xem chi tiết</p>
                </div>
              </CardContent>
            </Card>
            </div>
          )}

          {/* Graph Stats */}
          <div className="nc-wrap nc-magenta">
          <Card className="nc-panel nc-md nc-border-magenta">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600"><BarChart3 className="h-4 w-4 text-white" /></div>
                <CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Graph Stats</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-emerald-950/40 text-center">
                  <p className="text-lg font-bold text-emerald-400">{graphNodes.length}</p>
                  <p className="text-[10px] text-emerald-400">Nodes</p>
                </div>
                <div className="p-3 rounded-xl bg-orange-950/40 text-center">
                  <p className="text-lg font-bold text-orange-400">{graphLinks.length}</p>
                  <p className="text-[10px] text-orange-400">Edges</p>
                </div>
                <div className="p-3 rounded-xl bg-violet-950/40 text-center">
                  <p className="text-lg font-bold text-violet-400">{entityTypesInGraph.length}</p>
                  <p className="text-[10px] text-violet-400">Types</p>
                </div>
                <div className="p-3 rounded-xl bg-teal-950/40 text-center">
                  <p className="text-lg font-bold text-cyan-400">
                    {graphLinks.length > 0 ? (graphLinks.length / Math.max(graphNodes.length, 1)).toFixed(1) : '0'}
                  </p>
                  <p className="text-[10px] text-cyan-400">Avg Degree</p>
                </div>
              </div>
            </CardContent>
          </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

// ==================== ENTITIES SECTION ====================

// Entities and Relationships tabs removed — their data is now available in Analytics tab

// ==================== ANALYTICS SECTION ====================

const DOMAIN_CHART_COLORS: Record<string, string> = {
  programming: '#14b8a6',
  algorithm: '#f59e0b',
  ml: '#8b5cf6',
  meta_cognitive: '#ec4899',
  linux: '#f97316',
  security: '#ef4444',
  mixed: '#6b7280',
}

const REL_TYPE_COLORS: Record<string, string> = {
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

interface DBStats {
  totalDocuments: number
  totalEntities: number
  totalRelationships: number
  totalResolvedEntities: number
  documentsByStatus: Record<string, number>
  entityTypeDistribution: Record<string, number>
  domainDistribution: Record<string, number>
  relTypeDistribution: Record<string, number>
  avgConfidence: number
  graphDensity: number
  resolvedCount: number
  orphanEntityCount: number      // Raw entities not in any relationship
  orphanResolvedCount: number    // Resolved entities not in any relationship
  entitiesInRelationships: number // Unique entity IDs appearing in relationships
  dailyTokens?: { date: string; tokens: number } // Today's token usage
  timestamp: string
}

interface AnalyticsData {
  documents: DocumentRecord[]
  embeddingStatus: EmbeddingStatus | null
  loading: boolean
  dbStats: DBStats | null
}

function AnalyticsSection({ data, onRefreshStats }: { data: AnalyticsData; onRefreshStats?: () => void }) {
  const { documents, embeddingStatus, loading, dbStats } = data
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
                    label={({ name, percent }) => ({ value: `${name} ${(percent * 100).toFixed(0)}%`, fill: '#d6d3d1', fontSize: 10 })}
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
              <Neo4jVerification />
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

function Neo4jVerification() {
  const [neo4jData, setNeo4jData] = useState<{ nodeCount: number; relationshipCount: number; labels: string[]; connected: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)

  const checkNeo4j = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('Health API không khả dụng')
      const data = await res.json()
      const neo4j = data.services?.neo4j
      if (neo4j?.connected) {
        setNeo4jData({
          connected: true,
          nodeCount: neo4j.nodeCount ?? 0,
          relationshipCount: neo4j.relationshipCount ?? 0,
          labels: neo4j.labels ?? [],
        })
      } else {
        setNeo4jData({ connected: false, nodeCount: 0, relationshipCount: 0, labels: [] })
      }
    } catch {
      setNeo4jData({ connected: false, nodeCount: 0, relationshipCount: 0, labels: [] })
    }
    setLoading(false)
  }, [])

  useEffect(() => { checkNeo4j() }, [checkNeo4j])

  const handleCleanNeo4j = useCallback(async () => {
    if (!confirm('Xóa toàn bộ dữ liệu Neo4j và đồng bộ lại? Điều này sẽ xóa tất cả nodes và relationships hiện có.')) return
    setCleaning(true)
    try {
      const res = await fetch('/api/setup/neo4j?action=clean', { method: 'DELETE' })
      const data = await res.json()
      if (data.success) {
        alert(`Đã dọn dẹp Neo4j: ${data.before.relationships}→${data.after.relationships} relationships, ${data.documentsReset} tài liệu cần đồng bộ lại`)
        await checkNeo4j()
      } else {
        alert(`Lỗi: ${data.error}`)
      }
    } catch (err) {
      alert(`Lỗi: ${err instanceof Error ? err.message : 'Unknown'}`)
    }
    setCleaning(false)
  }, [checkNeo4j])

  if (loading) {
    return (
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">Kết nối:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Nodes:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Relationships:</span><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>
      </div>
    )
  }

  if (!neo4jData?.connected) {
    return <div className="mt-2 flex items-center gap-1 text-[10px] text-red-400"><XCircle className="h-3 w-3" /> Không kết nối được Neo4j</div>
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

// ==================== THEME TOGGLE ====================

// ThemeToggle removed — no longer needed

// ==================== CONNECTION STATUS (FOOTER) ====================

function ConnectionStatus({ health, lastChecked, onRefresh, refreshing, error }: {
  health: HealthResponse | null
  lastChecked: Date | null
  onRefresh: () => void
  refreshing: boolean
  error?: string | null
}) {
  // FIX: show a real error state instead of spinning "Đang kiểm tra kết nối..."
  // forever when the health check fails (network error, timeout, HTTP 500...).
  // The 10s auto-poll keeps retrying in the background; the user can also retry manually.
  if (!health && error) {
    return (
      <footer className="connection-status-bar flex-shrink-0">
        <div className="flex items-center justify-center gap-2 text-[10px] py-1.5 px-4">
          <XCircle className="h-3 w-3 text-red-400" />
          <span className="text-red-400">Không kiểm tra được trạng thái: {error}</span>
          <button
            onClick={onRefresh}
            className="ml-1 underline underline-offset-2 hover:text-red-300 cursor-pointer"
            aria-label="Thử lại"
          >
            Thử lại
          </button>
        </div>
      </footer>
    )
  }

  if (!health) {
    return (
      <footer className="connection-status-bar flex-shrink-0">
        <div className="flex items-center justify-center gap-2 text-[10px] text-stone-500 py-1.5 px-4">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Đang kiểm tra kết nối...</span>
        </div>
      </footer>
    )
  }

  const { qdrant, neo4j, sqlite, r2, supabase, llm } = health.services
  const neo4jError = neo4j.error
  const qdrantError = qdrant.error
  const r2Error = r2?.error
  const supabaseError = supabase?.error

  // Format last checked time
  const formatLastChecked = (date: Date | null) => {
    if (!date) return ''
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // Total points across Qdrant collections
  const qdrantTotalPoints = (qdrant.documentsCollection?.pointCount ?? 0) + (qdrant.chunksCollection?.pointCount ?? 0)

  return (
    <footer className="connection-status-bar flex-shrink-0">
      <div className="flex items-center justify-between gap-2 py-1.5 px-2 sm:px-4 text-[10px] overflow-x-auto">
        {/* Left: Overall status + services */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 flex-wrap">
          {/* Overall status badge */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className={`px-1.5 py-0.5 rounded text-[9px] font-semibold cursor-default ${health.status === 'healthy' ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-500/55' : 'bg-amber-950/50 text-amber-500 border border-amber-500/55'}`}>
                {health.status === 'healthy' ? '● HEALTHY' : '● DEGRADED'}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">System Status</div>
                <div>Response: {health.responseTimeMs}ms</div>
                <div>Core: Qdrant{qdrant.connected ? '✓' : '✗'} + SQLite{sqlite?.connected ? '✓' : '✗'}</div>
                <div>LLM: {Object.values(llm).filter(v => v.available).length}/{Object.keys(llm).length} available</div>
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          <div className="h-3 w-px bg-stone-700" />

          {/* Qdrant */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <div className={`w-2 h-2 rounded-full ${qdrant.connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-stone-300 font-medium">Qdrant</span>
                {qdrant.connected && qdrant.version && <span className="text-stone-500 hidden sm:inline">v{qdrant.version}</span>}
                {qdrant.connected && qdrantTotalPoints > 0 && <span className="text-stone-500 hidden md:inline">{qdrantTotalPoints.toLocaleString()} pts</span>}
                {!qdrant.connected && <span className="text-red-400">Offline</span>}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[260px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">Qdrant Vector DB</div>
                {qdrant.connected ? (<>
                  {qdrant.version && <div>Version: {qdrant.version}</div>}
                  {qdrant.documentsCollection && <div>Documents: {qdrant.documentsCollection.pointCount?.toLocaleString() ?? 0} points</div>}
                  {qdrant.chunksCollection && <div>Chunks: {qdrant.chunksCollection.pointCount?.toLocaleString() ?? 0} points{qdrant.chunksCollection.vectorCount ? `, ${qdrant.chunksCollection.vectorCount.toLocaleString()} vectors` : ''}</div>}
                </>) : <div className="text-red-400">Error: {qdrantError || 'Không kết nối được'}</div>}
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          {/* Neo4j */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <div className={`w-2 h-2 rounded-full ${neo4j.connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-stone-300 font-medium">Neo4j</span>
                {neo4j.connected && neo4j.nodeCount > 0 && <span className="text-stone-500 hidden md:inline">{neo4j.nodeCount.toLocaleString()} nodes</span>}
                {neo4j.connected && neo4j.relationshipCount > 0 && <span className="text-stone-500 hidden md:inline">{neo4j.relationshipCount.toLocaleString()} rels</span>}
                {!neo4j.connected && <span className="text-red-400">{neo4jError?.includes('discovery') ? 'DNS' : neo4jError?.includes('timed out') ? 'Timeout' : 'Offline'}</span>}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[260px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">Neo4j Graph DB</div>
                {neo4j.connected ? (<>
                  <div>Nodes: {neo4j.nodeCount.toLocaleString()}</div>
                  <div>Relationships: {neo4j.relationshipCount.toLocaleString()}</div>
                  {neo4j.labels.length > 0 && <div>Labels: {neo4j.labels.slice(0, 10).join(', ')}{neo4j.labels.length > 10 ? ` +${neo4j.labels.length - 10}` : ''}</div>}
                </>) : <div className="text-red-400">Error: {neo4jError || 'Không kết nối được'}</div>}
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          {/* SQLite */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <div className={`w-2 h-2 rounded-full ${sqlite?.connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-stone-300 font-medium">SQLite</span>
                {sqlite?.connected && sqlite.tableCount !== undefined && <span className="text-stone-500 hidden sm:inline">{sqlite.tableCount.toLocaleString()} records</span>}
                {!sqlite?.connected && <span className="text-red-400">Error</span>}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">SQLite (Local Buffer)</div>
                {sqlite?.connected ? (<>
                  {sqlite.tableCount !== undefined && <div>Entity records: {sqlite.tableCount.toLocaleString()}</div>}
                </>) : <div className="text-red-400">Error: {sqlite?.error || 'Không kết nối'}</div>}
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          <div className="h-3 w-px bg-stone-700 hidden sm:block" />

          {/* Cloudflare R2 */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <div className={`w-2 h-2 rounded-full ${r2?.connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-stone-300 font-medium">Cloudflare</span>
                {r2?.connected && r2.objectCount !== undefined && <span className="text-stone-500 hidden sm:inline">{r2.objectCount} files</span>}
                {!r2?.connected && <span className="text-red-400">{r2?.configured ? 'Error' : 'Off'}</span>}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[260px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">Cloudflare R2 (PDF Backup)</div>
                {r2?.connected ? (<>
                  <div>Bucket: {r2.bucket || 'themagnumopus'}</div>
                  {r2.objectCount !== undefined && <div>Objects: {r2.objectCount.toLocaleString()}</div>}
                  <div className="text-stone-400">Nguồn tài liệu chính</div>
                </>) : <div className="text-red-400">Error: {r2Error || (r2?.configured ? 'Không kết nối' : 'Chưa cấu hình')}</div>}
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          {/* Supabase */}
          <StatusTooltip>
            <StatusTooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <div className={`w-2 h-2 rounded-full ${supabase?.connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-stone-300 font-medium">Supabase</span>
                {supabase?.connected && supabase.tableCount !== undefined && <span className="text-stone-500 hidden md:inline">{supabase.tableCount} tables</span>}
                {!supabase?.connected && <span className="text-red-400">{supabase?.configured ? 'Error' : 'Off'}</span>}
              </div>
            </StatusTooltipTrigger>
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[260px]">
              <div className="space-y-1">
                <div className="font-semibold text-stone-100">Supabase (Cloud Sync)</div>
                {supabase?.connected ? (<>
                  {supabase.tableCount !== undefined && <div>Backup tables: {supabase.tableCount}</div>}
                  <div className="text-stone-400">Backup SQLite → Cloud (12 bảng: memory, chat, config, personal data)</div>
                </>) : <div className="text-red-400">Error: {supabaseError || (supabase?.configured ? 'Không kết nối' : 'Chưa cấu hình')}</div>}
              </div>
            </StatusTooltipContent>
          </StatusTooltip>

          <div className="h-3 w-px bg-stone-700 hidden sm:block" />

          {/* LLM Providers — compact row */}
          <div className="flex items-center gap-2">
            <span className="text-stone-500 hidden sm:inline">LLM:</span>
            {Object.entries(llm).map(([key, info]) => {
              const labels: Record<string, string> = {
                nvidia: 'NVIDIA',
              }
              return (
                <StatusTooltip key={key}>
                  <StatusTooltipTrigger asChild>
                    <div className="flex items-center gap-1 cursor-default">
                      <div className={`w-2 h-2 rounded-full ${
                        info.available
                          ? info.geoBlocked
                            ? 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]'
                            : 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                          : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                      }`} />
                      <span className={`${info.available ? (info.geoBlocked ? 'text-amber-400' : 'text-stone-300') : 'text-stone-500'}`}>{labels[key] || key}</span>
                    </div>
                  </StatusTooltipTrigger>
                  <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[260px]">
                    <div className="space-y-1">
                      <div className="font-semibold text-stone-100">{labels[key] || key}</div>
                      <div>Model: {info.model}</div>
                      <div>Status: {info.available ? (info.geoBlocked ? 'Geo-blocked' : 'Available') : 'Unavailable'}</div>
                      {info.error && <div className="text-red-400">Error: {info.error}</div>}
                    </div>
                  </StatusTooltipContent>
                </StatusTooltip>
              )
            })}
          </div>
        </div>

        {/* Right: last checked + refresh */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {lastChecked && (
            <span className="text-stone-600">Checked: {formatLastChecked(lastChecked)}</span>
          )}
          <button
            onClick={onRefresh}
            className="p-1 rounded hover:bg-cyan-500/20 text-stone-500 hover:text-cyan-400 transition-colors"
            title="Refresh connection status"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
    </footer>
  )
}

// ==================== TOKEN SSE REALTIME CONTEXT ====================

/** Context for sharing real-time token data across components.
 *  Uses Server-Sent Events (SSE) instead of polling — single connection,
 *  instant updates (< 500ms), zero wasted requests when idle. */
const TokenStreamContext = React.createContext<TokenUsageData | null>(null)

/** Provider component that opens one SSE connection to /api/token-usage/stream
 *  and shares the latest token data with all children via context. */
function TokenStreamProvider({ children }: { children: React.ReactNode }) {
  const [tokenData, setTokenData] = useState<TokenUsageData | null>(null)

  useEffect(() => {
    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let sseActive = false

    const connect = () => {
      es = new EventSource('/api/token-usage/stream')

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          setTokenData({
            date: data.date,
            tokens: data.tokens,
            providers: data.providers || {},
            slots: data.slots || {},
            models: data.models || {},
          })
          sseActive = true
        } catch {}
      }

      es.onerror = () => {
        // Connection lost — close and reconnect after delay
        sseActive = false
        es?.close()
        es = null
        reconnectTimer = setTimeout(connect, 3000)
      }
    }

    connect()

    // POLLING FALLBACK: If SSE is not delivering updates (Next.js dev server
    // may buffer SSE events), poll every 10s as a safety net.
    // FIX (perf): skip the poll while SSE is delivering — the sseActive flag was
    // maintained but never consulted, so BOTH streams ran in parallel forever
    // (double data traffic for the same token stats).
    pollTimer = setInterval(async () => {
      if (sseActive) return // SSE is healthy — no need to poll
      try {
        const res = await fetch('/api/token-usage')
        if (res.ok) {
          const data = await res.json()
          setTokenData(prev => {
            // Only update if data actually changed (avoid unnecessary re-renders)
            if (prev && prev.tokens === data.tokens && prev.date === data.date) return prev
            return {
              date: data.date,
              tokens: data.tokens,
              providers: data.providers || {},
              slots: data.slots || {},
              models: data.models || {},
            }
          })
        }
      } catch { /* ignore */ }
    }, 10_000)

    return () => {
      es?.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [])

  return (
    <TokenStreamContext.Provider value={tokenData}>
      {children}
    </TokenStreamContext.Provider>
  )
}

/** Hook for components to access real-time token data from SSE stream. */
function useTokenStream(): TokenUsageData | null {
  return React.useContext(TokenStreamContext)
}

// ==================== STATS OVERVIEW ====================

/** Format token count: e.g., 1234 → "1.2K", 1500000 → "1.5M" */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function StatsOverview({ docTotal, docStatusBreakdown, entities, relationships, resolvedEntities, embeddingStatus, processingCount }: {
  docTotal: number; docStatusBreakdown: Record<string, number>; entities: number; relationships: number; resolvedEntities: number; embeddingStatus: EmbeddingStatus | null; processingCount: number
}) {
  // Use server-provided status breakdown (covers ALL docs, not just current page)
  const processedCount = (docStatusBreakdown['extracted'] || 0) + (docStatusBreakdown['indexed'] || 0)

  // Real-time token count from SSE stream (no polling needed)
  const tokenStream = useTokenStream()
  const todayTokens = tokenStream?.tokens ?? null

  // Time until midnight for token reset display (Vietnam ICT, UTC+7)
  const getTimeUntilMidnight = () => {
    const now = new Date()
    // Calculate midnight in Vietnam timezone (Asia/Ho_Chi_Minh)
    const vnParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)
    const y = vnParts.find(p => p.type === 'year')!.value
    const m = vnParts.find(p => p.type === 'month')!.value
    const d = vnParts.find(p => p.type === 'day')!.value
    // Midnight tonight in VN = tomorrow 00:00 Asia/Ho_Chi_Minh
    const tomorrowVN = new Date(`${y}-${m}-${d}T00:00:00+07:00`)
    tomorrowVN.setDate(tomorrowVN.getDate() + 1)
    const diff = tomorrowVN.getTime() - now.getTime()
    const hours = Math.floor(diff / 3600000)
    const minutes = Math.floor((diff % 3600000) / 60000)
    return `${hours}h ${minutes}p`
  }

  // Key indicators: show which of the 4 keys are active (each can hold up to 4 docs)
  const activeKeys = Math.min(processingCount, 4)

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-teal-950/50"><BookOpen className="h-4 w-4 text-teal-400" /></div><div><p className="text-xl font-bold tracking-tight text-stone-100">{processedCount}/{docTotal}</p><p className="text-[10px] text-stone-400">Tài liệu</p></div></div>
      </Card></div>
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-950/50"><Zap className="h-4 w-4 text-amber-500" /></div>
          <div>
            <p className="text-xl font-bold tracking-tight text-stone-100">{todayTokens !== null ? formatTokenCount(todayTokens) : <Loader2 className="h-4 w-4 animate-spin text-stone-400 inline" />}</p>
            <p className="text-[10px] text-stone-400">{todayTokens !== null ? `Token hôm nay · reset sau ${getTimeUntilMidnight()}` : 'Đang tải...'}</p>
          </div>
          {/* Key indicators */}
          <div className="flex gap-1 ml-1">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className={`h-2 w-2 rounded-full transition-colors ${i < activeKeys ? 'bg-amber-500 animate-pulse' : 'bg-stone-600'}`} title={`Key ${i + 1}: ${i < activeKeys ? 'đang xử lý' : 'sẵn sàng'} (4 docs/key)`} />
            ))}
          </div>
        </div>
      </Card></div>
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-violet-950/50"><Layers className="h-4 w-4 text-violet-400" /></div><div><p className="text-xl font-bold tracking-tight text-stone-100">{entities}</p><p className="text-[10px] text-stone-400">Entities{resolvedEntities > 0 && entities > resolvedEntities ? ` (${resolvedEntities} đã hợp nhất)` : ''}</p></div></div>
      </Card></div>
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-orange-950/50"><GitBranch className="h-4 w-4 text-orange-400" /></div><div><p className="text-xl font-bold tracking-tight text-stone-100">{relationships}</p><p className="text-[10px] text-stone-400">Relationships</p></div></div>
      </Card></div>
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3"><div className={`p-2 rounded-lg ${embeddingStatus && embeddingStatus.realRatio > 0 ? 'bg-teal-950/50' : 'bg-amber-950/50'}`}><TrendingUp className={`h-4 w-4 ${embeddingStatus && embeddingStatus.realRatio > 0 ? 'text-teal-400' : 'text-amber-500'}`} /></div><div>
          <p className="text-xl font-bold tracking-tight text-stone-100">{embeddingStatus ? `${(embeddingStatus.realRatio * 100).toFixed(0)}%` : <Loader2 className="h-4 w-4 animate-spin text-stone-400 inline" />}</p>
          <p className="text-[10px] text-stone-400">{embeddingStatus ? (embeddingStatus.realRatio === 0 ? '⚠️ Chưa có Real Embed' : `${embeddingStatus.real}/${embeddingStatus.total} Real`) : 'Đang tải...'}</p>
        </div></div>
      </Card></div>
    </div>
  )
}

// ==================== TOKEN USAGE SECTION ====================

interface TokenUsageData {
  date: string
  tokens: number
  providers: Record<string, number>
  slots: Record<string, Record<number, number>> // provider → { keyIndex → tokens }
  models: Record<string, Record<string, number>> // provider → { modelName → tokens }
}

/** NVIDIA NIM model configuration — Single Provider Architecture
 *  1 extraction core (nemotron-550b — DUÝ NHẤT, chỉ dùng cho trích xuất dữ liệu)
 *  + 4 agent/chat cores (user directive 2026-08-25)
 *  Verified 2026-08-25 via actual completion calls against integrate.api.nvidia.com */
const NVIDIA_CORE_CONFIG = {
  extraction: {
    label: 'Trích xuất',
    icon: '📄',
    color: 'text-cyan-400',
    headerBg: 'bg-cyan-950/60',
    barColor: '#22d3ee',
    models: [
      { key: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b' },
    ],
  },
  agent: {
    label: 'Agent / Chat',
    icon: '🤖',
    color: 'text-amber-400',
    headerBg: 'bg-amber-950/60',
    barColor: '#f59e0b',
    models: [
      { key: 'openai/gpt-oss-120b', label: 'gpt-oss-120b' },
      { key: 'moonshotai/kimi-k3', label: 'kimi-k3' },
      { key: 'deepseek-ai/deepseek-v4-flash-0731', label: 'deepseek-v4-flash' },
      { key: 'minimaxai/minimax-m3', label: 'minimax-m3' },
    ],
  },
} as const

/** NVIDIA key color map */
const KEY_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f97316']

function TokenUsageSection({ health }: { health: HealthResponse | null }) {
  // Real-time today's data from SSE stream (no polling needed)
  const todayUsage = useTokenStream()
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedDateUsage, setSelectedDateUsage] = useState<TokenUsageData | null>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [tokenLoading, setTokenLoading] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)

  // Mark loading as done once SSE data arrives
  useEffect(() => {
    if (todayUsage) setTokenLoading(false)
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

  // Get NVIDIA models data from display data
  const nvidiaModels = displayData?.models?.['nvidia'] || {}

  // Calculate per-group totals
  const extractionTotal = NVIDIA_CORE_CONFIG.extraction.models.reduce(
    (sum, m) => sum + (nvidiaModels[m.key] || 0), 0
  )
  const agentTotal = NVIDIA_CORE_CONFIG.agent.models.reduce(
    (sum, m) => sum + (nvidiaModels[m.key] || 0), 0
  )

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

          {/* Token theo nhóm lõi — 2 cột: Trích xuất + Agent/Chat */}
          <div className="grid grid-cols-2 gap-3">
            {/* Trích xuất column */}
            <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
              <div className={`px-3 py-2.5 ${NVIDIA_CORE_CONFIG.extraction.headerBg} border-b border-cyan-400/35`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{NVIDIA_CORE_CONFIG.extraction.icon}</span>
                    <span className={`text-xs font-bold ${NVIDIA_CORE_CONFIG.extraction.color}`}>{NVIDIA_CORE_CONFIG.extraction.label}</span>
                    <span className="text-[9px] text-stone-500">(2 lõi)</span>
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
                    <span className="text-[9px] text-stone-500]">(4 lõi)</span>
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

// ==================== AUTO-LEARN SECTION (Phase 4) ====================

interface AutoLearnRecord {
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

interface AutoLearnStats {
  totalRecords: number
  completedRecords: number
  failedRecords: number
  pendingRecords: number
  totalEntities: number
  totalRelationships: number
  totalChunks: number
}

function AutoLearnSection() {
  const [records, setRecords] = useState<AutoLearnRecord[]>([])
  const [stats, setStats] = useState<AutoLearnStats | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-learn')
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
        setStats(data.stats || null)
      }
    } catch (err) {
      console.error('[AutoLearn] Fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const formatNumber = (n: number) => n.toLocaleString('vi-VN')

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
  const providerColorMap: Record<string, { color: string; bg: string }> = {
    nvidia: { color: 'text-green-400', bg: 'bg-green-950/50' },
  }

  return (
    <div className="nc-wrap nc-lime">
    <Card className="nc-panel nc-md nc-border-lime">
      <CardHeader className="pb-1">
        <div className="flex flex-col items-center gap-1">
          <CardTitle className="text-base font-bold tracking-widest text-center text-white">AUTO-LEARN</CardTitle>
          <p className="text-[10px] text-stone-400">Agent tự bổ sung kiến thức vào Knowledge Base khi DB chưa đủ thông tin</p>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-3">
          {/* Stats Overview */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-stone-100">{formatNumber(stats.totalRecords)}</p>
                <p className="text-[9px] text-stone-400">Tổng bản ghi</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-emerald-400">{formatNumber(stats.completedRecords)}</p>
                <p className="text-[9px] text-stone-400">Hoàn thành</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-red-400">{formatNumber(stats.failedRecords)}</p>
                <p className="text-[9px] text-stone-400">Thất bại</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-amber-400">{formatNumber(stats.pendingRecords)}</p>
                <p className="text-[9px] text-stone-400">Đang xử lý</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-cyan-400">{formatNumber(stats.totalEntities)}</p>
                <p className="text-[9px] text-stone-400">Entities</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-violet-400">{formatNumber(stats.totalRelationships)}</p>
                <p className="text-[9px] text-stone-400">Relationships</p>
              </div>
              <div className="nc-panel nc-sm nc-border-lime p-2.5 text-center">
                <p className="text-lg font-bold text-pink-400">{formatNumber(stats.totalChunks)}</p>
                <p className="text-[9px] text-stone-400">Chunks Qdrant</p>
              </div>
            </div>
          )}

          {/* How it works */}
          <div className="nc-panel nc-sm nc-border-lime p-3">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="h-3.5 w-3.5 text-rose-400" />
              <span className="text-xs font-semibold text-stone-300">Cách hoạt động</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-stone-400">
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">1</span>
                <span>Agent trả lời câu hỏi → Kiểm tra <span className="text-amber-400">confidence</span> (0.5–0.85)</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">2</span>
                <span>LLM trích xuất <span className="text-cyan-400">entities</span> + <span className="text-violet-400">relationships</span> + key facts</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-rose-950/50 text-rose-400 flex items-center justify-center text-[9px] font-bold">3</span>
                <span>Lưu vào <span className="text-green-400">Qdrant</span> (vector) + <span className="text-orange-400">Neo4j</span> (graph) + <span className="text-blue-400">SQLite</span></span>
              </div>
            </div>
          </div>

          {/* Records Table */}
          <div className="nc-panel nc-sm nc-border-lime overflow-hidden">
            <div className="flex items-center gap-2 mb-0 px-3 py-2 bg-slate-950/60 border-b border-cyan-400/35">
              <GraduationCap className="h-3.5 w-3.5 text-stone-400" />
              <span className="text-xs font-semibold text-stone-300">Bản ghi Auto-Learn</span>
              <span className="text-[10px] text-stone-500 ml-auto">Tự cập nhật mỗi 10s</span>
            </div>
            {loading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-stone-400" />
                <span className="text-xs text-stone-500">Đang tải...</span>
              </div>
            ) : records.length === 0 ? (
              <div className="py-6 text-center">
                <Brain className="h-8 w-8 mx-auto mb-2 text-stone-600" />
                <p className="text-xs text-stone-500">Chưa có bản ghi Auto-Learn.</p>
                <p className="text-[10px] text-stone-600 mt-1">Khi Agent chat với confidence 0.5–0.85, kiến thức sẽ tự động được bổ sung.</p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto dialog-scrollbar">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-950/80 backdrop-blur-sm z-10">
                    <tr className="border-b border-cyan-400/35">
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Agent</th>
                      <th className="py-2 px-2 text-left font-semibold text-stone-300">Query</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Conf</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Provider</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Ent</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Rel</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Chunk</th>
                      <th className="py-2 px-2 text-center font-semibold text-stone-300">Status</th>
                      <th className="py-2 px-2 text-right font-semibold text-stone-300">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((rec, idx) => {
                      const pc = providerColorMap[rec.provider] || { color: 'text-stone-400', bg: 'bg-stone-950/50' }
                      const timeAgo = Math.round((Date.now() - new Date(rec.createdAt).getTime()) / 60000)
                      const timeStr = timeAgo < 60 ? `${timeAgo}m` : timeAgo < 1440 ? `${Math.round(timeAgo / 60)}h` : `${Math.round(timeAgo / 1440)}d`
                      return (
                        <tr key={rec.id} className={`${idx % 2 === 0 ? 'bg-cyan-950/10' : ''} hover:bg-slate-950/50 transition-colors border-b border-stone-700/30`}>
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
                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${pc.bg} ${pc.color} font-medium`}>{rec.provider}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="text-[10px] tabular-nums text-cyan-400">{rec.entitiesCount || '—'}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="text-[10px] tabular-nums text-violet-400">{rec.relationshipsCount || '—'}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            {rec.chunkSaved ? <CheckCircle2 className="h-3 w-3 text-emerald-400 inline" /> : <XCircle className="h-3 w-3 text-stone-600 inline" />}
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
            )}
          </div>
        </div>
      </CardContent>
    </Card>
    </div>
  )
}

// ==================== SMOLAB MODULE (Phase 1: Chat Tab) ====================

interface SmolabMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_call' | 'error' | 'opencode_progress' | 'opencode_result'
  content: string
  timestamp: Date
  model?: string
  provider?: string
  sources?: Array<{ type: string; content: string; documentTitle?: string }>
  confidence?: number
  durationMs?: number
  toolName?: string
  feedback?: 'positive' | 'negative' | null
  opencodeSessionId?: string
  opencodeStep?: string
  opencodeDetail?: string
  opencodeResult?: {
    filesChanged: string[]
    additions: number
    deletions: number
    diagnostics: number
    kbUsed: boolean
  }
  enrichment?: {
    score: number
    entitiesFound: number
    documentsFound: number
    correctionsFound: number
    insightsFound: number
  }
  agentName?: string
  agentPosition?: string
  agentAvatar?: string
  isTeamMessage?: boolean
  toolCallInfo?: { tool: string; detail: string }
  iterationInfo?: string // ReAct loop iteration progress (e.g., "Vòng 2/3")
  // Phase 3: Frontend Suggestion Card (C2 — Smart TL Bridge)
  isWorkflowSuggestion?: boolean // True if this message is a TL suggestion card
  suggestionText?: string // Short suggestion from TL
  routingMode?: string // A (Visual) | B (Backend) | C (Hybrid)
  routingTier?: number // 1 (Simple) | 2 (Medium) | 3 (Complex)
  routingScore?: number // 3-9 complexity score
  assessmentRouting?: { // Full routing decision for workflow
    mode: 'A' | 'B' | 'C'
    tier: 1 | 2 | 3
    score: number
    reasoning: string
    parts: Array<{ name: string; type: 'visual' | 'backend'; description: string; dependency: string[] }>
    spec: string
  }
  suggestionRejected?: boolean // True if user rejected the suggestion
}

interface SmolabSession {
  id: string
  sessionId: string
  title: string
  model?: string | null
  messageCount: number
  updatedAt: string
  agentProfileId?: string | null
  teamMode?: string | null
  teamName?: string | null
  tasks?: Array<{ id: string; type: string; status: string; progress: number; inputSummary?: string | null }>
}

const SMOLAB_MODEL_GROUPS = [
  {
    provider: 'NVIDIA',
    icon: '🎮',
    models: [
      // 2 extraction cores
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      // 5 agent/chat cores
      { id: 'deepseek-ai/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'z-ai/glm-5.1', label: 'GLM 5.1' },
      { id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7' },
      { id: 'qwen/qwen3.5-397b-a17b', label: 'Qwen3.5 397B' },
    ],
  },
]

const SMOLAB_TABS = [
  { id: 'knowledge', label: 'Knowledge', icon: Brain, color: 'cyan' },
  { id: 'memory', label: 'Memory', icon: Thermometer, color: 'rose' },
  { id: 'learning', label: 'Learning', icon: BookMarked, color: 'amber' },
  { id: 'skills', label: 'Skills', icon: Wrench, color: 'violet' },
  { id: 'automation', label: 'Automation', icon: Zap, color: 'orange' },
  { id: 'channels', label: 'Channels', icon: Radio, color: 'teal' },
  { id: 'code', label: 'Code', icon: Code2, color: 'emerald' },
]

const TAB_COLOR_CLASSES: Record<string, { active: string; hover: string }> = {
  emerald: { active: 'from-emerald-500/80 to-teal-600/80', hover: 'hover:text-emerald-400' },
  cyan: { active: 'from-cyan-500/80 to-sky-600/80', hover: 'hover:text-cyan-400' },
  amber: { active: 'from-amber-500/80 to-yellow-600/80', hover: 'hover:text-amber-400' },
  violet: { active: 'from-violet-500/80 to-purple-600/80', hover: 'hover:text-violet-400' },
  orange: { active: 'from-orange-500/80 to-red-600/80', hover: 'hover:text-orange-400' },
  teal: { active: 'from-teal-500/80 to-emerald-600/80', hover: 'hover:text-teal-400' },
  rose: { active: 'from-rose-500/80 to-pink-600/80', hover: 'hover:text-rose-400' },
}

const SMOLAB_SUGGESTIONS = [
  'Knowledge Base chứa những gì?',
  'Mối quan hệ giữa ML và Neural Network',
  'Các kỹ thuật bảo mật phổ biến',
]

// ==================== PHASE 7: AI TOOL EVENT BRIDGE (module helpers) ====================
//
// The code-team workflow SSE stream (/api/code-team/workflow) emits
//   data: {"type":"tool_call"|"tool_result","agent":"APEX","position":"TL",
//          "tool":"<name>","detail":"<escaped-JSON-string>","result":"OK"|"Error","duration":N}
// The REAL data lives in `detail` (a JSON string, truncated at 200/500 chars);
// `result` is only 'OK'|'Error'. file tools put the path in detail.path, shell
// the command in detail.command, opencode the action in detail.action.
//
// The stream reader (chat submit handler) re-dispatches every tool_call/
// tool_result as this window CustomEvent; CodeTabContent listens and reacts
// (auto-open file in editor, echo AI commands in the terminal, auto-open the
// Preview panel when the AI starts a dev server...).

const AI_TOOL_EVENT_NAME = 'tmo-ai-tool-event'

/** Basic JSON string unescape (\n \t \" \\ \/ \uXXXX) for regex-extracted values. */
function unescapeJsonString(s: string): string {
  try {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\')
  } catch {
    return s
  }
}

/** Regex-extract a JSON string field from a (possibly truncated) raw JSON string. */
function extractJsonStringField(raw: unknown, field: string): string | null {
  try {
    const s = String(raw ?? '')
    const m = s.match(new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'))
    return m ? unescapeJsonString(m[1]) : null
  } catch {
    return null
  }
}

/** Regex-extract a JSON number field from a (possibly truncated) raw JSON string. */
function extractJsonNumberField(raw: unknown, field: string): number | null {
  try {
    const s = String(raw ?? '')
    const m = s.match(new RegExp('"' + field + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Basename of a path (works for both / and \ separators). */
function pathFileName(p: unknown): string {
  const s = typeof p === 'string' ? p : ''
  if (!s) return 'file'
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || s
}

/** Human-friendly chat bubble for an AI tool call (rich Vietnamese labels). */
function formatToolBubble(tool: string, detail?: string): string {
  try {
    const raw = typeof detail === 'string' ? detail : ''
    if (tool === 'file_read') {
      const p = extractJsonStringField(raw, 'path') || extractJsonStringField(raw, 'filePath') || extractJsonStringField(raw, 'file_path')
      return p ? `📖 Đang đọc ${pathFileName(p)}` : '📖 Đang đọc file'
    }
    if (tool === 'file_edit' || tool === 'file_multi_edit') {
      const p = extractJsonStringField(raw, 'path') || extractJsonStringField(raw, 'filePath') || extractJsonStringField(raw, 'file_path')
      const editCount = (raw.match(/"old_string"/g) || []).length
        || (raw.match(/"new_string"/g) || []).length
        || (tool === 'file_edit' ? 1 : 0)
      const n = editCount > 1 ? ` (${editCount} edits)` : ''
      return p ? `✏️ Đang sửa ${pathFileName(p)}${n}` : `✏️ Đang sửa file${n}`
    }
    if (tool === 'shell' || tool === 'gateway_exec') {
      const cmd = extractJsonStringField(raw, 'command')
      if (cmd) return `▶️ ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`
    }
    if (tool === 'start_preview') {
      const port = extractJsonNumberField(raw, 'port')
      return port ? `▶️ Start preview (port ${port})` : '▶️ Start preview'
    }
    if (tool === 'stop_preview') return '⏹️ Stop preview'
    return `🔧 ${tool}`
  } catch {
    return `🔧 ${tool}`
  }
}

// ==================== KNOWLEDGE TAB CONTENT ====================

function KnowledgeTabContent() {
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

// ==================== MEMORY TAB CONTENT ====================

interface MemoryRow {
  id: string
  tier: 'hot' | 'warm' | 'cold'
  sessionId?: string | null
  content: string
  context?: string | null
  importance: number
  accessCount?: number
  lastAccessedAt?: string | null
  source?: string
  tags?: string | null
  domain?: string
  isActive?: boolean
  category?: string
  role?: string
  expiresAt?: string | null
  createdAt: string
  updatedAt?: string
}

interface ArchiveRow {
  id: string
  originalIds: string
  summaryContent: string
  domain: string
  importance: number
  sourceCount: number
  qdrantPointId: string | null
  embeddingModel: string | null
  expiresAt: string | null
  createdAt: string
}

interface TierStats {
  tiers: { hot: number; warm: number; coldInactive: number; coldArchive: number }
  domains: { user: number; work: number; meta: number }
  pending: { decayed: number; expiredArchives: number }
}

function MemoryTabContent() {
  // Agent selector
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [agentsLoading, setAgentsLoading] = useState(true)

  // Tier stats
  const [tierStats, setTierStats] = useState<TierStats | null>(null)
  const [tierStatsLoading, setTierStatsLoading] = useState(false)

  // Active sub-tab
  const [activeTier, setActiveTier] = useState<'hot' | 'warm' | 'cold' | 'archive'>('warm')

  // Memory list
  const [memories, setMemories] = useState<{ hot: MemoryRow[]; warm: MemoryRow[]; cold: MemoryRow[] }>({ hot: [], warm: [], cold: [] })
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryPage, setMemoryPage] = useState(1)
  const [memoryTotals, setMemoryTotals] = useState({ hot: 0, warm: 0, cold: 0 })

  // Archive list (separate endpoint)
  const [archives, setArchives] = useState<ArchiveRow[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveTotal, setArchiveTotal] = useState(0)

  // Search
  const [searchQuery, setSearchQuery] = useState('')

  // Action in progress
  const [actionLoading, setActionLoading] = useState(false)
  // Track which memory is being acted on (delete/promote/archive)
  const [actingId, setActingId] = useState<string | null>(null)

  // ---------- Load agent list ----------
  useEffect(() => {
    (async () => {
      setAgentsLoading(true)
      try {
        const res = await fetch('/api/agents')
        const data = await res.json()
        const list = (data.agents || data || []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }))
        list.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
        setAgents(list)
        // Default to first agent if any
        if (list.length > 0 && !selectedAgentId) setSelectedAgentId(list[0].id)
      } catch (e) {
        console.error('Failed to load agents:', e)
      } finally {
        setAgentsLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- Load tier stats when agent changes ----------
  const fetchTierStats = useCallback(async () => {
    if (!selectedAgentId) return
    setTierStatsLoading(true)
    try {
      const res = await fetch(`/api/memory/tiers?agentId=${encodeURIComponent(selectedAgentId)}`)
      if (res.ok) setTierStats(await res.json())
    } catch (e) {
      console.error('Failed to load tier stats:', e)
    } finally {
      setTierStatsLoading(false)
    }
  }, [selectedAgentId])

  useEffect(() => {
    fetchTierStats()
  }, [fetchTierStats])

  // ---------- Load memory list when agent or page changes ----------
  const fetchMemories = useCallback(async () => {
    if (!selectedAgentId) return
    setMemoryLoading(true)
    try {
      const params = new URLSearchParams({
        agentId: selectedAgentId,
        page: String(memoryPage),
        pageSize: '25',
      })
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      const res = await fetch(`/api/memory/list?${params.toString()}`)
      const data = await res.json()
      setMemories({
        hot: data.hot?.memories || [],
        warm: data.warm?.memories || [],
        cold: data.cold?.memories || [],
      })
      setMemoryTotals({
        hot: data.hot?.total || 0,
        warm: data.warm?.total || 0,
        cold: data.cold?.total || 0,
      })
    } catch (e) {
      console.error('Failed to load memories:', e)
    } finally {
      setMemoryLoading(false)
    }
  }, [selectedAgentId, memoryPage, searchQuery])

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  // ---------- Load archive list ----------
  const fetchArchives = useCallback(async () => {
    if (!selectedAgentId) return
    setArchiveLoading(true)
    try {
      const params = new URLSearchParams({ agentId: selectedAgentId, pageSize: '25' })
      const res = await fetch(`/api/memory/archive?${params.toString()}`)
      const data = await res.json()
      setArchives(data.archives || [])
      setArchiveTotal(data.total || 0)
    } catch (e) {
      console.error('Failed to load archives:', e)
    } finally {
      setArchiveLoading(false)
    }
  }, [selectedAgentId])

  useEffect(() => {
    if (activeTier === 'archive') fetchArchives()
  }, [activeTier, fetchArchives])

  // ---------- Actions ----------
  const handleRunTransition = useCallback(async (action: 'promote' | 'archive' | 'cleanup' | 'all') => {
    if (!selectedAgentId) return
    const labelMap: Record<string, string> = {
      promote: 'Promote HOT → WARM',
      archive: 'Archive WARM → COLD',
      cleanup: 'Cleanup expired COLD',
      all: 'Run all transitions',
    }
    if (!window.confirm(`Chạy "${labelMap[action]}" cho agent này?`)) return
    setActionLoading(true)
    try {
      const res = await fetch('/api/memory/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, action }),
      })
      const data = await res.json()
      if (res.ok) {
        sonnerToast.success('Hoàn tất', {
          description: `promoted=${data.promoted ?? 0} archived=${data.archived ?? 0} cleaned=${data.cleaned ?? 0}`,
          duration: 4000,
        })
        fetchTierStats()
        fetchMemories()
        if (activeTier === 'archive') fetchArchives()
      } else {
        sonnerToast.error('Lỗi', { description: data.error || 'Thất bại', duration: 4000 })
      }
    } catch (e) {
      sonnerToast.error('Lỗi mạng', { description: e instanceof Error ? e.message : 'unknown', duration: 4000 })
    } finally {
      setActionLoading(false)
    }
  }, [selectedAgentId, activeTier, fetchTierStats, fetchMemories, fetchArchives])

  const handleDeleteMemory = useCallback(async (id: string) => {
    if (!window.confirm('Xóa memory này? Không thể hoàn tác.')) return
    setActingId(id)
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) {
        sonnerToast.success('Đã xóa memory', { duration: 2500 })
        fetchTierStats()
        fetchMemories()
      } else {
        const err = await res.json().catch(() => ({}))
        sonnerToast.error('Lỗi xóa', { description: err.error || 'thất bại', duration: 4000 })
      }
    } finally {
      setActingId(null)
    }
  }, [fetchTierStats, fetchMemories])

  const handleMoveMemory = useCallback(async (id: string, action: 'promote' | 'archive') => {
    setActingId(id)
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}?action=${action}`, { method: 'PATCH' })
      if (res.ok) {
        const data = await res.json()
        sonnerToast.success(action === 'promote' ? 'Đã promote → WARM' : 'Đã archive → COLD', {
          description: `tier=${data.tier}, isActive=${data.isActive}`,
          duration: 3000,
        })
        fetchTierStats()
        fetchMemories()
      } else {
        const err = await res.json().catch(() => ({}))
        sonnerToast.error('Lỗi', { description: err.error || 'thất bại', duration: 4000 })
      }
    } finally {
      setActingId(null)
    }
  }, [fetchTierStats, fetchMemories])

  // ---------- Render helpers ----------
  const importanceColor = (imp: number) => {
    if (imp >= 0.7) return 'text-emerald-400'
    if (imp >= 0.4) return 'text-amber-400'
    return 'text-rose-400'
  }
  const importanceLabel = (imp: number) => {
    if (imp >= 0.7) return 'Cao'
    if (imp >= 0.4) return 'TB'
    return 'Thấp'
  }

  const domainBadge = (domain?: string) => {
    if (!domain) return null
    const map: Record<string, string> = {
      user: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
      work: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      meta: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
      session: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    }
    return <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${map[domain] || map.session}`}>{domain}</Badge>
  }

  const categoryBadge = (cat?: string) => {
    if (!cat) return null
    const map: Record<string, string> = {
      insight: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      fact: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      preference: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
      correction: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      procedure: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      user_info: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
      session: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    }
    return <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${map[cat] || map.session}`}>{cat}</Badge>
  }

  const tierConfig = {
    hot: { icon: Flame, label: 'HOT', desc: 'Working Memory — phiên hiện tại, TTL ngắn', color: 'orange' },
    warm: { icon: Thermometer, label: 'WARM', desc: 'AgentMemory active — truy xuất thường xuyên', color: 'amber' },
    cold: { icon: Snowflake, label: 'COLD', desc: 'Đã decay — đợi archive hoặc xóa', color: 'sky' },
    archive: { icon: Archive, label: 'ARCHIVE', desc: 'Tóm tắt LLM từ nhiều memory đã gộp', color: 'violet' },
  } as const

  const renderMemoryRow = (m: MemoryRow) => (
    <div key={m.id} className="group p-3 rounded-lg border border-slate-700/40 bg-slate-900/40 hover:border-slate-600/60 hover:bg-slate-900/60 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {categoryBadge(m.category)}
          {domainBadge(m.domain)}
          {m.role && <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-500/15 text-slate-300 border-slate-500/30">{m.role}</Badge>}
          {m.isActive === false && <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-600/30 text-slate-400 border-slate-600/40">inactive</Badge>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${importanceColor(m.importance)} bg-slate-900/40 border-slate-700/50`}>
            {importanceLabel(m.importance)} · {m.importance.toFixed(2)}
          </Badge>
          {m.accessCount !== undefined && m.accessCount > 0 && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-900/40 border-slate-700/50 text-slate-400">
              ×{m.accessCount}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-[12px] text-slate-200 leading-relaxed line-clamp-3 mb-1.5">{m.content}</p>
      {m.context && (
        <p className="text-[10px] text-slate-500 italic line-clamp-1 mb-1.5">↳ {m.context}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[9px] text-slate-500 flex items-center gap-2 min-w-0">
          <span>{new Date(m.createdAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}</span>
          {m.lastAccessedAt && <span>· last: {new Date(m.lastAccessedAt).toLocaleDateString('vi-VN')}</span>}
          {m.expiresAt && <span className="text-amber-500/70">· TTL {new Date(m.expiresAt).toLocaleDateString('vi-VN')}</span>}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {m.tier === 'cold' && (
            <Button
              size="sm" variant="ghost" disabled={actingId === m.id}
              onClick={() => handleMoveMemory(m.id, 'promote')}
              className="h-6 px-1.5 text-[10px] text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/30"
              title="Promote → WARM"
            >
              {actingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Thermometer className="h-3 w-3 mr-0.5" /> Warm</>}
            </Button>
          )}
          {m.tier === 'warm' && (
            <Button
              size="sm" variant="ghost" disabled={actingId === m.id}
              onClick={() => handleMoveMemory(m.id, 'archive')}
              className="h-6 px-1.5 text-[10px] text-sky-400 hover:text-sky-300 hover:bg-sky-900/30"
              title="Archive → COLD"
            >
              {actingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Snowflake className="h-3 w-3 mr-0.5" /> Cold</>}
            </Button>
          )}
          <Button
            size="sm" variant="ghost" disabled={actingId === m.id}
            onClick={() => handleDeleteMemory(m.id)}
            className="h-6 px-1.5 text-[10px] text-rose-400 hover:text-rose-300 hover:bg-rose-900/30"
            title="Xóa memory"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )

  const renderArchiveRow = (a: ArchiveRow) => {
    let originalIds: string[] = []
    try { originalIds = JSON.parse(a.originalIds) } catch { /* ignore */ }
    return (
      <div key={a.id} className="p-3 rounded-lg border border-violet-700/30 bg-violet-950/15 hover:border-violet-600/50 transition-colors">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {domainBadge(a.domain)}
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-violet-500/15 text-violet-300 border-violet-500/30">
              <Archive className="h-2.5 w-2.5 mr-0.5" />archive
            </Badge>
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-500/15 text-slate-300 border-slate-500/30">
              {a.sourceCount} nguồn
            </Badge>
          </div>
          <span className="text-[10px] text-slate-500">{new Date(a.createdAt).toLocaleDateString('vi-VN')}</span>
        </div>
        <p className="text-[12px] text-slate-200 leading-relaxed mb-2">{a.summaryContent}</p>
        <div className="flex items-center justify-between text-[9px] text-slate-500">
          <span>importance {a.importance.toFixed(2)}</span>
          {a.expiresAt && <span className="text-rose-500/60">hết hạn {new Date(a.expiresAt).toLocaleDateString('vi-VN')}</span>}
        </div>
      </div>
    )
  }

  // ---------- Tier dashboard cards ----------
  const tierCards = [
    { key: 'hot' as const, label: 'HOT', icon: Flame, count: tierStats?.tiers.hot ?? 0, total: memoryTotals.hot, color: 'orange', desc: 'Working Memory' },
    { key: 'warm' as const, label: 'WARM', icon: Thermometer, count: tierStats?.tiers.warm ?? 0, total: memoryTotals.warm, color: 'amber', desc: 'Active Long-term' },
    { key: 'cold' as const, label: 'COLD', icon: Snowflake, count: (tierStats?.tiers.coldInactive ?? 0), total: memoryTotals.cold, color: 'sky', desc: 'Decayed' },
    { key: 'archive' as const, label: 'ARCHIVE', icon: Archive, count: tierStats?.tiers.coldArchive ?? 0, total: archiveTotal, color: 'violet', desc: 'LLM Summary' },
  ]

  const colorMap: Record<string, string> = {
    orange: 'border-orange-500/40 bg-orange-950/15 text-orange-300',
    amber: 'border-amber-500/40 bg-amber-950/15 text-amber-300',
    sky: 'border-sky-500/40 bg-sky-950/15 text-sky-300',
    violet: 'border-violet-500/40 bg-violet-950/15 text-violet-300',
  }

  const activeMemories = activeTier === 'archive' ? archives : (memories[activeTier] || [])
  const activeTotal = activeTier === 'archive' ? archiveTotal : memoryTotals[activeTier]
  const activeLoading = activeTier === 'archive' ? archiveLoading : memoryLoading

  return (
    <div className="space-y-4">
      {/* Header: Agent selector + actions */}
      <Card className="bg-slate-900/40 border-slate-700/40">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4 text-rose-400" />
                Memory System — 3 Tier Architecture
              </CardTitle>
              <CardDescription className="text-[11px] mt-0.5">
                HOT (WorkingMemory) → WARM (AgentMemory active) → COLD (decayed) → ARCHIVE (LLM tóm tắt)
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId} disabled={agentsLoading}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder={agentsLoading ? 'Đang tải...' : 'Chọn agent'} />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(a => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm" variant="outline" disabled={!selectedAgentId || actionLoading}
                onClick={() => handleRunTransition('all')}
                className="h-8 text-[11px] border-rose-500/40 bg-rose-950/20 text-rose-200 hover:bg-rose-900/40"
              >
                {actionLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Run Transitions
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Tier dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {tierCards.map(card => {
              const Icon = card.icon
              const isActive = activeTier === card.key
              return (
                <button
                  key={card.key}
                  onClick={() => { setActiveTier(card.key); setMemoryPage(1) }}
                  className={`text-left p-3 rounded-lg border transition-all ${colorMap[card.color]} ${isActive ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-current' : 'opacity-80 hover:opacity-100'}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <Icon className="h-4 w-4" />
                    <span className="text-2xl font-bold tabular-nums">{card.count}</span>
                  </div>
                  <div className="text-[10px] font-semibold tracking-wide">{card.label}</div>
                  <div className="text-[9px] opacity-70 mt-0.5">{card.desc}</div>
                </button>
              )
            })}
          </div>
          {tierStats && (tierStats.pending.decayed > 0 || tierStats.pending.expiredArchives > 0) && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-amber-400">
              <AlertCircle className="h-3 w-3" />
              <span>
                {tierStats.pending.decayed > 0 && `${tierStats.pending.decayed} memory chờ archive · `}
                {tierStats.pending.expiredArchives > 0 && `${tierStats.pending.expiredArchives} archive hết hạn chờ xóa`}
                {' · bấm "Run Transitions" để xử lý'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sub-tab content + search */}
      <Card className="bg-slate-900/40 border-slate-700/40">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {(() => {
                const cfg = tierConfig[activeTier]
                const Icon = cfg.icon
                return <Icon className="h-4 w-4 text-rose-400" />
              })()}
              {tierConfig[activeTier].label} — {tierConfig[activeTier].desc}
            </CardTitle>
            <div className="flex items-center gap-2">
              {activeTier !== 'archive' && (
                <Input
                  placeholder="Tìm memory..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setMemoryPage(1) }}
                  className="h-7 w-48 text-xs"
                />
              )}
              <Badge variant="outline" className="text-[10px] bg-slate-900/40 border-slate-700/50">
                {activeTotal} total
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {activeLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          ) : !selectedAgentId ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              Chọn một agent để xem memory
            </div>
          ) : activeMemories.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              <Archive className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Không có memory nào ở tier {activeTier.toUpperCase()}
              {activeTier === 'hot' && <span className="block mt-1 opacity-70">HOT memory được tạo khi chat — kết thúc session sẽ tự promote → WARM</span>}
              {activeTier === 'archive' && <span className="block mt-1 opacity-70">Archive được tạo khi WARM memory decay dưới 0.1 importance</span>}
            </div>
          ) : (
            <ScrollArea className="h-[480px] pr-2">
              <div className="space-y-2">
                {activeTier === 'archive'
                  ? archives.map(renderArchiveRow)
                  : (memories[activeTier] || []).map(renderMemoryRow)}
              </div>
            </ScrollArea>
          )}

          {/* Pagination */}
          {(activeTier === 'hot' || activeTier === 'warm' || activeTier === 'cold') && activeTotal > 25 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-800">
              <Button
                size="sm" variant="ghost" disabled={memoryPage === 1 || memoryLoading}
                onClick={() => setMemoryPage(p => Math.max(1, p - 1))}
                className="h-7 text-xs"
              >
                <ChevronLeft className="h-3 w-3 mr-1" /> Trước
              </Button>
              <span className="text-[10px] text-slate-400">Trang {memoryPage} / {Math.ceil(activeTotal / 25)}</span>
              <Button
                size="sm" variant="ghost" disabled={memoryPage * 25 >= activeTotal || memoryLoading}
                onClick={() => setMemoryPage(p => p + 1)}
                className="h-7 text-xs"
              >
                Sau <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ==================== LEARNING TAB CONTENT ====================

// Phase 4 SMOLAB Proposal 11' — Eval harness types (Evaluation Results card)
interface EvalRunSummary {
  id: string
  status: string
  caseCount: number
  processedCount: number
  avgRecallAt5?: number
  avgFaithfulness?: number
  // Task 4 (2026-08-25): coverage split — "did the system attempt an answer"
  // vs faithfulness's "was the attempted answer correct".
  avgCoverage?: number
  avgCondFaithfulness?: number
  answeredCount?: number
  refusalCount?: number
  avgF1?: number
  avgLatencyMs?: number
  hallucinationCount?: number
  errorMessage?: string | null
  startedAt: string
  completedAt?: string | null
}

interface EvalCaseResult {
  id: string
  question: string
  category: string
  recallAt5: number
  faithfulnessMedian: number
  faithfulnessScores: number[]
  extractionF1: number
  hallucinationDetected: boolean
  retrievedChunks: number
  rawConfidence: number
  latencyMs: number
}

interface EvalResultsPayload {
  run: EvalRunSummary | null
  results: EvalCaseResult[]
}

function LearningTabContent() {
  // Timeline data
  const [timeline, setTimeline] = useState<{
    events: Array<{
      id: string
      type: string
      content: string
      timestamp: string
      metadata: Record<string, unknown>
    }>
    total: number
    typeCounts: Record<string, number>
  } | null>(null)
  const [timelineFilter, setTimelineFilter] = useState<string>('all')
  const [timelineLoading, setTimelineLoading] = useState(false)

  // Learning stats
  const [stats, setStats] = useState<{
    totalInsights: number
    totalCorrections: number
    totalPreferences: number
    totalStandingOrders: number
    totalFeedbackPositive: number
    totalFeedbackNegative: number
    accuracyRate: number
    appliedCorrections: number
    pendingCorrections: number
    insightsByDay: Array<{ date: string; count: number }>
    correctionsByDay: Array<{ date: string; count: number }>
    insightTypeDistribution: Array<{ type: string; count: number }>
    insightSourceDistribution: Array<{ source: string; count: number }>
    standingOrders: Array<{ id: string; order: string; priority: number }>
    recentInsights: Array<Record<string, unknown>>
    recentCorrections: Array<Record<string, unknown>>
  } | null>(null)

  // Manual teaching form
  const [teachType, setTeachType] = useState<'insight' | 'correction' | 'preference' | 'order'>('insight')
  const [teachContent, setTeachContent] = useState('')
  const [teachRelatedEntity, setTeachRelatedEntity] = useState('')
  const [teachWrongAnswer, setTeachWrongAnswer] = useState('')
  const [teachReason, setTeachReason] = useState('')
  const [teachSubmitting, setTeachSubmitting] = useState(false)

  // Feedback history
  const [feedbackHistory, setFeedbackHistory] = useState<Array<{
    id: string
    type: string
    content: string
    timestamp: string
    metadata: Record<string, unknown>
  }>>([])
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | 'positive' | 'negative'>('all')

  // Export/Import
  const [exportFormat, setExportFormat] = useState<'json' | 'markdown'>('json')
  const [importMode, setImportMode] = useState<'skip' | 'overwrite' | 'merge'>('skip')
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Knowledge graph mini-view
  const [agentEntities, setAgentEntities] = useState<Array<{ id: string; entityName: string; entityType: string; description: string | null }>>([])

  // Standing orders management
  const [orders, setOrders] = useState<Array<{ id: string; order: string; priority: number; enabled: boolean }>>([])
  const [newOrder, setNewOrder] = useState('')
  const [newOrderPriority, setNewOrderPriority] = useState(0)

  // Phase 2 SMOLAB Proposal 6 — Writeback Audit (PendingWriteback saga tracker)
  const [writebackAudit, setWritebackAudit] = useState<{
    counts: { pending: number; partial: number; failed: number; completed: number; total: number }
    recent: Array<{
      batchId: string
      documentId: string
      status: string
      failedStep: string | null
      attempts: number
      createdAt: string
      updatedAt: string
    }>
  } | null>(null)
  const [reconciling, setReconciling] = useState(false)

  // Phase 2 SMOLAB Proposal 8 — Layer 9 Adaptation Intelligence (ExecutionMetrics
  // + FailurePattern + StrategyAdaptationLog + ML quality placeholders).
  const [layer9Metrics, setLayer9Metrics] = useState<{
    aggregated: {
      totalRuns: number
      totalCompletedSteps: number
      totalFailedSteps: number
      totalTokensUsed: number
      overallSuccessRate: number
      overallTokenEfficiency: number
    }
    byRoutingMode: Record<string, { count: number; avgSuccess: number; avgTokens: number; avgTime: number }>
    successRateTrend: Array<{ runId: string; successRate: number; timestamp: string }>
    recentPatterns: Array<{
      id: string
      sessionId: string
      type: string
      count: number
      nextStrategy: string
      resolved: boolean
      createdAt: string
    }>
    recentAdaptations: Array<{
      id: string
      sessionId: string
      fromStrategy: string
      toStrategy: string
      reason: string
      confidence: number
      successful: boolean | null
      createdAt: string
    }>
    mlQuality: {
      embeddingCacheHitRate: number | null
      pseudoHashVectorCount: number
      autoLearnVerificationRate: number | null
    }
  } | null>(null)

  // Phase 4 SMOLAB Proposal 11' — Eval harness (latest run status + results)
  const [evalLatestRun, setEvalLatestRun] = useState<EvalRunSummary | null>(null)
  const [evalData, setEvalData] = useState<EvalResultsPayload | null>(null)
  const [evalStarting, setEvalStarting] = useState(false)
  // Bump to force an immediate re-poll (e.g. right after starting a run).
  const [evalRefresh, setEvalRefresh] = useState(0)

  // Fetch data on mount
  useEffect(() => {
    const fetchData = async () => {
      setTimelineLoading(true)
      try {
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])

        if (timelineRes.ok) {
          const data = await timelineRes.json()
          setTimeline(data)
          // Extract feedback events
          setFeedbackHistory(data.events?.filter((e: { type: string }) => e.type === 'feedback') || [])
        }

        if (statsRes.ok) {
          const data = await statsRes.json()
          setStats(data)
          setOrders(data.standingOrders || [])
        }
      } catch (err) {
        console.error('[Learning] Fetch error:', err)
      }
      setTimelineLoading(false)
    }

    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [timelineFilter])

  // Fetch agent-created entities for graph mini-view
  useEffect(() => {
    const fetchEntities = async () => {
      try {
        const res = await fetch('/api/openclaw/knowledge/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'sql', query: "SELECT id, entityName, entityType, description FROM LocalEntity WHERE source = 'agent' LIMIT 30" }),
        })
        if (res.ok) {
          const data = await res.json()
          setAgentEntities(data.records?.map((r: Record<string, unknown>) => ({
            id: String(r.id || ''),
            entityName: String(r.entityName || ''),
            entityType: String(r.entityType || ''),
            description: r.description ? String(r.description) : null,
          })) || [])
        }
      } catch {}
    }
    fetchEntities()
  }, [])

  // Phase 2 SMOLAB Proposal 6 — Fetch writeback audit (60s auto-refresh)
  useEffect(() => {
    let cancelled = false
    const fetchWritebackAudit = async () => {
      try {
        const res = await fetch('/api/storage/reconcile-writebacks')
        if (res.ok && !cancelled) {
          const data = await res.json()
          if (!cancelled) setWritebackAudit(data)
        }
      } catch (err) {
        console.warn('[Writeback Audit] fetch failed:', err)
      }
    }
    fetchWritebackAudit()
    const interval = setInterval(fetchWritebackAudit, 60000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Phase 2 SMOLAB Proposal 8 — Fetch Layer 9 metrics (30s auto-refresh)
  useEffect(() => {
    let cancelled = false
    const fetchLayer9 = async () => {
      try {
        const res = await fetch('/api/openclaw/learning/layer9-metrics')
        if (res.ok && !cancelled) {
          const data = await res.json()
          if (!cancelled) setLayer9Metrics(data)
        }
      } catch (err) {
        console.warn('[Layer9 Metrics] fetch failed:', err)
      }
    }
    fetchLayer9()
    const interval = setInterval(fetchLayer9, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Phase 4 SMOLAB Proposal 11' — Fetch eval run status + results.
  // Polls every 10s while a run is in progress, every 60s otherwise.
  // /api/eval/run (no param) → latest 10 runs (live status source).
  // /api/eval/results (no param) → latest COMPLETED run + per-case results.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      let running = false
      try {
        const [runsRes, resultsRes] = await Promise.all([
          fetch('/api/eval/run'),
          fetch('/api/eval/results'),
        ])
        if (runsRes.ok && !cancelled) {
          const data = (await runsRes.json()) as { runs?: EvalRunSummary[] }
          const latest = Array.isArray(data.runs) && data.runs.length > 0 ? data.runs[0] : null
          if (!cancelled) setEvalLatestRun(latest)
          running = latest?.status === 'running'
        }
        if (resultsRes.ok && !cancelled) {
          const data = (await resultsRes.json()) as EvalResultsPayload
          if (!cancelled) setEvalData(data)
        }
      } catch (err) {
        console.warn('[Eval Results] fetch failed:', err)
      }
      if (cancelled) return
      // 10s cadence while a run is in progress, 60s otherwise.
      timer = setTimeout(poll, running ? 10_000 : 60_000)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [evalRefresh])

  // Phase 4 SMOLAB Proposal 11' — Start a background eval run (10 cases).
  // POST /api/eval/run returns immediately (fire-and-forget runner); the
  // poll effect above picks up the running status + refreshes every 10s.
  const handleRunEval = async () => {
    setEvalStarting(true)
    try {
      const res = await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseLimit: 10 }),
      })
      const data = (await res.json()) as { runId?: string; caseCount?: number; error?: string }
      if (res.ok && data.runId) {
        toast({
          title: 'Eval started',
          description: `Run ${data.runId.slice(0, 8)} — ${data.caseCount ?? 10} cases × 4 LLM calls (chạy nền)`,
        })
        // Force an immediate re-poll so the running badge shows up right away.
        setEvalRefresh((n) => n + 1)
      } else {
        toast({ title: 'Eval start failed', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối eval', variant: 'destructive' })
    }
    setEvalStarting(false)
  }

  // Reconcile now — POST endpoint that re-attempts pending/partial/failed batches
  const handleReconcileWritebacks = async () => {
    setReconciling(true)
    try {
      const res = await fetch('/api/storage/reconcile-writebacks?limit=20', { method: 'POST' })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast({
          title: 'Reconcile hoàn tất',
          description: `Đã xử lý ${data.processed} batch (OK: ${data.completed}, thất bại: ${data.stillFailed})`,
        })
        // Refresh audit immediately
        const auditRes = await fetch('/api/storage/reconcile-writebacks')
        if (auditRes.ok) setWritebackAudit(await auditRes.json())
      } else {
        toast({ title: 'Reconcile lỗi', description: data.error || 'Thất bại', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối reconcile', variant: 'destructive' })
    }
    setReconciling(false)
  }

  // Teach agent
  const handleTeach = async () => {
    if (!teachContent.trim()) return
    if (teachType === 'correction' && !teachWrongAnswer.trim()) return

    setTeachSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        type: teachType,
        content: teachContent.trim(),
        relatedEntity: teachRelatedEntity.trim() || undefined,
      }

      if (teachType === 'correction') {
        body.metadata = {
          wrongAnswer: teachWrongAnswer.trim(),
          reason: teachReason.trim() || undefined,
        }
      } else if (teachType === 'preference') {
        body.metadata = {
          preferenceKey: teachContent.trim().split(':')[0].trim(),
          preferenceValue: teachContent.trim(),
          source: 'manual',
        }
      } else if (teachType === 'order') {
        body.metadata = {
          priority: newOrderPriority,
          enabled: true,
        }
      } else if (teachType === 'insight') {
        body.metadata = {
          insightType: 'factual',
          confidence: 0.9,
          source: 'manual',
        }
      }

      const res = await fetch('/api/openclaw/learning/teach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        toast({ title: 'Đã dạy Agent thành công', description: `Loại: ${teachType}` })
        setTeachContent('')
        setTeachRelatedEntity('')
        setTeachWrongAnswer('')
        setTeachReason('')
        // Refresh data
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])
        if (timelineRes.ok) { const data = await timelineRes.json(); setTimeline(data) }
        if (statsRes.ok) { const data = await statsRes.json(); setStats(data); setOrders(data.standingOrders || []) }
      } else {
        const data = await res.json()
        toast({ title: 'Lỗi', description: data.error || 'Không thể dạy Agent', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối', variant: 'destructive' })
    }
    setTeachSubmitting(false)
  }

  // Export
  const handleExport = async () => {
    try {
      const res = await fetch(`/api/openclaw/learning/export?format=${exportFormat}`)
      if (res.ok) {
        if (exportFormat === 'markdown') {
          const text = await res.text()
          const blob = new Blob([text], { type: 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'agent-memory.md'
          a.click()
          URL.revokeObjectURL(url)
        } else {
          const data = await res.json()
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'agent-memory.json'
          a.click()
          URL.revokeObjectURL(url)
        }
        toast({ title: 'Xuất thành công', description: `Đã xuất bộ nhớ Agent (${exportFormat})` })
      }
    } catch {
      toast({ title: 'Lỗi xuất dữ liệu', variant: 'destructive' })
    }
  }

  // Import
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch(`/api/openclaw/learning/import?mode=${importMode}`, {
        method: 'POST',
        body: formData,
      })

      if (res.ok) {
        const data = await res.json()
        toast({ title: 'Nhập thành công', description: `Insights: ${data.stats?.insights?.imported || 0} | Corrections: ${data.stats?.corrections?.imported || 0} | Preferences: ${data.stats?.preferences?.imported || 0}` })
        // Refresh
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])
        if (timelineRes.ok) { const d = await timelineRes.json(); setTimeline(d) }
        if (statsRes.ok) { const d = await statsRes.json(); setStats(d); setOrders(d.standingOrders || []) }
      } else {
        toast({ title: 'Lỗi nhập dữ liệu', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối', variant: 'destructive' })
    }
    setImporting(false)
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Format timestamp
  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    } catch { return ts }
  }

  const formatDate = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
    } catch { return ts }
  }

  // Timeline event type colors and icons
  const typeConfig: Record<string, { color: string; bg: string; border: string; icon: React.ReactNode; label: string }> = {
    insight: { color: 'text-amber-400', bg: 'bg-amber-950/30', border: 'border-amber-400/35', icon: <Lightbulb className="h-3.5 w-3.5" />, label: 'Insight' },
    correction: { color: 'text-red-400', bg: 'bg-red-950/30', border: 'border-red-400/35', icon: <RotateCcw className="h-3.5 w-3.5" />, label: 'Correction' },
    preference: { color: 'text-violet-400', bg: 'bg-violet-950/30', border: 'border-violet-400/35', icon: <Settings className="h-3.5 w-3.5" />, label: 'Preference' },
    feedback: { color: 'text-cyan-400', bg: 'bg-cyan-950/30', border: 'border-cyan-400/35', icon: <ThumbsUp className="h-3.5 w-3.5" />, label: 'Feedback' },
    pattern: { color: 'text-emerald-400', bg: 'bg-emerald-950/30', border: 'border-emerald-400/35', icon: <Target className="h-3.5 w-3.5" />, label: 'Pattern' },
    order: { color: 'text-blue-400', bg: 'bg-blue-950/30', border: 'border-blue-400/35', icon: <BookMarked className="h-3.5 w-3.5" />, label: 'Standing Order' },
  }

  const getTypeConfig = (type: string) => typeConfig[type] || typeConfig.pattern

  // Filtered feedback
  const filteredFeedback = feedbackFilter === 'all'
    ? feedbackHistory
    : feedbackHistory.filter(e => {
        const fbType = (e.metadata?.feedbackType as string) || (e.metadata?.type as string) || ''
        return fbType === feedbackFilter
      })

  return (
    <div className="space-y-4">

      {/* ===== 1. LEARNING STATS ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <GraduationCap className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Thống kê Học tập</span>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <Lightbulb className="h-4 w-4 mx-auto text-amber-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalInsights ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Insights</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <RotateCcw className="h-4 w-4 mx-auto text-red-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalCorrections ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Corrections</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <ThumbsUp className="h-4 w-4 mx-auto text-emerald-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.accuracyRate !== undefined ? `${Math.round(stats.accuracyRate * 100)}%` : '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Độ chính xác</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <BookMarked className="h-4 w-4 mx-auto text-violet-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalStandingOrders ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Standing Orders</p>
            </div>
          </div>

          {/* Feedback counts */}
          <div className="flex items-center gap-3 mb-4">
            <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
              <ThumbsUp className="h-3 w-3" /> {stats?.totalFeedbackPositive ?? 0} tích cực
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-red-400">
              <ThumbsDown className="h-3 w-3" /> {stats?.totalFeedbackNegative ?? 0} cần cải thiện
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-stone-400">
              <CheckCircle2 className="h-3 w-3" /> {stats?.appliedCorrections ?? 0} đã áp dụng
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-stone-400">
              <Clock className="h-3 w-3" /> {stats?.pendingCorrections ?? 0} chờ xử lý
            </span>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Insights by day */}
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Insights / ngày (30 ngày)</span>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats?.insightsByDay || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(245,158,11,0.1)" />
                    <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#78716c' }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 8, fill: '#78716c' }} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ background: '#1c1917', border: '1px solid rgba(245,158,11,0.3)', fontSize: 10 }} />
                    <Area type="monotone" dataKey="count" stroke="#f59e0b" fill="rgba(245,158,11,0.15)" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Corrections by day */}
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Corrections / ngày (30 ngày)</span>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats?.correctionsByDay || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(239,68,68,0.1)" />
                    <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#78716c' }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 8, fill: '#78716c' }} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ background: '#1c1917', border: '1px solid rgba(239,68,68,0.3)', fontSize: 10 }} />
                    <Bar dataKey="count" fill="rgba(239,68,68,0.6)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Insight type distribution */}
          {(stats?.insightTypeDistribution?.length ?? 0) > 0 && (
            <div className="mt-3 p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Phân loại Insight</span>
              <div className="flex flex-wrap gap-2">
                {stats?.insightTypeDistribution.map(t => (
                  <div key={t.type} className="flex items-center gap-1.5 px-2 py-1 bg-amber-950/30 border border-amber-500/15 rounded-lg">
                    <span className="text-[10px] text-amber-300 font-mono">{t.type}</span>
                    <Badge className="text-[9px] h-4 px-1.5 bg-amber-900/40 text-amber-400 border-amber-400/35">{t.count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== 1b. WRITEBACK AUDIT (Phase 2 SMOLAB Proposal 6) ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Writeback Audit</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">
                {writebackAudit?.counts?.total ?? 0} batch
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={reconciling}
              onClick={handleReconcileWritebacks}
              className="h-6 px-2 text-[10px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200 border border-amber-500/25"
            >
              {reconciling ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Reconcile now
            </Button>
          </div>

          {/* 4 stat tiles: pending / partial / failed / completed */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <Clock className="h-3.5 w-3.5 mx-auto text-amber-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.pending ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Pending</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <AlertTriangle className="h-3.5 w-3.5 mx-auto text-orange-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.partial ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Partial</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <XCircle className="h-3.5 w-3.5 mx-auto text-red-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.failed ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Failed</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.completed ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Completed</p>
            </div>
          </div>

          {/* Recent batches (last 5) */}
          {(writebackAudit?.recent?.length ?? 0) > 0 && (
            <div className="p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent batches</span>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                {writebackAudit?.recent.slice(0, 5).map(b => {
                  const statusColor =
                    b.status === 'completed' ? 'text-emerald-400 bg-emerald-950/30 border-emerald-400/30'
                    : b.status === 'failed' ? 'text-red-400 bg-red-950/30 border-red-400/30'
                    : b.status === 'partial' ? 'text-orange-400 bg-orange-950/30 border-orange-400/30'
                    : 'text-amber-400 bg-amber-950/30 border-amber-400/30'
                  return (
                    <div key={b.batchId} className={`flex items-center gap-2 p-1.5 border rounded-md ${statusColor}`}>
                      <span className="text-[9px] font-mono text-stone-400 truncate flex-1">
                        {b.batchId.slice(0, 8)}
                      </span>
                      <span className="text-[9px] uppercase font-semibold">{b.status}</span>
                      {b.failedStep && (
                        <span className="text-[8px] text-red-400/80" title={b.failedStep}>
                          {b.failedStep}
                        </span>
                      )}
                      <Badge className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-300 border-slate-700">
                        ×{b.attempts}
                      </Badge>
                      <span className="text-[8px] text-stone-500">{formatTime(b.createdAt)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {(writebackAudit?.recent?.length ?? 0) === 0 && (
            <div className="text-[10px] text-stone-500 italic text-center py-2">
              Chưa có writeback batch nào — chat với agent để kích hoạt auto-learn writeback.
            </div>
          )}
        </div>
      </div>

      {/* ===== 1c. LAYER 9 — ADAPTATION INTELLIGENCE (Phase 2 SMOLAB Proposal 8) ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Layer 9 — Adaptation Intelligence</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-emerald-950/50 text-emerald-400 border-emerald-400/35">
                {layer9Metrics?.aggregated?.totalRuns ?? 0} runs
              </Badge>
            </div>
          </div>

          {/* 4 stat tiles: Total Runs / Success Rate / Token Efficiency / Tokens Used */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <div className="p-2 bg-slate-950/50 border border-emerald-500/15 rounded-lg text-center">
              <Activity className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{layer9Metrics?.aggregated?.totalRuns ?? 0}</p>
              <p className="text-[9px] text-stone-400 uppercase">Total Runs</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-emerald-500/15 rounded-lg text-center">
              <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {((layer9Metrics?.aggregated?.overallSuccessRate ?? 0) * 100).toFixed(1)}%
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Success Rate</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Zap className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {(layer9Metrics?.aggregated?.overallTokenEfficiency ?? 0).toFixed(2)}
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Token Efficiency</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Cpu className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {(layer9Metrics?.aggregated?.totalTokensUsed ?? 0).toLocaleString()}
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Tokens Used</p>
            </div>
          </div>

          {/* Success Rate Trend — inline SVG sparkline (no external dep) */}
          <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-stone-400 uppercase flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-emerald-400" /> Success Rate Trend (last 10 runs)
              </span>
              <span className="text-[9px] text-emerald-400/70 font-mono">
                {layer9Metrics?.successRateTrend?.length ?? 0}/10
              </span>
            </div>
            {(layer9Metrics?.successRateTrend?.length ?? 0) >= 2 ? (
              <svg viewBox="0 0 100 30" className="w-full h-8" preserveAspectRatio="none">
                <polyline
                  fill="none"
                  stroke="rgb(52 211 153)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  points={
                    layer9Metrics!.successRateTrend
                      .map((p, i) => {
                        const n = layer9Metrics!.successRateTrend.length
                        const x = n > 1 ? (i / (n - 1)) * 100 : 0
                        const y = 30 - (p.successRate * 30)
                        return `${x.toFixed(2)},${y.toFixed(2)}`
                      })
                      .join(' ')
                  }
                />
              </svg>
            ) : (
              <div className="text-[10px] text-stone-500 italic text-center py-2">
                Not enough data yet — needs at least 2 workflow runs.
              </div>
            )}
          </div>

          {/* 2-column grid: Recent Failure Patterns + Recent Adaptations */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            {/* Recent Failure Patterns */}
            <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent Failure Patterns</span>
              {(layer9Metrics?.recentPatterns?.length ?? 0) > 0 ? (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                  {layer9Metrics?.recentPatterns.slice(0, 5).map(p => (
                    <div key={p.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-orange-400/25 bg-orange-950/20">
                      <Badge className="text-[8px] h-3.5 px-1 bg-orange-950/60 text-orange-400 border-orange-400/40 truncate max-w-[80px]">
                        {p.type}
                      </Badge>
                      <span className="text-[9px] text-stone-300">×{p.count}</span>
                      <span className="text-[8px] text-cyan-400/80 truncate flex-1" title={p.nextStrategy}>
                        → {p.nextStrategy}
                      </span>
                      {p.resolved && <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400 flex-shrink-0" />}
                      <span className="text-[8px] text-stone-500">
                        {p.createdAt ? formatTime(p.createdAt) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-stone-500 italic text-center py-2">
                  No failure patterns detected — workflows healthy.
                </div>
              )}
            </div>

            {/* Recent Adaptations */}
            <div className="p-2 bg-slate-950/50 border border-cyan-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent Adaptations</span>
              {(layer9Metrics?.recentAdaptations?.length ?? 0) > 0 ? (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                  {layer9Metrics?.recentAdaptations.slice(0, 5).map(a => (
                    <div key={a.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-cyan-400/25 bg-cyan-950/20">
                      <span className="text-[8px] font-mono text-stone-300 truncate max-w-[60px]" title={a.fromStrategy}>
                        {a.fromStrategy}
                      </span>
                      <ArrowRight className="h-2.5 w-2.5 text-cyan-400 flex-shrink-0" />
                      <span className="text-[8px] font-mono text-emerald-400 truncate max-w-[60px]" title={a.toStrategy}>
                        {a.toStrategy}
                      </span>
                      <span className="text-[8px] text-stone-400 truncate flex-1" title={a.reason}>
                        {a.reason}
                      </span>
                      <Badge className="text-[8px] h-3.5 px-1 bg-cyan-950/60 text-cyan-300 border-cyan-400/40">
                        {(a.confidence * 100).toFixed(0)}%
                      </Badge>
                      <span className="text-[8px] text-stone-500">{formatTime(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-stone-500 italic text-center py-2">
                  No adaptations triggered.
                </div>
              )}
            </div>
          </div>

          {/* ML Quality subpanel (Phase 4 will populate TBDs) */}
          <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg">
            <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">ML Quality</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="flex items-center gap-1.5 text-[10px]">
                <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                <span className="text-stone-300">Pseudo-hash vectors:</span>
                <span className="font-mono text-emerald-400 font-semibold">
                  {layer9Metrics?.mlQuality?.pseudoHashVectorCount ?? 0}
                </span>
                <span className="text-emerald-400">✓</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <Activity className="h-3 w-3 text-stone-500 flex-shrink-0" />
                <span className="text-stone-300">Embedding cache hit:</span>
                <span className="font-mono text-stone-400 italic">
                  {layer9Metrics?.mlQuality?.embeddingCacheHitRate == null
                    ? 'TBD'
                    : `${((layer9Metrics.mlQuality.embeddingCacheHitRate as number) * 100).toFixed(0)}%`}
                  <span className="text-stone-500 ml-1">(Phase 4)</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <Activity className="h-3 w-3 text-stone-500 flex-shrink-0" />
                <span className="text-stone-300">Auto-learn verified:</span>
                <span className="font-mono text-stone-400 italic">
                  {layer9Metrics?.mlQuality?.autoLearnVerificationRate == null
                    ? 'TBD'
                    : `${((layer9Metrics.mlQuality.autoLearnVerificationRate as number) * 100).toFixed(0)}%`}
                  <span className="text-stone-500 ml-1">(Phase 4)</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 1d. EVALUATION RESULTS (Phase 4 SMOLAB Proposal 11' — eval harness) ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          {/* Header row: icon + title + latest run status badge + Run Eval button */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-stone-100">Evaluation Results</span>
              {evalLatestRun && (
                <Badge
                  className={
                    evalLatestRun.status === 'completed'
                      ? 'text-[9px] h-4 px-1.5 bg-emerald-950/50 text-emerald-400 border-emerald-400/35'
                      : evalLatestRun.status === 'failed'
                        ? 'text-[9px] h-4 px-1.5 bg-red-950/50 text-red-400 border-red-400/35'
                        : 'text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35'
                  }
                >
                  {evalLatestRun.status}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={evalStarting || evalLatestRun?.status === 'running'}
              onClick={handleRunEval}
              className="h-6 px-2 text-[10px] bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 hover:text-cyan-200 border border-cyan-500/25"
            >
              {evalStarting || evalLatestRun?.status === 'running' ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Run Eval
            </Button>
          </div>

          {/* Live progress line while a run is in progress */}
          {evalLatestRun?.status === 'running' && (
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg mb-3 flex items-center gap-2">
              <Loader2 className="h-3 w-3 text-cyan-400 animate-spin flex-shrink-0" />
              <span className="text-[10px] text-stone-300 truncate">
                Running — {evalLatestRun.processedCount}/{evalLatestRun.caseCount} cases processed
                {evalData?.run ? ` (đang hiển thị kết quả run hoàn thành trước đó)` : ''}
              </span>
            </div>
          )}

          {/* Failed-run banner */}
          {evalLatestRun?.status === 'failed' && (
            <div className="p-2 bg-red-950/20 border border-red-400/25 rounded-lg mb-3 flex items-center gap-2">
              <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
              <span className="text-[10px] text-red-300 truncate" title={evalLatestRun.errorMessage ?? ''}>
                Run failed: {evalLatestRun.errorMessage || 'unknown error'}
              </span>
            </div>
          )}

          {/* Latest completed run: 6 stat tiles + meta + per-case list */}
          {evalData?.run ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 mb-2">
                {/* Task 4: Coverage — fraction of cases the system attempted to
                    answer (negative cases count refusing as correct "answering"). */}
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Layers className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgCoverage ?? 0) * 100).toFixed(0)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Coverage</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Target className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgRecallAt5 ?? 0) * 100).toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Recall@5</p>
                </div>
                {/* Task 4: conditional faithfulness — among ANSWERED cases only
                    (the honest "was the attempted answer right" number). */}
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {(evalData.run.avgCondFaithfulness ?? 0) > 0
                      ? `${((evalData.run.avgCondFaithfulness ?? 0) * 100).toFixed(1)}%`
                      : '—'}
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase" title="Faithfulness among answered cases only (avg across all cases in parentheses)">
                    Faith·ans ({((evalData.run.avgFaithfulness ?? 0) * 100).toFixed(0)}%)
                  </p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <GitBranch className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgF1 ?? 0) * 100).toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Entity F1</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <AlertTriangle className={`h-3.5 w-3.5 mx-auto mb-0.5 ${(evalData.run.hallucinationCount ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`} />
                  <p className={`text-base font-bold tabular-nums ${(evalData.run.hallucinationCount ?? 0) > 0 ? 'text-red-400' : 'text-stone-100'}`}>
                    {evalData.run.hallucinationCount ?? 0}
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Hallucinations</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Clock className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgLatencyMs ?? 0) / 1000).toFixed(1)}s
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Avg Latency</p>
                </div>
              </div>

              {/* Task 4: answered/refused split line */}
              <div className="flex items-center gap-3 mb-2 text-[9px] text-stone-500 flex-wrap">
                <span className="text-emerald-400">{evalData.run.answeredCount ?? 0} answered</span>
                <span className="text-stone-500">·</span>
                <span className="text-amber-400">{evalData.run.refusalCount ?? 0} refused (correct for out-of-domain)</span>
              </div>

              {/* Run meta line */}
              <div className="flex items-center gap-3 mb-2 text-[9px] text-stone-500 flex-wrap">
                <span>Run {evalData.run.id.slice(0, 8)}</span>
                <span>Started: {formatDate(evalData.run.startedAt)} {formatTime(evalData.run.startedAt)}</span>
                {evalData.run.completedAt && <span>Completed: {formatTime(evalData.run.completedAt)}</span>}
                <span>
                  {evalData.run.processedCount}/{evalData.run.caseCount} cases
                </span>
                <span>{evalData.results.length} results</span>
              </div>

              {/* Last 5 per-case results */}
              {evalData.results.length > 0 && (
                <div className="p-2 bg-slate-950/50 border border-cyan-500/10 rounded-lg">
                  <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent cases (last 5)</span>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                    {evalData.results.slice(-5).reverse().map((r) => (
                      <div key={r.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-cyan-400/20 bg-cyan-950/10">
                        <span className="text-[9px] text-stone-300 truncate flex-1" title={r.question}>
                          {r.question}
                        </span>
                        <Badge className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-400 border-slate-700 truncate max-w-[70px]">
                          {r.category}
                        </Badge>
                        <span
                          className="text-[9px] text-cyan-400 font-mono flex-shrink-0"
                          title={`judges: ${r.faithfulnessScores?.join(', ') ?? '—'}`}
                        >
                          F:{r.faithfulnessMedian.toFixed(2)}
                        </span>
                        <span className="text-[9px] text-emerald-400 font-mono flex-shrink-0">
                          R:{(r.recallAt5 * 100).toFixed(0)}%
                        </span>
                        {r.hallucinationDetected && (
                          <AlertTriangle className="h-2.5 w-2.5 text-red-400 flex-shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : evalLatestRun?.status !== 'running' ? (
            <div className="text-[10px] text-stone-500 italic text-center py-2">
              No eval runs yet — click Run Eval to start (uses ~10 cases × 4 LLM calls).
            </div>
          ) : null}
        </div>
      </div>

      {/* ===== 2. MEMORY TIMELINE ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Memory Timeline</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{timeline?.total ?? 0}</Badge>
            </div>
            <div className="flex items-center gap-1">
              {['all', 'insight', 'correction', 'preference', 'feedback', 'pattern'].map(filter => (
                <Button
                  key={filter}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[9px] ${timelineFilter === filter ? 'bg-amber-500/20 text-amber-400' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => setTimelineFilter(filter)}
                >
                  {filter === 'all' ? 'Tất cả' : getTypeConfig(filter).label}
                </Button>
              ))}
            </div>
          </div>

          {timelineLoading && !timeline ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 text-amber-400 animate-spin" />
            </div>
          ) : (timeline?.events?.length ?? 0) > 0 ? (
            <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1" style={{ scrollbarWidth: 'thin' }}>
              {timeline?.events.map(event => {
                const cfg = getTypeConfig(event.type)
                return (
                  <div key={event.id} className={`flex items-start gap-2.5 p-2 ${cfg.bg} border ${cfg.border} rounded-lg`}>
                    <div className={`shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge className={`text-[8px] h-3.5 px-1 ${cfg.bg} ${cfg.color} border ${cfg.border}`}>{cfg.label}</Badge>
                        <span className="text-[9px] text-stone-500">{formatDate(event.timestamp)} {formatTime(event.timestamp)}</span>
                      </div>
                      <p className="text-[11px] text-stone-300 leading-relaxed line-clamp-2">{event.content}</p>
                      {/* Show extra metadata for feedback */}
                      {event.type === 'feedback' && (event.metadata?.feedbackType || event.metadata?.type) && (
                        <span className="inline-flex items-center gap-1 mt-0.5">
                          {((event.metadata?.feedbackType || event.metadata?.type) === 'positive') ? (
                            <ThumbsUp className="h-2.5 w-2.5 text-emerald-400" />
                          ) : (
                            <ThumbsDown className="h-2.5 w-2.5 text-red-400" />
                          )}
                        </span>
                      )}
                      {/* Show applied status for corrections */}
                      {event.type === 'correction' && (
                        <span className="text-[9px] text-stone-500 ml-2">
                          {event.metadata?.applied ? '✓ Đã áp dụng' : '⏳ Chờ xử lý'}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BookMarked className="h-8 w-8 text-amber-500/30 mb-2" />
              <p className="text-xs text-stone-500">Chưa có sự kiện học tập nào</p>
              <p className="text-[10px] text-stone-600">Chat với Agent hoặc dạy Agent để bắt đầu</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 3. MANUAL TEACHING ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <GraduationCap className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Dạy Agent</span>
          </div>

          <div className="space-y-3">
            {/* Type selector */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 w-16 shrink-0">Loại:</span>
              <div className="flex gap-1">
                {(['insight', 'correction', 'preference', 'order'] as const).map(t => {
                  const cfg = getTypeConfig(t)
                  return (
                    <Button
                      key={t}
                      variant="ghost"
                      size="sm"
                      className={`h-7 px-2.5 text-[10px] ${teachType === t ? `${cfg.bg} ${cfg.color} border ${cfg.border}` : 'text-stone-400 hover:text-stone-200'}`}
                      onClick={() => setTeachType(t)}
                    >
                      {cfg.icon} <span className="ml-1">{cfg.label}</span>
                    </Button>
                  )
                })}
              </div>
            </div>

            {/* Wrong answer (for correction only) */}
            {teachType === 'correction' && (
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">Sai:</span>
                <Textarea
                  value={teachWrongAnswer}
                  onChange={e => setTeachWrongAnswer(e.target.value)}
                  placeholder="Câu trả lời sai của Agent..."
                  className="text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 min-h-[60px] resize-none"
                />
              </div>
            )}

            {/* Content */}
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">
                {teachType === 'correction' ? 'Đúng:' : teachType === 'order' ? 'Lệnh:' : 'Nội dung:'}
              </span>
              <Textarea
                value={teachContent}
                onChange={e => setTeachContent(e.target.value)}
                placeholder={
                  teachType === 'insight' ? 'VD: QuickSort có độ phức tạp O(n log n) trung bình'
                  : teachType === 'correction' ? 'VD: QuickSort có độ phức tạp O(n log n) trung bình, không phải O(n²)'
                  : teachType === 'preference' ? 'VD: response_style: ngắn gọn'
                  : 'VD: Luôn tìm kiếm Knowledge Base trước khi trả lời'
                }
                className="text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 min-h-[60px] resize-none"
              />
            </div>

            {/* Reason (for correction) */}
            {teachType === 'correction' && (
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">Lý do:</span>
                <Input
                  value={teachReason}
                  onChange={e => setTeachReason(e.target.value)}
                  placeholder="Tại sao Agent sai? (tùy chọn)"
                  className="h-8 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50"
                />
              </div>
            )}

            {/* Related entity (for insight/correction) */}
            {(teachType === 'insight' || teachType === 'correction') && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0">Entity:</span>
                <Input
                  value={teachRelatedEntity}
                  onChange={e => setTeachRelatedEntity(e.target.value)}
                  placeholder="Entity liên quan (tùy chọn)"
                  className="h-8 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50"
                />
              </div>
            )}

            {/* Submit button */}
            <div className="flex items-center justify-end">
              <Button
                onClick={handleTeach}
                disabled={teachSubmitting || !teachContent.trim() || (teachType === 'correction' && !teachWrongAnswer.trim())}
                className="chamfer-sm h-8 px-4 bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700 text-white border-0 text-xs"
              >
                {teachSubmitting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Đang gửi...</> : <><GraduationCap className="mr-1.5 h-3.5 w-3.5" /> Dạy Agent</>}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 4. FEEDBACK HISTORY ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Lịch sử Feedback</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{feedbackHistory.length}</Badge>
            </div>
            <div className="flex items-center gap-1">
              {(['all', 'positive', 'negative'] as const).map(f => (
                <Button
                  key={f}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[9px] ${feedbackFilter === f ? 'bg-amber-500/20 text-amber-400' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => setFeedbackFilter(f)}
                >
                  {f === 'all' ? 'Tất cả' : f === 'positive' ? '👍' : '👎'}
                </Button>
              ))}
            </div>
          </div>

          {filteredFeedback.length > 0 ? (
            <div className="max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-slate-950/80">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Thời gian</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Feedback</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Nội dung</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Correction</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFeedback.map(event => {
                    const meta = event.metadata || {}
                    const isPositive = (meta.feedbackType || meta.type) === 'positive'
                    return (
                      <tr key={event.id} className="hover:bg-slate-950/30">
                        <td className="px-2 py-1.5 text-stone-400 border-b border-amber-500/5 whitespace-nowrap">{formatTime(event.timestamp)}</td>
                        <td className="px-2 py-1.5 border-b border-amber-500/5">
                          {isPositive ? <ThumbsUp className="h-3 w-3 text-emerald-400" /> : <ThumbsDown className="h-3 w-3 text-red-400" />}
                        </td>
                        <td className="px-2 py-1.5 text-stone-300 border-b border-amber-500/5 max-w-[200px] truncate">{String(meta.userContent || event.content).substring(0, 60)}</td>
                        <td className="px-2 py-1.5 text-stone-400 border-b border-amber-500/5 max-w-[150px] truncate">{meta.correction ? String(meta.correction).substring(0, 40) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-[10px] text-stone-500">Chưa có feedback nào</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 5. KNOWLEDGE GRAPH MINI-VIEW ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <Network className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Agent Knowledge Graph</span>
            <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{agentEntities.length} entities</Badge>
          </div>

          {agentEntities.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {agentEntities.map(entity => (
                <div key={entity.id} className="p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    <span className="text-[10px] font-medium text-stone-200 truncate">{entity.entityName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge className="text-[8px] h-3 px-1 bg-cyan-950/30 text-cyan-400 border-cyan-400/35">{entity.entityType}</Badge>
                  </div>
                  {entity.description && (
                    <p className="text-[9px] text-stone-500 mt-0.5 line-clamp-1">{entity.description}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4">
              <Network className="h-6 w-6 text-amber-500/20 mx-auto mb-1" />
              <p className="text-[10px] text-stone-500">Agent chưa tạo entity nào</p>
              <p className="text-[9px] text-stone-600">Sử dụng knowledge_write tool để Agent tạo entity</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 6. STANDING ORDERS ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <BookMarked className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Standing Orders</span>
            <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{orders.length}</Badge>
          </div>

          {orders.length > 0 ? (
            <div className="space-y-1.5 mb-3 max-h-40 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {orders.map((order, idx) => (
                <div key={order.id} className="flex items-start gap-2 p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
                  <span className="text-[10px] text-stone-500 shrink-0">{idx + 1}.</span>
                  <span className="text-[11px] text-stone-300 flex-1">{order.order}</span>
                  <Badge className="text-[8px] h-3.5 px-1 bg-blue-950/30 text-blue-400 border-blue-400/35">P{order.priority}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-stone-500 mb-3">Chưa có standing order nào</p>
          )}

          {/* Add new order inline */}
          <div className="flex items-center gap-2">
            <Input
              value={newOrder}
              onChange={e => setNewOrder(e.target.value)}
              placeholder="Thêm standing order mới..."
              className="h-7 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 flex-1"
              onKeyDown={e => {
                if (e.key === 'Enter' && newOrder.trim()) {
                  // Directly teach - don't set teachContent/teachType (pollutes form state)
                  const orderText = newOrder.trim()
                  fetch('/api/openclaw/learning/teach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'order', content: orderText, metadata: { priority: newOrderPriority, enabled: true } }),
                  }).then(async res => {
                    if (res.ok) {
                      toast({ title: 'Đã thêm Standing Order' })
                      setNewOrder('')
                      const statsRes = await fetch('/api/openclaw/learning/stats')
                      if (statsRes.ok) { const d = await statsRes.json(); setStats(d); setOrders(d.standingOrders || []) }
                    }
                  })
                }
              }}
            />
            <Input
              type="number"
              value={newOrderPriority}
              onChange={e => setNewOrderPriority(parseInt(e.target.value) || 0)}
              className="h-7 w-14 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 text-center"
              min={0}
              max={10}
            />
          </div>
        </div>
      </div>

      {/* ===== 7. EXPORT / IMPORT ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <FileJson className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Xuất / Nhập Bộ nhớ</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Export */}
            <div className="p-3 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <FileDown className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs text-stone-200">Xuất bộ nhớ</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Select value={exportFormat} onValueChange={(v: 'json' | 'markdown') => setExportFormat(v)}>
                  <SelectTrigger className="h-7 text-xs w-[110px] rounded-lg border-amber-400/35 bg-slate-950/60 text-stone-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950/80 border-amber-400/35">
                    <SelectItem value="json" className="text-stone-200 focus:text-white focus:bg-stone-800/80">JSON</SelectItem>
                    <SelectItem value="markdown" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Markdown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleExport}
                className="chamfer-sm h-7 px-3 bg-gradient-to-r from-amber-500/80 to-yellow-600/80 hover:from-amber-600/80 hover:to-yellow-700/80 text-white border-0 text-[10px]"
              >
                <Download className="mr-1 h-3 w-3" /> Xuất {exportFormat.toUpperCase()}
              </Button>
            </div>

            {/* Import */}
            <div className="p-3 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <FileUp className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs text-stone-200">Nhập bộ nhớ</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Select value={importMode} onValueChange={(v: 'skip' | 'overwrite' | 'merge') => setImportMode(v)}>
                  <SelectTrigger className="h-7 text-xs w-[110px] rounded-lg border-amber-400/35 bg-slate-950/60 text-stone-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950/80 border-amber-400/35">
                    <SelectItem value="skip" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Bỏ qua trùng</SelectItem>
                    <SelectItem value="overwrite" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Ghi đè</SelectItem>
                    <SelectItem value="merge" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Ghép nối</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="chamfer-sm h-7 px-3 bg-gradient-to-r from-violet-500/80 to-purple-600/80 hover:from-violet-600/80 hover:to-purple-700/80 text-white border-0 text-[10px]"
                >
                  {importing ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Đang nhập...</> : <><UploadIcon className="mr-1 h-3 w-3" /> Chọn file JSON</>}
                </Button>
                <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

// ==================== CHANNELS TAB CONTENT (Phase 6) ====================

function ChannelsTabContent() {
  // Channels list
  const [channels, setChannels] = useState<Array<{
    channelType: string; icon: string; label: string; enabled: boolean;
    connected: boolean; config: Record<string, string>; connectedAt: string | null;
    gatewayStatus: string | null;
  }> | null>(null)
  const [channelsLoading, setChannelsLoading] = useState(false)

  // Selected channel for config
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [channelConfig, setChannelConfig] = useState<{
    channelType: string; label: string; enabled: boolean; connectedAt: string | null;
    config: Record<string, string>; fields: Array<{ key: string; label: string; type: string; placeholder?: string; options?: string[] }>;
  } | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [editedConfig, setEditedConfig] = useState<Record<string, string>>({})

  // Messages
  const [messages, setMessages] = useState<Array<{
    id: string; channel: string; direction: string; sender: string;
    content: string; timestamp: string; agentReplied: boolean; agentReply: string | null;
  }> | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [msgFilter, setMsgFilter] = useState('all')

  // Reply
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyChannel, setReplyChannel] = useState<string>('webchat')
  const [replyContent, setReplyContent] = useState('')
  const [replySending, setReplySending] = useState(false)

  // Testing channel
  const [testingChannel, setTestingChannel] = useState<string | null>(null)

  // Load channels
  const loadChannels = useCallback(async () => {
    setChannelsLoading(true)
    try {
      const res = await fetch('/api/openclaw/channels')
      const data = await res.json()
      setChannels(data.channels || [])
    } catch (err) {
      console.error('Failed to load channels:', err)
    } finally {
      setChannelsLoading(false)
    }
  }, [])

  // Load channel config
  const loadConfig = useCallback(async (channelType: string) => {
    setConfigLoading(true)
    try {
      const res = await fetch(`/api/openclaw/channels/config?channel=${channelType}`)
      const data = await res.json()
      setChannelConfig(data)
      setEditedConfig(data.config || {})
    } catch (err) {
      console.error('Failed to load config:', err)
    } finally {
      setConfigLoading(false)
    }
  }, [])

  // Load messages
  const loadMessages = useCallback(async (channel?: string) => {
    setMessagesLoading(true)
    try {
      const ch = channel || msgFilter
      const res = await fetch(`/api/openclaw/channels/messages?channel=${ch}&limit=50`)
      const data = await res.json()
      setMessages(data.messages || [])
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      setMessagesLoading(false)
    }
  }, [msgFilter])

  useEffect(() => { loadChannels() }, [loadChannels])
  useEffect(() => {
    loadMessages()
    const interval = setInterval(loadMessages, 30000)
    return () => clearInterval(interval)
  }, [loadMessages])

  // Connect channel
  const handleConnect = async (channelType: string) => {
    try {
      await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', channelType, config: {} }),
      })
      toast({ title: 'Kết nối thành công', description: `Kênh ${channelType} đã được bật` })
      loadChannels()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể kết nối kênh', variant: 'destructive' })
    }
  }

  // Disconnect channel
  const handleDisconnect = async (channelType: string) => {
    try {
      await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', channelType }),
      })
      toast({ title: 'Đã ngắt kết nối', description: `Kênh ${channelType} đã được tắt` })
      loadChannels()
      if (selectedChannel === channelType) {
        setSelectedChannel(null)
        setChannelConfig(null)
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể ngắt kết nối', variant: 'destructive' })
    }
  }

  // Test channel
  const handleTest = async (channelType: string) => {
    setTestingChannel(channelType)
    try {
      const res = await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', channelType }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Test thành công', description: `Kênh ${channelType} phản hồi OK` })
      } else {
        toast({ title: 'Test thất bại', description: data.error || 'Kênh không phản hồi', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể test kênh', variant: 'destructive' })
    } finally {
      setTestingChannel(null)
    }
  }

  // Save config
  const handleSaveConfig = async () => {
    if (!selectedChannel) return
    setConfigSaving(true)
    try {
      const res = await fetch(`/api/openclaw/channels/config?channel=${selectedChannel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: editedConfig, enabled: true }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã lưu', description: `Cấu hình ${selectedChannel} đã được cập nhật` })
        loadChannels()
        loadConfig(selectedChannel)
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Không thể lưu', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể lưu cấu hình', variant: 'destructive' })
    } finally {
      setConfigSaving(false)
    }
  }

  // Open config for a channel
  const openConfig = (channelType: string) => {
    setSelectedChannel(channelType)
    loadConfig(channelType)
  }

  // Send reply
  const handleReply = async () => {
    if (!replyTo || !replyContent.trim()) return
    setReplySending(true)
    try {
      await fetch('/api/openclaw/channels/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: replyChannel, messageId: replyTo, content: replyContent }),
      })
      toast({ title: 'Đã gửi', description: 'Phản hồi đã được gửi' })
      setReplyTo(null)
      setReplyContent('')
      loadMessages()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể gửi phản hồi', variant: 'destructive' })
    } finally {
      setReplySending(false)
    }
  }

  const connectedCount = channels?.filter(c => c.connected).length || 0
  const totalMessages = messages?.length || 0

  return (
    <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-160px)] pr-1">
      {/* ─── Header Stats ─── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Kênh đã kết nối</span>
          </div>
          <div className="text-xl font-bold text-teal-300 mt-1">{connectedCount}<span className="text-xs text-stone-500">/{channels?.length || 6}</span></div>
        </div></div>
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Tin nhắn gần đây</span>
          </div>
          <div className="text-xl font-bold text-teal-300 mt-1">{totalMessages}</div>
        </div></div>
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Trạng thái</span>
          </div>
          <div className="text-sm font-bold text-teal-300 mt-1">{connectedCount > 0 ? 'Hoạt động' : 'Chưa kết nối'}</div>
        </div></div>
      </div>

      {/* ─── Section 1: Channel List ─── */}
      <div className="nc-wrap nc-teal">
        <div className="nc-panel nc-md nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-teal-400" />
              <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Kênh giao tiếp</h3>
            </div>
            <Button onClick={() => loadChannels()} variant="ghost" size="sm" className="h-6 px-2 text-teal-400 hover:text-teal-300">
              <RefreshCw className={`h-3 w-3 ${channelsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {channelsLoading && !channels ? (
              <div className="col-span-3 text-center py-6"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (channels || []).map(ch => (
              <div key={ch.channelType} className="nc-wrap nc-teal">
                <div className="nc-panel nc-sm nc-border-teal p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{ch.icon}</span>
                      <span className="text-xs font-bold text-stone-200">{ch.label}</span>
                    </div>
                    <Badge className={`text-[9px] px-1.5 py-0 ${ch.connected ? 'bg-teal-500/20 text-teal-300 border-teal-400/50' : 'bg-slate-700/50 text-stone-500 border-slate-400/50'}`}>
                      {ch.connected ? 'Online' : 'Offline'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    {ch.connected ? (
                      <>
                        <Button onClick={() => openConfig(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 border border-teal-400/35">
                          <Settings className="h-3 w-3 mr-1" /> Cấu hình
                        </Button>
                        <Button onClick={() => handleTest(ch.channelType)} variant="ghost" size="sm" disabled={testingChannel === ch.channelType} className="h-6 px-2 text-[10px] text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border border-amber-400/35">
                          {testingChannel === ch.channelType ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />} Test
                        </Button>
                        <Button onClick={() => handleDisconnect(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-400/35">
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => openConfig(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 border border-teal-400/35">
                        <Plus className="h-3 w-3 mr-1" /> Cài đặt
                      </Button>
                    )}
                  </div>
                  {ch.connectedAt && (
                    <div className="text-[9px] text-stone-500 mt-1.5">
                      Kết nối: {new Date(ch.connectedAt).toLocaleString('vi-VN')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Section 2: Channel Config ─── */}
      {selectedChannel && channelConfig && (
        <div className="nc-wrap nc-teal">
          <div className="nc-panel nc-md nc-border-teal p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-teal-400" />
                <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Cấu hình {channelConfig.label}</h3>
              </div>
              <Button onClick={() => { setSelectedChannel(null); setChannelConfig(null) }} variant="ghost" size="sm" className="h-6 px-2 text-stone-400 hover:text-stone-200">
                <X className="h-3 w-3" />
              </Button>
            </div>
            {configLoading ? (
              <div className="text-center py-4"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (
              <div className="space-y-3">
                {channelConfig.fields.map(field => (
                  <div key={field.key}>
                    <label className="text-[10px] text-teal-400/70 uppercase tracking-wider mb-1 block">{field.label}</label>
                    {field.type === 'password' ? (
                      <Input
                        type="password"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    ) : field.type === 'select' && field.options ? (
                      <Select value={editedConfig[field.key] || ''} onValueChange={v => setEditedConfig(prev => ({ ...prev, [field.key]: v }))}>
                        <SelectTrigger className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200">
                          <SelectValue placeholder={field.placeholder || 'Chọn...'} />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-900 border-teal-400/35">
                          {field.options.map(opt => <SelectItem key={opt} value={opt} className="text-xs text-stone-200">{opt}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : field.type === 'number' ? (
                      <Input
                        type="number"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    ) : (
                      <Input
                        type="text"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-2">
                  <Button onClick={handleSaveConfig} disabled={configSaving} className="chamfer-sm h-7 px-3 bg-gradient-to-r from-teal-500/80 to-emerald-600/80 hover:from-teal-600/80 hover:to-emerald-700/80 text-white border-0 text-[10px]">
                    {configSaving ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Đang lưu...</> : <><Check className="mr-1 h-3 w-3" /> Lưu & Kết nối</>}
                  </Button>
                  <Button onClick={() => handleTest(selectedChannel)} disabled={testingChannel === selectedChannel} variant="ghost" size="sm" className="h-7 px-3 text-[10px] text-amber-400 hover:text-amber-300 border border-amber-400/35">
                    {testingChannel === selectedChannel ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />} Test kết nối
                  </Button>
                  {channelConfig.enabled && (
                    <Button onClick={() => handleDisconnect(selectedChannel)} variant="ghost" size="sm" className="h-7 px-3 text-[10px] text-red-400 hover:text-red-300 border border-red-400/35">
                      <XCircle className="mr-1 h-3 w-3" /> Ngắt kết nối
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Section 3: Message Monitor ─── */}
      <div className="nc-wrap nc-teal">
        <div className="nc-panel nc-md nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-teal-400" />
              <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Theo dõi tin nhắn</h3>
            </div>
            <div className="flex items-center gap-2">
              <Select value={msgFilter} onValueChange={v => { setMsgFilter(v); loadMessages(v) }}>
                <SelectTrigger className="h-6 w-24 text-[10px] bg-slate-950/60 border-teal-400/35 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-teal-400/35">
                  <SelectItem value="all" className="text-xs text-stone-200">Tất cả</SelectItem>
                  <SelectItem value="telegram" className="text-xs text-stone-200">💬 Telegram</SelectItem>
                  <SelectItem value="discord" className="text-xs text-stone-200">🎮 Discord</SelectItem>
                  <SelectItem value="slack" className="text-xs text-stone-200">📱 Slack</SelectItem>
                  <SelectItem value="webchat" className="text-xs text-stone-200">🌐 WebChat</SelectItem>
                  <SelectItem value="whatsapp" className="text-xs text-stone-200">📞 WhatsApp</SelectItem>
                  <SelectItem value="signal" className="text-xs text-stone-200">🔒 Signal</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => loadMessages()} variant="ghost" size="sm" className="h-6 px-2 text-teal-400 hover:text-teal-300">
                <RefreshCw className={`h-3 w-3 ${messagesLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1.5 custom-scrollbar">
            {messagesLoading && !messages ? (
              <div className="text-center py-6"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (messages || []).length === 0 ? (
              <div className="text-center py-6 text-stone-500 text-xs">Chưa có tin nhắn</div>
            ) : (messages || []).map(msg => {
              const channelIcon: Record<string, string> = { telegram: '💬', discord: '🎮', slack: '📱', webchat: '🌐', whatsapp: '📞', signal: '🔒' }
              return (
                <div key={msg.id} className="flex items-start gap-2 p-2 rounded-lg bg-slate-950/40 border border-teal-400/25 hover:border-teal-400/35 transition-colors">
                  <span className="text-sm mt-0.5">{channelIcon[msg.channel] || '📡'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-bold text-teal-300">{msg.sender}</span>
                      <span className="text-[9px] text-stone-600">{new Date(msg.timestamp).toLocaleString('vi-VN')}</span>
                      {msg.direction === 'inbound' ? (
                        <Badge className="text-[8px] px-1 py-0 bg-blue-500/20 text-blue-300 border-blue-400/50">Nhận</Badge>
                      ) : (
                        <Badge className="text-[8px] px-1 py-0 bg-teal-500/20 text-teal-300 border-teal-400/50">Gửi</Badge>
                      )}
                    </div>
                    <p className="text-xs text-stone-300 break-words">{msg.content}</p>
                    {msg.agentReplied && msg.agentReply && (
                      <div className="mt-1 p-1.5 rounded bg-teal-500/5 border border-teal-400/25">
                        <div className="flex items-center gap-1 mb-0.5">
                          <Sparkles className="h-2.5 w-2.5 text-teal-400" />
                          <span className="text-[9px] text-teal-400">Agent phản hồi</span>
                        </div>
                        <p className="text-[11px] text-stone-400 break-words">{msg.agentReply}</p>
                      </div>
                    )}
                  </div>
                  <Button onClick={() => { setReplyTo(msg.id); setReplyChannel(msg.channel); setReplyContent('') }} variant="ghost" size="sm" className="h-5 w-5 p-0 text-stone-500 hover:text-teal-400 flex-shrink-0">
                    <MessageCircle className="h-3 w-3" />
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ─── Section 4: Reply Panel ─── */}
      {replyTo && (
        <div className="nc-wrap nc-teal">
          <div className="nc-panel nc-md nc-border-teal p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-teal-400" />
                <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Phản hồi tin nhắn</h3>
              </div>
              <Button onClick={() => { setReplyTo(null); setReplyChannel('webchat'); setReplyContent('') }} variant="ghost" size="sm" className="h-6 px-2 text-stone-400 hover:text-stone-200">
                <X className="h-3 w-3" />
              </Button>
            </div>
            <Textarea
              value={replyContent}
              onChange={e => setReplyContent(e.target.value)}
              placeholder={`Nhập phản hồi trên kênh ${replyChannel}... (Agent sẽ gửi thay bạn)`}
              className="min-h-[60px] text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40 resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <Button onClick={handleReply} disabled={replySending || !replyContent.trim()} className="chamfer-sm h-7 px-3 bg-gradient-to-r from-teal-500/80 to-emerald-600/80 hover:from-teal-600/80 hover:to-emerald-700/80 text-white border-0 text-[10px]">
                {replySending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />} Gửi phản hồi
              </Button>
              <span className="text-[9px] text-stone-600">Hoặc để Agent tự động phản hồi</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SmolabModule({ sidebarOpen }: { sidebarOpen: boolean }) {
  // Chat state
  const [messages, setMessages] = useState<SmolabMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState('nvidia/llama-3.1-nemotron-70b-instruct')
  const [activeSmolabTab, setActiveSmolabTab] = useState('knowledge')
  const [gatewayOnline, setGatewayOnline] = useState(false)
  const [sessions, setSessions] = useState<SmolabSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [showSessionSelect, setShowSessionSelect] = useState(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)

  // Restore persisted Smolab tab AFTER mount to avoid hydration mismatch.
  const smolabTabRestoredRef = useRef(false)
  useEffect(() => {
    if (!smolabTabRestoredRef.current) {
      smolabTabRestoredRef.current = true
      try {
        const saved = localStorage.getItem('graphrag-smolab-tab')
        if (saved) {
          // If saved tab was removed (e.g. 'chat-settings'), redirect to 'knowledge'
          const validTabs = SMOLAB_TABS.map(t => t.id)
          const validTab = validTabs.includes(saved) ? saved : 'knowledge'
          setActiveSmolabTab(validTab)
          if (validTab !== saved) localStorage.setItem('graphrag-smolab-tab', validTab)
        }
      } catch { /* ignore */ }
    }
  }, [])

  // Phase D: Agent/Team chat mode
  const [chatMode, setChatMode] = useState<'single' | 'multi'>('single')
  const [smolabAgents, setSmolabAgents] = useState<any[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null) // 'code' | 'research'
  const [showAgentSelect, setShowAgentSelect] = useState(false)
  const [showTeamSelect, setShowTeamSelect] = useState(false)

  // Smolab task tracking — background task polling (Phase 6)
  const [activeTaskIds, setActiveTaskIds] = useState<Map<string, string>>(new Map()) // sessionId → taskId
  const [taskPolling, setTaskPolling] = useState(false)


  // canChat — PHẢI chọn Agent/Team trước khi chat (Phase 5)
  const canChat = (chatMode === 'single' && !!selectedAgentId) || (chatMode === 'multi' && !!selectedTeam)

  // Resize panel state — persisted via localStorage so positions survive module switches
  const SMOLAB_STORAGE_PREFIX = 'smolab_layout_'
  const readStored = <T,>(key: string, fallback: T): T => {
    if (typeof window === 'undefined') return fallback
    try {
      const raw = localStorage.getItem(SMOLAB_STORAGE_PREFIX + key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch { return fallback }
  }

  const [chatPanelWidth, setChatPanelWidth] = useState(() => readStored('chatPanelWidth', 400))
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const smolabContainerRef = useRef<HTMLDivElement>(null)

  // Outer edge resize state — absolute viewport positions
  // smolabLeft = distance from viewport left edge to module left edge
  // smolabRight = distance from viewport right edge to module right edge
  // smolabTop = distance from viewport top (below header) to module top edge
  const SIDEBAR_WIDTH_OPEN = 224 // w-56 = 14rem = 224px
  const SIDEBAR_WIDTH_CLOSED = 48  // w-12 = 3rem = 48px
  const HEADER_HEIGHT = 56
  const MIN_MODULE_WIDTH = 300
  const MIN_MODULE_HEIGHT = 200

  const sidebarWidth = sidebarOpen ? SIDEBAR_WIDTH_OPEN : SIDEBAR_WIDTH_CLOSED
  // Default left = sidebar width (right edge of sidebar)
  const [smolabLeft, setSmolabLeft] = useState<number | null>(() => readStored<number | null>('smolabLeft', null))
  const [smolabRight, setSmolabRight] = useState<number | null>(() => readStored<number | null>('smolabRight', null))
  const [smolabTop, setSmolabTop] = useState<number | null>(() => readStored<number | null>('smolabTop', null))
  const [smolabHeight, setSmolabHeight] = useState<number | null>(() => readStored<number | null>('smolabHeight', null))

  // Effective values (resolve null to defaults)
  const effectiveLeft = smolabLeft !== null ? smolabLeft : sidebarWidth
  const effectiveRight = smolabRight !== null ? smolabRight : 0
  const effectiveTop = smolabTop !== null ? smolabTop : 0
  const effectiveHeight = smolabHeight !== null ? smolabHeight : (window.innerHeight - HEADER_HEIGHT - effectiveTop)

  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const isDraggingBottom = useRef(false)
  const isDraggingTop = useRef(false)
  const dragStartLeft = useRef(0)
  const dragStartRight = useRef(0)
  const dragStartTop = useRef(0)
  const dragStartHeight = useRef(0)
  const dragStartY = useRef(0) // shared for top & bottom edge dragging
  const smolabOuterRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  // V1 FIX: Ref to skip message loading when session ID is set programmatically (e.g. sendMessage creates new session)
  // This prevents the useEffect from wiping messages that were just added to state
  const skipMessageLoadRef = useRef(false)

  // Persist layout positions to localStorage on every change
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'chatPanelWidth', JSON.stringify(chatPanelWidth)) } catch {}
  }, [chatPanelWidth, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabLeft', JSON.stringify(smolabLeft)) } catch {}
  }, [smolabLeft, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabRight', JSON.stringify(smolabRight)) } catch {}
  }, [smolabRight, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabTop', JSON.stringify(smolabTop)) } catch {}
  }, [smolabTop, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabHeight', JSON.stringify(smolabHeight)) } catch {}
  }, [smolabHeight, SMOLAB_STORAGE_PREFIX])

  // Resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = chatPanelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    // Add overlay to prevent iframe/content stealing mouse events
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [chatPanelWidth])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - dragStartX.current
      const containerWidth = smolabContainerRef.current?.offsetWidth || 1200
      const MIN_CHAT = 280
      const MAX_CHAT = containerWidth - 400 // leave at least 400px for tab content
      const newWidth = Math.min(MAX_CHAT, Math.max(MIN_CHAT, dragStartWidth.current + delta))
      setChatPanelWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const overlay = document.getElementById('resize-overlay')
      if (overlay) overlay.remove()
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Left edge resize handler (absolute viewport positioning)
  const handleLeftEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingLeft.current = true
    dragStartX.current = e.clientX
    dragStartLeft.current = effectiveLeft
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-left'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [effectiveLeft])

  // Right edge resize handler (absolute viewport positioning)
  const handleRightEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRight.current = true
    dragStartX.current = e.clientX
    dragStartRight.current = effectiveRight
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-right'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [effectiveRight])

  // Bottom edge resize handler
  const handleBottomEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingBottom.current = true
    dragStartY.current = e.clientY
    dragStartHeight.current = smolabHeight ?? (window.innerHeight - HEADER_HEIGHT - effectiveTop)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-bottom'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize;'
    document.body.appendChild(overlay)
  }, [smolabHeight, effectiveTop])

  // Top edge resize handler
  const handleTopEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingTop.current = true
    dragStartY.current = e.clientY
    dragStartTop.current = effectiveTop
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-top'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize;'
    document.body.appendChild(overlay)
  }, [effectiveTop])

  // Mouse move/up for left, right, top, bottom edge dragging (viewport-based)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (isDraggingLeft.current) {
        // Left edge: dragging right → module narrows (left increases), dragging left → module widens (left decreases)
        const delta = e.clientX - dragStartX.current
        const newLeft = dragStartLeft.current + delta
        // Min: 0 (flush to screen left edge)
        // Max: vw - effectiveRight - MIN_MODULE_WIDTH (must leave room for module content)
        const maxLeft = vw - effectiveRight - MIN_MODULE_WIDTH
        setSmolabLeft(Math.min(maxLeft, Math.max(0, newLeft)))
      }
      if (isDraggingRight.current) {
        // Right edge: dragging left → module narrows (right increases), dragging right → module widens (right decreases)
        const delta = e.clientX - dragStartX.current
        const newRight = dragStartRight.current - delta
        // Min: 0 (flush to screen right edge)
        // Max: vw - effectiveLeft - MIN_MODULE_WIDTH (must leave room for module content)
        const maxRight = vw - effectiveLeft - MIN_MODULE_WIDTH
        setSmolabRight(Math.min(maxRight, Math.max(0, newRight)))
      }
      if (isDraggingBottom.current) {
        // Bottom edge: dragging down → taller, dragging up → shorter
        const delta = e.clientY - dragStartY.current
        const maxH = vh - HEADER_HEIGHT - effectiveTop
        const newHeight = Math.min(maxH, Math.max(MIN_MODULE_HEIGHT, dragStartHeight.current + delta))
        setSmolabHeight(newHeight)
      }
      if (isDraggingTop.current) {
        // Top edge: dragging down → module shrinks from top (top increases), dragging up → module grows (top decreases)
        const delta = e.clientY - dragStartY.current
        const newTop = dragStartTop.current + delta
        // Min: 0 (flush to header bottom)
        // Max: vh - HEADER_HEIGHT - MIN_MODULE_HEIGHT
        const maxTop = vh - HEADER_HEIGHT - MIN_MODULE_HEIGHT
        setSmolabTop(Math.min(maxTop, Math.max(0, newTop)))
      }
    }
    const handleMouseUp = () => {
      let didStop = false
      if (isDraggingLeft.current) {
        isDraggingLeft.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-left')
        if (overlay) overlay.remove()
      }
      if (isDraggingRight.current) {
        isDraggingRight.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-right')
        if (overlay) overlay.remove()
      }
      if (isDraggingBottom.current) {
        isDraggingBottom.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-bottom')
        if (overlay) overlay.remove()
      }
      if (isDraggingTop.current) {
        isDraggingTop.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-top')
        if (overlay) overlay.remove()
      }
      if (didStop) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [effectiveRight, effectiveLeft, effectiveTop])

  // Check gateway status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/openclaw/status')
        if (res.ok) {
          const data = await res.json()
          setGatewayOnline(data.status === 'online')
        }
      } catch { setGatewayOnline(false) }
    }
    checkStatus()
    const interval = setInterval(checkStatus, 15000)
    return () => clearInterval(interval)
  }, [])

  // Load sessions on mount — respects current agent/team filter
  useEffect(() => {
    const loadSessions = async () => {
      try {
        let url = '/api/openclaw/sessions?action=list'
        // If an agent is selected in single mode, filter by agentProfileId
        if (chatMode === 'single' && selectedAgentId) {
          url += `&agentProfileId=${selectedAgentId}`
        }
        // If a team is selected in multi mode, filter by teamName
        if (chatMode === 'multi' && selectedTeam) {
          url += `&teamName=${selectedTeam}`
        }
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          setSessions(data.sessions || [])
        }
      } catch {}
    }
    loadSessions()
    const interval = setInterval(loadSessions, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [chatMode, selectedAgentId, selectedTeam])

  const [agentsLoadError, setAgentsLoadError] = useState<string | null>(null)

  // Fetch agents for Smolab on mount
  useEffect(() => {
    const loadAgents = async () => {
      try {
        setAgentsLoadError(null)
        const res = await fetch('/api/agents?enabled=true')
        if (res.ok) {
          const data = await res.json()
          setSmolabAgents(data.agents || [])
        } else {
          const errData = await res.json().catch(() => ({}))
          const errMsg = errData.error || errData.details || `Lỗi ${res.status}`
          console.warn('[Smolab] Failed to load agents:', errMsg)
          setAgentsLoadError(errMsg)
        }
      } catch (err) {
        console.warn('[Smolab] Failed to load agents:', err)
        setAgentsLoadError('Không thể kết nối tới server. Kiểm tra dev server đang chạy?')
      }
    }
    loadAgents()
    const interval = setInterval(loadAgents, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  // ===== V1 FIX: Load messages from DB when switching sessions =====
  // When currentSessionId changes, fetch persisted messages from /api/chat-messages
  const prevSessionIdRef = useRef(currentSessionId)
  useEffect(() => {
    // Skip if session ID hasn't actually changed (prevents re-fetch on re-render)
    if (prevSessionIdRef.current === currentSessionId) return
    prevSessionIdRef.current = currentSessionId

    // Skip when session ID is set programmatically (sendMessage/startWorkflow) to avoid wiping in-flight messages
    if (skipMessageLoadRef.current) {
      skipMessageLoadRef.current = false
      return
    }

    if (!currentSessionId) {
      setMessages([])
      return
    }

    setLoadingMessages(true)
    fetch(`/api/chat-messages?sessionId=${encodeURIComponent(currentSessionId)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
          const loaded: SmolabMessage[] = data.messages.map((m: {
            id: string
            role: string
            content: string
            model?: string | null
            provider?: string | null
            metadata?: string | null
            createdAt: string
          }) => {
            // Parse metadata JSON if present (handle both single and double-stringified data for backward compat)
            let parsedMeta: Record<string, unknown> | undefined
            if (m.metadata) {
              try {
                const first = JSON.parse(m.metadata)
                // If double-stringified (legacy data), first parse returns a string — parse again
                parsedMeta = typeof first === 'string' ? JSON.parse(first) : first
              } catch { /* ignore */ }
            }
            return {
              id: m.id,
              role: (['user', 'assistant', 'tool_call', 'error'].includes(m.role) ? m.role : 'assistant') as SmolabMessage['role'],
              content: m.content,
              timestamp: new Date(m.createdAt),
              model: m.model || undefined,
              provider: m.provider || undefined,
              sources: parsedMeta?.sources as Array<{ type: string; content: string; documentTitle?: string }> | undefined,
              confidence: parsedMeta?.confidence as number | undefined,
              toolName: parsedMeta?.toolName as string | undefined,
              agentName: parsedMeta?.agentName as string | undefined,
              agentPosition: parsedMeta?.agentPosition as string | undefined,
              isTeamMessage: parsedMeta?.isTeamMessage as boolean | undefined,
            }
          })
          setMessages(loaded)
        } else {
          setMessages([])
        }
      })
      .catch(err => {
        console.error('[Smolab] Failed to load session messages:', err)
        setMessages([])
      })
      .finally(() => setLoadingMessages(false))
  }, [currentSessionId])

  // Close dropdown menus on click outside
  // Use mousedown (not click) so the handler fires BEFORE React's onClick + stopPropagation
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Only close if the click target is NOT inside any dropdown or toggle button
      const target = e.target as HTMLElement
      if (target.closest('[data-dropdown-toggle]') || target.closest('[data-dropdown-menu]')) return
      setShowAgentSelect(false)
      setShowTeamSelect(false)
      setShowSessionSelect(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Clear session search when dropdown closes
  useEffect(() => {
    if (!showSessionSelect) setSessionSearchQuery('')
  }, [showSessionSelect])

  // Fetch sessions filtered by agent — using isolated API (Phase 7)
  const fetchSessionsForAgent = useCallback(async (agentProfileId: string) => {
    try {
      const res = await fetch(`/api/smolab/sessions?mode=single&agentProfileId=${agentProfileId}`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions || [])
      }
    } catch {}
  }, [])

  // Fetch sessions filtered by team — using isolated API (Phase 7)
  const fetchSessionsForTeam = useCallback(async (teamName: string) => {
    try {
      const res = await fetch(`/api/smolab/sessions?mode=multi&teamName=${teamName}`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions || [])
      }
    } catch {}
  }, [])

  // Phase 7: Reset + reload sessions khi đổi Agent/Team
  useEffect(() => {
    // Reset chat khi đổi agent/team
    setMessages([])
    setCurrentSessionId('')
    setActiveTaskIds(new Map())
    setTaskPolling(false)
    setSessions([])

    // Load sessions cho agent/team mới
    if (chatMode === 'single' && selectedAgentId) {
      fetchSessionsForAgent(selectedAgentId)
    } else if (chatMode === 'multi' && selectedTeam) {
      fetchSessionsForTeam(selectedTeam)
    }
  }, [selectedAgentId, selectedTeam, chatMode, fetchSessionsForAgent, fetchSessionsForTeam])

  // Phase 6: Task polling — check mỗi 2 giây khi có task đang chạy
  useEffect(() => {
    if (!taskPolling || activeTaskIds.size === 0) return

    const pollInterval = setInterval(async () => {
      let anyRunning = false

      for (const [sessionId, taskId] of activeTaskIds) {
        try {
          const res = await fetch(`/api/smolab/tasks/${taskId}`)
          if (!res.ok) continue
          const data = await res.json()
          const task = data.task

          if (task.status === 'completed') {
            // Task xong → load messages mới
            const msgRes = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`)
            if (msgRes.ok) {
              const msgData = await msgRes.json()
              const loaded: SmolabMessage[] = msgData.messages.map((m: any) => ({
                id: m.id,
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content,
                timestamp: new Date(m.createdAt),
                model: m.model,
                provider: m.provider,
              }))
              setMessages(loaded)
            }

            // Remove khỏi tracking
            setActiveTaskIds(prev => {
              const next = new Map(prev)
              next.delete(sessionId)
              return next
            })

            // Toast nếu KHÔNG phải session hiện tại (task nền hoàn thành)
            if (sessionId !== currentSessionId) {
              sonnerToast.success('Task hoàn thành', {
                description: `Phiên "${sessionId.slice(0, 8)}..." đã xong`,
              })
            }

          } else if (task.status === 'failed') {
            if (sessionId === currentSessionId) {
              const errMsg: SmolabMessage = {
                id: `error_${Date.now()}`,
                role: 'error',
                content: `Lỗi: ${task.error || 'Unknown error'}`,
                timestamp: new Date(),
              }
              setMessages(prev => [...prev, errMsg])
            }

            setActiveTaskIds(prev => {
              const next = new Map(prev)
              next.delete(sessionId)
              return next
            })

          } else if (task.status === 'running' || task.status === 'pending') {
            anyRunning = true
          }
        } catch {
          // Ignore poll errors
        }
      }

      // Dừng polling nếu không còn task nào đang chạy
      if (!anyRunning) {
        setTaskPolling(false)
      }
    }, 2000) // Poll mỗi 2 giây

    return () => clearInterval(pollInterval)
  }, [taskPolling, activeTaskIds, currentSessionId])

  const createNewSession = useCallback(async () => {
    try {
      const body: Record<string, unknown> = { title: 'Cuộc trò chuyện mới', model: selectedModel }

      // Phase D: Include agent/team info in session creation
      if (chatMode === 'single' && selectedAgentId) {
        body.agentProfileId = selectedAgentId
        body.teamMode = 'single'
        const agent = smolabAgents.find((a: any) => a.id === selectedAgentId)
        if (agent) {
          body.model = agent.model
          body.provider = agent.provider
          body.title = agent.name
        }
      } else if (chatMode === 'multi' && selectedTeam) {
        body.teamName = selectedTeam
        body.teamMode = 'multi'
        const tl = smolabAgents.find((a: any) => a.team === selectedTeam && a.position === 'TL' && a.enabled)
        if (tl) {
          body.model = tl.model
          body.provider = tl.provider
          body.title = `Team ${selectedTeam === 'code' ? 'Code' : 'Research'}`
          body.agentProfileId = tl.id
        }
      }

      const res = await fetch('/api/openclaw/sessions?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping new session
        setCurrentSessionId(data.sessionId)
        setMessages([])
        // Refresh sessions list so the new session appears in the dropdown
        if (chatMode === 'single' && selectedAgentId) {
          fetchSessionsForAgent(selectedAgentId)
        } else if (chatMode === 'multi' && selectedTeam) {
          fetchSessionsForTeam(selectedTeam)
        } else {
          // No filter — reload all sessions
          try {
            const allRes = await fetch('/api/openclaw/sessions?action=list')
            if (allRes.ok) {
              const allData = await allRes.json()
              setSessions(allData.sessions || [])
            }
          } catch {}
        }
      }
    } catch {}
  }, [selectedModel, chatMode, selectedAgentId, selectedTeam, smolabAgents, fetchSessionsForAgent, fetchSessionsForTeam])

  // ===== SESSION RENAME & DELETE =====
  const renameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      const res = await fetch('/api/openclaw/sessions?action=rename', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, title: newTitle }),
      })
      if (res.ok) {
        // Update local sessions list immediately
        setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title: newTitle } : s))
        setRenamingSessionId(null)
        setRenameValue('')
      }
    } catch {}
  }, [])

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/openclaw/sessions?action=delete&sessionId=${sessionId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        // Remove from local list
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
        // If deleted the current session, reset
        if (currentSessionId === sessionId) {
          skipMessageLoadRef.current = true  // V1 FIX: skip useEffect on reset
          setCurrentSessionId('')
          setMessages([])
        }
      }
    } catch {}
  }, [currentSessionId])

  const startRenaming = useCallback((sessionId: string, currentTitle: string) => {
    setRenamingSessionId(sessionId)
    setRenameValue(currentTitle)
  }, [])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter' && renameValue.trim()) {
      renameSession(sessionId, renameValue.trim())
    } else if (e.key === 'Escape') {
      setRenamingSessionId(null)
      setRenameValue('')
    }
  }, [renameValue, renameSession])

  // Export session messages as JSON
  const exportSession = useCallback(async (sessionId: string, title: string) => {
    try {
      const res = await fetch(`/api/chat-messages?sessionId=${sessionId}`)
      if (!res.ok) throw new Error('Failed to fetch messages')
      const data = await res.json()
      const messages = (data.messages || []).map((msg: { role: string; content: string; createdAt?: string; timestamp?: string }) => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.createdAt || msg.timestamp || null,
      }))
      const exportData = {
        sessionTitle: title,
        sessionId,
        exportedAt: new Date().toISOString(),
        messages,
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const date = new Date().toISOString().slice(0, 10)
      const safeTitle = title.replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/g, '_').slice(0, 50)
      a.href = url
      a.download = `chat-export-${safeTitle}-${date}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      sonnerToast.success('Xuất phiên thành công', { description: `Đã xuất ${messages.length} tin nhắn` })
    } catch {
      sonnerToast.error('Xuất phiên thất bại', { description: 'Không thể tải tin nhắn từ phiên này' })
    }
  }, [])

  // ===== WORKFLOW TRIGGER (Critical Issues Resolution) =====
  // Keyword chính thức để khởi động workflow multi-agents: "tiến hành triển khai"
  // Không mở rộng thêm keywords — giữ đúng 1 keyword chính thức để rõ ràng và discoverable
  const WORKFLOW_TRIGGER_KEYWORD = 'tiến hành triển khai'

  function isWorkflowTrigger(text: string): boolean {
    const lower = text.toLowerCase().trim()
    return lower.includes(WORKFLOW_TRIGGER_KEYWORD)
  }

  const startWorkflow = useCallback(async (text: string, routing?: SmolabMessage['assessmentRouting'], options?: { skipUserMsg?: boolean }) => {
    // Auto-create session if none
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping in-flight messages
      setCurrentSessionId(sessionId)
    }

    // Add user message (skip if already added by TL Assessment flow)
    const userMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    if (!options?.skipUserMsg) {
      setMessages(prev => [...prev, userMsg])
    }
    setInput('')
    setIsLoading(true)

    // Add workflow start indicator
    const startMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '🔄 Code Team đang khởi động workflow...',
      timestamp: new Date(),
      isTeamMessage: true,
      agentName: 'SYSTEM',
      agentPosition: 'TL',
      agentAvatar: '👑',
    }
    setMessages(prev => [...prev, startMsg])

    try {
      // When skipUserMsg, user message already exists in messages state (from TL Assessment flow)
      const chatMessages = (options?.skipUserMsg ? messages : [...messages, userMsg])
        .filter((m: SmolabMessage) => m.role === 'user' || m.role === 'assistant')
        .map((m: SmolabMessage) => ({ role: m.role, content: m.content }))

      const workflowBody: Record<string, unknown> = {
        messages: chatMessages,
        sessionId,
        userRequest: text,
      }
      // Phase 3: Pass pre-computed routing from TL Assessment if available
      if (routing) {
        workflowBody.routing = routing
      }

      const res = await fetch('/api/code-team/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflowBody),
      })

      if (!res.ok) {
        throw new Error(`Workflow API error: ${res.status}`)
      }

      if (!res.body) {
        throw new Error('No response body')
      }

      // Read SSE stream
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentAgentMsgId: string | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          // Skip heartbeat lines
          if (trimmed.startsWith(':')) continue

          // Parse SSE data lines
          if (!trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6)
          let event: Record<string, unknown>
          try {
            event = JSON.parse(jsonStr)
          } catch {
            continue
          }

          const eventType = event.type as string

          // Phase 7: re-dispatch AI tool events on the window so CodeTabContent
          // can react (auto-open file / terminal echo / preview auto-open).
          // Defensive — NEVER break the SSE loop.
          if (eventType === 'tool_call' || eventType === 'tool_result') {
            try {
              window.dispatchEvent(new CustomEvent(AI_TOOL_EVENT_NAME, {
                detail: {
                  type: eventType,
                  tool: event.tool,
                  detail: typeof event.detail === 'string' ? event.detail : undefined,
                  result: typeof event.result === 'string' ? event.result : undefined,
                },
              }))
            } catch { /* never break the stream */ }
          }

          switch (eventType) {
            case 'workflow_start': {
              // Update the start indicator message
              setMessages(prev => prev.map(m =>
                m.id === startMsg.id
                  ? { ...m, content: `🚀 Code Team workflow đã bắt đầu (Session: ${(event.sessionId as string || '').slice(0, 8)}...)` }
                  : m
              ))
              break
            }

            case 'agent_start': {
              const agentName = event.agent as string
              const agentPosition = event.position as string
              const agentAvatar = event.avatar as string
              const agentMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '',
                timestamp: new Date(),
                isTeamMessage: true,
                agentName,
                agentPosition,
                agentAvatar,
              }
              currentAgentMsgId = agentMsg.id
              setMessages(prev => [...prev, agentMsg])
              break
            }

            case 'agent_chunk': {
              if (!currentAgentMsgId) break
              // REPLACE content (not append) — each ReAct iteration returns FULL LLM output,
              // not incremental deltas. Appending would duplicate text across iterations.
              const chunkContent = event.content as string
              setMessages(prev => prev.map(m =>
                m.id === currentAgentMsgId
                  ? { ...m, content: chunkContent }
                  : m
              ))
              break
            }

            case 'agent_complete': {
              if (!currentAgentMsgId) break
              const completeContent = event.content as string
              const duration = event.duration as number | undefined
              setMessages(prev => prev.map(m =>
                m.id === currentAgentMsgId
                  ? { ...m, content: completeContent || m.content, durationMs: duration }
                  : m
              ))
              currentAgentMsgId = null
              break
            }

            case 'tool_call': {
              const toolAgentName = event.agent as string
              const toolAgentPosition = event.position as string
              const toolName = event.tool as string
              const toolDetail = event.detail as string
              const toolMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                // Phase 7: rich bubble — 📖 file / ✏️ edit / ▶️ command
                content: formatToolBubble(toolName, toolDetail),
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: toolAgentName,
                agentPosition: toolAgentPosition,
                agentAvatar: '🔧',
                toolCallInfo: { tool: toolName, detail: toolDetail || '' },
              }
              setMessages(prev => [...prev, toolMsg])
              break
            }

            case 'tool_result': {
              // Handled by the Phase 7 window event bridge above
              // (AI_TOOL_EVENT_NAME) — CodeTabContent refreshes the file tree /
              // editor / preview panel from there.
              break
            }

            case 'checkpoint': {
              const checkpointStep = event.step as string
              const checkpointDecision = event.decision as string | undefined
              const checkpointReasoning = event.reasoning as string | undefined
              const checkpointMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `📋 Checkpoint: Step ${checkpointStep}${checkpointDecision ? ` → ${checkpointDecision}` : ''}${checkpointReasoning ? `\n${checkpointReasoning}` : ''}`,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: 'CHECKPOINT',
                agentPosition: 'TL',
                agentAvatar: '📋',
              }
              setMessages(prev => [...prev, checkpointMsg])
              break
            }

            case 'workflow_done': {
              const totalDuration = event.totalDuration as number | undefined
              const doneMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `✅ Workflow hoàn thành!${totalDuration ? ` (${(totalDuration / 1000).toFixed(1)}s)` : ''}`,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: 'SYSTEM',
                agentPosition: 'TL',
                agentAvatar: '✅',
              }
              setMessages(prev => [...prev, doneMsg])
              break
            }

            case 'iteration': {
              // ReAct loop iteration progress — update current agent message with iteration indicator
              if (currentAgentMsgId) {
                const iterNum = event.iteration as number | undefined
                const maxIter = event.maxIterations as number | undefined
                const iterText = maxIter ? ` (Vòng ${iterNum}/${maxIter})` : ` (Vòng ${iterNum})`
                setMessages(prev => prev.map(m =>
                  m.id === currentAgentMsgId
                    ? { ...m, iterationInfo: iterText }
                    : m
                ))
              }
              break
            }

            case 'error': {
              const errorMsg = event.message as string
              const errorAgent = event.agent as string | undefined
              const errMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'error',
                content: `❌ Workflow Error${errorAgent ? ` (${errorAgent})` : ''}: ${errorMsg}`,
                timestamp: new Date(),
              }
              setMessages(prev => [...prev, errMsg])
              break
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const errMsg: SmolabMessage = {
        id: crypto.randomUUID(),
        role: 'error',
        content: `❌ Workflow failed: ${errorMsg}`,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, errMsg])
    } finally {
      setIsLoading(false)
    }
  }, [messages, currentSessionId, setCurrentSessionId, setMessages, setInput, setIsLoading])

  const sendMessage = useCallback(async (queryText?: string) => {
    const text = queryText || input.trim()
    if (!text || isLoading) return

    // === WORKFLOW TRIGGER (Critical Issues Resolution) ===
    // Cách 1: Keyword shortcut — "tiến hành triển khai" → trigger trực tiếp (backward compat)
    if (chatMode === 'multi' && selectedTeam === 'code' && isWorkflowTrigger(text)) {
      await startWorkflow(text)
      return
    }

    // === Cách 2: Smart TL Assessment (Phase 3 — C2 Resolution) ===
    // Khi multi mode + team code → gọi TL Assessment để đánh giá request
    // - CODE_TEAM → Hiển thị Suggestion Card (user chấp nhận/từ chối)
    // - SIMPLE → Chat bình thường (TL có thể trả lời trực tiếp)
    if (chatMode === 'multi' && selectedTeam === 'code') {
      // Add user message first
      const userMsg: SmolabMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, userMsg])
      if (!queryText) setInput('')
      setIsLoading(true)

      try {
        // Call TL Assessment API
        const recentHistory = [...messages, userMsg]
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map(m => ({ role: m.role, content: m.content }))

        const assessRes = await fetch('/api/code-team/assess', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, chatHistory: recentHistory }),
        })

        if (!assessRes.ok) {
          throw new Error(`Assessment API error: ${assessRes.status}`)
        }

        const { assessment, isDirectTrigger } = await assessRes.json()

        // Direct trigger — should not normally reach here (caught by isWorkflowTrigger above),
        // but handle it as safety net
        if (isDirectTrigger) {
          await startWorkflow(text)
          return
        }

        if (assessment.decision === 'CODE_TEAM') {
          // TL suggests Code Team workflow → Show Suggestion Card
          // Build parts based on routing mode (matching assessmentToRoutingDecision in tl-bridge.ts)
          const routingMode = assessment.routing?.mode || 'B'
          let parts: NonNullable<SmolabMessage['assessmentRouting']>['parts']
          if (routingMode === 'A') {
            // Pure Visual
            parts = [{ name: 'visual', type: 'visual' as const, description: text, dependency: [] }]
          } else if (routingMode === 'C') {
            // Hybrid — visual + backend
            parts = [
              { name: 'visual', type: 'visual' as const, description: `Phần giao diện UI/UX: ${text}`, dependency: [] },
              { name: 'backend', type: 'backend' as const, description: `Phần backend/logic: ${text}`, dependency: ['visual'] },
            ]
          } else {
            // Pure Backend (Mode B)
            parts = [{ name: 'backend', type: 'backend' as const, description: text, dependency: [] }]
          }

          const assessmentRouting: SmolabMessage['assessmentRouting'] = assessment.routing
            ? {
                mode: assessment.routing.mode,
                tier: assessment.routing.tier,
                score: assessment.routing.score,
                reasoning: assessment.routing.reasoning || '',
                parts,
                spec: text,
              }
            : undefined

          const suggestionMsg: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isTeamMessage: true,
            agentName: 'APEX',
            agentPosition: 'TL',
            agentAvatar: '👑',
            isWorkflowSuggestion: true,
            suggestionText: assessment.suggestion || 'APEX đề xuất sử dụng Code Team để xử lý yêu cầu này.',
            routingMode: assessment.routing?.mode,
            routingTier: assessment.routing?.tier,
            routingScore: assessment.routing?.score,
            assessmentRouting: assessmentRouting,
          }
          setMessages(prev => [...prev, suggestionMsg])
        } else {
          // SIMPLE → TL can answer directly or show normal chat
          const tlAnswer: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assessment.directAnswer || assessment.reasoning || 'Tôi hiểu yêu cầu của bạn. Bạn có thể hỏi thêm chi tiết hoặc sử dụng "tiến hành triển khai" để khởi động Code Team.',
            timestamp: new Date(),
            isTeamMessage: true,
            agentName: 'APEX',
            agentPosition: 'TL',
            agentAvatar: '👑',
          }
          setMessages(prev => [...prev, tlAnswer])
        }
      } catch (err) {
        // Assessment failed → show error, suggest keyword fallback
        const errMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'error',
          content: `⚠️ Không thể đánh giá yêu cầu. ${err instanceof Error ? err.message : 'Lỗi không xác định'}. Bạn có thể dùng "tiến hành triển khai" để khởi động Code Team trực tiếp.`,
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, errMsg])
      } finally {
        setIsLoading(false)
      }
      return // Always return after TL Assessment flow (success or failure)
    }

    // Auto-create session if none
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping in-flight messages
      setCurrentSessionId(sessionId)
    }

    const userMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, userMsg])
    if (!queryText) setInput('')
    setIsLoading(true)

    // Add tool call indicator
    const toolMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'tool_call',
      content: 'Đang tìm kiếm Knowledge Base...',
      timestamp: new Date(),
      toolName: 'knowledge_search',
    }
    setMessages(prev => [...prev, toolMsg])

    try {
      const chatMessages = [...messages, userMsg]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))

      // Build chat request body with optional agent injection
      const chatBody: Record<string, unknown> = {
        messages: chatMessages,
        model: selectedModel,
        sessionId,
        stream: false,
      }

      // Phase D: Inject agent instruction
      if (chatMode === 'single' && selectedAgentId) {
        const agent = smolabAgents.find((a: any) => a.id === selectedAgentId)
        if (agent) {
          chatBody.agentInstruction = agent.instruction
          chatBody.agentTemperature = agent.temperature
          chatBody.agentMaxTokens = agent.maxTokens
          chatBody.agentProfileId = agent.id
          chatBody.agentProfileName = agent.name
          chatBody.agentProvider = agent.provider
          chatBody.agentModel = agent.model
          chatBody.teamMode = 'single'
          chatBody.model = agent.model
        }
      } else if (chatMode === 'multi' && selectedTeam) {
        const tl = smolabAgents.find((a: any) => a.team === selectedTeam && a.position === 'TL' && a.enabled)
        if (tl) {
          chatBody.agentInstruction = tl.instruction
          chatBody.agentTemperature = tl.temperature
          chatBody.agentMaxTokens = tl.maxTokens
          chatBody.agentProfileId = tl.id
          chatBody.agentProfileName = tl.name
          chatBody.agentProvider = tl.provider
          chatBody.agentModel = tl.model
          chatBody.teamMode = 'multi'
          chatBody.teamName = selectedTeam
          chatBody.model = tl.model
        }
      }

      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody),
      })

      if (!res.ok) throw new Error(`Chat API error: ${res.status}`)

      const data = await res.json()

      // Remove tool call indicator and add real response
      setMessages(prev => {
        const withoutTool = prev.filter(m => m.id !== toolMsg.id)
        
        // OC-3.2: If routed to OpenCode, show progress messages
        if (data.routedTo === 'opencode') {
          const progressMsg: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'opencode_progress',
            content: data.content || 'OpenCode session đã được tạo',
            timestamp: new Date(),
            model: data.model,
            provider: data.provider,
            opencodeSessionId: data.opencodeSessionId,
            enrichment: data.enrichment,
          }
          return [...withoutTool, progressMsg]
        }
        
        const assistantMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.content || 'Không thể tạo câu trả lời.',
          timestamp: new Date(),
          model: data.model,
          provider: data.provider,
          sources: data.sources,
          confidence: data.confidence,
        }
        return [...withoutTool, assistantMsg]
      })
    } catch (err) {
      setMessages(prev => {
        const withoutTool = prev.filter(m => m.id !== toolMsg.id)
        return [...withoutTool, {
          id: crypto.randomUUID(),
          role: 'error',
          content: `Lỗi: ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: new Date(),
        }]
      })
    }
    setIsLoading(false)
  }, [input, isLoading, messages, selectedModel, currentSessionId, chatMode, selectedAgentId, selectedTeam, smolabAgents, startWorkflow])

  const handleFeedback = useCallback(async (messageId: string, type: 'positive' | 'negative', msgContent: string) => {
    setFeedbackLoading(messageId)
    try {
      const userMsg = messages.find(m => m.role === 'user' && messages.indexOf(m) < messages.findIndex(m2 => m2.id === messageId))
      await fetch('/api/openclaw/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          messageId,
          sessionId: currentSessionId,
          content: userMsg?.content || '',
          agentResponse: msgContent,
        }),
      })
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, feedback: type } : m))
      toast({ title: type === 'positive' ? '👍 Cảm ơn phản hồi!' : '👎 Đã ghi nhận góp ý', description: type === 'positive' ? 'Phản hồi giúp Agent cải thiện' : 'Agent sẽ học từ góp ý này', duration: 2000 })
    } catch {}
    setFeedbackLoading(null)
  }, [messages, currentSessionId])

  // V1/V6 FIX: Clear chat resets to empty session (no need to delete server-side messages — user may want to revisit them)
  const clearChat = useCallback(() => {
    skipMessageLoadRef.current = true  // V1 FIX: skip useEffect on clear
    setMessages([])
    setCurrentSessionId('')
  }, [])

  // Get provider display name from model id
  const getModelDisplay = useCallback((modelId: string) => {
    for (const group of SMOLAB_MODEL_GROUPS) {
      const found = group.models.find(m => m.id === modelId)
      if (found) return `${group.icon} ${found.label}`
    }
    return modelId
  }, [])

  // ==================== RENDER ====================
  // Absolute positioning relative to body div (which is already below the header)
  // effectiveTop = distance from body div top to module top edge
  const moduleStyle: React.CSSProperties = {
    position: 'absolute',
    top: effectiveTop + 'px',
    left: effectiveLeft + 'px',
    right: effectiveRight + 'px',
    height: smolabHeight !== null ? smolabHeight + 'px' : `calc(100vh - ${HEADER_HEIGHT + effectiveTop}px)`,
    minHeight: MIN_MODULE_HEIGHT + 'px',
    zIndex: 15, // Above sidebar (z-10)
  }

  return (
    <div
      ref={smolabOuterRef}
      className="relative"
      style={moduleStyle}
    >
      {/* ===== LEFT OUTER EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute left-0 top-3 bottom-4 w-3 cursor-col-resize group z-20 transition-colors duration-150"
        onMouseDown={handleLeftEdgeMouseDown}
        title="Kéo để thay đổi lề trái"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-y-0 -left-1 -right-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-y-0 right-0 w-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== RIGHT OUTER EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute right-0 top-3 bottom-4 w-3 cursor-col-resize group z-20 transition-colors duration-150"
        onMouseDown={handleRightEdgeMouseDown}
        title="Kéo để thay đổi lề phải"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-y-0 -right-1 -left-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 top-0 bottom-0 w-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-y-0 left-0 w-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== TOP EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute top-0 left-3 right-3 h-3 cursor-row-resize group z-20 transition-colors duration-150"
        onMouseDown={handleTopEdgeMouseDown}
        title="Kéo để thay đổi lề trên"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-0 -top-1 -bottom-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 right-0 bottom-0 h-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-x-0 bottom-0 h-1.5 flex items-center justify-center">
          <div className="flex items-center gap-1">
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== BOTTOM EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute bottom-0 left-3 right-3 h-3 cursor-row-resize group z-20 transition-colors duration-150"
        onMouseDown={handleBottomEdgeMouseDown}
        title="Kéo để thay đổi chiều cao"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-0 -top-2 -bottom-1 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 right-0 top-0 h-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-x-0 top-0 h-1.5 flex items-center justify-center">
          <div className="flex items-center gap-1">
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== MAIN CONTENT AREA ===== */}
      <div ref={smolabContainerRef} className="flex h-full min-h-[200px]">
      {/* ===== LEFT: Chat Panel (resizable) ===== */}
      <div className="flex flex-col flex-shrink-0" style={{ width: chatPanelWidth + 'px', minWidth: '280px' }}>
        <div className="nc-wrap nc-cyan flex flex-col h-full">
          <div className="nc-panel nc-md nc-border-cyan flex flex-col h-full overflow-hidden">

            {/* Agent Header */}
            <div className="flex-shrink-0 p-3 border-b border-cyan-400/35">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {/* Mode Toggle Button — click to switch Single/Multi */}
                  <button
                    onClick={() => {
                      const newMode = chatMode === 'single' ? 'multi' : 'single'
                      setChatMode(newMode)
                      setSelectedAgentId(null)
                      setSelectedTeam(null)
                      setMessages([])
                      skipMessageLoadRef.current = true
                      setCurrentSessionId('')
                      setSessions([])
                      setActiveTaskIds(new Map())
                      setTaskPolling(false)
                    }}
                    className="p-1.5 bg-gradient-to-br from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 transition-colors"
                    title={chatMode === 'single' ? 'Chuyển sang Multi (Team) mode' : 'Chuyển sang Single mode'}
                  >
                    {chatMode === 'single' 
                      ? <User className="h-4 w-4 text-white" /> 
                      : <Users className="h-4 w-4 text-white" />
                    }
                  </button>
                  <div>
                    <span className="text-sm font-semibold text-stone-100">
                      {chatMode === 'single' && selectedAgentId
                        ? (() => { const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId); return a ? `${a.avatar} ${a.name}` : 'OpenClaw Agent' })()
                        : chatMode === 'multi' && selectedTeam
                        ? (selectedTeam === 'code' ? '💻 Code' : '🔬 Research')
                        : 'OpenClaw Agent'
                      }
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className={`w-2 h-2 ${gatewayOnline ? 'bg-emerald-400' : 'bg-stone-500'} animate-pulse`} />
                      <span className="text-[9px] text-stone-400">{gatewayOnline ? 'Online' : 'Offline'}</span>
                      <span className="text-[9px] text-stone-500 ml-1">• {chatMode === 'single' ? 'Single' : 'Multi'}</span>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-stone-400 hover:text-amber-400" onClick={clearChat} title="Xóa chat">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Single Mode — Agent Selector + Session Selector */}
              {chatMode === 'single' && (
                <div className="flex gap-2">
                  {/* Agent Selector — LUÔN hiển thị, highlight khi chưa chọn (Phase 5) */}
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowAgentSelect(!showAgentSelect); setShowSessionSelect(false); setShowTeamSelect(false) }}
                      className={`chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors ${!selectedAgentId ? 'border-cyan-500/70 bg-cyan-950/30' : 'border-cyan-400/40 bg-slate-950/50 hover:border-cyan-500/40'} border`}
                    >
                      <span className="text-stone-300 truncate">
                        {selectedAgentId
                          ? (() => { const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId); return a ? `${a.avatar} ${a.name}` : '🔧 Chọn Agent' })()
                          : '🔧 Chọn Agent'
                        }
                      </span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showAgentSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-cyan-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {/* Đề xuất 1 (2026-08-25): Single mode liệt kê TẤT CẢ agents — nhóm theo
                            "Độc lập" / "💻 Team Code" / "🔬 Team Research" — để user chat 1-1 với
                            bất kỳ agent nào (BOLT, CORTEX...) cho task nhỏ nhanh, không cần
                            khởi động workflow multi-agent. Chat flow đã generic theo selectedAgentId. */}
                        {(() => {
                          const enabledAgents = smolabAgents.filter((a: any) => a.enabled)
                          const standalone = enabledAgents.filter((a: any) => !a.team)
                          const codeTeam = enabledAgents.filter((a: any) => a.team === 'code')
                          const researchTeam = enabledAgents.filter((a: any) => a.team === 'research')
                          const renderAgent = (agent: any, suffix?: string) => (
                            <button key={agent.id}
                              onClick={() => {
                                setSelectedAgentId(agent.id)
                                setShowAgentSelect(false)
                                setSelectedModel(agent.model)
                                // useEffect on selectedAgentId will handle messages/session reset + session fetch
                              }}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-cyan-500/10 transition-colors ${selectedAgentId === agent.id ? 'text-cyan-400' : 'text-stone-300'}`}
                            >
                              {agent.avatar} {agent.name}
                              <span className="text-stone-500 ml-1">({(agent.model || '').split('/').pop() || agent.provider})</span>
                              {suffix && <span className="text-stone-600 ml-1">{suffix}</span>}
                            </button>
                          )
                          return (
                            <>
                              {standalone.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-cyan-500/70 border-b border-cyan-400/20">Độc lập</div>
                                  {standalone.map((a: any) => renderAgent(a))}
                                </>
                              )}
                              {codeTeam.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-amber-500/70 border-b border-amber-400/20 border-t border-t-amber-400/10 mt-1">💻 Team Code — chat 1-1</div>
                                  {codeTeam.map((a: any) => renderAgent(a, a.position ? `• ${a.position}` : undefined))}
                                </>
                              )}
                              {researchTeam.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-violet-400/70 border-b border-violet-400/20 border-t border-t-violet-400/10 mt-1">🔬 Team Research — chat 1-1</div>
                                  {researchTeam.map((a: any) => renderAgent(a, a.position ? `• ${a.position}` : undefined))}
                                </>
                              )}
                            </>
                          )
                        })()}
                        {agentsLoadError && (
                          <div className="px-3 py-2 text-xs text-red-400">
                            <AlertTriangle className="h-3 w-3 inline mr-1" />
                            {agentsLoadError}
                            <button onClick={() => { fetch('/api/agents?enabled=true').then(r => r.ok ? r.json() : Promise.reject()).then(d => setSmolabAgents(d.agents || [])).catch(() => {}) }} className="ml-2 text-cyan-400 hover:underline">Thử lại</button>
                          </div>
                        )}
                        {!agentsLoadError && smolabAgents.filter((a: any) => a.enabled).length === 0 && (
                          <div className="px-3 py-2 text-xs text-stone-500">Chưa có Agent nào. Tạo Agent trong tab Agents.</div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Session Selector (Single) — CHỈ hiện khi đã chọn Agent (Phase 5) */}
                  {selectedAgentId ? (
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowSessionSelect(!showSessionSelect); setShowAgentSelect(false); setShowTeamSelect(false) }}
                      className="chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs border border-cyan-400/40 bg-slate-950/50 hover:border-cyan-500/40 transition-colors"
                    >
                      <span className="text-stone-300 truncate">{currentSessionId ? (sessions.find((s: SmolabSession) => s.sessionId === currentSessionId)?.title || `Phiên ${currentSessionId.slice(0, 8)}...`) : '💬 Phiên chat'}</span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showSessionSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-cyan-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        <div className="px-2 py-1.5 border-b border-cyan-400/20">
                          <div className="flex items-center gap-1.5 bg-slate-900/80 rounded px-2 py-1">
                            <Search className="h-3 w-3 text-stone-500 flex-shrink-0" />
                            <input
                              type="text"
                              value={sessionSearchQuery}
                              onChange={(e) => setSessionSearchQuery(e.target.value)}
                              placeholder="Tìm phiên..."
                              className="flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => { createNewSession(); setShowSessionSelect(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-2"
                        >
                          <Plus className="h-3 w-3" /> Tạo phiên mới
                        </button>
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .length === 0 && sessionSearchQuery && (
                          <div className="px-3 py-2 text-xs text-stone-500 text-center">Không tìm thấy phiên nào</div>
                        )}
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .map((s: SmolabSession) => (
                          <div key={s.sessionId}
                            className={`flex items-center gap-1 px-2 py-1 text-xs hover:bg-cyan-500/10 transition-colors ${currentSessionId === s.sessionId ? 'bg-cyan-500/5' : ''}`}
                          >
                            {renamingSessionId === s.sessionId ? (
                              <div className="flex-1 flex items-center gap-1 min-w-0">
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => handleRenameKeyDown(e, s.sessionId)}
                                  onBlur={() => renameSession(s.sessionId, renameValue.trim() || s.title)}
                                  className="flex-1 min-w-0 bg-slate-800 border border-cyan-500/40 rounded px-1.5 py-0.5 text-xs text-stone-200 outline-none focus:border-cyan-400"
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            ) : (
                              <button
                                onClick={() => { setCurrentSessionId(s.sessionId); setShowSessionSelect(false) }}
                                className={`flex-1 min-w-0 text-left truncate ${currentSessionId === s.sessionId ? 'text-cyan-400' : 'text-stone-300'}`}
                              >
                                {s.title} <span className="text-stone-500">({s.messageCount})</span>
                                {s.tasks && s.tasks.length > 0 && (
                                  <span className="flex items-center gap-0.5 ml-1 text-amber-400">
                                    <Zap className="h-3 w-3" />
                                    <span className="text-[9px]">{s.tasks.length}</span>
                                  </span>
                                )}
                              </button>
                            )}
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); exportSession(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-emerald-400 transition-colors"
                                title="Xuất phiên"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startRenaming(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-cyan-400 transition-colors"
                                title="Đổi tên"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId) }}
                                className="p-0.5 text-stone-500 hover:text-red-400 transition-colors"
                                title="Xóa phiên"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center px-2.5 py-1.5 text-xs text-cyan-500/50 border border-cyan-400/15 bg-slate-950/30">
                      Chọn Agent để xem phiên
                    </div>
                  )}
                </div>
              )}

              {/* Multi Mode — Team Selector + Session Selector */}
              {chatMode === 'multi' && (
                <div className="flex gap-2">
                  {/* Team Selector — LUÔN hiển thị, highlight khi chưa chọn (Phase 5) */}
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowTeamSelect(!showTeamSelect); setShowSessionSelect(false); setShowAgentSelect(false) }}
                      className={`chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors ${!selectedTeam ? 'border-amber-500/70 bg-amber-950/30' : 'border-amber-400/40 bg-slate-950/50 hover:border-amber-500/40'} border`}
                    >
                      <span className="text-stone-300 truncate">
                        {selectedTeam ? (selectedTeam === 'code' ? '💻 Code' : '🔬 Research') : '👥 Chọn Team'}
                      </span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showTeamSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-amber-400/50">
                        <button
                          onClick={() => { setSelectedTeam('code'); setShowTeamSelect(false) }}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors ${selectedTeam === 'code' ? 'text-amber-400' : 'text-stone-300'}`}
                        >
                          💻 Code
                          <span className="text-stone-500 ml-1">({smolabAgents.filter((a: any) => a.team === 'code' && a.enabled).length} agents)</span>
                          <div className="flex gap-1 mt-1">
                            {smolabAgents.filter((a: any) => a.team === 'code' && a.enabled).map((a: any) => (
                              <span key={a.id} className="text-[9px] text-stone-500">{a.avatar} {a.position}</span>
                            ))}
                          </div>
                        </button>
                        <button
                          onClick={() => { setSelectedTeam('research'); setShowTeamSelect(false) }}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors ${selectedTeam === 'research' ? 'text-amber-400' : 'text-stone-300'}`}
                        >
                          🔬 Research
                          <span className="text-stone-500 ml-1">({smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).length} agents)</span>
                          {/* Audit fix 2026-08-25: cảnh báo team trống ngay trong dropdown — tránh chọn team không có agent rồi chat vô ích */}
                          {smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).length === 0 && (
                            <div className="text-[9px] text-amber-500/80 mt-0.5">⚠️ Chưa có agent — tạo trong tab Agents</div>
                          )}
                          <div className="flex gap-1 mt-1">
                            {smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).map((a: any) => (
                              <span key={a.id} className="text-[9px] text-stone-500">{a.avatar} {a.position}</span>
                            ))}
                          </div>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Session Selector (Multi) — CHỈ hiện khi đã chọn Team (Phase 5) */}
                  {selectedTeam ? (
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowSessionSelect(!showSessionSelect); setShowTeamSelect(false); setShowAgentSelect(false) }}
                      className="chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs border border-amber-400/40 bg-slate-950/50 hover:border-amber-500/40 transition-colors"
                    >
                      <span className="text-stone-300 truncate">{currentSessionId ? (sessions.find((s: SmolabSession) => s.sessionId === currentSessionId)?.title || `Phiên ${currentSessionId.slice(0, 8)}...`) : '💬 Phiên chat'}</span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showSessionSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-amber-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        <div className="px-2 py-1.5 border-b border-amber-400/20">
                          <div className="flex items-center gap-1.5 bg-slate-900/80 rounded px-2 py-1">
                            <Search className="h-3 w-3 text-stone-500 flex-shrink-0" />
                            <input
                              type="text"
                              value={sessionSearchQuery}
                              onChange={(e) => setSessionSearchQuery(e.target.value)}
                              placeholder="Tìm phiên..."
                              className="flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => { createNewSession(); setShowSessionSelect(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-2"
                        >
                          <Plus className="h-3 w-3" /> Tạo phiên mới
                        </button>
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .length === 0 && sessionSearchQuery && (
                          <div className="px-3 py-2 text-xs text-stone-500 text-center">Không tìm thấy phiên nào</div>
                        )}
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .map((s: SmolabSession) => (
                          <div key={s.sessionId}
                            className={`flex items-center gap-1 px-2 py-1 text-xs hover:bg-amber-500/10 transition-colors ${currentSessionId === s.sessionId ? 'bg-amber-500/5' : ''}`}
                          >
                            {renamingSessionId === s.sessionId ? (
                              <div className="flex-1 flex items-center gap-1 min-w-0">
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => handleRenameKeyDown(e, s.sessionId)}
                                  onBlur={() => renameSession(s.sessionId, renameValue.trim() || s.title)}
                                  className="flex-1 min-w-0 bg-slate-800 border border-amber-500/40 rounded px-1.5 py-0.5 text-xs text-stone-200 outline-none focus:border-amber-400"
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            ) : (
                              <button
                                onClick={() => { setCurrentSessionId(s.sessionId); setShowSessionSelect(false) }}
                                className={`flex-1 min-w-0 text-left truncate ${currentSessionId === s.sessionId ? 'text-amber-400' : 'text-stone-300'}`}
                              >
                                {s.title} <span className="text-stone-500">({s.messageCount})</span>
                                {s.tasks && s.tasks.length > 0 && (
                                  <span className="flex items-center gap-0.5 ml-1 text-amber-400">
                                    <Zap className="h-3 w-3" />
                                    <span className="text-[9px]">{s.tasks.length}</span>
                                  </span>
                                )}
                              </button>
                            )}
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); exportSession(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-emerald-400 transition-colors"
                                title="Xuất phiên"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startRenaming(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-amber-400 transition-colors"
                                title="Đổi tên"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId) }}
                                className="p-0.5 text-stone-500 hover:text-red-400 transition-colors"
                                title="Xóa phiên"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center px-2.5 py-1.5 text-xs text-amber-500/50 border border-amber-400/15 bg-slate-950/30">
                      Chọn Team để xem phiên
                    </div>
                  )}
                </div>
              )}

              {/* Agent/Team model indicator */}
              {((chatMode === 'single' && selectedAgentId) || (chatMode === 'multi' && selectedTeam)) && (
                <div className="mt-2 px-2.5 py-1.5 text-[10px] text-stone-500 bg-slate-950/30 border border-stone-700/20">
                  {chatMode === 'single' && selectedAgentId && (() => {
                    const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId)
                    return a ? `🤖 Model: ${a.model} (${a.provider}) • T: ${a.temperature} • 📦 ${a.maxTokens} tokens` : ''
                  })()}
                  {chatMode === 'multi' && selectedTeam && (() => {
                    const tl = smolabAgents.find((ag: any) => ag.team === selectedTeam && ag.position === 'TL' && ag.enabled)
                    return tl ? `👥 TL Model: ${tl.model} (${tl.provider}) • T: ${tl.temperature} • 📦 ${tl.maxTokens} tokens` : `⚠️ Team ${selectedTeam === 'code' ? 'Code' : 'Research'} chưa có Team Lead (TL)`
                  })()}
                </div>
              )}
            </div>

            {/* Messages List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ scrollbarWidth: 'thin' }}>
              {loadingMessages ? (
                /* V1 FIX: Loading indicator while fetching session messages */
                <div className="flex items-center justify-center h-full py-8">
                  <div className="flex items-center gap-2 text-stone-400">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                    <span className="text-xs">Đang tải tin nhắn...</span>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                /* Welcome Screen */
                <div className="flex flex-col items-center justify-center h-full text-center py-8">
                  <div className="p-4 bg-gradient-to-br from-emerald-900/30 to-teal-900/30 border border-emerald-400/35 mb-4">
                    <Sparkles className="h-10 w-10 text-amber-400" />
                  </div>
                  <h3 className="text-base font-bold text-stone-200 mb-1" style={{ fontFamily: "'Cormorant Infant', 'Georgia', serif" }}>
                    {chatMode === 'single' ? 'Single Agent Chat' : 'Multi Agent Team'}
                  </h3>
                  <p className="text-xs text-stone-400 max-w-[240px] mb-4">
                    {chatMode === 'single'
                      ? 'Chọn một Agent để bắt đầu trò chuyện với AI Agent chuyên biệt.'
                      : 'Chọn một Team để các Agents phối hợp làm việc.'}
                  </p>
                  <div className="flex items-center gap-1.5 mb-4">
                    <div className={`w-2 h-2 ${gatewayOnline ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <span className="text-[10px] text-stone-400">Gateway {gatewayOnline ? 'Online' : 'Offline — Mock Mode'}</span>
                  </div>
                  <div className="flex flex-col gap-2 w-full">
                    {SMOLAB_SUGGESTIONS.map(q => (
                      <button
                        key={q}
                        onClick={() => sendMessage(q)}
                        className="chamfer-sm text-xs px-3 py-2 border border-cyan-400/35 bg-slate-950/50 text-stone-300 hover:border-emerald-300 hover:bg-emerald-900/30 hover:text-emerald-400 transition-colors text-left"
                      >
                        💬 {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* Message Bubbles */
                messages.map(msg => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2`}>
                    {/* Bot icon for assistant/tool/error/opencode — team messages use agent avatar */}
                    {(msg.role === 'assistant' || msg.role === 'tool_call' || msg.role === 'error' || msg.role === 'opencode_progress' || msg.role === 'opencode_result') && (
                      <div className={`flex-shrink-0 w-6 h-6 flex items-center justify-center mt-0.5 ${
                        msg.isTeamMessage && msg.agentName
                          ? (AGENT_COLORS[msg.agentName]?.bg || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.bg : undefined) || 'bg-gradient-to-br from-emerald-900 to-teal-900')
                          : 'bg-gradient-to-br from-emerald-900 to-teal-900'
                      }`}>
                        {msg.isTeamMessage && msg.agentAvatar ? (
                          <span className="text-xs leading-none">{msg.agentAvatar}</span>
                        ) : msg.role === 'tool_call' ? <Search className="h-3 w-3 text-cyan-400" /> :
                         msg.role === 'error' ? <AlertCircle className="h-3 w-3 text-red-400" /> :
                         msg.role === 'opencode_progress' ? <Code2 className="h-3 w-3 text-emerald-400" /> :
                         msg.role === 'opencode_result' ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> :
                         <Brain className="h-3 w-3 text-emerald-400" />}
                      </div>
                    )}

                    {/* Team agent message rendering */}
                    {msg.isTeamMessage && msg.agentName ? (
                      <div className={`max-w-[85%] p-3 rounded-xl border ${
                        AGENT_COLORS[msg.agentName]?.border || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.border : undefined) || 'border-cyan-400/35'
                      } ${
                        AGENT_COLORS[msg.agentName]?.bg || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.bg : undefined) || 'bg-slate-950/50'
                      }`}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-sm">{msg.agentAvatar || '🤖'}</span>
                          <span className={`font-semibold text-xs ${
                            AGENT_COLORS[msg.agentName]?.text || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.text : undefined) || 'text-stone-200'
                          }`}>
                            {msg.agentName}
                          </span>
                          {msg.agentPosition && <span className="text-[9px] text-stone-400">({msg.agentPosition})</span>}
                          {msg.iterationInfo && <span className="text-[9px] text-amber-400/80 ml-1">{msg.iterationInfo}</span>}
                          <span className="text-[9px] text-stone-500 ml-auto">
                            {msg.timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {/* Phase 3: Workflow Suggestion Card */}
                        {msg.isWorkflowSuggestion && !msg.suggestionRejected ? (
                          <div className="mt-1.5 p-3 rounded-lg border border-amber-500/30 bg-amber-950/20">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-amber-400 text-xs font-medium">🚀 APEX đề xuất Code Team</span>
                            </div>
                            <p className="text-[11px] text-gray-300 mb-2">{msg.suggestionText}</p>
                            {(msg.routingMode || msg.routingTier || msg.routingScore) && (
                              <div className="flex items-center gap-2 text-[9px] text-gray-400 mb-3">
                                {msg.routingMode && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Mode {msg.routingMode === 'A' ? 'A (Visual)' : msg.routingMode === 'B' ? 'B (Backend)' : 'C (Hybrid)'}</span>}
                                {msg.routingTier && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Tier {msg.routingTier === 1 ? '1 Simple' : msg.routingTier === 2 ? '2 Medium' : '3 Complex'}</span>}
                                {msg.routingScore != null && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Score {msg.routingScore}/9</span>}
                              </div>
                            )}
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  // Accept: trigger workflow with pre-computed routing
                                  const userMessages = messages.filter(m => m.role === 'user')
                                  const lastUserMsg = userMessages[userMessages.length - 1]
                                  if (lastUserMsg) {
                                    // Remove the suggestion card, keep the user message
                                    setMessages(prev => prev.filter(m => m.id !== msg.id))
                                    startWorkflow(lastUserMsg.content, msg.assessmentRouting, { skipUserMsg: true })
                                  }
                                }}
                                className="px-3 py-1.5 text-[10px] bg-amber-500/20 text-amber-300 rounded border border-amber-500/30 hover:bg-amber-500/30 transition-colors font-medium"
                              >
                                ✅ Triển khai
                              </button>
                              <button
                                onClick={() => {
                                  // Reject: dismiss suggestion card
                                  setMessages(prev => prev.map(m =>
                                    m.id === msg.id
                                      ? { ...m, isWorkflowSuggestion: false, suggestionRejected: true, content: '✅ Đã hủy Code Team workflow.' }
                                      : m
                                  ))
                                }}
                                className="px-3 py-1.5 text-[10px] bg-slate-700/30 text-gray-400 rounded border border-slate-600/30 hover:bg-slate-700/50 transition-colors"
                              >
                                ❌ Không
                              </button>
                            </div>
                          </div>
                        ) : msg.suggestionRejected ? (
                          <p className="text-xs text-stone-400 italic">{msg.content}</p>
                        ) : (
                          <p className="text-xs whitespace-pre-wrap leading-relaxed text-stone-200">{msg.content}</p>
                        )}
                        {msg.toolCallInfo && (
                          <div className="mt-2 p-2 rounded-lg bg-slate-950/50 border border-stone-700/50 text-[9px] text-stone-400">
                            {formatToolBubble(msg.toolCallInfo.tool, msg.toolCallInfo.detail)}
                          </div>
                        )}
                        {msg.durationMs && (
                          <div className="text-[8px] text-stone-500 mt-1">{(msg.durationMs / 1000).toFixed(1)}s</div>
                        )}
                      </div>
                    ) : msg.role === 'user' ? (
                      <div className="max-w-[85%] p-2.5 bg-gradient-to-r from-cyan-600/80 to-teal-700/80 text-white">
                        <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      </div>
                    ) : (
                    <div className={`max-w-[85%] p-2.5 ${
                      msg.role === 'tool_call'
                      ? 'bg-slate-950/50 border border-cyan-500/15 border-l-2 border-l-cyan-400'
                      : msg.role === 'error'
                      ? 'bg-red-950/30 border border-red-400/35'
                      : msg.role === 'opencode_progress'
                      ? 'bg-emerald-950/30 border border-emerald-400/35 border-l-2 border-l-emerald-400'
                      : msg.role === 'opencode_result'
                      ? 'bg-emerald-950/20 border border-emerald-400/50 border-l-2 border-l-emerald-300'
                      : 'bg-slate-950/50 border border-cyan-400/35 border-l-2 border-l-emerald-400'
                    }`}>
                      {/* Role label */}
                      {msg.role === 'assistant' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[9px] text-stone-400 font-medium">Agent</span>
                          {msg.provider && <Badge className="text-[7px] h-3 px-1 bg-stone-950/50 text-stone-400">{msg.provider}</Badge>}
                          {msg.confidence != null && <Badge variant="outline" className="text-[7px] h-3 px-1">{(msg.confidence * 100).toFixed(0)}%</Badge>}
                        </div>
                      )}
                      {msg.role === 'tool_call' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />
                          <span className="text-[9px] text-cyan-400">🔍 {msg.content}</span>
                        </div>
                      )}
                      {msg.role === 'error' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[9px] text-red-400">Lỗi</span>
                        </div>
                      )}
                      {msg.role === 'opencode_progress' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                          <span className="text-[9px] text-emerald-400 font-medium">🔧 OpenCode Session</span>
                          {msg.opencodeSessionId && <Badge className="text-[7px] h-3 px-1 bg-emerald-950/50 text-emerald-400">{msg.opencodeSessionId.slice(0, 8)}</Badge>}
                        </div>
                      )}
                      {msg.role === 'opencode_result' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span className="text-[9px] text-emerald-400 font-medium">✅ OpenCode Hoàn thành</span>
                        </div>
                      )}

                      {/* Content */}
                      {msg.role !== 'tool_call' && (
                        <p className="text-xs whitespace-pre-wrap leading-relaxed text-stone-300">{msg.content}</p>
                      )}

                      {/* Sources */}
                      {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                        <details className="mt-1.5 pt-1.5 border-t border-cyan-500/15">
                          <summary className="text-[9px] text-stone-400 cursor-pointer hover:text-stone-300">Nguồn ({msg.sources.length})</summary>
                          <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
                            {msg.sources.map((s, i) => (
                              <div key={i} className="text-[9px] text-stone-400 flex items-start gap-1">
                                <span>{s.type === 'chunk' ? '📄' : s.type === 'entity' ? '🏷️' : '🔗'}</span>
                                <span className="truncate">{s.content.slice(0, 60)}{s.documentTitle && <span className="text-[8px]"> ({s.documentTitle})</span>}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}

                      {/* OC-3.2: KB Enrichment info for OpenCode progress messages */}
                      {msg.role === 'opencode_progress' && msg.enrichment && (
                        <div className="mt-1.5 pt-1.5 border-t border-emerald-500/15">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-[9px] text-emerald-400">📊 KB Enrichment</span>
                            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full" style={{ width: `${Math.round(msg.enrichment.score * 100)}%` }} />
                            </div>
                            <span className="text-[9px] text-emerald-300">{Math.round(msg.enrichment.score * 100)}%</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {msg.enrichment.entitiesFound > 0 && <Badge className="text-[7px] h-3 px-1 bg-emerald-950/50 text-emerald-400">🏷️ {msg.enrichment.entitiesFound} entities</Badge>}
                            {msg.enrichment.documentsFound > 0 && <Badge className="text-[7px] h-3 px-1 bg-cyan-950/50 text-cyan-400">📄 {msg.enrichment.documentsFound} docs</Badge>}
                            {msg.enrichment.correctionsFound > 0 && <Badge className="text-[7px] h-3 px-1 bg-amber-950/50 text-amber-400">📝 {msg.enrichment.correctionsFound} corrections</Badge>}
                            {msg.enrichment.insightsFound > 0 && <Badge className="text-[7px] h-3 px-1 bg-violet-950/50 text-violet-400">💡 {msg.enrichment.insightsFound} insights</Badge>}
                          </div>
                        </div>
                      )}

                      {/* OC-3.2: Result summary for OpenCode result messages */}
                      {msg.role === 'opencode_result' && msg.opencodeResult && (
                        <div className="mt-1.5 pt-1.5 border-t border-emerald-500/15 space-y-1">
                          <div className="flex flex-wrap gap-1">
                            <Badge className="text-[7px] h-3 px-1 bg-emerald-950/50 text-emerald-400">+{msg.opencodeResult.additions} -{msg.opencodeResult.deletions}</Badge>
                            <Badge className="text-[7px] h-3 px-1 bg-cyan-950/50 text-cyan-400">📁 {msg.opencodeResult.filesChanged.length} files</Badge>
                            <Badge className="text-[7px] h-3 px-1 bg-amber-950/50 text-amber-400">🔧 {msg.opencodeResult.diagnostics} diagnostics</Badge>
                            {msg.opencodeResult.kbUsed && <Badge className="text-[7px] h-3 px-1 bg-violet-950/50 text-violet-400">🔍 KB used</Badge>}
                          </div>
                          {msg.opencodeResult.filesChanged.length > 0 && (
                            <div className="text-[9px] text-stone-400">
                              Files: {msg.opencodeResult.filesChanged.join(', ')}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Feedback buttons for assistant messages */}
                      {msg.role === 'assistant' && (
                        <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-cyan-400/25">
                          <button
                            onClick={() => handleFeedback(msg.id, 'positive', msg.content)}
                            disabled={feedbackLoading === msg.id || msg.feedback !== null}
                            className={`p-1 transition-colors ${msg.feedback === 'positive' ? 'text-emerald-400' : 'text-stone-500 hover:text-emerald-400'}`}
                            title="Hữu ích"
                          >
                            <ThumbsUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => handleFeedback(msg.id, 'negative', msg.content)}
                            disabled={feedbackLoading === msg.id || msg.feedback !== null}
                            className={`p-1 transition-colors ${msg.feedback === 'negative' ? 'text-red-400' : 'text-stone-500 hover:text-red-400'}`}
                            title="Cần cải thiện"
                          >
                            <ThumbsDown className="h-3 w-3" />
                          </button>
                          <span className="text-[8px] text-stone-500 ml-auto">
                            {msg.timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      )}
                    </div>
                    )}

                    {/* User icon */}
                    {msg.role === 'user' && (
                      <div className="flex-shrink-0 w-6 h-6 bg-gradient-to-br from-cyan-900 to-teal-900 flex items-center justify-center mt-0.5">
                        <MessageSquare className="h-3 w-3 text-cyan-400" />
                      </div>
                    )}
                  </div>
                ))
              )}

              {/* Loading indicator */}
              {isLoading && messages[messages.length - 1]?.role !== 'tool_call' && (
                <div className="flex justify-start gap-2">
                  <div className="flex-shrink-0 w-6 h-6 bg-gradient-to-br from-emerald-900 to-teal-900 flex items-center justify-center">
                    <Brain className="h-3 w-3 text-emerald-400" />
                  </div>
                  <div className="bg-slate-950/50 border border-cyan-400/35 p-2.5">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                      <span className="text-xs text-stone-400">Đang suy nghĩ...</span>
                    </div>
                  </div>
                </div>
              )}
              {/* Phase 6: Typing indicator khi task đang chạy trong background */}
              {activeTaskIds.has(currentSessionId) && !isLoading && (
                <div className="flex items-center gap-2 px-4 py-2 text-xs text-stone-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{chatMode === 'single' ? (smolabAgents.find((a: any) => a.id === selectedAgentId)?.name || 'Agent') : (selectedTeam === 'code' ? 'Code Team' : 'Research Team')} đang xử lý...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Box — Phase 5: Disable khi chưa chọn Agent/Team */}
            <div className="flex-shrink-0 p-3 border-t border-cyan-400/35">
              {canChat ? (
              <>
              <div className="flex items-center gap-2">
                <input
                  ref={chatInputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  placeholder="Nhập câu hỏi..."
                  className="chamfer-sm flex-1 px-3 py-2 text-xs bg-slate-950/60 border border-cyan-400/40 text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  disabled={isLoading}
                />
                <Button
                  onClick={() => sendMessage()}
                  disabled={isLoading || !input.trim()}
                  className="chamfer-sm h-8 w-8 p-0 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white"
                >
                  {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
              </>
              ) : (
                <div className="flex items-center justify-center h-10 text-stone-500 text-xs gap-2">
                  <Zap className="h-4 w-4 opacity-30" />
                  <span>Chọn Agent hoặc Team để bắt đầu chat</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== RESIZE HANDLE ===== */}
      <div
        className="flex-shrink-0 w-2 cursor-col-resize group relative flex items-center justify-center"
        onMouseDown={handleResizeMouseDown}
        title="Kéo để thay đổi kích thước"
      >
        {/* Handle visual indicator */}
        <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        <div className="relative flex flex-col items-center gap-0.5">
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
        </div>
      </div>

      {/* ===== RIGHT: Tab Content (resizable) ===== */}
      <div className="flex flex-col flex-1 min-w-0 sm:min-w-[300px] md:min-w-[400px]">
        <div className="nc-wrap nc-cyan flex flex-col h-full">
          <div className="nc-panel nc-md nc-border-cyan flex flex-col h-full overflow-hidden">

            {/* Tab Bar */}
            <div className="flex-shrink-0 flex border-b border-cyan-400/35">
              {SMOLAB_TABS.map(tab => {
                const IconComp = tab.icon
                const colorClass = TAB_COLOR_CLASSES[tab.color]
                return (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveSmolabTab(tab.id)
                      try { localStorage.setItem('graphrag-smolab-tab', tab.id) } catch { /* ignore */ }
                    }}
                    className={`chamfer-sm flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-all border-b-2 ${
                      activeSmolabTab === tab.id
                        ? `bg-gradient-to-r ${colorClass.active} text-white border-b-cyan-400`
                        : `text-stone-400 ${colorClass.hover} border-b-transparent hover:bg-slate-950/30`
                    }`}
                  >
                    <IconComp className="h-3 w-3" />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin' }}>

              {/* Tab: Knowledge Bridge */}
              {activeSmolabTab === 'knowledge' && (
                <KnowledgeTabContent />
              )}
              {activeSmolabTab === 'memory' && (
                <MemoryTabContent />
              )}
              {activeSmolabTab === 'learning' && (
                <LearningTabContent />
              )}
              {activeSmolabTab === 'skills' && (
                <SkillsTabContent />
              )}
              {activeSmolabTab === 'automation' && (
                <AutomationTabContent />
              )}
              {activeSmolabTab === 'channels' && (
                <ChannelsTabContent />
              )}
              {activeSmolabTab === 'code' && (
                <CodeTabContent />
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

// ==================== SKILLS & TOOLS TAB (Phase 4) ====================



function SkillsTabContent() {
  // Installed skills
  const [installedSkills, setInstalledSkills] = useState<Array<{
    id: string; slug: string; name: string; content: string; source: string;
    enabled: boolean; version: string; installedAt: string; updatedAt: string;
  }> | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(false)

  // ClawHub search
  const [clawhubQuery, setClawhubQuery] = useState('')
  const [clawhubResults, setClawhubResults] = useState<Array<{
    slug: string; name: string; version: string; description: string;
    author: string; authorHandle?: string; authorImage?: string;
    downloads: number; installs?: number; stars?: number; score?: number;
    category: string; installed: boolean; source?: string; url?: string;
  }> | null>(null)
  const [clawhubSearching, setClawhubSearching] = useState(false)

  // Skill editor
  const [editingSkill, setEditingSkill] = useState<{
    slug: string; name: string; content: string; source: string;
  } | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // Custom skill creation
  const [showCreateSkill, setShowCreateSkill] = useState(false)
  const [newSkillSlug, setNewSkillSlug] = useState('')
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  const [newSkillCreating, setNewSkillCreating] = useState(false)

  // Skill content dialog
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [skillDialogContent, setSkillDialogContent] = useState<{
    name: string; slug: string; content: string; version: string;
    source: string; installed: boolean; author?: string; authorHandle?: string;
    description?: string;
  } | null>(null)
  const [skillDialogContentLoading, setSkillDialogContentLoading] = useState(false)

  // Load installed skills
  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const res = await fetch('/api/openclaw/skills?action=installed')
      if (res.ok) {
        const data = await res.json()
        setInstalledSkills(data.skills)
      }
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  // Search ClawHub
  const searchClawHub = useCallback(async (queryOverride?: string) => {
    setClawhubSearching(true)
    try {
      const q = queryOverride !== undefined ? queryOverride : clawhubQuery
      // ClawHub API doesn't support '*' wildcard — use 'skill' as broad fallback
      const searchQuery = q.trim() || 'skill'
      const params = new URLSearchParams({ action: 'search', q: searchQuery, limit: '20' })
      const res = await fetch(`/api/openclaw/skills?${params}`)
      if (res.ok) {
        const data = await res.json()
        setClawhubResults(data.skills)
        if (data.source === 'none') {
          toast({ title: '⚠️ Không thể kết nối ClawHub', description: data.message, variant: 'destructive' })
        }
      }
    } catch (error) {
      console.error('ClawHub search failed:', error)
      toast({ title: '❌ Lỗi tìm kiếm', description: 'Không thể tìm kiếm trên ClawHub', variant: 'destructive' })
    } finally {
      setClawhubSearching(false)
    }
  }, [clawhubQuery])

  // Install skill from ClawHub
  const installSkill = useCallback(async (slug: string, ownerHandle?: string) => {
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', slug, ownerHandle }),
      })
      if (res.ok) {
        const data = await res.json()
        toast({ title: '✅ Cài đặt thành công', description: data.message })
        loadSkills()
        searchClawHub()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể cài đặt skill', variant: 'destructive' })
    }
  }, [loadSkills, searchClawHub])

  // Uninstall skill
  const uninstallSkill = useCallback(async (slug: string, name: string) => {
    if (!confirm(`Gỡ cài đặt skill "${name}"? Hành động này không thể hoàn tác.`)) return
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uninstall', slug }),
      })
      if (res.ok) {
        toast({ title: '🗑️ Đã gỡ cài đặt', description: `Skill "${name}" đã gỡ` })
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể gỡ skill', variant: 'destructive' })
    }
  }, [loadSkills])

  // Toggle skill
  const toggleSkill = useCallback(async (slug: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', slug, enabled }),
      })
      if (res.ok) {
        const data = await res.json()
        toast({ title: enabled ? '✅ Đã bật' : '⏸️ Đã tắt', description: data.message })
        loadSkills()
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể toggle skill', variant: 'destructive' })
    }
  }, [loadSkills])

  // Fetch skill content for dialog
  const fetchSkillContent = useCallback(async (slug: string, ownerHandle?: string) => {
    setSkillDialogContentLoading(true)
    setSkillDialogOpen(true)
    setSkillDialogContent(null)
    try {
      const params = new URLSearchParams({ action: 'content', slug })
      if (ownerHandle) params.set('ownerHandle', ownerHandle)
      const res = await fetch(`/api/openclaw/skills?${params}`)
      if (res.ok) {
        const data = await res.json()
        if (data.error && !data.content) {
          toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
          setSkillDialogOpen(false)
        } else {
          setSkillDialogContent(data)
        }
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể tải nội dung skill', variant: 'destructive' })
      setSkillDialogOpen(false)
    } finally {
      setSkillDialogContentLoading(false)
    }
  }, [])

  // Open skill editor
  const openEditor = useCallback((skill: { slug: string; name: string; content: string; source: string }) => {
    setEditingSkill(skill)
    setEditContent(skill.content)
    setEditName(skill.name)
  }, [])

  // Save edited skill
  const saveEditedSkill = useCallback(async () => {
    if (!editingSkill) return
    setEditSaving(true)
    try {
      const res = await fetch('/api/openclaw/skills/custom', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editingSkill.slug, name: editName, content: editContent }),
      })
      if (res.ok) {
        toast({ title: '✅ Đã lưu', description: `Skill "${editName}" đã cập nhật` })
        setEditingSkill(null)
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể lưu skill', variant: 'destructive' })
    } finally {
      setEditSaving(false)
    }
  }, [editingSkill, editName, editContent, loadSkills])

  // Create custom skill
  const createCustomSkill = useCallback(async () => {
    if (!newSkillSlug || !newSkillName || !newSkillContent) {
      toast({ title: '❌ Thiếu thông tin', description: 'Cần slug, tên và nội dung', variant: 'destructive' })
      return
    }
    setNewSkillCreating(true)
    try {
      const res = await fetch('/api/openclaw/skills/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSkillSlug, name: newSkillName, content: newSkillContent, enabled: true }),
      })
      if (res.ok) {
        toast({ title: '✅ Đã tạo', description: `Custom skill "${newSkillName}" đã tạo` })
        setShowCreateSkill(false)
        setNewSkillSlug('')
        setNewSkillName('')
        setNewSkillContent('')
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể tạo skill', variant: 'destructive' })
    } finally {
      setNewSkillCreating(false)
    }
  }, [newSkillSlug, newSkillName, newSkillContent, loadSkills])

  // Load data on mount (only once)
  useEffect(() => {
    loadSkills()
    searchClawHub('skill') // initial load — browse popular skills from ClawHub
  }, [])

  const sourceBadgeColor: Record<string, string> = {
    bundled: 'bg-violet-500/20 text-violet-300 border-violet-400/50',
    clawhub: 'bg-blue-500/20 text-blue-300 border-blue-400/50',
    custom: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50',
    template: 'bg-purple-500/20 text-purple-300 border-purple-400/50',
  }

  return (
    <div className="space-y-4 p-4 max-h-full overflow-y-auto">
      {/* ClawHub Marketplace */}
      <div className="nc-wrap nc-violet">
        <div className="nc-panel nc-md nc-border-violet p-4">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-violet-400" />
            <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">ClawHub Marketplace</h3>
            <a href="https://clawhub.ai/skills" target="_blank" rel="noopener noreferrer" className="ml-auto text-[10px] text-violet-400 hover:text-violet-300 flex items-center gap-1">
              <ExternalLink className="w-3 h-3" /> ClawHub.ai
            </a>
          </div>
          <div className="flex gap-2 mb-3">
            <Input
              placeholder="Tìm kiếm skill trên ClawHub.ai..."
              value={clawhubQuery}
              onChange={(e) => setClawhubQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchClawHub()}
              className="flex-1 bg-slate-800/50 border-violet-400/35 text-white placeholder:text-slate-500 text-sm"
            />
            <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={() => searchClawHub()} disabled={clawhubSearching}>
              {clawhubSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            </Button>
          </div>

          {clawhubResults && clawhubResults.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {clawhubResults.map((skill, idx) => {
                // ClawHub slugs are unique per-author, not globally — compose key to avoid duplicate React keys
                const reactKey = `${skill.slug}::${skill.authorHandle || skill.author || `idx-${idx}`}`
                return (
                <div key={reactKey} className="nc-wrap nc-violet-soft cursor-pointer hover:ring-1 hover:ring-violet-400/50 transition-all" onClick={() => fetchSkillContent(skill.slug, skill.authorHandle)}>
                  <div className="nc-panel nc-sm nc-border-violet-soft p-3">
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        {skill.authorImage ? (
                          <img src={skill.authorImage} alt="" className="w-5 h-5 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-violet-500/30 flex items-center justify-center flex-shrink-0">
                            <span className="text-[8px] text-violet-300">{(skill.author || '?')[0]}</span>
                          </div>
                        )}
                        <h4 className="text-sm font-medium text-white truncate">{skill.name}</h4>
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50 flex-shrink-0 ml-1">
                        v{skill.version}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-400 mb-2 line-clamp-2">{skill.description}</p>
                    <span className="text-[9px] text-violet-500/70 flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" /> Xem nội dung</span>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 text-[10px] text-slate-500">
                        <span className="truncate max-w-[100px]">👤 {skill.author}</span>
                        {skill.downloads > 0 && <span>⬇️ {skill.downloads >= 1000 ? `${(skill.downloads / 1000).toFixed(1)}k` : skill.downloads}</span>}
                        {skill.stars !== undefined && skill.stars > 0 && <span>⭐ {skill.stars}</span>}
                        {skill.url && (
                          <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300" onClick={(e) => e.stopPropagation()}>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {skill.installed ? (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">Đã cài</Badge>
                      ) : (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={(e) => { e.stopPropagation(); installSkill(skill.slug, skill.authorHandle) }}>
                          <Download className="w-3 h-3 mr-1" /> Cài
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-slate-500 text-sm">
              {clawhubSearching ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                  <span>Đang tìm kiếm trên ClawHub.ai...</span>
                </div>
              ) : (
                <div>
                  <p>Nhập từ khóa và bấm tìm kiếm</p>
                  <p className="text-[10px] text-slate-600 mt-1">Dữ liệu từ ClawHub.ai — kho skill cho AI agents</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SKILL.md Guides — Hướng dẫn cho agents */}
      {installedSkills && installedSkills.length > 0 && (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-violet-400" />
                <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">SKILL.md Guides</h3>
                <Badge variant="outline" className="text-violet-400 border-violet-400/50">{installedSkills.length}</Badge>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={() => setShowCreateSkill(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Tạo Custom
                </Button>
              </div>
            </div>

            <p className="text-xs text-slate-500 mb-3">
              Tài liệu SKILL.md được inject vào system prompt của agent — hướng dẫn agent <em>khi nào</em> và <em>cách nào</em> sử dụng tool tương ứng. Đây là &quot;sách hướng dẫn&quot;, không phải code.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {installedSkills.map((skill, idx) => (
                <div key={skill.id || `${skill.slug}::idx-${idx}`} className="nc-wrap nc-violet-soft">
                  <div className="nc-panel nc-sm nc-border-violet-soft p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-white truncate">{skill.name}</h4>
                        <p className="text-xs text-slate-400 mt-0.5">v{skill.version}</p>
                        <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                          {skill.content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || 'Không có mô tả'}
                        </p>
                      </div>
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => toggleSkill(skill.slug, checked)}
                        className="data-[state=checked]:bg-violet-500 data-[state=unchecked]:bg-slate-700 ml-2 flex-shrink-0"
                      />
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${sourceBadgeColor[skill.source] || sourceBadgeColor.custom}`}>
                        {skill.source === 'bundled' ? '📦 Mặc định' : skill.source === 'clawhub' ? '🏪 ClawHub' : skill.source === 'template' ? '📋 Template' : '✏️ Custom'}
                      </Badge>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${skill.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50' : 'bg-slate-500/20 text-slate-400 border-slate-400/50'}`}>
                        {skill.enabled ? '✅ Bật' : '⏸️ Tắt'}
                      </Badge>
                    </div>
                    <div className="flex gap-1.5 mt-2">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-cyan-400 hover:bg-cyan-500/10" onClick={(e) => { e.stopPropagation(); fetchSkillContent(skill.slug) }}>
                        <Eye className="w-3 h-3 mr-1" /> Xem
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-violet-400 hover:bg-violet-500/10" onClick={() => openEditor(skill)}>
                        <Edit3 className="w-3 h-3 mr-1" /> Sửa
                      </Button>
                      {skill.source !== 'bundled' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-red-400 hover:bg-red-500/10" onClick={() => uninstallSkill(skill.slug, skill.name)}>
                          <Trash2 className="w-3 h-3 mr-1" /> Gỡ
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}



      {/* Section 3: Skill Editor (Modal-like overlay) */}
      {editingSkill && (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-violet-400" />
                <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">Chỉnh sửa Skill</h3>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">{editingSkill.source}</Badge>
              </div>
              <Button size="sm" variant="ghost" className="text-slate-400 hover:text-white" onClick={() => setEditingSkill(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Slug</label>
                <Input value={editingSkill.slug} disabled className="bg-slate-800/50 border-violet-400/35 text-slate-500 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Tên Skill</label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-slate-800/50 border-violet-400/35 text-white text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Nội dung (SKILL.md)</label>
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={12}
                  className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono resize-y"
                  placeholder="# Skill Title&#10;&#10;## Description&#10;..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setEditingSkill(null)}>Hủy</Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={saveEditedSkill} disabled={editSaving}>
                  {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Check className="w-3.5 h-3.5 mr-1" />} Lưu
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section 4: Create Custom Skill (expandable) */}
      {showCreateSkill && (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-violet-400" />
                <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">Tạo Custom Skill</h3>
              </div>
              <Button size="sm" variant="ghost" className="text-slate-400 hover:text-white" onClick={() => setShowCreateSkill(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Slug (ID)</label>
                  <Input value={newSkillSlug} onChange={(e) => setNewSkillSlug(e.target.value.replace(/\s+/g, '-').toLowerCase())} placeholder="my-custom-skill" className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Tên Skill</label>
                  <Input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="My Custom Skill" className="bg-slate-800/50 border-violet-400/35 text-white text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Nội dung SKILL.md</label>
                <Textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  rows={10}
                  className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono resize-y"
                  placeholder="# Skill Title&#10;&#10;## Description&#10;Mô tả skill...&#10;&#10;## When to Use&#10;- Khi nào...&#10;&#10;## Rules&#10;- Quy tắc..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setShowCreateSkill(false)}>Hủy</Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={createCustomSkill} disabled={newSkillCreating}>
                  {newSkillCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />} Tạo Skill
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Skill Content Dialog */}
      <Dialog open={skillDialogOpen} onOpenChange={setSkillDialogOpen}>
        <DialogContent className="bg-slate-950 border-violet-400/35 text-white max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-violet-300">
              <BookOpen className="w-5 h-5" />
              {skillDialogContentLoading ? 'Đang tải...' : skillDialogContent?.name || 'Skill Content'}
              {skillDialogContent && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">
                  v{skillDialogContent.version}
                </Badge>
              )}
              {skillDialogContent?.installed && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">
                  Đã cài
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-slate-400 text-xs">
              {skillDialogContent?.author && `bởi ${skillDialogContent.author}`}
              {skillDialogContent?.description && ` — ${skillDialogContent.description}`}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 overflow-y-auto max-h-[55vh]">
            {skillDialogContentLoading ? (
              <div className="flex items-center justify-center py-12 text-violet-400/60">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Đang tải nội dung từ ClawHub...
              </div>
            ) : skillDialogContent?.content ? (
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono bg-slate-900/50 rounded-lg p-4 border border-violet-400/20">
                {skillDialogContent.content}
              </pre>
            ) : (
              <div className="text-center py-8 text-slate-500 text-sm">
                Không có nội dung để hiển thị
              </div>
            )}
          </div>
          <DialogFooter className="flex items-center gap-2 mt-2">
            {skillDialogContent && !skillDialogContent.installed && (
              <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={() => {
                if (skillDialogContent) {
                  installSkill(skillDialogContent.slug, skillDialogContent.authorHandle)
                  setSkillDialogOpen(false)
                }
              }}>
                <Download className="w-3.5 h-3.5 mr-1" /> Cài đặt Skill
              </Button>
            )}
            {skillDialogContent?.url && (
              <a href={`https://clawhub.ai/${skillDialogContent.authorHandle}/${skillDialogContent.slug}`} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10">
                  <ExternalLink className="w-3.5 h-3.5 mr-1" /> ClawHub.ai
                </Button>
              </a>
            )}
            <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setSkillDialogOpen(false)}>
              Đóng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== AUTOMATION TAB (Phase 5) ====================

const CRON_PRESETS = [
  { label: 'Mỗi 30 phút', expression: '*/30 * * * *' },
  { label: 'Mỗi giờ', expression: '0 * * * *' },
  { label: 'Mỗi ngày lúc 9:00', expression: '0 9 * * *' },
  { label: 'Mỗi thứ Hai lúc 8:00', expression: '0 8 * * 1' },
  { label: 'Mỗi ngày đầu tháng', expression: '0 0 1 * *' },
]

const HEARTBEAT_INTERVALS = ['1m', '5m', '15m', '30m', '1h']

/** Convert a cron expression to a human-readable Vietnamese description */
function describeCronExpression(expr: string): string {
  if (expr.startsWith('heartbeat:')) return `Heartbeat mỗi ${expr.replace('heartbeat:', '')}`

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [min, hour, day, month, dow] = parts

  // Every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/)
  if (everyMinMatch && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi ${everyMinMatch[1]} phút`
  }

  // Every minute
  if (min === '*' && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return 'Mỗi phút'
  }

  // Hourly at specific minute
  if (min !== '*' && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi giờ lúc phút ${min}`
  }

  // Daily at HH:MM
  if (min !== '*' && hour !== '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi ngày lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Weekly on specific day at HH:MM
  const dayNames: Record<string, string> = { '0': 'Chủ nhật', '1': 'thứ Hai', '2': 'thứ Ba', '3': 'thứ Tư', '4': 'thứ Năm', '5': 'thứ Sáu', '6': 'thứ Bảy' }
  if (min !== '*' && hour !== '*' && day === '*' && month === '*' && dow !== '*') {
    const dayName = dayNames[dow] || `ngày ${dow}`
    return `Mỗi ${dayName} lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Monthly on specific day at HH:MM
  if (min !== '*' && hour !== '*' && day !== '*' && month === '*' && dow === '*') {
    return `Ngày ${day} hàng tháng lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  return expr
}

function AutomationTabContent() {
  // Cron Jobs
  const [cronJobs, setCronJobs] = useState<Array<{
    id: string; agentId: string; expression: string; taskPrompt: string;
    enabled: boolean; lastRunAt: string | null; nextRunAt: string | null;
    createdAt: string; updatedAt: string;
  }> | null>(null)
  const [cronLoading, setCronLoading] = useState(false)

  // Cron Editor
  const [showCronEditor, setShowCronEditor] = useState(false)
  const [editingCron, setEditingCron] = useState<typeof cronJobs extends Array<infer T> | null ? T : never | null>(null)
  const [cronExpression, setCronExpression] = useState('')
  const [cronTaskPrompt, setCronTaskPrompt] = useState('')
  const [cronEnabled, setCronEnabled] = useState(true)
  const [cronSaving, setCronSaving] = useState(false)

  // Webhooks
  const [webhooks, setWebhooks] = useState<Array<{
    id: string; agentId: string; url: string; events: string;
    secret: string | null; enabled: boolean; createdAt: string; updatedAt: string;
  }> | null>(null)
  const [webhookLoading, setWebhookLoading] = useState(false)

  // Webhook Editor
  const [showWebhookEditor, setShowWebhookEditor] = useState(false)
  const [editingWebhook, setEditingWebhook] = useState<typeof webhooks extends Array<infer T> | null ? T : never | null>(null)
  const [whUrl, setWhUrl] = useState('')
  const [whEvents, setWhEvents] = useState('')
  const [whSecret, setWhSecret] = useState('')
  const [whEnabled, setWhEnabled] = useState(true)
  const [whSaving, setWhSaving] = useState(false)

  // Heartbeat
  const [heartbeat, setHeartbeat] = useState<{
    interval: string; actionPrompt: string; enabled: boolean;
  }>({ interval: '5m', actionPrompt: 'Kiểm tra sức khỏe hệ thống', enabled: false })
  const [heartbeatLoading, setHeartbeatLoading] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)

  // Standing Orders
  const [orders, setOrders] = useState<Array<{
    id: string; agentId: string; order: string; priority: number;
    enabled: boolean; createdAt: string;
  }> | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [newOrder, setNewOrder] = useState('')
  const [newOrderPriority, setNewOrderPriority] = useState(0)

  // Task History
  const [history, setHistory] = useState<Array<{
    id: string; jobId: string | null; type: string; status: string;
    result: string | null; errorMessage: string | null;
    startedAt: string; completedAt: string | null;
  }> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyFilter, setHistoryFilter] = useState('all')

  // Load cron jobs
  const loadCronJobs = useCallback(async () => {
    setCronLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation?type=cron')
      if (res.ok) { const data = await res.json(); setCronJobs(data.jobs || []) }
    } catch (e) { console.error('Failed to load cron jobs:', e) }
    finally { setCronLoading(false) }
  }, [])

  // Load webhooks
  const loadWebhooks = useCallback(async () => {
    setWebhookLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation?type=webhook')
      if (res.ok) { const data = await res.json(); setWebhooks(data.webhooks || []) }
    } catch (e) { console.error('Failed to load webhooks:', e) }
    finally { setWebhookLoading(false) }
  }, [])

  // Load heartbeat
  const loadHeartbeat = useCallback(async () => {
    setHeartbeatLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation/heartbeat')
      if (res.ok) {
        const data = await res.json()
        if (data.config) setHeartbeat(data.config)
      }
    } catch (e) { console.error('Failed to load heartbeat:', e) }
    finally { setHeartbeatLoading(false) }
  }, [])

  // Load standing orders
  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation/orders')
      if (res.ok) { const data = await res.json(); setOrders(data.orders || []) }
    } catch (e) { console.error('Failed to load orders:', e) }
    finally { setOrdersLoading(false) }
  }, [])

  // Load history
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const params = new URLSearchParams()
      if (historyFilter !== 'all') params.set('type', historyFilter)
      params.set('limit', '30')
      const res = await fetch(`/api/openclaw/automation/history?${params}`)
      if (res.ok) { const data = await res.json(); setHistory(data.tasks || []) }
    } catch (e) { console.error('Failed to load history:', e) }
    finally { setHistoryLoading(false) }
  }, [historyFilter])

  // Initial load (only data that doesn't depend on volatile filters)
  useEffect(() => { loadCronJobs(); loadWebhooks(); loadHeartbeat(); loadOrders(); loadHistory() }, [loadCronJobs, loadWebhooks, loadHeartbeat, loadOrders])

  // Reload history when filter changes (separate from main load to avoid re-fetching all data)
  useEffect(() => { loadHistory() }, [loadHistory])

  // Scheduler auto-poll — triggers cron/heartbeat execution every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/openclaw/automation/scheduler')
        if (res.ok) {
          const data = await res.json()
          // If any jobs were executed, refresh the data
          if (data.cron?.executed > 0 || data.cron?.failed > 0 || data.heartbeat?.executed) {
            loadCronJobs()
            loadHistory()
          }
        }
      } catch { /* silent */ }
    }, 30000) // Poll every 30 seconds
    return () => clearInterval(interval)
  }, [loadCronJobs, loadHistory])

  // ─── Cron Actions ───
  const saveCron = useCallback(async () => {
    if (!cronExpression.trim() || !cronTaskPrompt.trim()) {
      toast({ title: '❌ Thiếu thông tin', description: 'Vui lòng nhập cron expression và task prompt', variant: 'destructive' })
      return
    }
    setCronSaving(true)
    try {
      const action = editingCron ? 'update-cron' : 'create-cron'
      const body: Record<string, unknown> = { action, expression: cronExpression, taskPrompt: cronTaskPrompt, enabled: cronEnabled }
      if (editingCron) body.id = editingCron.id
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: editingCron ? '✅ Đã cập nhật' : '✅ Đã tạo', description: 'Cron job đã được lưu' })
        setShowCronEditor(false); setEditingCron(null); setCronExpression(''); setCronTaskPrompt(''); setCronEnabled(true)
        loadCronJobs()
      } else { const d = await res.json(); toast({ title: '❌ Lỗi', description: d.error, variant: 'destructive' }) }
    } catch { toast({ title: '❌ Lỗi', description: 'Không thể lưu cron job', variant: 'destructive' }) }
    finally { setCronSaving(false) }
  }, [editingCron, cronExpression, cronTaskPrompt, cronEnabled, loadCronJobs])

  const deleteCron = useCallback(async (id: string) => {
    if (!confirm('Xóa cron job này?')) return
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-cron', id }),
      })
      if (res.ok) { toast({ title: '🗑️ Đã xóa', description: 'Cron job đã bị xóa' }); loadCronJobs() }
    } catch { toast({ title: '❌ Lỗi', description: 'Không thể xóa cron job', variant: 'destructive' }) }
  }, [loadCronJobs])

  const toggleCron = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-cron', id, enabled }),
      })
      if (res.ok) { toast({ title: enabled ? '▶️ Đã bật' : '⏸️ Đã tắt' }); loadCronJobs() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadCronJobs])

  const runCronNow = useCallback(async (id: string) => {
    try {
      toast({ title: '⏳ Đang chạy task...', description: 'Gọi LLM thực thi cron job' })
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-cron', id }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          const exec = data.execution || {}
          toast({
            title: '✅ Task hoàn tất',
            description: exec.llmResponse
              ? exec.llmResponse.slice(0, 150) + (exec.llmResponse.length > 150 ? '...' : '')
              : `Thực thi trong ${exec.durationMs || 0}ms`,
          })
        } else {
          toast({ title: '⚠️ Task thất bại', description: data.execution?.error || 'LLM error', variant: 'destructive' })
        }
        loadCronJobs(); loadHistory()
      }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadCronJobs, loadHistory])

  const openCronEditor = useCallback((job?: NonNullable<typeof cronJobs>[number]) => {
    if (job) {
      setEditingCron(job); setCronExpression(job.expression); setCronTaskPrompt(job.taskPrompt); setCronEnabled(job.enabled)
    } else {
      setEditingCron(null); setCronExpression(''); setCronTaskPrompt(''); setCronEnabled(true)
    }
    setShowCronEditor(true)
  }, [])

  // ─── Webhook Actions ───
  const saveWebhook = useCallback(async () => {
    if (!whUrl.trim()) { toast({ title: '❌ Thiếu URL', variant: 'destructive' }); return }
    setWhSaving(true)
    try {
      const action = editingWebhook ? 'update-webhook' : 'create-webhook'
      const eventsArr = whEvents.split(',').map(e => e.trim()).filter(Boolean)
      const body: Record<string, unknown> = { action, url: whUrl, events: eventsArr, enabled: whEnabled }
      if (whSecret) body.secret = whSecret
      if (editingWebhook) body.id = editingWebhook.id
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: editingWebhook ? '✅ Đã cập nhật' : '✅ Đã tạo', description: 'Webhook đã được lưu' })
        setShowWebhookEditor(false); setEditingWebhook(null); setWhUrl(''); setWhEvents(''); setWhSecret(''); setWhEnabled(true)
        loadWebhooks()
      } else { const d = await res.json(); toast({ title: '❌ Lỗi', description: d.error, variant: 'destructive' }) }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
    finally { setWhSaving(false) }
  }, [editingWebhook, whUrl, whEvents, whSecret, whEnabled, loadWebhooks])

  const deleteWebhook = useCallback(async (id: string) => {
    if (!confirm('Xóa webhook này?')) return
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-webhook', id }),
      })
      if (res.ok) { toast({ title: '🗑️ Đã xóa' }); loadWebhooks() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadWebhooks])

  const testWebhook = useCallback(async (id: string) => {
    try {
      toast({ title: '🧪 Đang test webhook...', description: 'Gửi HTTP POST đến webhook URL' })
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-webhook', id }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          toast({
            title: '✅ Webhook thành công',
            description: `HTTP ${data.dispatch?.httpStatus} — ${data.dispatch?.durationMs || 0}ms`,
          })
        } else {
          toast({
            title: '⚠️ Webhook thất bại',
            description: data.dispatch?.error || `HTTP ${data.dispatch?.httpStatus}`,
            variant: 'destructive',
          })
        }
        loadHistory()
      }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadHistory])

  const openWebhookEditor = useCallback((wh?: NonNullable<typeof webhooks>[number]) => {
    if (wh) {
      setEditingWebhook(wh); setWhUrl(wh.url)
      try { const arr = JSON.parse(wh.events); setWhEvents(Array.isArray(arr) ? arr.join(', ') : wh.events) } catch { setWhEvents(wh.events) }
      setWhSecret(wh.secret || ''); setWhEnabled(wh.enabled)
    } else {
      setEditingWebhook(null); setWhUrl(''); setWhEvents(''); setWhSecret(''); setWhEnabled(true)
    }
    setShowWebhookEditor(true)
  }, [])

  // ─── Heartbeat Actions ───
  const saveHeartbeat = useCallback(async () => {
    setHeartbeatSaving(true)
    try {
      const res = await fetch('/api/openclaw/automation/heartbeat', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat),
      })
      if (res.ok) { toast({ title: '✅ Heartbeat đã cập nhật' }) }
      else { const d = await res.json(); toast({ title: '❌ Lỗi', description: d.error, variant: 'destructive' }) }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
    finally { setHeartbeatSaving(false) }
  }, [heartbeat])

  // ─── Standing Order Actions ───
  const addOrder = useCallback(async () => {
    if (!newOrder.trim()) return
    try {
      const res = await fetch('/api/openclaw/automation/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder, priority: newOrderPriority }),
      })
      if (res.ok) { toast({ title: '✅ Đã thêm order' }); setNewOrder(''); setNewOrderPriority(0); loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [newOrder, newOrderPriority, loadOrders])

  const deleteOrder = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/openclaw/automation/orders?id=${id}`, { method: 'DELETE' })
      if (res.ok) { toast({ title: '🗑️ Đã xóa order' }); loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadOrders])

  const toggleOrder = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/automation/orders', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      })
      if (res.ok) { loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadOrders])

  // Format time ago
  const timeAgo = (dateStr: string | null) => {
    if (!dateStr) return '—'
    const diff = Date.now() - new Date(dateStr).getTime()
    if (diff < 60000) return 'vừa xong'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`
    return `${Math.floor(diff / 86400000)} ngày trước`
  }

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return '—'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  }

  // Filter out heartbeat jobs from regular cron display
  const regularCronJobs = cronJobs?.filter(j => !j.expression.startsWith('heartbeat:')) || []

  return (
    <div className="space-y-4 p-4 max-h-full overflow-y-auto">

      {/* Section 1: Cron Jobs */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Cron Jobs</h3>
              {regularCronJobs.length > 0 && (
                <Badge variant="outline" className="text-orange-400 border-orange-500/30">{regularCronJobs.length}</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={() => openCronEditor()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Tạo Cron
              </Button>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadCronJobs} disabled={cronLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${cronLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {cronLoading && !cronJobs ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-orange-400 animate-spin" /></div>
          ) : regularCronJobs.length === 0 ? (
            <div className="text-center py-8 text-stone-500 text-xs">Chưa có cron job nào. Nhấn &quot;Tạo Cron&quot; để bắt đầu.</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {regularCronJobs.map(job => (
                <div key={job.id} className="nc-wrap nc-orange-soft">
                  <div className="nc-panel nc-sm nc-border-orange-soft p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <code className="text-xs text-orange-300 bg-orange-950/50 px-1.5 py-0.5 rounded font-mono">{job.expression}</code>
                          <span className="text-[9px] text-orange-400/60">— {describeCronExpression(job.expression)}</span>
                          <Badge className={`text-[9px] ${job.enabled ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-500'}`}>
                            {job.enabled ? 'Active' : 'Paused'}
                          </Badge>
                        </div>
                        <p className="text-xs text-stone-300 truncate">{job.taskPrompt}</p>
                        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-stone-500">
                          <span>Chạy cuối: {timeAgo(job.lastRunAt)}</span>
                          {job.nextRunAt && <span>Tiếp: {new Date(job.nextRunAt).toLocaleString('vi-VN')}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => runCronNow(job.id)} title="Chạy ngay">
                          <Play className="w-3.5 h-3.5" />
                        </Button>
                        <Switch checked={job.enabled} onCheckedChange={(checked) => toggleCron(job.id, checked)} className="scale-75" />
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => openCronEditor(job)} title="Sửa">
                          <Edit3 className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-red-400" onClick={() => deleteCron(job.id)} title="Xóa">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Cron Editor (inline) */}
          {showCronEditor && (
            <div className="mt-4 pt-4 border-t border-orange-400/35">
              <h4 className="text-xs font-semibold text-orange-300 mb-3">{editingCron ? '✏️ Sửa Cron Job' : '➕ Tạo Cron Job'}</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Cron Expression</label>
                  <Input value={cronExpression} onChange={e => setCronExpression(e.target.value)} placeholder="0 9 * * *" className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                  {cronExpression && <p className="text-[9px] text-orange-400/70 mt-1">{describeCronExpression(cronExpression)}</p>}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {CRON_PRESETS.map(p => (
                      <Button key={p.expression} size="sm" variant="outline" className="h-6 text-[9px] text-orange-400 border-orange-400/35 hover:bg-orange-500/10" onClick={() => setCronExpression(p.expression)}>
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Task Prompt</label>
                  <textarea value={cronTaskPrompt} onChange={e => setCronTaskPrompt(e.target.value)} placeholder="Tóm tắt tin tức mỗi sáng..." rows={3} className="w-full text-xs bg-slate-950/60 border border-orange-400/35 rounded-md px-3 py-2 text-stone-200 focus:outline-none focus:border-orange-500/40 resize-none" />
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider">Bật ngay</label>
                  <Switch checked={cronEnabled} onCheckedChange={setCronEnabled} className="data-[state=checked]:bg-orange-500" />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveCron} disabled={cronSaving}>
                    {cronSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} {editingCron ? 'Cập nhật' : 'Tạo'}
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs text-stone-400 border-stone-600" onClick={() => { setShowCronEditor(false); setEditingCron(null) }}>Hủy</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 2: Heartbeat Config */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Heartbeat</h3>
              <Badge className={`text-[9px] ${heartbeat.enabled ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-500'}`}>
                {heartbeat.enabled ? 'Active' : 'Inactive'}
              </Badge>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Interval</label>
              <div className="flex flex-wrap gap-1.5">
                {HEARTBEAT_INTERVALS.map(iv => (
                  <Button key={iv} size="sm" variant={heartbeat.interval === iv ? 'default' : 'outline'}
                    className={`h-7 text-xs ${heartbeat.interval === iv ? 'bg-orange-500 text-white' : 'text-orange-400 border-orange-400/35 hover:bg-orange-500/10'}`}
                    onClick={() => setHeartbeat(prev => ({ ...prev, interval: iv }))}>
                    {iv}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Action Prompt</label>
              <Input value={heartbeat.actionPrompt} onChange={e => setHeartbeat(prev => ({ ...prev, actionPrompt: e.target.value }))}
                className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" />
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={heartbeat.enabled} onCheckedChange={(checked) => setHeartbeat(prev => ({ ...prev, enabled: checked }))}
                className="data-[state=checked]:bg-orange-500" />
              <span className="text-xs text-stone-400">{heartbeat.enabled ? 'Đang hoạt động' : 'Đã tắt'}</span>
            </div>
            <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveHeartbeat} disabled={heartbeatSaving}>
              {heartbeatSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} Lưu Heartbeat
            </Button>
          </div>
        </div>
      </div>

      {/* Section 3: Webhooks */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cable className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Webhooks</h3>
              {webhooks && webhooks.length > 0 && (
                <Badge variant="outline" className="text-orange-400 border-orange-500/30">{webhooks.length}</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={() => openWebhookEditor()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Thêm Webhook
              </Button>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadWebhooks} disabled={webhookLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${webhookLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {webhookLoading && !webhooks ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-orange-400 animate-spin" /></div>
          ) : !webhooks || webhooks.length === 0 ? (
            <div className="text-center py-8 text-stone-500 text-xs">Chưa có webhook nào.</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {webhooks.map(wh => {
                let eventsList: string[] = []
                try { eventsList = JSON.parse(wh.events) } catch { eventsList = [wh.events] }
                return (
                  <div key={wh.id} className="nc-wrap nc-orange-soft">
                    <div className="nc-panel nc-sm nc-border-orange-soft p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-orange-300 font-mono truncate">{wh.url}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {eventsList.map((ev, i) => (
                              <Badge key={i} className="text-[8px] bg-orange-950/50 text-orange-400">{ev}</Badge>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <Badge className={`text-[9px] ${wh.enabled ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-500'}`}>
                              {wh.enabled ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => testWebhook(wh.id)} title="Test">
                            <Zap className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => openWebhookEditor(wh)} title="Sửa">
                            <Edit3 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-red-400" onClick={() => deleteWebhook(wh.id)} title="Xóa">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Webhook Editor (inline) */}
          {showWebhookEditor && (
            <div className="mt-4 pt-4 border-t border-orange-400/35">
              <h4 className="text-xs font-semibold text-orange-300 mb-3">{editingWebhook ? '✏️ Sửa Webhook' : '➕ Thêm Webhook'}</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">URL</label>
                  <Input value={whUrl} onChange={e => setWhUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Events (phẩy ngăn cách)</label>
                  <Input value={whEvents} onChange={e => setWhEvents(e.target.value)} placeholder="document.uploaded, query.completed" className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Secret (tùy chọn)</label>
                  <Input value={whSecret} onChange={e => setWhSecret(e.target.value)} placeholder="whsec_..." type="password" className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div className="flex items-center gap-3">
                  <Switch checked={whEnabled} onCheckedChange={setWhEnabled} className="data-[state=checked]:bg-orange-500" />
                  <span className="text-xs text-stone-400">Bật ngay</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveWebhook} disabled={whSaving}>
                    {whSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} {editingWebhook ? 'Cập nhật' : 'Tạo'}
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs text-stone-400 border-stone-600" onClick={() => { setShowWebhookEditor(false); setEditingWebhook(null) }}>Hủy</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 4: Standing Orders */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Standing Orders</h3>
              {orders && <Badge variant="outline" className="text-orange-400 border-orange-500/30">{orders.length}</Badge>}
            </div>
            <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadOrders} disabled={ordersLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${ordersLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {ordersLoading && !orders ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-orange-400 animate-spin" /></div>
          ) : orders && orders.length > 0 ? (
            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {orders.map((o, idx) => (
                <div key={o.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-orange-950/20 border border-orange-500/10">
                  <span className="text-xs text-orange-400/60 font-mono w-5 text-right">{idx + 1}</span>
                  <Switch checked={o.enabled} onCheckedChange={(checked) => toggleOrder(o.id, checked)} className="scale-75 data-[state=checked]:bg-orange-500" />
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs truncate ${o.enabled ? 'text-stone-200' : 'text-stone-500 line-through'}`}>{o.order}</p>
                  </div>
                  <Badge className="text-[8px] bg-orange-950/50 text-orange-400">P{o.priority}</Badge>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-stone-500 hover:text-red-400" onClick={() => deleteOrder(o.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-stone-500 text-xs mb-4">Chưa có standing order nào.</div>
          )}

          {/* Add new order inline */}
          <div className="flex gap-2">
            <Input value={newOrder} onChange={e => setNewOrder(e.target.value)} placeholder="Thêm standing order mới..." className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200 flex-1"
              onKeyDown={e => { if (e.key === 'Enter') addOrder() }} />
            <Input value={newOrderPriority || ''} onChange={e => setNewOrderPriority(parseInt(e.target.value) || 0)} placeholder="P" type="number" min={0} max={100} className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200 w-14" />
            <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={addOrder}>
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Section 5: Task History */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Lịch sử thực thi</h3>
              {history && <Badge variant="outline" className="text-orange-400 border-orange-500/30">{history.length}</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Select value={historyFilter} onValueChange={setHistoryFilter}>
                <SelectTrigger className="h-7 w-28 text-[10px] bg-slate-950/60 border-orange-400/35 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="heartbeat">Heartbeat</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadHistory} disabled={historyLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {historyLoading && !history ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-orange-400 animate-spin" /></div>
          ) : !history || history.length === 0 ? (
            <div className="text-center py-4 text-stone-500 text-xs">Chưa có lịch sử thực thi nào.</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-orange-500/10">
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Thời gian</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Loại</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Trạng thái</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Thời lượng</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2">Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(task => (
                    <tr key={task.id} className="border-b border-orange-500/5 hover:bg-orange-950/10">
                      <td className="py-2 pr-2 text-stone-400 whitespace-nowrap">{new Date(task.startedAt).toLocaleString('vi-VN')}</td>
                      <td className="py-2 pr-2">
                        <Badge className={`text-[8px] ${task.type === 'cron' ? 'bg-orange-950/50 text-orange-400' : task.type === 'webhook' ? 'bg-blue-950/50 text-blue-400' : task.type === 'heartbeat' ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-400'}`}>
                          {task.type}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2">
                        <Badge className={`text-[8px] ${task.status === 'completed' ? 'bg-emerald-950/50 text-emerald-400' : task.status === 'failed' ? 'bg-red-950/50 text-red-400' : task.status === 'running' ? 'bg-amber-950/50 text-amber-400' : 'bg-slate-800 text-stone-400'}`}>
                          {task.status === 'completed' ? '✅ Done' : task.status === 'failed' ? '❌ Failed' : task.status === 'running' ? '⏳ Running' : '⏸️ Pending'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2 text-stone-400">{formatDuration(task.startedAt, task.completedAt)}</td>
                      <td className="py-2 text-stone-500 truncate max-w-48">
                        {task.errorMessage ? <span className="text-red-400">{task.errorMessage}</span> : task.result ? (
                          <details><summary className="cursor-pointer hover:text-orange-400">Xem</summary><pre className="mt-1 text-[9px] text-stone-400 whitespace-pre-wrap max-h-24 overflow-y-auto">{task.result}</pre></details>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Section 6: Task Flow Editor (Simplified Visual) */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center gap-2 mb-4">
            <Route className="w-5 h-5 text-orange-400" />
            <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Task Flow</h3>
          </div>
          <p className="text-[10px] text-stone-500 mb-4">Minh họa quy trình tự động hóa: Trigger → Action → Condition → Action</p>
          <div className="flex items-center gap-2 overflow-x-auto pb-2">
            {/* Trigger */}
            <div className="flex-shrink-0 p-3 rounded-lg bg-orange-950/30 border border-orange-400/35 min-w-[120px] text-center">
              <div className="p-1.5 rounded-md bg-orange-500/20 inline-block mb-2"><Clock className="w-4 h-4 text-orange-400" /></div>
              <p className="text-[10px] font-semibold text-orange-300">Trigger</p>
              <p className="text-[9px] text-stone-500">Cron / Webhook / Manual</p>
            </div>
            <ChevronRight className="w-4 h-4 text-orange-400/50 flex-shrink-0" />
            {/* Action */}
            <div className="flex-shrink-0 p-3 rounded-lg bg-orange-950/30 border border-orange-400/35 min-w-[120px] text-center">
              <div className="p-1.5 rounded-md bg-orange-500/20 inline-block mb-2"><Zap className="w-4 h-4 text-orange-400" /></div>
              <p className="text-[10px] font-semibold text-orange-300">Action</p>
              <p className="text-[9px] text-stone-500">Agent Prompt / Tool</p>
            </div>
            <ChevronRight className="w-4 h-4 text-orange-400/50 flex-shrink-0" />
            {/* Condition */}
            <div className="flex-shrink-0 p-3 rounded-lg bg-orange-950/30 border border-orange-400/35 min-w-[120px] text-center">
              <div className="p-1.5 rounded-md bg-orange-500/20 inline-block mb-2"><GitBranch className="w-4 h-4 text-orange-400" /></div>
              <p className="text-[10px] font-semibold text-orange-300">Condition</p>
              <p className="text-[9px] text-stone-500">If / Else</p>
            </div>
            <ChevronRight className="w-4 h-4 text-orange-400/50 flex-shrink-0" />
            {/* Result */}
            <div className="flex-shrink-0 p-3 rounded-lg bg-orange-950/30 border border-orange-400/35 min-w-[120px] text-center">
              <div className="p-1.5 rounded-md bg-orange-500/20 inline-block mb-2"><CheckCircle2 className="w-4 h-4 text-orange-400" /></div>
              <p className="text-[10px] font-semibold text-orange-300">Result</p>
              <p className="text-[9px] text-stone-500">Log / Notify</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge className="text-[9px] bg-orange-950/50 text-orange-400 border border-orange-400/35">Cron Jobs: {regularCronJobs.length}</Badge>
            <Badge className="text-[9px] bg-blue-950/50 text-blue-400 border border-blue-400/35">Webhooks: {webhooks?.length || 0}</Badge>
            <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">Heartbeat: {heartbeat.enabled ? heartbeat.interval : 'Off'}</Badge>
            <Badge className="text-[9px] bg-amber-950/50 text-amber-400 border border-amber-400/35">Orders: {orders?.length || 0}</Badge>
            <Badge className="text-[9px] bg-slate-800 text-stone-400 border border-stone-600">Executions: {history?.length || 0}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}

// ==================== CODE TAB (Phase OC-1) ====================

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
  children?: FileNode[]
}

function CodeTabContent() {
  // Server status
  const [serverOnline, setServerOnline] = useState(false)
  const [serverInfo, setServerInfo] = useState<{
    version: string; port: number; workspace: string; uptime: string; uptimeMs: number;
    sessions: { total: number; active: number; completed: number };
    tools: { available: string[]; count: number };
    lsp: { available: boolean; languages: string[] };
    mcp: { servers: string[]; connected: number };
  } | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [serverActionLoading, setServerActionLoading] = useState(false)

  // File explorer
  const [fileTree, setFileTree] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['src']))
  // Phase 8 — Monaco multi-tab state. selectedFile/fileContent/editedContent
  // are now COMPAT DERIVED values (same names, see below) so existing call
  // sites (file-tree highlight, header badges, save/revert buttons) keep working.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const openFilesRef = useRef<OpenFile[]>([])
  useEffect(() => { openFilesRef.current = openFiles })
  const activeOpenFile = openFiles[Math.min(Math.max(activeFileIndex, 0), Math.max(openFiles.length - 1, 0))]
  const selectedFile = activeOpenFile?.path ?? null
  const fileContent: { path: string; content: string; language: string; lines: number; size: number } | null = activeOpenFile
    ? {
        path: activeOpenFile.path,
        content: activeOpenFile.content,
        language: activeOpenFile.language || 'plaintext',
        lines: activeOpenFile.lines ?? activeOpenFile.content.split('\n').length,
        size: activeOpenFile.size ?? activeOpenFile.content.length,
      }
    : null
  const [fileLoading, setFileLoading] = useState(false)
  const [fileSearch, setFileSearch] = useState('')

  // Sessions
  const [sessions, setSessions] = useState<Array<{
    sessionId: string; model: string | null; provider: string | null;
    prompt: string | null; status: string; filesTouched: string[]; toolsUsed: string[];
    createdAt: string;
  }>>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [newSessionPrompt, setNewSessionPrompt] = useState('')
  const [newSessionModel, setNewSessionModel] = useState('deepseek/deepseek-chat')
  const [creatingSession, setCreatingSession] = useState(false)

  // MCP Bridge
  const [mcpStatus, setMcpStatus] = useState<{
    outbound: { description: string; tools: { name: string; enabled: boolean; source: string }[] };
    inbound: { description: string; tools: { name: string; enabled: boolean; source: string }[] };
    bridgeStatus: string; lastSync: string;
  } | null>(null)
  const [mcpSyncing, setMcpSyncing] = useState(false)
  const [mcpToggling, setMcpToggling] = useState<string | null>(null)

  // Terminal
  const [terminalOutput, setTerminalOutput] = useState<string[]>([])
  const [terminalLoading, setTerminalLoading] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState('')
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(192)
  const terminalDragRef = useRef<{ startY: number; startH: number } | null>(null)
  // Phase 4: persistent interactive shell (bash -i) session + SSE stream refs
  const terminalSessionIdRef = useRef<string | null>(null)
  const terminalEvtRef = useRef<EventSource | null>(null)
  const terminalBufferRef = useRef<string>('')
  const terminalPrevRootRef = useRef<string | null>(null)
  // Phase 7: scroll anchor for the terminal output panel (AI command echo)
  const terminalViewRef = useRef<HTMLDivElement | null>(null)

  // File Explorer resize
  const [fileExplorerHeight, setFileExplorerHeight] = useState(400)
  const fileExplorerDragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Preview panel
  const [showPreview, setShowPreview] = useState(false)
  const [previewPort, setPreviewPort] = useState<number | null>(null)
  const [previewDetecting, setPreviewDetecting] = useState(false)
  const [previewFramework, setPreviewFramework] = useState<string | null>(null)
  const [previewFrameworkIcon, setPreviewFrameworkIcon] = useState('📦')
  const [previewDevCommand, setPreviewDevCommand] = useState<string | null>(null)
  const [previewAutoStarting, setPreviewAutoStarting] = useState(false)
  const [previewAutoStartAttempted, setPreviewAutoStartAttempted] = useState(false)
  const [previewIframeKey, setPreviewIframeKey] = useState(0)
  const previewAutoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Phase 3: SSE log stream for the running preview dev server
  const previewEventSrcRef = useRef<EventSource | null>(null)
  const [previewLogs, setPreviewLogs] = useState<string[]>([])

  // LSP Diagnostics
  const [diagnostics, setDiagnostics] = useState<Array<{
    file?: string; line?: number; column?: number; severity?: string; code?: string; message?: string;
  }>>([])

  // Log modal
  const [showLogs, setShowLogs] = useState(false)
  const [serverLogs, setServerLogs] = useState<string[]>([])

  // Git Integration
  const [gitStatus, setGitStatus] = useState<{
    branch: string; lastCommit: string; modified: string[]; staged: string[]; untracked: string[];
    ahead: number; behind: number; totalChanges: number; available: boolean;
  }>({ branch: '', lastCommit: '', modified: [], staged: [], untracked: [], ahead: 0, behind: 0, totalChanges: 0, available: false })
  const [gitDiff, setGitDiff] = useState('')
  const [gitDiffStats, setGitDiffStats] = useState<{ additions: number; deletions: number; filesChanged: number }>({ additions: 0, deletions: 0, filesChanged: 0 })
  const [gitLoading, setGitLoading] = useState(false)
  const [gitSectionOpen, setGitSectionOpen] = useState(true)

  // Session Timeline
  const [selectedTimelineSession, setSelectedTimelineSession] = useState<string | null>(null)
  const [timelineData, setTimelineData] = useState<{ timeline: Array<{ timestamp: string; event: string; label: string; detail?: string }> }>({ timeline: [] })
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineSectionOpen, setTimelineSectionOpen] = useState(true)

  // Knowledge Context Panel
  const [kbContext, setKbContext] = useState<{
    entities: Array<{ name: string; type: string; description: string }>;
    documents: Array<{ source: string; score: number }>;
    corrections: Array<{ content: string; createdAt: string }>;
    insights: Array<{ content: string; type: string }>;
    enrichmentScore: number;
  }>({ entities: [], documents: [], corrections: [], insights: [], enrichmentScore: 0 })
  const [kbContextLoading, setKbContextLoading] = useState(false)
  const [kbContextQuery, setKbContextQuery] = useState('')
  const [kbSectionOpen, setKbSectionOpen] = useState(true)

  // Diff Viewer toggle
  const [diffViewActive, setDiffViewActive] = useState(false)
  // Phase 9: PendingEdit review (AI edit-before-write approval queue)
  const [pendingEdits, setPendingEdits] = useState<Array<Record<string, unknown>>>([])
  const [showPendingModal, setShowPendingModal] = useState(false)
  // Phase 10: workspace-wide search panel (ripgrep-backed)
  const [showSearchPanel, setShowSearchPanel] = useState(false)

  // Local File Explorer state
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem('smolab_layout_opencode_root') } catch { return null }
  })
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [folderPickerPath, setFolderPickerPath] = useState('/home/z')
  const [folderPickerItems, setFolderPickerItems] = useState<Array<{ name: string; path: string; type: 'directory' | 'file' }>>([])
  const [folderPickerLoading, setFolderPickerLoading] = useState(false)
  // Phase 8 compat: dirty-content of the ACTIVE tab (null = không có chỉnh sửa chưa lưu)
  const editedContent = activeOpenFile?.isDirty ? activeOpenFile.content : null
  const [isSaving, setIsSaving] = useState(false)
  const [showNewFileInput, setShowNewFileInput] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // ---- Data loading ----
  // Persist workspace root to localStorage
  useEffect(() => {
    if (workspaceRoot) {
      try { localStorage.setItem('smolab_layout_opencode_root', workspaceRoot) } catch {}
    } else {
      try { localStorage.removeItem('smolab_layout_opencode_root') } catch {}
    }
  }, [workspaceRoot])

  // Phase 2: folder picker commit — set local workspace + sync to DB as ACTIVE
  // workspace (POST /api/workspace; 409 conflict → PATCH existing → active).
  const handleWorkspaceSelect = useCallback(async (folderPath: string) => {
    setWorkspaceRoot(folderPath)
    if (typeof window !== 'undefined') localStorage.setItem('smolab_layout_opencode_root', folderPath)
    setFileTree([])
    setOpenFiles([])
    setActiveFileIndex(0)
    setShowFolderPicker(false)
    toast({ title: `Đã chọn workspace: ${folderPath}` })
    try {
      const folderName = folderPath.split('/').pop() || folderPath
      const createRes = await authedFetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, rootPath: folderPath }),
      })
      if (createRes.ok) {
        const created = await createRes.json()
        const id = created?.data?.id // response shape: {ok, data} — workspace lives in .data
        if (id) {
          await authedFetch('/api/workspace', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          })
        }
        toast({ title: 'Đã đăng ký workspace active trong DB' })
      } else if (createRes.status === 409) {
        const existing = await createRes.json()
        const id = existing?.data?.id
        if (id) {
          await authedFetch('/api/workspace', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          })
        }
        toast({ title: 'Workspace đã tồn tại, đã set active' })
      } else {
        console.error('Workspace register failed:', await createRes.text())
        toast({ title: 'Lỗi đăng ký workspace (xem console)', variant: 'destructive' })
      }
    } catch (err) {
      console.error('Workspace register exception:', err)
    }
  }, [])

  // Load folder picker contents
  const loadFolderPicker = useCallback(async (path: string) => {
    setFolderPickerLoading(true)
    try {
      const res = await authedFetch(`/api/opencode/files/browse?path=${encodeURIComponent(path)}&mode=all`)
      const data = await res.json()
      if (data.items) {
        setFolderPickerPath(data.currentPath)
        setFolderPickerItems(data.items)
      }
    } catch {
      setFolderPickerItems([])
    } finally {
      setFolderPickerLoading(false)
    }
  }, [])

  // Save file handler (Phase 8: multi-tab aware — saves openFiles[idx])
  const handleSaveFile = useCallback(async (idx?: number) => {
    const targetIdx = typeof idx === 'number' ? idx : activeFileIndex
    const target = openFiles[targetIdx]
    if (!target) return
    setIsSaving(true)
    try {
      const res = await authedFetch('/api/opencode/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.path, content: target.content }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã lưu file', description: target.path.split('/').pop() || target.path })
        // originalContent = what was actually saved; if the user typed more
        // while the request was in flight, the tab correctly stays dirty.
        setOpenFiles(prev => prev.map((f, i) => (i === targetIdx
          ? { ...f, originalContent: target.content, isDirty: f.content !== target.content }
          : f)))
        // Metadata refresh (language/lines/size) — best-effort, same GET as handleFileSelect
        if (workspaceRoot) {
          try {
            const readRes = await authedFetch(`/api/opencode/files/read?path=${encodeURIComponent(target.path)}&root=${encodeURIComponent(workspaceRoot)}`)
            const readData = await readRes.json()
            if (readData.content !== undefined) {
              setOpenFiles(prev => prev.map((f, i) => (i === targetIdx
                ? { ...f, language: readData.language ?? f.language, lines: readData.lines ?? f.lines, size: readData.size ?? f.size }
                : f)))
            }
          } catch {}
        }
      } else {
        toast({ title: 'Lỗi lưu file', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi lưu file', description: 'Network error', variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }, [activeFileIndex, openFiles, workspaceRoot])

  // Phase 8: Monaco multi-tab handlers
  const handleContentChange = useCallback((idx: number, content: string) => {
    setOpenFiles(prev => prev.map((f, i) => (i === idx ? { ...f, content, isDirty: content !== f.originalContent } : f)))
  }, [])

  const handleCloseFile = useCallback((idx: number) => {
    if (idx < 0 || idx >= openFiles.length) return
    const nextLength = openFiles.length - 1
    setOpenFiles(prev => prev.filter((_, i) => i !== idx))
    setActiveFileIndex(cur => {
      if (cur > idx) return cur - 1
      if (cur === idx) return Math.max(Math.min(cur, nextLength - 1), 0)
      return cur
    })
  }, [openFiles])

  // Phase 8: revert active (or given) tab back to its original content
  const handleRevertFile = useCallback((idx?: number) => {
    const targetIdx = typeof idx === 'number' ? idx : activeFileIndex
    setOpenFiles(prev => prev.map((f, i) => (i === targetIdx ? { ...f, content: f.originalContent, isDirty: false } : f)))
  }, [activeFileIndex])

  const loadFileTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      const url = workspaceRoot
        ? `/api/opencode/files/tree?root=${encodeURIComponent(workspaceRoot)}&depth=3`
        : '/api/opencode/files/tree?depth=3'
      const res = await authedFetch(url)
      const data = await res.json()
      setFileTree(data.tree || [])
    } catch {
      setFileTree([])
    } finally {
      setTreeLoading(false)
    }
  }, [workspaceRoot])

  // Phase 9: fetch AI edits waiting for review (before/after + approve/reject/apply lifecycle).
  // NOTE: no synchronous setState here — this is also called directly from an
  // effect (30s poll) and react-hooks/set-state-in-effect must stay quiet.
  const loadPendingEdits = useCallback(async () => {
    try {
      const res = await authedFetch('/api/openclaw/pending-edits?status=pending')
      const d = await res.json().catch(() => ({ ok: false }))
      if (d.ok) setPendingEdits(Array.isArray(d.edits) ? d.edits : [])
    } catch { /* offline — keep current list */ }
  }, [])

  // Phase 9: initial load + 30s poll. CodeTabContent only mounts while the
  // Code tab is visible, so being mounted IS the visibility gate. The initial
  // fetch goes through a 0ms timeout so no setState runs synchronously in the
  // effect body (react-hooks/set-state-in-effect stays at baseline).
  useEffect(() => {
    const initial = setTimeout(() => { void loadPendingEdits() }, 0)
    const timer = setInterval(() => { void loadPendingEdits() }, 30000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [loadPendingEdits])

  // Phase 10: rename/move a file or directory (prompt for the new path)
  const handleRenameFile = useCallback(async (filePath: string, name: string) => {
    if (!workspaceRoot) return
    const newPath = window.prompt('Đường dẫn mới:', filePath)
    if (!newPath || !newPath.trim() || newPath.trim() === filePath) return
    try {
      const res = await authedFetch('/api/opencode/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: filePath, newPath: newPath.trim(), root: workspaceRoot }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: 'Đã đổi tên', description: `${name} → ${String(newPath.split('/').pop())}` })
        // keep open tabs pointing at the new path
        const next = openFilesRef.current.map(f => (f.path === filePath ? { ...f, path: data.newPath || newPath.trim() } : f))
        setOpenFiles(next)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi đổi tên', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [workspaceRoot, loadFileTree])

  // Phase 10: delete a file or directory (confirm first; server has path-escape guard)
  const handleDeleteFile = useCallback(async (filePath: string, name: string) => {
    if (!workspaceRoot) return
    if (!window.confirm(`Xóa ${name}?`)) return
    try {
      const res = await authedFetch('/api/opencode/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, root: workspaceRoot }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: 'Đã xóa', description: name })
        const idx = openFilesRef.current.findIndex(f => f.path === filePath)
        if (idx >= 0) handleCloseFile(idx)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi xóa file', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [workspaceRoot, handleCloseFile, loadFileTree])

  // Create new file handler
  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim() || !workspaceRoot) return
    const trimmed = newFileName.trim()
    const fullPath = trimmed.startsWith('/') ? trimmed : `${workspaceRoot}/${trimmed}`
    try {
      const res = await authedFetch('/api/opencode/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, content: '' }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã tạo file', description: newFileName })
        setNewFileName('')
        setShowNewFileInput(false)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi tạo file', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [newFileName, workspaceRoot, loadFileTree])

  // Create new folder handler
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !workspaceRoot) return
    const trimmed = newFolderName.trim()
    const fullPath = trimmed.startsWith('/') ? trimmed : `${workspaceRoot}/${trimmed}`
    try {
      const res = await authedFetch('/api/opencode/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã tạo thư mục', description: newFolderName })
        setNewFolderName('')
        setShowNewFolderInput(false)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi tạo thư mục', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [newFolderName, workspaceRoot, loadFileTree])

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const res = await authedFetch('/api/opencode/status')
      const data = await res.json()
      setServerOnline(data.online)
      setServerInfo(data.serverInfo)
    } catch {
      setServerOnline(false)
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const res = await authedFetch('/api/opencode/sessions')
      const data = await res.json()
      setSessions(data.sessions || [])
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const loadMcpStatus = useCallback(async () => {
    try {
      const res = await authedFetch('/api/opencode/mcp/status')
      const data = await res.json()
      setMcpStatus(data)
    } catch {
      setMcpStatus(null)
    }
  }, [])

  const loadTerminal = useCallback(async () => {
    setTerminalLoading(true)
    try {
      const res = await authedFetch('/api/opencode/terminal')
      const data = await res.json()
      if (data.output && Array.isArray(data.output)) {
        setTerminalOutput(data.output)
      } else if (data.terminals) {
        const allLines: string[] = []
        for (const lines of Object.values(data.terminals) as string[][]) {
          allLines.push(...lines)
        }
        setTerminalOutput(allLines)
      } else {
        setTerminalOutput([])
      }
    } catch {
      setTerminalOutput([])
    } finally {
      setTerminalLoading(false)
    }
  }, [])

  const loadDiagnostics = useCallback(async () => {
    try {
      const res = await authedFetch('/api/opencode/lsp/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const data = await res.json()
      setDiagnostics(data.diagnostics || [])
    } catch {
      setDiagnostics([])
    }
  }, [])

  const loadGitStatus = useCallback(async () => {
    setGitLoading(true)
    try {
      const res = await authedFetch('/api/opencode/git/status')
      const data = await res.json()
      setGitStatus({
        branch: data.branch || '',
        lastCommit: data.lastCommit || '',
        modified: data.modified || [],
        staged: data.staged || [],
        untracked: data.untracked || [],
        ahead: data.ahead || 0,
        behind: data.behind || 0,
        totalChanges: data.totalChanges || 0,
        available: data.available !== false,
      })
    } catch {
      setGitStatus(prev => ({ ...prev, available: false }))
    } finally {
      setGitLoading(false)
    }
  }, [])

  const loadGitDiff = useCallback(async (staged: boolean = false) => {
    setGitLoading(true)
    try {
      const res = await authedFetch(`/api/opencode/git/diff?staged=${staged}`)
      const data = await res.json()
      setGitDiff(data.diff || '')
      setGitDiffStats({
        additions: data.stats?.additions || 0,
        deletions: data.stats?.deletions || 0,
        filesChanged: data.stats?.filesChanged || 0,
      })
    } catch {
      setGitDiff('Không thể tải diff')
      setGitDiffStats({ additions: 0, deletions: 0, filesChanged: 0 })
    } finally {
      setGitLoading(false)
    }
  }, [])

  const loadTimeline = useCallback(async (sessionId: string) => {
    setTimelineLoading(true)
    setSelectedTimelineSession(sessionId)
    try {
      const res = await authedFetch(`/api/opencode/sessions/${encodeURIComponent(sessionId)}/timeline`)
      const data = await res.json()
      setTimelineData({ timeline: data.timeline || [] })
    } catch {
      setTimelineData({ timeline: [] })
    } finally {
      setTimelineLoading(false)
    }
  }, [])

  const loadKbContext = useCallback(async (query?: string) => {
    setKbContextLoading(true)
    try {
      const url = query ? `/api/opencode/knowledge/enrich?query=${encodeURIComponent(query)}` : '/api/opencode/knowledge/enrich'
      const res = await authedFetch(url)
      const data = await res.json()
      // The API returns { enrichment: { entities, documents, corrections, insights, enrichmentScore } }
      const enrichment = data.enrichment || data
      setKbContext({
        entities: enrichment.entities || [],
        documents: enrichment.documents || [],
        corrections: enrichment.corrections || [],
        insights: enrichment.insights || [],
        enrichmentScore: enrichment.enrichmentScore || 0,
      })
    } catch {
      setKbContext({ entities: [], documents: [], corrections: [], insights: [], enrichmentScore: 0 })
    } finally {
      setKbContextLoading(false)
    }
  }, [])

  // Initial load + polling
  useEffect(() => {
    loadStatus()
    loadFileTree()
    loadSessions()
    loadMcpStatus()
    loadTerminal()
    loadDiagnostics()
    loadGitStatus()
    loadKbContext()
    const interval = setInterval(() => { loadStatus() }, 30000)
    return () => clearInterval(interval)
  }, [loadStatus, loadFileTree, loadSessions, loadMcpStatus, loadTerminal, loadDiagnostics, loadGitStatus, loadKbContext])

  // Reload file tree when workspace root changes
  useEffect(() => {
    if (workspaceRoot) {
      loadFileTree()
    }
  }, [workspaceRoot, loadFileTree])

  // File Explorer drag-to-resize handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!fileExplorerDragRef.current) return
      const delta = e.clientY - fileExplorerDragRef.current.startY
      const newH = Math.max(200, Math.min(900, fileExplorerDragRef.current.startH + delta))
      setFileExplorerHeight(newH)
    }
    const handleMouseUp = () => {
      fileExplorerDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Terminal drag-to-resize handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!terminalDragRef.current) return
      const delta = e.clientY - terminalDragRef.current.startY
      const newH = Math.max(120, Math.min(900, terminalDragRef.current.startH + delta))
      setTerminalHeight(newH)
    }
    const handleMouseUp = () => {
      terminalDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ---- Handlers ----
  const handleServerAction = useCallback(async (action: 'restart' | 'stop' | 'start') => {
    setServerActionLoading(true)
    try {
      const res = await authedFetch('/api/opencode/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      toast({ title: action === 'restart' ? 'Đang khởi động lại...' : action === 'stop' ? 'Đang dừng server...' : 'Đang khởi động...', description: data.message })
      setTimeout(() => { loadStatus() }, 2000)
    } catch {
      toast({ title: 'Lỗi', description: `Không thể ${action} server`, variant: 'destructive' })
    } finally {
      setServerActionLoading(false)
    }
  }, [loadStatus])

  const handleViewLogs = useCallback(async () => {
    try {
      // Try fetching server logs from the dedicated logs endpoint
      const res = await authedFetch('/api/opencode/terminal')
      const data = await res.json()
      const logs: string[] = []
      // Collect server output lines
      if (data.output && Array.isArray(data.output)) {
        logs.push(...data.output)
      } else if (data.terminals) {
        for (const lines of Object.values(data.terminals) as string[][]) {
          logs.push(...lines)
        }
      }
      // Also try to get server process logs
      try {
        const statusRes = await authedFetch('/api/opencode/status')
        const statusData = await statusRes.json()
        if (statusData.online) {
          logs.push(`[${new Date().toISOString()}] Server Status: Online`)
          if (statusData.serverInfo) {
            logs.push(`  Version: ${statusData.serverInfo.version}`)
            logs.push(`  Uptime: ${statusData.serverInfo.uptime}`)
            logs.push(`  Sessions: ${statusData.serverInfo.sessions?.active || 0} active`)
            logs.push(`  Tools: ${statusData.serverInfo.tools?.count || 0} available`)
            logs.push(`  MCP: ${statusData.serverInfo.mcp?.connected || 0} servers`)
          }
        } else {
          logs.push(`[${new Date().toISOString()}] Server Status: Offline`)
        }
      } catch {}
      setServerLogs(logs.length > 0 ? logs : ['No logs available — server may be offline'])
      setShowLogs(true)
    } catch {
      setServerLogs(['Error fetching logs'])
      setShowLogs(true)
    }
  }, [])

  const handleFileSelect = useCallback(async (path: string, opts?: { refresh?: boolean }) => {
    // Phase 8: multi-tab aware. Name + signature preserved (Phase 7 AI-tool
    // bridge + file tree click depend on it).
    // Phase 7: opts.refresh — force a fresh fetch (the AI edited the file on
    // disk; bust any cache so the editor shows the new content).
    const loadDiagnostics = async () => {
      try {
        const diagRes = await authedFetch('/api/opencode/lsp/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: path }),
        })
        const diagData = await diagRes.json()
        setDiagnostics(diagData.diagnostics || [])
      } catch {}
    }
    const existingIdx = openFilesRef.current.findIndex(f => f.path === path)
    if (existingIdx >= 0) {
      setActiveFileIndex(existingIdx)
      if (!opts?.refresh) {
        // Tab already open — just activate it + reload diagnostics
        await loadDiagnostics()
        return
      }
    }
    setFileLoading(true)
    try {
      const baseUrl = workspaceRoot
        ? `/api/opencode/files/read?path=${encodeURIComponent(path)}&root=${encodeURIComponent(workspaceRoot)}`
        : `/api/opencode/files/read?path=${encodeURIComponent(path)}`
      const url = opts?.refresh ? `${baseUrl}&_=${Date.now()}` : baseUrl
      const res = await authedFetch(url)
      const data = await res.json()
      if (data.content !== undefined) {
        const entry: OpenFile = {
          path,
          content: data.content,
          originalContent: data.content,
          isDirty: false,
          language: data.language,
          lines: data.lines,
          size: data.size,
        }
        if (existingIdx >= 0) {
          // refresh: replace content in the existing tab
          setOpenFiles(prev => prev.map((f, i) => (i === existingIdx ? entry : f)))
        } else {
          // new file: append tab + activate (ref is pre-append → its length IS the new index)
          setOpenFiles(prev => [...prev, entry])
          setActiveFileIndex(Math.max(openFilesRef.current.length, 0))
        }
        // Load diagnostics for this file
        await loadDiagnostics()
      }
    } catch {
    } finally {
      setFileLoading(false)
    }
  }, [workspaceRoot])

  const handleCreateSession = useCallback(async () => {
    if (!newSessionPrompt.trim()) return
    setCreatingSession(true)
    try {
      const res = await authedFetch('/api/opencode/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: newSessionPrompt, model: newSessionModel }),
      })
      const data = await res.json()
      if (data.session) {
        toast({ title: 'Session created', description: `Session ${data.session.sessionId?.substring(0, 8)}...` })
        setNewSessionPrompt('')
        loadSessions()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Failed to create session', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to create session', variant: 'destructive' })
    } finally {
      setCreatingSession(false)
    }
  }, [newSessionPrompt, newSessionModel, loadSessions])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch(`/api/opencode/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      toast({ title: 'Session deleted' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to delete session', variant: 'destructive' })
    }
  }, [loadSessions])

  const handlePauseSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch('/api/opencode/sessions/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      toast({ title: 'Session paused' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to pause session', variant: 'destructive' })
    }
  }, [loadSessions])

  const handleResumeSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch('/api/opencode/sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      toast({ title: 'Session resumed' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to resume session', variant: 'destructive' })
    }
  }, [loadSessions])

  // Phase 4: append a raw SSE chunk as complete lines (partial line stays buffered)
  const appendTerminalChunk = useCallback((chunk: string) => {
    const clean = chunk.replace(/\r/g, '')
    terminalBufferRef.current += clean
    const lines = terminalBufferRef.current.split('\n')
    terminalBufferRef.current = lines.pop() ?? ''
    if (lines.length > 0) {
      setTerminalOutput(prev => [...prev, ...lines].slice(-500))
    }
  }, [])

  // Phase 4: handle one SSE frame from the terminal stream
  const handleTerminalFrame = useCallback((parsed: { type?: string; data?: string; code?: number | null } | null) => {
    if (!parsed) return
    if (parsed.type === 'init') {
      // Replay: replace the panel with the server-side cumulative output
      terminalBufferRef.current = ''
      setTerminalOutput([])
      if (parsed.data) appendTerminalChunk(String(parsed.data))
    } else if (parsed.type === 'chunk' && parsed.data) {
      appendTerminalChunk(String(parsed.data))
    } else if (parsed.type === 'exit') {
      // Shell died — close SSE + clear ref so the next command spawns a fresh shell
      try { terminalEvtRef.current?.close() } catch { /* ignore */ }
      terminalEvtRef.current = null
      terminalSessionIdRef.current = null
      const rest = terminalBufferRef.current
      terminalBufferRef.current = ''
      setTerminalOutput(prev => [...prev, ...(rest ? [rest] : []), `[exit ${parsed.code ?? 'null'}]`].slice(-500))
    }
  }, [appendTerminalChunk])

  // Phase 4: lazily create the persistent shell session + open its SSE stream.
  // Waits for the FIRST init frame (≤2s) before returning so the local `$ cmd`
  // echo isn't immediately wiped by the init replay.
  const ensureTerminalSession = useCallback(async (): Promise<string | null> => {
    if (terminalSessionIdRef.current) return terminalSessionIdRef.current
    try {
      const res = await authedFetch('/api/opencode/terminal/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: workspaceRoot || undefined }),
      })
      const data = await res.json()
      if (!res.ok || !data?.sessionId) throw new Error(data?.error || 'start failed')
      const sid: string = data.sessionId
      terminalSessionIdRef.current = sid

      // Open the SSE stream; resolve once the init frame lands (or 2s timeout)
      await new Promise<void>(resolve => {
        let settled = false
        const finish = (): void => { if (!settled) { settled = true; resolve() } }
        const timer = setTimeout(finish, 2000)
        try {
          // EventSource cannot set headers — auth relies on the HttpOnly
          // tmo_api_token cookie set by /api/auth/setup on mount.
          const es = new EventSource(`/api/opencode/terminal/stream?sessionId=${encodeURIComponent(sid)}`)
          terminalEvtRef.current = es
          es.onmessage = (ev: MessageEvent<string>) => {
            let parsed: { type?: string; data?: string; code?: number | null } | null = null
            try { parsed = JSON.parse(ev.data) } catch { return }
            if (!settled && parsed?.type === 'init') {
              clearTimeout(timer)
              finish()
            }
            handleTerminalFrame(parsed)
          }
          es.onerror = () => {
            // auto-reconnect handles transient drops; just stop waiting
            clearTimeout(timer)
            finish()
          }
        } catch {
          clearTimeout(timer)
          finish()
        }
      })
      return sid
    } catch (err) {
      console.error('Terminal session start failed:', err)
      terminalSessionIdRef.current = null
      return null
    }
  }, [workspaceRoot, handleTerminalFrame])

  // Phase 4: workspace changed — tear down the terminal session (SSE + shell)
  // so the next command spawns a fresh shell in the NEW cwd.
  useEffect(() => {
    const prevRoot = terminalPrevRootRef.current
    terminalPrevRootRef.current = workspaceRoot
    if (prevRoot === workspaceRoot) return
    const oldSid = terminalSessionIdRef.current
    if (!oldSid) return
    terminalSessionIdRef.current = null
    try { terminalEvtRef.current?.close() } catch { /* ignore */ }
    terminalEvtRef.current = null
    void authedFetch('/api/opencode/terminal/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: oldSid }),
    }).catch(() => { /* best-effort */ })
  }, [workspaceRoot])

  // Phase 4: unmount — stop listening (server session reaped by idle cleanup)
  useEffect(() => {
    return () => {
      try { terminalEvtRef.current?.close() } catch { /* ignore */ }
      terminalEvtRef.current = null
    }
  }, [])

  // Phase 4: kill the shell session now; it is lazily re-created on next command
  const handleTerminalRestart = useCallback(() => {
    const oldSid = terminalSessionIdRef.current
    terminalSessionIdRef.current = null
    try { terminalEvtRef.current?.close() } catch { /* ignore */ }
    terminalEvtRef.current = null
    if (oldSid) {
      void authedFetch('/api/opencode/terminal/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: oldSid }),
      }).catch(() => { /* best-effort */ })
    }
    setTerminalOutput(prev => [...prev, '[terminal restarted]'])
    toast({ title: 'Terminal đã dừng', description: 'Shell mới sẽ khởi động ở lệnh kế tiếp' })
  }, [])

  const handleExecuteCommand = useCallback(async () => {
    if (!terminalCommand.trim()) return
    setTerminalRunning(true)
    const cmd = terminalCommand
    setTerminalCommand('')
    // Phase 4: persistent shell — cwd/env/background jobs survive between commands
    const sid = await ensureTerminalSession()
    setTerminalOutput(prev => [...prev, `$ ${cmd}`])
    if (sid) {
      try {
        const res = await authedFetch('/api/opencode/terminal/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, data: `${cmd}\n` }),
        })
        if (res.ok) {
          const data = await res.json()
          if (data?.ok) {
            return // output streams in via SSE (terminalEvtRef)
          }
        }
      } catch { /* fall through to legacy one-shot execute */ }
    }
    // Legacy fallback: one-shot /api/opencode/execute
    try {
      const res = await authedFetch('/api/opencode/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd: workspaceRoot || undefined }),
      })
      const data = await res.json()
      if (data.output) {
        setTerminalOutput(prev => [...prev, ...data.output.split('\n')])
      }
      if (data.error && !data.success) {
        setTerminalOutput(prev => [...prev, `Error (exit ${data.exitCode ?? 1}): ${data.error}`])
      }
      if (data.source === 'local-exec') {
        // Show source indicator for local execution
        setTerminalOutput(prev => prev.length > 0 && prev[prev.length - 1] !== '' ? prev : [...prev, `[local-exec]`])
      }
    } catch {
      setTerminalOutput(prev => [...prev, 'Error: Failed to execute command'])
    } finally {
      setTerminalRunning(false)
    }
  }, [terminalCommand, workspaceRoot, ensureTerminalSession])

  // Phase 3: subscribe to the dev-server log SSE stream for a workspace root
  const startPreviewLogStream = useCallback((root: string) => {
    try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
    previewEventSrcRef.current = null
    setPreviewLogs([])
    try {
      // EventSource cannot set headers — auth relies on the HttpOnly
      // tmo_api_token cookie set by /api/auth/setup on mount.
      const es = new EventSource(`/api/opencode/preview/stream?root=${encodeURIComponent(root)}`)
      previewEventSrcRef.current = es
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as { type?: string; data?: string }
          if (parsed?.type === 'init') {
            const lines = String(parsed.data || '').split('\n').filter(Boolean)
            setPreviewLogs(lines)
          } else if (parsed?.type === 'chunk' && parsed.data) {
            const lines = String(parsed.data).split('\n').filter(Boolean)
            if (lines.length > 0) setPreviewLogs(prev => [...prev, ...lines].slice(-200))
          }
        } catch { /* malformed frame — ignore */ }
      }
    } catch (err) {
      console.error('Preview log stream error:', err)
    }
  }, [])

  // Close the preview SSE stream when the tab unmounts
  useEffect(() => {
    return () => {
      try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
      previewEventSrcRef.current = null
    }
  }, [])

  // Smart Preview: detect framework, find port, auto-start dev server, auto-refresh
  const handlePreviewToggle = useCallback(async () => {
    if (showPreview) {
      // OFF — tear everything down (SSE, logs, detached dev-server process)
      setShowPreview(false)
      setPreviewPort(null)
      // Clean up auto-start timer
      if (previewAutoStartTimerRef.current) {
        clearTimeout(previewAutoStartTimerRef.current)
        previewAutoStartTimerRef.current = null
      }
      // Close SSE log stream + clear captured logs
      try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
      previewEventSrcRef.current = null
      setPreviewLogs([])
      // Kill the detached dev-server process group for this workspace
      if (workspaceRoot) {
        try {
          await authedFetch('/api/opencode/preview/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root: workspaceRoot }),
          })
        } catch (err) {
          console.error('Preview stop failed:', err)
        }
      }
      return
    }
    setShowPreview(true)
    setPreviewAutoStartAttempted(false)
    setPreviewAutoStarting(false)
    if (!workspaceRoot) return
    setPreviewDetecting(true)
    setPreviewPort(null)
    setPreviewFramework(null)
    setPreviewFrameworkIcon('📦')
    setPreviewDevCommand(null)
    setPreviewLogs([])

    try {
      // Step 1: Smart detect — framework, configured port, running ports
      const detectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
      if (detectRes.ok) {
        const detectData = await detectRes.json()

        // Update framework info
        if (detectData.framework) {
          setPreviewFramework(detectData.framework)
          setPreviewFrameworkIcon(detectData.frameworkIcon || '📦')
        }
        if (detectData.devCommand) {
          setPreviewDevCommand(detectData.devCommand)
        }

        // Step 2: If port already detected, use it immediately
        if (detectData.detectedPort) {
          setPreviewPort(detectData.detectedPort)
          startPreviewLogStream(workspaceRoot)
          setPreviewDetecting(false)
          return
        }

        // Step 3: Auto-start dev server if we have a dev command
        if (detectData.devCommand && !detectData.detectedPort) {
          setPreviewAutoStarting(true)
          setPreviewAutoStartAttempted(true)

          try {
            const startRes = await authedFetch('/api/opencode/preview/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                root: workspaceRoot,
                script: detectData.devScript || 'dev',
              }),
            })

            if (startRes.ok) {
              const startData = await startRes.json()
              const startedPort: number | null = startData?.port ?? null

              if (startedPort) {
                // Phase 3: start route picked a free port (>= 3005) for us
                setPreviewPort(startedPort)
                // Tail the dev-server log via SSE
                startPreviewLogStream(workspaceRoot)
                // Port-ready poll: remount the iframe only once the dev server
                // actually accepts connections (timing-race fix — no manual
                // refresh needed)
                void (async () => {
                  for (let i = 0; i < 24; i++) {
                    await new Promise(r => setTimeout(r, 500))
                    try {
                      await fetch(`http://127.0.0.1:${startedPort}`, { mode: 'no-cors', signal: AbortSignal.timeout(800) })
                      setPreviewIframeKey(prev => prev + 1)
                      return
                    } catch { /* not ready yet — keep polling */ }
                  }
                })()
              } else if (startData.status === 'started' || startData.status === 'already_running') {
                // Legacy path (no port reported) — poll for port with retries
                const maxRetries = 15
                const retryDelay = 2000 // 2s between retries
                let found = false

                for (let i = 0; i < maxRetries; i++) {
                  await new Promise(r => setTimeout(r, retryDelay))
                  // Re-detect to find the newly started port
                  const reDetectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
                  if (reDetectRes.ok) {
                    const reDetectData = await reDetectRes.json()
                    if (reDetectData.detectedPort) {
                      setPreviewPort(reDetectData.detectedPort)
                      found = true
                      break
                    }
                  }
                }

                if (!found) {
                  // Server started but port not detected yet
                  // Show a helpful message with retry
                }
              }
            }
          } catch {
            // Auto-start failed
          } finally {
            setPreviewAutoStarting(false)
          }
        }
      }
    } catch {
      // Detection failed — fallback: try basic port scan
      // Phase 3: skip TMO's own reserved ports 3000-3004 (self-collision)
      const ports = [3005, 3006, 3007, 3008, 5173, 5174, 8080, 4000, 4200, 8000, 4173]
      for (const port of ports) {
        try {
          const checkRes = await fetch(`http://127.0.0.1:${port}`, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
          if (checkRes.ok) {
            setPreviewPort(port)
            break
          }
        } catch { continue }
      }
    } finally {
      setPreviewDetecting(false)
    }
  }, [showPreview, workspaceRoot, startPreviewLogStream])

  // ==================== PHASE 7: AI-DRIVEN PREVIEW + TOOL EVENT HANDLING ====================

  /** openAiPreview — mirror of the handlePreviewToggle ON branch, but the AI
   *  already started the dev server (start_preview tool) on a KNOWN port, so
   *  we skip detect/auto-start and wire the panel directly: SSE log stream +
   *  port-ready poll (remount iframe once the server accepts connections). */
  const openAiPreview = useCallback((port: number, root?: string) => {
    if (!port || port <= 0) return
    const previewRoot = (typeof root === 'string' && root) || workspaceRoot || ''
    setShowPreview(true)
    setPreviewDetecting(false)
    setPreviewAutoStarting(false)
    setPreviewAutoStartAttempted(true)
    setPreviewPort(port)
    setPreviewLogs([])
    // Tail the dev-server log (closes any previous stream first)
    if (previewRoot) startPreviewLogStream(previewRoot)
    // Port-ready poll — timing-race fix (same as handlePreviewToggle)
    void (async () => {
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500))
        try {
          await fetch(`http://127.0.0.1:${port}`, { mode: 'no-cors', signal: AbortSignal.timeout(800) })
          setPreviewIframeKey(prev => prev + 1)
          return
        } catch { /* not ready yet — keep polling */ }
      }
    })()
    toast({ title: '🚀 AI đã start preview', description: `Port ${port}` })
  }, [workspaceRoot, startPreviewLogStream])

  /** handleAIToolEvent — react to AI tool calls streamed from the code-team
   *  workflow (via the 'tmo-ai-tool-event' window CustomEvent dispatched by
   *  the chat submit handler's SSE reader):
   *    tool_call  file_read/file_edit*    → open the file in the editor + toast
   *    tool_call  shell / opencode(bash)  → echo `$ [AI] cmd` in the Terminal
   *    tool_result file_edit* (OK)        → refresh tree + reload file + toast ✅
   *    tool_result file_delete (OK)       → refresh tree + toast 🗑️
   *    tool_result start_preview (OK)     → openAiPreview(port, root)
   *    tool_result stop_preview  (OK)     → tear the preview panel down
   *  Fully defensive — any parsing failure is swallowed (never break the UI). */
  const handleAIToolEvent = useCallback((ev: {type?: string; tool?: string; detail?: string; result?: string}) => {
    try {
      if (!ev || (ev.type !== 'tool_call' && ev.type !== 'tool_result')) return
      const tool = typeof ev.tool === 'string' ? ev.tool : ''
      if (!tool) return
      let detail: Record<string, unknown> | null = null
      try { detail = ev.detail ? JSON.parse(ev.detail) : null } catch { /* truncated */ }
      const rawDetail = typeof ev.detail === 'string' ? ev.detail : ''
      const argPath = typeof detail?.path === 'string' ? detail.path
        : typeof detail?.filePath === 'string' ? detail.filePath
        : typeof detail?.file_path === 'string' ? detail.file_path : null
      const deletedPath = typeof detail?.deleted === 'string' ? detail.deleted : null
      const pathFromDetail = argPath || deletedPath || extractJsonStringField(rawDetail, 'path') || extractJsonStringField(rawDetail, 'deleted')
      const resolveAbs = (p?: string | null): string | null => {
        if (typeof p !== 'string' || !p) return null
        if (p.startsWith('/')) return p
        return workspaceRoot ? `${workspaceRoot.replace(/\/+$/, '')}/${p}` : p
      }
      const absPath = resolveAbs(pathFromDetail)
      const fileName = pathFileName(absPath || pathFromDetail)
      if (ev.type === 'tool_call') {
        switch (tool) {
          case 'file_read': if (absPath) { void handleFileSelect(absPath); toast({ title: `📖 AI đang đọc ${fileName}` }) } break
          case 'file_edit': case 'file_multi_edit': if (absPath) { void handleFileSelect(absPath); toast({ title: `✏️ AI đang sửa ${fileName}` }) } break
          case 'shell': {
            const cmd = (typeof detail?.command === 'string' ? detail.command : null) || extractJsonStringField(rawDetail, 'command') || rawDetail
            setTerminalOutput(prev => [...prev, `$ [AI] ${String(cmd).slice(0, 120)}`])
            try { terminalViewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
            toast({ title: '▶️ AI chạy lệnh', description: String(cmd).slice(0, 60) })
            break
          }
          case 'opencode': {
            const action = (typeof detail?.action === 'string' ? detail.action : null) || extractJsonStringField(rawDetail, 'action')
            if ((action === 'read' || action === 'write') && absPath) {
              void handleFileSelect(absPath)
              toast({ title: action === 'read' ? `📖 AI đang đọc ${fileName}` : `✏️ AI đang sửa ${fileName}` })
            } else if (action === 'bash') {
              const cmd = (typeof detail?.command === 'string' ? detail.command : null) || extractJsonStringField(rawDetail, 'command') || rawDetail
              setTerminalOutput(prev => [...prev, `$ [AI] ${String(cmd).slice(0, 120)}`])
              try { terminalViewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
              toast({ title: '▶️ AI chạy lệnh', description: String(cmd).slice(0, 60) })
            }
            break
          }
        }
      } else if (ev.result !== 'Error') {
        switch (tool) {
          case 'file_edit': case 'file_multi_edit': {
            void loadFileTree()
            void loadPendingEdits()
            if (absPath) { void handleFileSelect(absPath, { refresh: true }); toast({ title: `✅ AI đã sửa ${fileName}` }) }
            break
          }
          case 'file_delete': { void loadFileTree(); toast({ title: `🗑️ AI đã xóa ${fileName || 'file'}` }); break }
          case 'start_preview': {
            const port = typeof detail?.port === 'number' ? detail.port : extractJsonNumberField(rawDetail, 'port') || 0
            if (port > 0) openAiPreview(port, typeof detail?.root === 'string' ? detail.root : undefined)
            break
          }
          case 'stop_preview': {
            previewEventSrcRef.current?.close(); previewEventSrcRef.current = null
            setPreviewLogs([]); setShowPreview(false); setPreviewPort(null)
            toast({ title: '⏹️ AI đã stop preview' })
            break
          }
        }
      }
    } catch (err) { console.warn('[ai-tool-event]', err) }
  }, [workspaceRoot, handleFileSelect, loadFileTree, loadPendingEdits, openAiPreview])

  // Phase 7: subscribe CodeTabContent to AI tool events dispatched by the
  // chat submit handler's workflow SSE reader.
  useEffect(() => {
    const listener = (e: Event) => {
      try { handleAIToolEvent((e as CustomEvent).detail) } catch { /* ignore */ }
    }
    window.addEventListener(AI_TOOL_EVENT_NAME, listener)
    return () => { window.removeEventListener(AI_TOOL_EVENT_NAME, listener) }
  }, [handleAIToolEvent])

  // Refresh iframe (for auto-refresh after file changes)
  const handlePreviewRefresh = useCallback(() => {
    setPreviewIframeKey(prev => prev + 1)
  }, [])

  // Retry preview detection
  const handlePreviewRetry = useCallback(async () => {
    if (!workspaceRoot) return
    setPreviewDetecting(true)
    setPreviewPort(null)
    setPreviewAutoStartAttempted(false)
    setPreviewAutoStarting(false)

    try {
      const detectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
      if (detectRes.ok) {
        const detectData = await detectRes.json()
        if (detectData.framework) {
          setPreviewFramework(detectData.framework)
          setPreviewFrameworkIcon(detectData.frameworkIcon || '📦')
        }
        if (detectData.devCommand) {
          setPreviewDevCommand(detectData.devCommand)
        }
        if (detectData.detectedPort) {
          setPreviewPort(detectData.detectedPort)
        } else if (detectData.devCommand) {
          // Try auto-start
          setPreviewAutoStarting(true)
          setPreviewAutoStartAttempted(true)
          try {
            const startRes = await authedFetch('/api/opencode/preview/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ root: workspaceRoot, script: detectData.devScript || 'dev' }),
            })
            if (startRes.ok) {
              const startData = await startRes.json()
              if (startData.status === 'started' || startData.status === 'already_running') {
                for (let i = 0; i < 15; i++) {
                  await new Promise(r => setTimeout(r, 2000))
                  const reDetectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
                  if (reDetectRes.ok) {
                    const reDetectData = await reDetectRes.json()
                    if (reDetectData.detectedPort) {
                      setPreviewPort(reDetectData.detectedPort)
                      break
                    }
                  }
                }
              }
            }
          } catch { /* ignore */ }
          finally { setPreviewAutoStarting(false) }
        }
      }
    } catch {
      // Fallback basic scan
      const ports = [3000, 3001, 3002, 5173, 5174, 8080, 4000, 4200, 8000, 4173]
      for (const port of ports) {
        try {
          const checkRes = await fetch(`http://127.0.0.1:${port}`, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
          if (checkRes.ok) { setPreviewPort(port); break }
        } catch { continue }
      }
    } finally {
      setPreviewDetecting(false)
    }
  }, [workspaceRoot])

  const handleQuickAction = useCallback((action: string) => {
    setNewSessionPrompt(action)
  }, [])

  const handleMcpToggle = useCallback(async (direction: 'outbound' | 'inbound', toolName: string, enabled: boolean) => {
    setMcpToggling(`${direction}:${toolName}`)
    try {
      const res = await authedFetch('/api/opencode/mcp/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, toolName, enabled }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: enabled ? 'Đã bật tool' : 'Đã tắt tool', description: `${toolName} (${direction})` })
        loadMcpStatus()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Toggle failed', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to toggle MCP tool', variant: 'destructive' })
    } finally {
      setMcpToggling(null)
    }
  }, [loadMcpStatus])

  const handleMcpSync = useCallback(async () => {
    setMcpSyncing(true)
    try {
      const res = await authedFetch('/api/opencode/mcp/sync', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'MCP Bridge đã đồng bộ', description: `Outbound: ${data.sync?.outboundSynced || 0}, Inbound: ${data.sync?.inboundSynced || 0}, Skills: ${data.sync?.skillsRegistered || 0}` })
        loadMcpStatus()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Sync failed', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to sync MCP tools', variant: 'destructive' })
    } finally {
      setMcpSyncing(false)
    }
  }, [loadMcpStatus])

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // File tree rendering
  const renderFileTree = useCallback((nodes: FileNode[], depth: number = 0): React.ReactNode => {
    const search = fileSearch.toLowerCase()
    return nodes
      .filter(n => !search || n.name.toLowerCase().includes(search) || n.path.toLowerCase().includes(search))
      .map(node => {
        const isDir = node.type === 'directory'
        const isExpanded = expandedDirs.has(node.path)
        const isSelected = selectedFile === node.path
        const iconColor = isDir ? 'text-amber-400' : node.extension === '.ts' || node.extension === '.tsx' ? 'text-blue-400' :
          node.extension === '.json' ? 'text-yellow-400' : node.extension === '.css' ? 'text-pink-400' :
          node.extension === '.md' ? 'text-stone-400' : 'text-stone-500'

        return (
          <div key={node.path}>
            <button
              onClick={() => isDir ? toggleDir(node.path) : handleFileSelect(node.path)}
              className={`group relative w-full flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-emerald-500/10 transition-colors rounded-sm ${
                isSelected ? 'bg-emerald-500/20 text-emerald-300' : 'text-stone-300'
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isDir ? (
                isExpanded ? <ChevronDown className="h-3 w-3 text-stone-500 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-stone-500 flex-shrink-0" />
              ) : (
                <span className="w-3 flex-shrink-0" />
              )}
              {isDir ? (
                <FolderOpen className={`h-3.5 w-3.5 ${iconColor} flex-shrink-0`} />
              ) : (
                <FileCode className={`h-3.5 w-3.5 ${iconColor} flex-shrink-0`} />
              )}
              <span className="truncate">{node.name}</span>
              {!isDir && (
                <span className="ml-auto flex items-center flex-shrink-0">
                  {node.size !== undefined && (
                    <span className="text-[9px] text-stone-600">
                      {node.size < 1024 ? `${node.size}B` : node.size < 1024 * 1024 ? `${(node.size / 1024).toFixed(1)}K` : `${(node.size / 1024 / 1024).toFixed(1)}M`}
                    </span>
                  )}
                  <span role="button" title="Đổi tên" className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-emerald-300 px-1" onClick={(e) => { e.stopPropagation(); void handleRenameFile(node.path, node.name) }}>
                    <Pencil className="h-2.5 w-2.5" />
                  </span>
                  <span role="button" title="Xóa" className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-red-400 px-1" onClick={(e) => { e.stopPropagation(); void handleDeleteFile(node.path, node.name) }}>
                    <Trash2 className="h-2.5 w-2.5" />
                  </span>
                </span>
              )}
            </button>
            {isDir && isExpanded && node.children && renderFileTree(node.children, depth + 1)}
          </div>
        )
      })
  }, [expandedDirs, selectedFile, fileSearch, toggleDir, handleFileSelect, handleRenameFile, handleDeleteFile])

  // Session status badge
  const statusBadge = useCallback((status: string) => {
    const map: Record<string, { cls: string; icon: React.ReactNode }> = {
      active: { cls: 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35', icon: <RefreshCw className="h-2.5 w-2.5 animate-spin" /> },
      paused: { cls: 'bg-amber-950/50 text-amber-400 border-amber-400/35', icon: <Pause className="h-2.5 w-2.5" /> },
      completed: { cls: 'bg-blue-950/50 text-blue-400 border-blue-400/35', icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
      failed: { cls: 'bg-red-950/50 text-red-400 border-red-400/35', icon: <XCircle className="h-2.5 w-2.5" /> },
    }
    const s = map[status] || map.active
    return <Badge className={`text-[9px] border ${s.cls} flex items-center gap-1`}>{s.icon} {status}</Badge>
  }, [])

  // Uptime formatter
  const formatUptime = useCallback((ms: number) => {
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  }, [])

  // Quick actions
  const QUICK_ACTIONS = [
    { label: 'Fix Bug', icon: Bug, prompt: 'Find and fix bugs in the current file' },
    { label: 'Refactor', icon: RefreshCw, prompt: 'Refactor this code for better readability and performance' },
    { label: 'Write Tests', icon: CheckCircle2, prompt: 'Write unit tests for the current file' },
    { label: 'Document', icon: FileText, prompt: 'Add documentation and comments to this code' },
    { label: 'Code Review', icon: Eye, prompt: 'Review this code for potential issues and improvements' },
    { label: 'Optimize', icon: Zap, prompt: 'Optimize this code for better performance' },
  ]

  // Model options — NVIDIA NIM only (user directive 2026-08-25: Agents/Chat chỉ dùng
  // 4 lõi sau; nemotron-3-ultra-550b KHÔNG nằm trong danh sách — lõi đó chỉ dành
  // cho trích xuất dữ liệu)
  const MODEL_OPTIONS = [
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (nhanh, ổn định)' },
    { value: 'moonshotai/kimi-k3', label: 'Kimi K3 (reasoning — chậm hơn)' },
    { value: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash (chậm nhất)' },
    { value: 'minimaxai/minimax-m3', label: 'MiniMax M3 (nhanh)' },
  ]

  return (
    <div className="space-y-4">

      {/* ===== Section 1: File Explorer + Code View ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-md nc-border-emerald overflow-hidden">
          <div className="flex items-center gap-2 p-3 border-b border-emerald-400/35">
            <button
              className="flex items-center gap-2 hover:bg-emerald-500/10 rounded px-1 py-0.5 transition-colors cursor-pointer"
              onClick={() => {
                setFolderPickerPath(workspaceRoot || '/home/z')
                loadFolderPicker(workspaceRoot || '/home/z')
                setShowFolderPicker(true)
              }}
              title="Chọn thư mục làm việc"
            >
              <FolderTree className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">File Explorer</span>
            </button>
            <Button
              size="sm"
              variant="outline"
              className={`h-7 px-2 text-[10px] gap-1 ${showPreview ? 'border-emerald-400/50 text-emerald-300 bg-emerald-500/20' : 'border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10'}`}
              onClick={handlePreviewToggle}
              title="Smart Preview — tự nhận diện framework và khởi động dev server"
            >
              <ExternalLinkIcon className="h-3 w-3" /> Preview
            </Button>
            {workspaceRoot && (
              <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35 max-w-[200px] truncate" title={workspaceRoot}>
                📁 {workspaceRoot.split('/').pop() || workspaceRoot}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {workspaceRoot && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => { setShowNewFileInput(true); setNewFileName('') }}
                    title="Tạo file mới"
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-7 w-7 p-0 border-emerald-400/50 ${showSearchPanel ? 'text-emerald-300 bg-emerald-500/20' : 'text-emerald-400 hover:bg-emerald-500/10'}`}
                    onClick={() => setShowSearchPanel(!showSearchPanel)}
                    title="Tìm kiếm trong workspace (rg)"
                  >
                    <Search className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => { setShowNewFolderInput(true); setNewFolderName('') }}
                    title="Tạo thư mục mới"
                  >
                    <FolderUp className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={loadFileTree}
                    disabled={treeLoading}
                  >
                    <RefreshCw className={`h-3 w-3 ${treeLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* New file/folder input bars */}
          {showNewFileInput && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/10 bg-emerald-950/20">
              <FileCode className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
              <Input
                placeholder="path/to/newfile.ts"
                value={newFileName}
                onChange={e => setNewFileName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFile(); if (e.key === 'Escape') setShowNewFileInput(false) }}
                className="h-7 flex-1 text-[11px] bg-slate-950/50 border-emerald-400/35"
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white" onClick={handleCreateFile}>Tạo</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] text-stone-400" onClick={() => setShowNewFileInput(false)}>Hủy</Button>
            </div>
          )}
          {showNewFolderInput && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/10 bg-emerald-950/20">
              <FolderOpen className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
              <Input
                placeholder="path/to/new-folder"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolderInput(false) }}
                className="h-7 flex-1 text-[11px] bg-slate-950/50 border-emerald-400/35"
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white" onClick={handleCreateFolder}>Tạo</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] text-stone-400" onClick={() => setShowNewFolderInput(false)}>Hủy</Button>
            </div>
          )}

          {/* Phase 10: workspace-wide search panel (ripgrep) */}
          {showSearchPanel && (
            <div className="border-b border-emerald-500/10 bg-slate-950/95 p-2" style={{ maxHeight: '300px' }}>
              <SearchPanel
                root={workspaceRoot || undefined}
                onResultClick={(path, _line) => {
                  void handleFileSelect(path.startsWith('/') ? path : `${workspaceRoot}/${path}`)
                  setShowSearchPanel(false)
                }}
                onClose={() => setShowSearchPanel(false)}
              />
            </div>
          )}

          {/* Main content area - either File Tree + Code View OR Preview */}
          {showPreview ? (
            /* ===== Smart Preview Panel (replaces entire content area) ===== */
            <div className="flex flex-col overflow-hidden" style={{ minHeight: '200px', height: `${fileExplorerHeight}px` }}>
              {/* Preview header bar */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                <div className="flex items-center gap-1.5">
                  <Monitor className="h-3 w-3 text-emerald-400" />
                  <span className="text-[10px] text-stone-400 font-medium">Preview</span>
                  {previewFramework && (
                    <Badge className="text-[8px] bg-violet-950/50 text-violet-300 border border-violet-400/35">
                      {previewFrameworkIcon} {previewFramework}
                    </Badge>
                  )}
                  {previewDetecting && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
                  {previewAutoStarting && (
                    <Badge className="text-[8px] bg-amber-950/50 text-amber-300 border border-amber-400/35 animate-pulse">
                      ⏳ Đang khởi động...
                    </Badge>
                  )}
                  {previewPort && (
                    <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
                      ✅ :{previewPort}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {previewPort && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 text-stone-500 hover:text-emerald-400"
                      onClick={handlePreviewRefresh}
                      title="Làm mới preview"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Preview content */}
              <div className="flex-1 bg-slate-950">
                {!workspaceRoot ? (
                  /* No workspace selected */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <FolderOpen className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-[11px] font-medium text-stone-400">Chưa chọn thư mục làm việc</p>
                    <p className="text-[10px] text-stone-600 mt-1">Chọn thư mục chứa project để preview ứng dụng</p>
                  </div>
                ) : previewDetecting ? (
                  /* Detecting framework & port */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-400 mb-3" />
                    <p className="text-[11px] text-stone-400">
                      {previewFramework
                        ? `Đang tìm dev server ${previewFrameworkIcon} ${previewFramework}...`
                        : 'Đang phân tích project...'}
                    </p>
                    <p className="text-[10px] text-stone-600 mt-1">Quét framework, cấu hình và port</p>
                  </div>
                ) : previewAutoStarting ? (
                  /* Auto-starting dev server */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <div className="relative mb-4">
                      <PlayIcon className="h-10 w-10 text-amber-400 opacity-60" />
                      <Loader2 className="h-4 w-4 animate-spin text-amber-300 absolute -bottom-1 -right-1" />
                    </div>
                    <p className="text-[11px] text-stone-400">Đang khởi động dev server...</p>
                    {previewDevCommand && (
                      <p className="text-[10px] text-amber-400/80 font-mono mt-1.5 bg-amber-950/30 px-2 py-0.5 rounded">
                        $ {previewDevCommand}
                      </p>
                    )}
                    <p className="text-[10px] text-stone-600 mt-2">Chờ dev server sẵn sàng (tối đa 30s)</p>
                  </div>
                ) : previewPort ? (
                  /* ✅ App loaded — show iframe + dev-server log tail (Phase 3) */
                  <div className="flex flex-col h-full min-h-0">
                    <iframe
                      key={previewIframeKey}
                      src={`http://127.0.0.1:${previewPort}`}
                      className="w-full flex-1 min-h-0 border-0 bg-white"
                      title="App Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                    />
                    {previewLogs.length > 0 && (
                      <pre className="m-0 max-h-[88px] overflow-auto px-2 py-1 bg-slate-950 border-t border-emerald-500/10 text-[9px] leading-relaxed font-mono text-stone-500 whitespace-pre-wrap">
                        {previewLogs.slice(-15).join('\n')}
                      </pre>
                    )}
                  </div>
                ) : (
                  /* No app found — show helpful empty state */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-6 text-center">
                    <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-slate-800/50 mb-3">
                      {previewFramework ? (
                        <span className="text-2xl">{previewFrameworkIcon}</span>
                      ) : (
                        <Code2 className="h-6 w-6 opacity-30" />
                      )}
                    </div>
                    {previewFramework ? (
                      <>
                        <p className="text-[11px] font-medium text-stone-400">
                          {previewFrameworkIcon} {previewFramework} — chưa chạy dev server
                        </p>
                        <p className="text-[10px] text-stone-600 mt-1.5 max-w-[300px]">
                          Preview đã nhận diện project {previewFramework} nhưng không tìm thấy dev server.
                        </p>
                        {previewAutoStartAttempted ? (
                          <p className="text-[10px] text-amber-400/70 mt-1.5">
                            ⚠️ Tự khởi động thất bại. Thử chạy thủ công trong Terminal.
                          </p>
                        ) : null}
                        {previewDevCommand && (
                          <div className="mt-2 flex items-center gap-1.5 bg-slate-800/50 px-2.5 py-1 rounded border border-stone-700/50">
                            <span className="text-[10px] text-stone-500">$</span>
                            <span className="text-[10px] text-emerald-400 font-mono">{previewDevCommand}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-[11px] font-medium text-stone-400">Chưa có ứng dụng để preview</p>
                        <p className="text-[10px] text-stone-600 mt-1.5 max-w-[280px]">
                          Thư mục <span className="text-emerald-400 font-mono">{workspaceRoot.split('/').pop()}</span> chưa có dev server đang chạy.
                        </p>
                        <p className="text-[10px] text-stone-600 mt-1">
                          Chạy <span className="text-emerald-400 font-mono">npm run dev</span> hoặc <span className="text-emerald-400 font-mono">bun dev</span> trong Terminal, sau đó bấm Thử lại.
                        </p>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 h-7 px-3 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10 gap-1"
                      onClick={handlePreviewRetry}
                    >
                      <RefreshCw className="h-3 w-3" /> Thử lại
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ===== File Tree + Code View ===== */
            <div className="flex" style={{ minHeight: '200px', height: `${fileExplorerHeight}px` }}>
              {/* File Tree */}
              <div className="w-1/3 border-r border-emerald-500/10 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {!workspaceRoot ? (
                  <div className="flex flex-col items-center justify-center h-40 text-stone-500 p-4 text-center">
                    <FolderOpen className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-[11px] font-medium text-stone-400">Chọn thư mục để bắt đầu</p>
                    <p className="text-[10px] text-stone-600 mt-1">Bấm vào File Explorer để chọn thư mục</p>
                    <Button
                      size="sm"
                      className="mt-3 h-7 px-3 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
                      onClick={() => {
                        setFolderPickerPath('/home/z')
                        loadFolderPicker('/home/z')
                        setShowFolderPicker(true)
                      }}
                    >
                      <FolderOpen className="h-3 w-3 mr-1" /> Chọn thư mục
                    </Button>
                  </div>
                ) : treeLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                  </div>
                ) : fileTree.length > 0 ? (
                  <div className="py-1">
                    {renderFileTree(fileTree)}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-32 text-stone-500">
                    <FolderOpen className="h-8 w-8 mb-2" />
                    <p className="text-[11px]">Thư mục trống</p>
                  </div>
                )}
              </div>

              {/* Code View */}
              <div className={`flex-1 flex flex-col overflow-y-auto`} style={{ scrollbarWidth: 'thin' }}>
                {fileLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                  </div>
                ) : selectedFile && fileContent ? (
                  <>
                    <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                      <span className="text-[10px] text-stone-400 font-mono truncate max-w-[50%]">{fileContent.path}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge className="text-[8px] bg-slate-800 text-stone-400">{fileContent.language}</Badge>
                        <Badge className="text-[8px] bg-slate-800 text-stone-400">{fileContent.lines} dòng</Badge>
                        {editedContent !== null && (
                          <Badge className="text-[8px] bg-amber-900/50 text-amber-400 border border-amber-400/50 animate-pulse">Đã chỉnh sửa</Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-5 text-[8px] px-1.5 ${diffViewActive ? 'text-emerald-400 bg-emerald-500/20' : 'text-stone-500 hover:text-stone-300'}`}
                          onClick={() => setDiffViewActive(!diffViewActive)}
                          title="Xem Diff"
                        >
                          <FileCode className="h-3 w-3 mr-0.5" /> Diff
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 text-[8px] px-1.5 text-stone-500 hover:text-emerald-300"
                          onClick={() => { setShowPendingModal(true); void loadPendingEdits() }}
                          title="Xem các AI edit chờ duyệt"
                        >
                          📝 Pending{pendingEdits.length > 0 ? ` (${pendingEdits.length})` : ''}
                        </Button>
                        {editedContent !== null && (
                          <Button
                            size="sm"
                            className="h-5 text-[8px] px-2 bg-emerald-600 hover:bg-emerald-500 text-white"
                            onClick={() => void handleSaveFile(activeFileIndex)}
                            disabled={isSaving}
                          >
                            {isSaving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" /> Lưu</>}
                          </Button>
                        )}
                        {editedContent !== null && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 text-[8px] px-1.5 text-stone-500 hover:text-red-400"
                            onClick={() => handleRevertFile(activeFileIndex)}
                            title="Hủy chỉnh sửa"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Phase 9: session diff view (buffer vs original). Phase 8 Monaco multi-tab editor otherwise (locally vendored /monaco-vs, no CDN). */}
                    {diffViewActive && activeOpenFile ? (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                          <span className="text-[10px] font-mono text-emerald-300">Diff: {activeOpenFile.path.split('/').pop()}</span>
                          <span className="text-[9px] text-stone-500">{activeOpenFile.isDirty ? 'thay đổi chưa lưu (so với nội dung gốc)' : 'không có thay đổi trong session'}</span>
                        </div>
                        <div className="flex-1 min-h-0">
                          <DiffViewer
                            originalContent={activeOpenFile.originalContent}
                            modifiedContent={activeOpenFile.content}
                            language={detectLanguage(activeOpenFile.path)}
                          />
                        </div>
                      </div>
                    ) : (
                      <CodeEditor
                        openFiles={openFiles}
                        activeFileIndex={activeFileIndex}
                        onActiveChange={setActiveFileIndex}
                        onContentChange={handleContentChange}
                        onSave={(idx) => void handleSaveFile(idx)}
                        onClose={handleCloseFile}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-stone-500">
                    <FileCode className="h-10 w-10 mb-3" />
                    <p className="text-xs">Chọn file để xem/chỉnh sửa</p>
                    <p className="text-[10px] text-stone-600 mt-1">Click vào file trong cây thư mục</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Drag handle at bottom of File Explorer */}
          <div
            className="flex items-center justify-center h-3 cursor-ns-resize hover:bg-emerald-500/10 transition-colors border-t border-emerald-500/10 group"
            onMouseDown={(e) => {
              e.preventDefault()
              fileExplorerDragRef.current = { startY: e.clientY, startH: fileExplorerHeight }
              document.body.style.cursor = 'ns-resize'
              document.body.style.userSelect = 'none'
            }}
            title="Kéo để thay đổi kích thước"
          >
            <GripHorizontal className="h-3 w-4 text-stone-600 group-hover:text-emerald-400 transition-colors" />
          </div>

          {/* LSP Diagnostics Panel - only shown when NOT in Preview mode */}
          {!showPreview && diagnostics.length > 0 && (
            <div className="border-t border-emerald-500/10 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-[11px] font-medium text-stone-300">LSP Diagnostics ({diagnostics.length})</span>
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {diagnostics.slice(0, 20).map((d, i) => (
                  <div key={i} className="flex items-start gap-2 text-[10px]">
                    {d.severity === 'error' || d.severity === 'Error' ? (
                      <XCircle className="h-3 w-3 text-red-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0 mt-0.5" />
                    )}
                    <span className="text-stone-400">
                      {d.line ? `L${d.line}` : ''}{d.column ? `:${d.column}` : ''} {d.message || d.raw || ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Folder Picker Dialog */}
      {showFolderPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[560px] max-h-[80vh] bg-slate-950 border border-emerald-400/50 rounded-xl shadow-2xl flex flex-col overflow-hidden">
            {/* Dialog header */}
            <div className="flex items-center gap-3 p-4 border-b border-emerald-400/35">
              <FolderOpen className="h-5 w-5 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Chọn thư mục làm việc</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 w-7 p-0 text-stone-500 hover:text-red-400"
                onClick={() => setShowFolderPicker(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Path breadcrumb / input */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-emerald-500/10 bg-slate-900/50">
              <span className="text-[10px] text-stone-500 flex-shrink-0">Đường dẫn:</span>
              <Input
                value={folderPickerPath}
                onChange={e => setFolderPickerPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadFolderPicker(e.target.value) }}
                className="h-7 flex-1 text-[11px] font-mono bg-slate-950/50 border-emerald-400/35"
                placeholder="/path/to/project"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px] border-emerald-400/50 text-emerald-400"
                onClick={() => loadFolderPicker(folderPickerPath)}
              >
                Đi đến
              </Button>
            </div>

            {/* Quick access paths */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-emerald-500/10">
              <span className="text-[9px] text-stone-600 flex-shrink-0">Truy cập nhanh:</span>
              {['.', '..', '/tmp'].map(p => (
                <Button
                  key={p}
                  size="sm"
                  variant="outline"
                  className={`h-6 px-2 text-[9px] border-emerald-400/35 ${folderPickerPath === p ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => loadFolderPicker(p)}
                >
                  {p.split('/').pop() || '/'}
                </Button>
              ))}
            </div>

            {/* Directory listing */}
            <div className="flex-1 overflow-y-auto p-2" style={{ scrollbarWidth: 'thin' }}>
              {folderPickerLoading ? (
                <div className="flex items-center justify-center h-24">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                </div>
              ) : folderPickerItems.length > 0 ? (
                <div className="space-y-0.5">
                  {folderPickerItems.map(item => (
                    <button
                      key={item.path}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] rounded-lg transition-colors ${
                        item.type === 'directory'
                          ? 'hover:bg-emerald-500/10 text-stone-200 cursor-pointer'
                          : 'text-stone-500 cursor-default'
                      }`}
                      onClick={() => {
                        if (item.type === 'directory') {
                          loadFolderPicker(item.path)
                        }
                      }}
                      onDoubleClick={() => {
                        if (item.type === 'directory') {
                          void handleWorkspaceSelect(item.path)
                        }
                      }}
                    >
                      {item.type === 'directory' ? (
                        <FolderOpen className="h-4 w-4 text-amber-400 flex-shrink-0" />
                      ) : (
                        <FileCode className="h-4 w-4 text-stone-600 flex-shrink-0" />
                      )}
                      <span className="truncate flex-1 text-left">{item.name}</span>
                      {item.type === 'directory' && (
                        <span className="text-[9px] text-stone-600">📂</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-24 text-stone-500">
                  <FolderOpen className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-[11px]">Thư mục trống hoặc không tồn tại</p>
                </div>
              )}
            </div>

            {/* Dialog footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-emerald-400/35 bg-slate-900/30">
              <span className="text-[10px] text-stone-500 font-mono truncate max-w-[60%]" title={folderPickerPath}>
                {folderPickerPath}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-[11px] border-stone-600 text-stone-300"
                  onClick={() => setShowFolderPicker(false)}
                >
                  Hủy
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-4 text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
                  onClick={() => { void handleWorkspaceSelect(folderPickerPath) }}
                >
                  <FolderOpen className="h-3.5 w-3.5" /> Chọn thư mục này
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Section 2: Terminal ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TerminalIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Terminal</span>
              {workspaceRoot && (
                <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35 max-w-[180px] truncate" title={workspaceRoot}>
                  📂 {workspaceRoot.split('/').pop() || workspaceRoot}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300 gap-1"
                title="Dừng shell hiện tại — shell mới sẽ khởi động ở lệnh kế tiếp"
                onClick={handleTerminalRestart}
              >
                <RotateCcw className="h-3 w-3" />
                Khởi động lại
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300"
                onClick={() => setTerminalOutput([])}
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300"
                onClick={() => { navigator.clipboard.writeText(terminalOutput.join('\n')); toast({ title: 'Copied to clipboard' }) }}
              >
                Copy
              </Button>
            </div>
          </div>

          <div ref={terminalViewRef} className={`bg-slate-950/80 rounded-lg border border-emerald-500/10 p-3 overflow-y-auto font-mono text-[11px]`} style={{ scrollbarWidth: 'thin', height: `${terminalHeight}px` }}>
            {terminalOutput.length > 0 ? (
              terminalOutput.map((line, i) => (
                <div key={i} className={`${line.startsWith('$') ? 'text-emerald-400' : line.startsWith('Error') || line.startsWith('✗') ? 'text-red-400' : line.startsWith('✓') ? 'text-emerald-300' : line.startsWith('[local-exec]') ? 'text-stone-600 text-[9px]' : 'text-stone-400'}`}>
                  {line}
                </div>
              ))
            ) : (
              <span className="text-stone-600">Terminal sẵn sàng. Nhập lệnh bên dưới để thực thi trên máy local.</span>
            )}
          </div>

          {/* Drag handle at bottom of Terminal output area */}
          <div
            className="flex items-center justify-center h-3 cursor-ns-resize hover:bg-emerald-500/10 transition-colors rounded-b-lg border-t border-emerald-500/10 group -mt-1"
            onMouseDown={(e) => {
              e.preventDefault()
              terminalDragRef.current = { startY: e.clientY, startH: terminalHeight }
              document.body.style.cursor = 'ns-resize'
              document.body.style.userSelect = 'none'
            }}
            title="Kéo để thay đổi kích thước Terminal"
          >
            <GripHorizontal className="h-3 w-4 text-stone-600 group-hover:text-emerald-400 transition-colors" />
          </div>

          {/* Command input */}
          <div className="mt-2 flex gap-2">
            <div className="flex items-center gap-1 text-emerald-400 text-[11px] font-mono flex-shrink-0 mt-1.5">$</div>
            <Input
              placeholder="Enter command..."
              value={terminalCommand}
              onChange={e => setTerminalCommand(e.target.value)}
              className="flex-1 h-8 text-[11px] font-mono bg-slate-950/50 border-emerald-400/35"
              onKeyDown={e => { if (e.key === 'Enter') handleExecuteCommand() }}
              disabled={terminalRunning}
            />
            <Button
              size="sm"
              className="h-8 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={handleExecuteCommand}
              disabled={terminalRunning || !terminalCommand.trim()}
            >
              {terminalRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayIcon className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      </div>

      {/* ===== Section 3: Active Sessions ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CpuIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Active Sessions</span>
            </div>
            <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
              {sessions.length} sessions
            </Badge>
          </div>

          {/* New session form */}
          <div className="mb-3 p-3 bg-slate-950/50 rounded-lg border border-emerald-500/10">
            <div className="flex gap-2 mb-2">
              <Input
                placeholder="Enter prompt... e.g. 'Fix bug in auth.ts'"
                value={newSessionPrompt}
                onChange={e => setNewSessionPrompt(e.target.value)}
                className="flex-1 h-8 text-[11px] bg-slate-950/50 border-emerald-400/35"
                onKeyDown={e => { if (e.key === 'Enter') handleCreateSession() }}
              />
              <Select value={newSessionModel} onValueChange={setNewSessionModel}>
                <SelectTrigger className="w-44 h-8 text-[10px] bg-slate-950/50 border-emerald-400/35">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map(m => (
                    <SelectItem key={m.value} value={m.value} className="text-[11px]">{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              className="h-7 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={handleCreateSession}
              disabled={creatingSession || !newSessionPrompt.trim()}
            >
              {creatingSession ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
              New Session
            </Button>
          </div>

          {/* Session list */}
          {sessionsLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
            </div>
          ) : sessions.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {sessions.map(s => (
                <div key={s.sessionId} className="flex items-center gap-3 p-2.5 bg-slate-950/30 rounded-lg border border-emerald-500/10 hover:border-emerald-400/35 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium text-stone-200 truncate">{s.prompt || `Session ${s.sessionId?.substring(0, 8)}...`}</span>
                      {statusBadge(s.status)}
                    </div>
                    <div className="flex items-center gap-3 text-[9px] text-stone-500">
                      <span>Model: {s.model || '—'}</span>
                      <span>ID: {s.sessionId?.substring(0, 8)}...</span>
                      {s.filesTouched && s.filesTouched.length > 0 && <span>Files: {s.filesTouched.length}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {s.status === 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-amber-400 hover:bg-amber-500/10"
                        onClick={() => handlePauseSession(s.sessionId)}
                        title="Pause"
                      >
                        <Pause className="h-3 w-3" />
                      </Button>
                    )}
                    {s.status === 'paused' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => handleResumeSession(s.sessionId)}
                        title="Resume"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadTimeline(s.sessionId)}
                      title="Xem dòng thời gian"
                    >
                      <History className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-red-400 hover:bg-red-500/10"
                      onClick={() => handleDeleteSession(s.sessionId)}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-stone-500">
              <CpuIcon className="h-8 w-8 mb-2" />
              <p className="text-[11px]">No sessions yet</p>
              <p className="text-[10px] text-stone-600">Create a new session above to start coding</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== Section 4: MCP Bridge Status ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CableIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">MCP Bridge</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={`text-[9px] border ${
                mcpStatus?.bridgeStatus === 'active' ? 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35' :
                mcpStatus?.bridgeStatus === 'degraded' ? 'bg-amber-950/50 text-amber-400 border-amber-400/35' :
                'bg-red-950/50 text-red-400 border-red-400/35'
              }`}>
                {mcpStatus?.bridgeStatus || 'unknown'}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[9px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={handleMcpSync}
                disabled={mcpSyncing}
              >
                {mcpSyncing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Sync
              </Button>
            </div>
          </div>

          {/* MCP Bridge Architecture Visual */}
          <div className="mb-3 p-2.5 bg-slate-950/60 rounded-lg border border-emerald-500/10">
            <div className="flex items-center justify-center gap-3 text-[10px]">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 border border-cyan-400/35 rounded">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                <span className="text-cyan-300 font-medium">OpenClaw</span>
              </div>
              <div className="flex items-center gap-1 text-emerald-400">
                <ArrowRightIcon className="h-3 w-3" />
                <span className="text-[9px] text-stone-500">MCP</span>
                <ArrowRightIcon className="h-3 w-3 rotate-180" />
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 bg-violet-500/10 border border-violet-400/35 rounded">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                <span className="text-violet-300 font-medium">OpenCode</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Outbound — OpenClaw Tools → OpenCode via MCP */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <ArrowRightIcon className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] font-medium text-cyan-400 uppercase">Outbound (OpenClaw → OpenCode)</span>
              </div>
              <div className="space-y-1.5">
                {(mcpStatus?.outbound?.tools || [
                  { name: 'knowledge_search', enabled: true, source: 'openclaw' },
                  { name: 'knowledge_graph', enabled: true, source: 'openclaw' },
                  { name: 'knowledge_write', enabled: true, source: 'openclaw' },
                  { name: 'web_search', enabled: true, source: 'openclaw' },
                ]).map(tool => (
                  <div key={tool.name} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      {mcpToggling === `outbound:${tool.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin text-stone-400 flex-shrink-0" />
                      ) : tool.enabled ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-stone-600 flex-shrink-0" />
                      )}
                      <span className={tool.enabled ? 'text-stone-300' : 'text-stone-600'}>{tool.name}</span>
                    </div>
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={(checked) => handleMcpToggle('outbound', tool.name, checked)}
                      disabled={mcpToggling === `outbound:${tool.name}`}
                      className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Inbound — OpenCode Tools → OpenClaw as Skills */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <ArrowRightIcon className="h-3 w-3 text-violet-400 rotate-180" />
                <span className="text-[10px] font-medium text-violet-400 uppercase">Inbound (OpenCode → OpenClaw)</span>
              </div>
              <div className="space-y-1.5">
                {(mcpStatus?.inbound?.tools || [
                  { name: 'file_read', enabled: true, source: 'opencode' },
                  { name: 'file_edit', enabled: true, source: 'opencode' },
                  { name: 'bash_exec', enabled: true, source: 'opencode' },
                  { name: 'lsp_diag', enabled: true, source: 'opencode' },
                  { name: 'fetch_url', enabled: true, source: 'opencode' },
                ]).map(tool => (
                  <div key={tool.name} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      {mcpToggling === `inbound:${tool.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin text-stone-400 flex-shrink-0" />
                      ) : tool.enabled ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-stone-600 flex-shrink-0" />
                      )}
                      <span className={tool.enabled ? 'text-stone-300' : 'text-stone-600'}>{tool.name}</span>
                    </div>
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={(checked) => handleMcpToggle('inbound', tool.name, checked)}
                      disabled={mcpToggling === `inbound:${tool.name}`}
                      className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between">
            {mcpStatus?.lastSync && (
              <span className="text-[9px] text-stone-600">
                Last sync: {new Date(mcpStatus.lastSync).toLocaleString()}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[9px] ml-auto border-stone-600 text-stone-400 hover:bg-stone-500/10"
              onClick={async () => {
                try {
                  const res = await authedFetch('/api/opencode/mcp/register', { method: 'POST' })
                  const data = await res.json()
                  toast({ title: 'MCP Tools đã đăng ký', description: `${data.registered || 0} mới, ${data.updated || 0} cập nhật` })
                  loadMcpStatus()
                } catch {
                  toast({ title: 'Lỗi', description: 'Failed to register tools', variant: 'destructive' })
                }
              }}
            >
              <Settings className="h-3 w-3 mr-1" /> Register Skills
            </Button>
          </div>
        </div>
      </div>

      {/* ===== Section 5: Git Integration ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setGitSectionOpen(!gitSectionOpen)}>
              <GitBranch className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Tích hợp Git</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${gitSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {gitLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              <Badge className={`text-[9px] border ${gitStatus.available ? 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35' : 'bg-red-950/50 text-red-400 border-red-400/35'}`}>
                {gitStatus.available ? 'Sẵn sàng' : 'Không khả dụng'}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-6 w-6 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={loadGitStatus}
                disabled={gitLoading}
              >
                <RefreshCw className={`h-3 w-3 ${gitLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {gitSectionOpen && (
            <>
              {gitStatus.available ? (
                <>
                  {/* Branch & Sync Status */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Nhánh</span>
                      <p className="text-xs text-emerald-300 font-mono flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        {gitStatus.branch || '—'}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Commit cuối</span>
                      <p className="text-xs text-stone-300 font-mono truncate" title={gitStatus.lastCommit}>
                        {gitStatus.lastCommit ? gitStatus.lastCommit.substring(0, 20) : '—'}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Thay đổi</span>
                      <p className="text-xs text-stone-300">{gitStatus.totalChanges} tệp</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Ahead</span>
                      <p className="text-xs text-emerald-300">{gitStatus.ahead} commit</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Behind</span>
                      <p className="text-xs text-amber-300">{gitStatus.behind} commit</p>
                    </div>
                  </div>

                  {/* File Lists */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-amber-500/10">
                      <span className="text-[9px] text-amber-400 uppercase font-medium">Đã sửa ({gitStatus.modified.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.modified.length > 0 ? gitStatus.modified.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                      <span className="text-[9px] text-emerald-400 uppercase font-medium">Đã staged ({gitStatus.staged.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.staged.length > 0 ? gitStatus.staged.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-red-500/10">
                      <span className="text-[9px] text-red-400 uppercase font-medium">Chưa theo dõi ({gitStatus.untracked.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.untracked.length > 0 ? gitStatus.untracked.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 mb-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadGitDiff(false)}
                      disabled={gitLoading}
                    >
                      <FileCode className="h-3 w-3 mr-1" /> Xem Diff
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadGitDiff(true)}
                      disabled={gitLoading}
                    >
                      <FileCode className="h-3 w-3 mr-1" /> Diff Staged
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-stone-600 text-stone-500"
                      disabled
                    >
                      <GitCommit className="h-3 w-3 mr-1" /> Commit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-stone-600 text-stone-500"
                      disabled
                    >
                      <RotateCcw className="h-3 w-3 mr-1" /> Revert
                    </Button>
                  </div>

                  {/* Diff Display */}
                  {gitDiff && (
                    <div className="border-t border-emerald-500/10 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-medium text-stone-300">Unified Diff</span>
                        {gitDiffStats.filesChanged > 0 && (
                          <div className="flex items-center gap-2 text-[9px]">
                            <span className="text-emerald-400">+{gitDiffStats.additions}</span>
                            <span className="text-red-400">-{gitDiffStats.deletions}</span>
                            <span className="text-stone-500">{gitDiffStats.filesChanged} tệp</span>
                          </div>
                        )}
                      </div>
                      <div className="bg-slate-950/80 rounded-lg border border-emerald-500/10 p-3 max-h-64 overflow-y-auto font-mono text-[10px]" style={{ scrollbarWidth: 'thin' }}>
                        {gitDiff.split('\n').map((line, i) => (
                          <div key={i} className={
                            line.startsWith('+') && !line.startsWith('++') ? 'text-emerald-400 bg-emerald-500/5' :
                            line.startsWith('-') && !line.startsWith('--') ? 'text-red-400 bg-red-500/5' :
                            line.startsWith('@@') ? 'text-cyan-400' :
                            line.startsWith('diff') || line.startsWith('index') ? 'text-stone-500 font-medium' :
                            'text-stone-400'
                          }>
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <GitBranch className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Git không khả dụng</p>
                  <p className="text-[10px] text-stone-600">Server đang offline hoặc chưa cấu hình Git</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ===== Section 6: Session Timeline ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setTimelineSectionOpen(!timelineSectionOpen)}>
              <History className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Dòng thời gian Session</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${timelineSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {timelineLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              {selectedTimelineSession && (
                <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
                  {selectedTimelineSession.substring(0, 8)}...
                </Badge>
              )}
            </div>
          </div>

          {timelineSectionOpen && (
            <>
              {!selectedTimelineSession ? (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <History className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Chưa chọn session</p>
                  <p className="text-[10px] text-stone-600">Nhấn vào nút ⏱ trong danh sách Session để xem dòng thời gian</p>
                </div>
              ) : timelineLoading ? (
                <div className="flex items-center justify-center h-16">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                </div>
              ) : timelineData.timeline.length > 0 ? (
                <div className="relative pl-6 max-h-80 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {/* Vertical timeline line */}
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-emerald-500/20" />
                  {timelineData.timeline.map((event, i) => {
                    const eventIcon: Record<string, string> = {
                      start: '🚀', file_read: '📁', tool_call: '🔧',
                      complete: '✅', error: '❌', paused: '⏸️',
                    }
                    const eventColor: Record<string, string> = {
                      start: 'text-emerald-400 bg-emerald-500/20',
                      file_read: 'text-blue-400 bg-blue-500/20',
                      tool_call: 'text-amber-400 bg-amber-500/20',
                      complete: 'text-green-400 bg-green-500/20',
                      error: 'text-red-400 bg-red-500/20',
                      paused: 'text-stone-400 bg-stone-500/20',
                    }
                    const color = eventColor[event.event] || eventColor.start
                    return (
                      <div key={i} className="relative mb-3 last:mb-0">
                        {/* Timeline dot */}
                        <div className={`absolute -left-6 top-0.5 h-5 w-5 rounded-full flex items-center justify-center text-[10px] ${color}`}>
                          {eventIcon[event.event] || '📋'}
                        </div>
                        <div className="ml-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-stone-200">{event.label}</span>
                            <span className="text-[9px] text-stone-600">{new Date(event.timestamp).toLocaleTimeString()}</span>
                          </div>
                          {event.detail && (
                            <p className="text-[10px] text-stone-500 mt-0.5">{event.detail}</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <Clock className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Không có sự kiện</p>
                  <p className="text-[10px] text-stone-600">Session này chưa có hoạt động nào</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ===== Section 7: Knowledge Context Panel ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setKbSectionOpen(!kbSectionOpen)}>
              <Brain className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Ngữ cảnh Kiến thức</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${kbSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {kbContextLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              <Button
                size="sm"
                variant="outline"
                className="h-6 w-6 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => loadKbContext()}
                disabled={kbContextLoading}
              >
                <RefreshCw className={`h-3 w-3 ${kbContextLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {kbSectionOpen && (
            <>
              {/* Enrichment Score */}
              <div className="mb-3 p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-stone-400">Điểm làm phong phú</span>
                  <span className="text-[11px] font-medium text-emerald-300">{kbContext.enrichmentScore}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 rounded-full transition-all"
                    style={{ width: `${kbContext.enrichmentScore}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                {/* Entities */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                  <span className="text-[9px] text-emerald-400 uppercase font-medium">Thực thể ({kbContext.entities.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.entities.length > 0 ? kbContext.entities.map((e, i) => (
                      <div key={i} className="text-[10px]">
                        <span className="text-stone-200 font-medium">{e.name}</span>
                        <span className="text-stone-600 ml-1">({e.type})</span>
                        {e.description && <p className="text-stone-500 truncate">{e.description}</p>}
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có thực thể</span>}
                  </div>
                </div>

                {/* Documents */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                  <span className="text-[9px] text-cyan-400 uppercase font-medium">Tài liệu ({kbContext.documents.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.documents.length > 0 ? kbContext.documents.map((d, i) => (
                      <div key={i} className="text-[10px] flex items-center justify-between">
                        <span className="text-stone-300 truncate">{d.source}</span>
                        <Badge className="text-[8px] bg-cyan-950/50 text-cyan-400 border border-cyan-400/35 ml-1">{(d.score * 100).toFixed(0)}%</Badge>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có tài liệu</span>}
                  </div>
                </div>

                {/* Corrections */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-amber-500/10">
                  <span className="text-[9px] text-amber-400 uppercase font-medium">Sửa đổi ({kbContext.corrections.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.corrections.length > 0 ? kbContext.corrections.map((c, i) => (
                      <div key={i} className="text-[10px]">
                        <span className="text-stone-300 truncate">{c.content}</span>
                        <span className="text-stone-600 ml-1">{new Date(c.createdAt).toLocaleDateString()}</span>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có sửa đổi</span>}
                  </div>
                </div>

                {/* Insights */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-violet-500/10">
                  <span className="text-[9px] text-violet-400 uppercase font-medium">Insights ({kbContext.insights.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.insights.length > 0 ? kbContext.insights.map((ins, i) => (
                      <div key={i} className="text-[10px]">
                        <Badge className="text-[8px] bg-violet-950/50 text-violet-400 border border-violet-400/35 mr-1">{ins.type}</Badge>
                        <span className="text-stone-300">{ins.content}</span>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có insight</span>}
                  </div>
                </div>
              </div>

              {/* Custom Query */}
              <div className="flex gap-2">
                <Input
                  placeholder="Nhập truy vấn để thử làm phong phú..."
                  value={kbContextQuery}
                  onChange={e => setKbContextQuery(e.target.value)}
                  className="flex-1 h-8 text-[11px] bg-slate-950/50 border-emerald-400/35"
                  onKeyDown={e => { if (e.key === 'Enter' && kbContextQuery.trim()) { loadKbContext(kbContextQuery) } }}
                />
                <Button
                  size="sm"
                  className="h-8 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
                  onClick={() => loadKbContext(kbContextQuery)}
                  disabled={kbContextLoading || !kbContextQuery.trim()}
                >
                  <Lightbulb className="h-3 w-3 mr-1" /> Thử
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Phase 9: PendingEdit review modal (portal dialog) */}
      {showPendingModal && (
        <PendingEditModal
          edits={pendingEdits}
          onRefresh={() => { void loadPendingEdits() }}
          onClose={() => setShowPendingModal(false)}
        />
      )}
    </div>
  )
}

function ComingSoonPlaceholder({ icon: Icon, label, description, color }: { icon: React.ComponentType<{ className?: string }>; label: string; description: string; color: string }) {
  const colorMap: Record<string, string> = {
    cyan: 'text-cyan-400 border-cyan-400/35',
    amber: 'text-amber-400 border-amber-400/35',
    violet: 'text-violet-400 border-violet-400/35',
    orange: 'text-orange-400 border-orange-400/35',
    teal: 'text-teal-400 border-teal-400/35',
  }
  const cls = colorMap[color] || colorMap.cyan
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-16">
      <div className={`p-5 border ${cls} mb-5`}>
        <Icon className="h-10 w-10" />
      </div>
      <h3 className="text-lg font-bold text-stone-200 mb-2" style={{ fontFamily: "'Cormorant Infant', 'Georgia', serif" }}>{label}</h3>
      <p className="text-xs text-stone-400 max-w-sm">{description}</p>
      <Badge className="mt-4 text-[10px] bg-amber-950/50 text-amber-400 border border-amber-400/35">Sắp ra mắt</Badge>
    </div>
  )
}

// ==================== AGENTS MODULE ====================

function AgentsModule() {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<any | null>(null)
  const [availableModels, setAvailableModels] = useState<any[]>([])
  const [formError, setFormError] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formInstruction, setFormInstruction] = useState('')
  const [formProvider, setFormProvider] = useState('nvidia')
  const [formModel, setFormModel] = useState('')
  const [formTemperature, setFormTemperature] = useState(0.7)
  const [formMaxTokens, setFormMaxTokens] = useState(4096)
  const [formTeam, setFormTeam] = useState<string | null>(null)
  const [formPosition, setFormPosition] = useState<string | null>(null)
  const [formAvatar, setFormAvatar] = useState('🤖')
  const [saving, setSaving] = useState(false)

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await fetch('/api/agents')
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const errMsg = errData.details || errData.error || `HTTP ${res.status}`
        throw new Error(errMsg)
      }
      const data = await res.json()
      setAgents(data.agents || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể tải danh sách Agent'
      setLoadError(msg)
      toast({ title: 'Lỗi tải Agents', description: msg, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch available models
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/models')
      if (!res.ok) throw new Error('Failed to fetch models')
      const data = await res.json()
      setAvailableModels(data.providers || [])
    } catch {
      // Silently fail for models — not critical
    }
  }, [])

  useEffect(() => {
    void fetchAgents()
    void fetchModels()
  }, [fetchAgents, fetchModels])

  // Get models for current provider
  const currentProviderModels = useMemo(() => {
    const provider = availableModels.find((p: any) => p.key === formProvider)
    return provider?.models || []
  }, [availableModels, formProvider])

  // Reset form
  const resetForm = useCallback(() => {
    setFormName('')
    setFormDescription('')
    setFormInstruction('')
    setFormProvider('nvidia')
    setFormModel('')
    setFormTemperature(0.7)
    setFormMaxTokens(4096)
    setFormTeam(null)
    setFormPosition(null)
    setFormAvatar('🤖')
    setFormError('')
    setEditingAgent(null)
  }, [])

  // Open create dialog
  const openCreateDialog = useCallback(() => {
    resetForm()
    setDialogOpen(true)
  }, [resetForm])

  // Open edit dialog
  const openEditDialog = useCallback((agent: any) => {
    setEditingAgent(agent)
    setFormName(agent.name || '')
    setFormDescription(agent.description || '')
    setFormInstruction(agent.instruction || '')
    setFormProvider(agent.provider || 'nvidia')
    setFormModel(agent.model || '')
    setFormTemperature(agent.temperature ?? 0.7)
    setFormMaxTokens(agent.maxTokens ?? 4096)
    setFormTeam(agent.team || null)
    setFormPosition(agent.position || null)
    setFormAvatar(agent.avatar || '🤖')
    setFormError('')
    setDialogOpen(true)
  }, [])

  // Close dialog
  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    resetForm()
  }, [resetForm])

  // Validate form
  const validateForm = useCallback((): string | null => {
    if (!formName || formName.trim().length < 2 || formName.trim().length > 50) {
      return 'Tên Agent phải từ 2-50 ký tự'
    }
    if (!formDescription || formDescription.trim().length === 0) {
      return 'Mô tả vai trò không được để trống'
    }
    if (formDescription.trim().length > 10000) {
      return 'Mô tả vai trò không được quá 10000 ký tự'
    }
    if (!formInstruction || formInstruction.trim().length === 0) {
      return 'Hướng dẫn chi tiết không được để trống'
    }
    if (formInstruction.trim().length > 10000) {
      return 'Hướng dẫn chi tiết không được quá 10000 ký tự'
    }
    if (!formProvider) return 'Vui lòng chọn Provider'
    if (!formModel) return 'Vui lòng chọn Model'
    if (formTemperature < 0 || formTemperature > 2) return 'Temperature phải từ 0.0 đến 2.0'
    if (formMaxTokens < 256 || formMaxTokens > 32768) return 'Max Tokens phải từ 256 đến 32768'
    if (formTeam && !formPosition) return 'Vui lòng chọn vị trí trong Team'
    return null
  }, [formName, formDescription, formInstruction, formProvider, formModel, formTemperature, formMaxTokens, formTeam, formPosition])

  // Save agent (create or update)
  const saveAgent = useCallback(async () => {
    const validationError = validateForm()
    if (validationError) {
      setFormError(validationError)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const payload: Record<string, unknown> = {
        name: formName,
        description: formDescription,
        instruction: formInstruction,
        provider: formProvider,
        model: formModel,
        temperature: formTemperature,
        maxTokens: formMaxTokens,
        team: formTeam || null,
        position: formPosition || null,
        avatar: formAvatar,
      }
      if (editingAgent) {
        payload.id = editingAgent.id
        const res = await fetch('/api/agents', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Cập nhật Agent thất bại')
        }
        toast({ title: 'Thành công', description: `Đã cập nhật Agent "${formName}"` })
      } else {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Tạo Agent thất bại')
        }
        toast({ title: 'Thành công', description: `Đã tạo Agent "${formName}"` })
      }
      closeDialog()
      void fetchAgents()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    } finally {
      setSaving(false)
    }
  }, [validateForm, editingAgent, formName, formDescription, formInstruction, formProvider, formModel, formTemperature, formMaxTokens, formTeam, formPosition, formAvatar, closeDialog, fetchAgents])

  // Delete agent
  const deleteAgent = useCallback(async (id: string, name: string) => {
    if (!confirm(`Xóa Agent "${name}"? Các phiên chat liên quan sẽ được giữ lại.`)) return
    try {
      const res = await fetch(`/api/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Xóa Agent thất bại')
      }
      toast({ title: 'Đã xóa', description: `Agent "${name}" đã được xóa` })
      void fetchAgents()
    } catch (err) {
      toast({ title: 'Không thể xóa', description: err instanceof Error ? err.message : 'Xóa Agent thất bại', variant: 'destructive' })
    }
  }, [fetchAgents])

  // Toggle agent enabled
  const toggleAgent = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      })
      if (!res.ok) throw new Error('Toggle failed')
      void fetchAgents()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể cập nhật trạng thái Agent', variant: 'destructive' })
    }
  }, [fetchAgents])

  // Handle provider change — reset model
  const handleProviderChange = useCallback((val: string) => {
    setFormProvider(val)
    setFormModel('')
  }, [])

  // Handle team change — reset position
  const handleTeamChange = useCallback((val: string) => {
    if (val === '_none') {
      setFormTeam(null)
      setFormPosition(null)
    } else {
      setFormTeam(val)
      setFormPosition(null)
    }
  }, [])

  // Group agents by team
  const codeAgents = useMemo(() => {
    const positions = CODE_POSITIONS
    return agents
      .filter((a: any) => a.team === 'code')
      .sort((a: any, b: any) => {
        const ai = positions.indexOf(a.position) ?? 99
        const bi = positions.indexOf(b.position) ?? 99
        return ai - bi
      })
  }, [agents])

  const researchAgents = useMemo(() => {
    const positions = RESEARCH_POSITIONS
    return agents
      .filter((a: any) => a.team === 'research')
      .sort((a: any, b: any) => {
        const ai = positions.indexOf(a.position) ?? 99
        const bi = positions.indexOf(b.position) ?? 99
        return ai - bi
      })
  }, [agents])

  const unaffiliatedAgents = useMemo(() =>
    agents.filter((a: any) => !a.team),
    [agents]
  )

  // Agent card renderer
  const AgentCard = ({ agent, accentColor }: { agent: any; accentColor: string }) => (
    <div
      className={`p-3.5 rounded-xl bg-slate-950/50 border ${accentColor} hover:border-opacity-60 transition-all group`}
    >
      {/* Top: Avatar + Name + Position */}
      <div className="flex items-start gap-3 mb-2.5">
        <span className="text-2xl leading-none flex-shrink-0 mt-0.5">{agent.avatar || '🤖'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-sm font-semibold text-stone-200 truncate">{agent.name}</h3>
            {agent.isSystem && (
              <Badge variant="outline" className="text-[7px] h-3.5 px-1 bg-fuchsia-950/50 text-fuchsia-300 border-fuchsia-500/55 font-bold tracking-wider">SYS</Badge>
            )}
            {agent.position && (
              <Badge variant="outline" className={`text-[8px] h-4 px-1 ${agent.position === 'TL' ? 'bg-amber-950/50 text-amber-300 border-amber-500/55' : 'bg-slate-950/50 text-stone-400 border-stone-500/55'}`}>
                {agent.position}
              </Badge>
            )}
            {agent.enabled === false && (
              <Badge variant="outline" className="text-[8px] h-4 px-1 bg-red-950/50 text-red-400 border-red-500/55">Tắt</Badge>
            )}
          </div>
          <p className="text-[11px] text-stone-400 line-clamp-2 mt-0.5">{agent.description}</p>
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 mb-2.5">
        <Badge variant="outline" className={`text-[9px] h-4.5 px-1.5 ${PROVIDER_BADGE_COLORS[agent.provider] || 'bg-slate-950/50 text-stone-400 border-stone-700'}`}>
          {PROVIDER_OPTIONS.find((p: any) => p.value === agent.provider)?.icon} {agent.provider}
        </Badge>
        <Badge variant="outline" className="text-[9px] h-4.5 px-1.5 bg-slate-950/50 text-stone-300 border-stone-500/55 truncate max-w-[140px]">
          {agent.model}
        </Badge>
        {/* Đề xuất 3 (2026-08-25): badge "mặc định/backup" trực quan hóa MODEL POLICY —
            kimi-k3 = lõi mặc định (emerald), lõi khác = backup (slate). */}
        {agent.model === 'moonshotai/kimi-k3' ? (
          <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-emerald-950/50 text-emerald-300 border-emerald-500/55 font-semibold">⭐ mặc định</Badge>
        ) : (
          <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-slate-950/50 text-stone-500 border-stone-600/55">↩️ backup</Badge>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 mb-2.5 text-[10px] text-stone-500">
        <span>🌡️ {agent.temperature ?? 0.7}</span>
        <span>📦 {(agent.maxTokens ?? 4096).toLocaleString()}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <div className="flex items-center gap-2">
          <Switch
            checked={agent.enabled ?? true}
            onCheckedChange={(checked) => void toggleAgent(agent.id, checked)}
            className="scale-75 data-[state=checked]:bg-emerald-500"
          />
          <span className="text-[10px] text-stone-500">{agent.enabled !== false ? 'Bật' : 'Tắt'}</span>
        </div>
        <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-stone-400 hover:text-amber-400 hover:bg-amber-950/30"
            onClick={() => openEditDialog(agent)}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          {!agent.isSystem && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-stone-400 hover:text-red-400 hover:bg-red-950/30"
              onClick={() => void deleteAgent(agent.id, agent.name)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  // Team section renderer — 3-per-row grid layout
  const TeamSection = ({ teamKey, label, icon, iconBg, agents: teamAgents, borderColor, accentBg }: {
    teamKey: string; label: string; icon: React.ReactNode; iconBg: string
    agents: any[]; borderColor: string; accentBg: string
  }) => (
    <div className="space-y-3">
      {/* Team header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-lg ${iconBg}`}>
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-stone-100">{label}</h3>
          <Badge className={`text-[10px] ${accentBg}`}>{teamAgents.length}</Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px] text-stone-400 hover:text-stone-200 hover:bg-slate-950/60"
          onClick={() => { resetForm(); setFormTeam(teamKey); setDialogOpen(true) }}
        >
          <Plus className="h-3 w-3 mr-1" /> Thêm vào {label}
        </Button>
      </div>

      {/* Empty team */}
      {teamAgents.length === 0 && (
        <div className={`p-6 rounded-xl border border-dashed ${borderColor} text-center`}>
          <p className="text-xs text-stone-500">Chưa có thành viên — nhấn "Thêm vào {label}" để tạo</p>
        </div>
      )}

      {/* 3-per-row grid */}
      {teamAgents.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {teamAgents.map((agent: any) => (
            <AgentCard key={agent.id} agent={agent} accentColor={borderColor} />
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="nc-wrap nc-magenta">
      {/* ==================== AGENTS MODULE ==================== */}
      <Card className="nc-panel nc-md nc-border-magenta">
        <CardContent className="pt-5 pb-5">
          {/* Module Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold tracking-tight text-stone-100">Agents</h2>
              <Badge className="text-[10px] bg-fuchsia-950/50 text-fuchsia-400 border border-fuchsia-500/55">
                {agents.length}
              </Badge>
            </div>
            <Button
              onClick={openCreateDialog}
              size="sm"
              className="h-8 px-3 text-xs bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white border-0"
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Tạo Agent mới
            </Button>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-fuchsia-400" />
            </div>
          )}

          {/* Error state — show when API fails */}
          {!loading && loadError && agents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/40 mb-4">
                <AlertTriangle className="h-10 w-10 text-red-400/70" />
              </div>
              <p className="text-sm text-red-400 font-medium mb-1">Không thể tải danh sách Agents</p>
              <p className="text-xs text-stone-500 max-w-md mb-3">{loadError}</p>
              <div className="text-[10px] text-stone-600 space-y-1 mb-4">
                <p>💡 Kiểm tra:</p>
                <p>• Đã chạy <code className="text-stone-400 bg-slate-950/60 px-1 rounded">bun run db:push</code> chưa?</p>
                <p>• File <code className="text-stone-400 bg-slate-950/60 px-1 rounded">.env</code> đã có DATABASE_URL chưa?</p>
                <p>• Dev server đang chạy trên port 3000?</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-4 text-xs border-fuchsia-400/35 text-fuchsia-400 hover:bg-fuchsia-950/30"
                onClick={() => void fetchAgents()}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Thử lại
              </Button>
            </div>
          )}

          {/* Empty state — no agents but no error */}
          {!loading && !loadError && agents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="p-4 rounded-2xl bg-slate-950/50 border border-fuchsia-400/35 mb-4">
                <Bot className="h-10 w-10 text-fuchsia-400/60" />
              </div>
              <p className="text-sm text-stone-400 mb-1">Chưa có Agent nào</p>
              <p className="text-xs text-stone-500">Tạo Agent đầu tiên để bắt đầu xây dựng hệ thống đa tác nhân</p>
            </div>
          )}

          {/* Team Sections */}
          {!loading && agents.length > 0 && (
            <div className="space-y-6">
              {/* ═══ Team Code ═══ */}
              <TeamSection
                teamKey="code"
                label="💻 Team Code"
                icon={<Code2 className="h-4 w-4 text-white" />}
                iconBg="bg-gradient-to-br from-amber-500 to-orange-600"
                agents={codeAgents}
                borderColor="border-amber-400/35"
                accentBg="bg-amber-950/50 text-amber-400 border border-amber-500/55"
              />

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-fuchsia-500/10" />
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/30" />
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/20" />
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/10" />
                </div>
                <div className="flex-1 h-px bg-fuchsia-500/10" />
              </div>

              {/* ═══ Team Research ═══ */}
              <TeamSection
                teamKey="research"
                label="🔬 Team Research"
                icon={<GraduationCap className="h-4 w-4 text-white" />}
                iconBg="bg-gradient-to-br from-cyan-500 to-teal-600"
                agents={researchAgents}
                borderColor="border-cyan-400/35"
                accentBg="bg-cyan-950/50 text-cyan-400 border border-cyan-500/55"
              />

              {/* Unaffiliated Agents */}
              {unaffiliatedAgents.length > 0 && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-fuchsia-500/10" />
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/30" />
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/20" />
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/10" />
                    </div>
                    <div className="flex-1 h-px bg-fuchsia-500/10" />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-gradient-to-br from-stone-500 to-stone-600">
                        <User className="h-4 w-4 text-white" />
                      </div>
                      <h3 className="text-sm font-semibold text-stone-100">Độc lập</h3>
                      <Badge className="text-[10px] bg-slate-950/50 text-stone-400 border border-stone-500/55">{unaffiliatedAgents.length}</Badge>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {unaffiliatedAgents.map((agent: any) => (
                        <AgentCard key={agent.id} agent={agent} accentColor="border-stone-500/45" />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ==================== CREATE/EDIT AGENT DIALOG ==================== */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden bg-slate-950 border-fuchsia-400/35 text-stone-200 dialog-scrollbar pr-5">
          <DialogHeader>
            <DialogTitle className="text-fuchsia-400 flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {editingAgent ? 'Sửa Agent' : 'Tạo Agent mới'}
            </DialogTitle>
            <DialogDescription className="text-stone-400 text-xs">
              {editingAgent ? 'Chỉnh sửa thông tin và cấu hình Agent' : 'Thiết lập Agent mới với vai trò, hướng dẫn và cấu hình AI'}
            </DialogDescription>
          </DialogHeader>

          {/* Error message */}
          {formError && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-500/55 text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {formError}
            </div>
          )}

          {/* Avatar Picker */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-300">Avatar</label>
            <div className="flex flex-wrap gap-1.5">
              {AVATAR_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setFormAvatar(emoji)}
                  className={`h-8 w-8 rounded-lg text-base flex items-center justify-center border transition-all ${
                    formAvatar === emoji
                      ? 'border-fuchsia-500 bg-fuchsia-950/40 ring-1 ring-fuchsia-500/50'
                      : 'border-stone-500/55 bg-slate-950/30 hover:border-stone-600'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* Tên Agent */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Tên Agent <span className="text-red-400">*</span>
            </label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="VD: Code Architect"
              maxLength={50}
              className="text-xs h-9 bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50"
            />
            <p className="text-[10px] text-stone-500">{formName.length}/50</p>
          </div>

          {/* Mô tả vai trò — Textarea với giới hạn 10000 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Mô tả vai trò <span className="text-red-400">*</span>
            </label>
            <Textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Mô tả chi tiết vai trò, trách nhiệm và chuyên môn của Agent..."
              maxLength={10000}
              rows={4}
              className="text-xs bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50 resize-none max-h-40 dialog-scrollbar overflow-y-auto"
            />
            <p className="text-[10px] text-stone-500">{formDescription.length}/10,000</p>
          </div>

          {/* Hướng dẫn chi tiết — Textarea với giới hạn 10000 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Hướng dẫn chi tiết (System Prompt) <span className="text-red-400">*</span>
            </label>
            <Textarea
              value={formInstruction}
              onChange={(e) => setFormInstruction(e.target.value)}
              placeholder="Nhập hướng dẫn chi tiết cho Agent — nội dung này sẽ được sử dụng làm system prompt khi Agent hoạt động..."
              maxLength={10000}
              rows={6}
              className="text-xs bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50 resize-none max-h-52 dialog-scrollbar overflow-y-auto"
            />
            <p className="text-[10px] text-stone-500">{formInstruction.length}/10,000</p>
          </div>

          {/* Divider — AI Core */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-fuchsia-500/20" />
            <span className="text-[10px] text-fuchsia-400/60 font-medium uppercase tracking-wider">Lõi AI</span>
            <div className="flex-1 h-px bg-fuchsia-500/20" />
          </div>

          {/* Provider + Model + Team + Position — all in one row */}
          <div className="grid grid-cols-4 gap-2">
            {/* Provider */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Provider <span className="text-red-400">*</span>
              </label>
              <Select value={formProvider} onValueChange={handleProviderChange}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {p.icon} {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Model <span className="text-red-400">*</span>
              </label>
              <Select value={formModel} onValueChange={setFormModel}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {currentProviderModels.map((m: any) => (
                    <SelectItem key={m.id} value={m.id} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {m.label || m.id}
                    </SelectItem>
                  ))}
                  {currentProviderModels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-stone-500">Chọn provider trước</div>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Team */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">Team</label>
              <Select value={formTeam || '_none'} onValueChange={handleTeamChange}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Team" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  <SelectItem value="_none" className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                    Không chọn
                  </SelectItem>
                  {TEAM_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Position */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Vị trí {formTeam && <span className="text-red-400">*</span>}
              </label>
              <Select value={formPosition || ''} onValueChange={setFormPosition} disabled={!formTeam}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50 disabled:opacity-40">
                  <SelectValue placeholder={formTeam ? 'Vị trí' : '—'} />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {(TEAM_POSITIONS[formTeam!] || []).map((pos) => (
                    <SelectItem key={pos} value={pos} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {pos} — {POSITION_LABELS[pos] || pos}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Temperature + Max Tokens — inline row */}
          <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-300 flex items-center justify-between">
                <span>Temperature</span>
                <span className="text-fuchsia-400 font-mono">{formTemperature.toFixed(1)}</span>
              </label>
              <Slider
                value={[formTemperature]}
                onValueChange={([val]) => setFormTemperature(val)}
                min={0}
                max={2}
                step={0.1}
                className="py-2 [&_[data-slot=slider-range]]:bg-fuchsia-500 [&_[data-slot=slider-thumb]]:border-fuchsia-500"
              />
              <div className="flex justify-between text-[9px] text-stone-600">
                <span>0.0 (Precise)</span>
                <span>2.0 (Creative)</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-300">Max Tokens</label>
              <Input
                type="number"
                value={formMaxTokens}
                onChange={(e) => setFormMaxTokens(Number(e.target.value))}
                min={256}
                max={32768}
                className="text-xs h-8 bg-slate-950/50 border-fuchsia-400/35 text-stone-200 focus:border-fuchsia-500/50 w-28"
              />
            </div>
          </div>

          {/* Dialog Actions */}
          <DialogFooter className="pt-2 border-t border-fuchsia-500/10">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-4 text-xs text-stone-400 hover:text-stone-200"
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-9 px-4 text-xs bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white border-0"
              disabled={saving}
              onClick={() => void saveAgent()}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {editingAgent ? 'Lưu thay đổi' : 'Tạo Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== MAIN PAGE ====================

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthLastChecked, setHealthLastChecked] = useState<Date | null>(null)
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  /** Last health check error — when set, the status bar shows a retryable error
   *  instead of spinning "Đang kiểm tra kết nối..." forever. */
  const [healthError, setHealthError] = useState<string | null>(null)
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  /** Ref to always have latest documents in async closures (avoids stale closure issues)
   *  Also used by fetchDocuments to guard against empty-list overwrite during polling. */
  const documentsRef = useRef(documents)
  useEffect(() => { documentsRef.current = documents }, [documents])
  /** Set of existing document titles — used by UploadSection to reject duplicates */
  const existingDocNames = useMemo(() => new Set(documents.map(d => d.title)), [documents])
  const [docPage, setDocPage] = useState(1)
  /** Ref to always have latest docPage in async closures (avoids stale closure issues) */
  const docPageRef = useRef(1)
  useEffect(() => { docPageRef.current = docPage }, [docPage])
  const [docTotal, setDocTotal] = useState(0)
  const docPageSize = 25
  /** Status breakdown across ALL documents (not just current page) */
  const [docStatusBreakdown, setDocStatusBreakdown] = useState<Record<string, number>>({})
  /** Loading state for document page changes */
  const [docLoading, setDocLoading] = useState(false)
  /** AbortController ref to cancel stale fetch requests (prevents race condition) */
  const fetchDocsAbortRef = useRef<AbortController | null>(null)
  const [entityTotal, setEntityTotal] = useState(0)
  const [relationshipTotal, setRelationshipTotal] = useState(0)
  const [resolvedEntityTotal, setResolvedEntityTotal] = useState(0)
  const [dbStats, setDbStats] = useState<DBStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  /** Tracks documents currently being EXTRACTED (status='extracting' or user clicked "Tiếp tục").
   *  This is separate from processingIds — it prevents the UI from flipping "Tạm dừng" → "Tiếp tục"
   *  if reconciliation temporarily changes the status. Only cleared when the pipeline truly finishes
   *  (indexed/error) or the user navigates away.
   */
  const [extractingDocIds, setExtractingDocIds] = useState<Set<string>>(new Set())
  /** Tracks documents that the user has PAUSED. Prevents auto-continue from re-triggering them.
   *  Cleared when the user clicks "Tiếp tục" to resume processing.
   */
  const [pausedDocIds, setPausedDocIds] = useState<Set<string>>(new Set())
  /** Ref to always have latest pausedDocIds in async closures (avoids stale closure issues) */
  const pausedDocIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => { pausedDocIdsRef.current = pausedDocIds }, [pausedDocIds])
  /** Tracks documents that the user EXPLICITLY paused (clicked "Tạm dừng").
   *  Different from pausedDocIds: pausedDocIds includes all paused docs,
   *  while userPausedDocIds only tracks docs the user manually paused.
   *  This distinction is needed to show:
   *  - "Đang tiếp tục..." (disabled, spinner) when doc is 'partial' but NOT user-paused (auto-continue active)
   *  - "Tiếp tục" (active button) when doc is 'partial' AND user-paused
   */
  const [userPausedDocIds, setUserPausedDocIds] = useState<Set<string>>(new Set())
  /** Ref to always have latest userPausedDocIds in async closures */
  const userPausedDocIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => { userPausedDocIdsRef.current = userPausedDocIds }, [userPausedDocIds])
  const [processingAll, setProcessingAll] = useState(false)
  const [activeTab, setActiveTab] = useState('chat')
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  /** Sidebar state: collapsed = thin strip with logo only, expanded = full sidebar panel */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activeModule, setActiveModule] = useState<'smolab' | 'agents' | 'database'>('database')

  // Auto-collapse sidebar on small screens (below md breakpoint)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setSidebarOpen(false)
    }
    handler(mq)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Phase 2 fix: set tmo_api_token HttpOnly cookie ngay khi page mount.
  // Cookie được tự gửi kèm mọi request /api/workspace + /api/opencode/*
  // → middleware chấp nhận (cookie path) — không cần token trong localStorage.
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/setup', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data?.ok) {
          // Cookie đã set — các request tiếp theo tự mang theo.
        }
      })
      .catch(err => console.warn('[auth/setup] cookie setup failed:', err))
    return () => { cancelled = true }
  }, [])
  const [gitPulling, setGitPulling] = useState(false)
  const [gitPullDialogOpen, setGitPullDialogOpen] = useState(false)
  const [gitPullRepoUrl, setGitPullRepoUrl] = useState('')
  const [gitPullApiToken, setGitPullApiToken] = useState('')
  const [gitPullBranch, setGitPullBranch] = useState('main')
  const [gitPullLoading, setGitPullLoading] = useState(false)
  const [gitPullConfirmOpen, setGitPullConfirmOpen] = useState(false)
  const [gitPullDryRunResult, setGitPullDryRunResult] = useState<{files: string[], schemaChanged: boolean, depsChanged?: boolean} | null>(null)
  const [gitPullDefaultConfig, setGitPullDefaultConfig] = useState<{currentRemote: string | null, currentBranch: string | null, currentCommit: string | null, repoUrl: string | null, hasToken: boolean, isGitRepo?: boolean} | null>(null)

  /** Validate repo URL format on the client side */
  const validateGitPullUrl = useCallback((url: string): string | null => {
    const trimmed = url.trim()
    if (!trimmed) return 'Vui lòng nhập URL kho lưu trữ'
    // Accept HTTPS, SSH, or bare domain formats
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return null
    if (trimmed.startsWith('git@')) return null // SSH format — backend will convert
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\//.test(trimmed)) return null // bare domain like github.com/user/repo
    return 'URL không hợp lệ. Sử dụng định dạng: https://github.com/user/repo.git hoặc git@github.com:user/repo.git'
  }, [])

  const handleGitPullDialogOpen = useCallback(async () => {
    setGitPullDialogOpen(true)
    setGitPullDryRunResult(null)
    // Fetch current git config and update commit/branch info
    try {
      const res = await fetch('/api/git-pull')
      const data = await res.json()
      setGitPullDefaultConfig(data)
      if (data.repoUrl) {
        setGitPullRepoUrl(data.repoUrl)
      }
      if (data.currentBranch) {
        setGitPullBranch(data.currentBranch)
      } else {
        setGitPullBranch('main')
      }
    } catch {}
  }, [])

  const handleGitPullDryRun = useCallback(async () => {
    // Client-side URL validation
    const urlError = validateGitPullUrl(gitPullRepoUrl)
    if (urlError) {
      toast({ title: 'Lỗi kiểm tra', description: urlError, variant: 'destructive', duration: 5000 })
      return
    }
    setGitPullLoading(true)
    setGitPullDryRunResult(null)
    try {
      const res = await fetch('/api/git-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: gitPullRepoUrl, apiToken: gitPullApiToken, branch: gitPullBranch, dryRun: true })
      })
      const data = await res.json()
      if (data.success) {
        setGitPullDryRunResult({ files: data.changedFiles || [], schemaChanged: data.schemaChanged || false })
      } else {
        toast({ title: 'Lỗi kiểm tra', description: data.error || 'Lỗi không xác định', variant: 'destructive', duration: 8000 })
      }
    } catch (err) {
      toast({ title: 'Lỗi kiểm tra', description: 'Không thể kết nối đến server. Vui lòng thử lại.', variant: 'destructive', duration: 5000 })
    } finally {
      setGitPullLoading(false)
    }
  }, [gitPullRepoUrl, gitPullApiToken, gitPullBranch, validateGitPullUrl])

  const handleGitPull = useCallback(async () => {
    // Client-side URL validation
    const urlError = validateGitPullUrl(gitPullRepoUrl)
    if (urlError) {
      toast({ title: 'Lỗi pull code', description: urlError, variant: 'destructive', duration: 5000 })
      return
    }
    setGitPullConfirmOpen(false)
    setGitPullLoading(true)
    try {
      const res = await fetch('/api/git-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: gitPullRepoUrl, apiToken: gitPullApiToken, branch: gitPullBranch })
      })
      const data = await res.json()
      if (data.success) {
        if (data.isUpToDate) {
          toast({ title: 'Đã cập nhật', description: 'Code đã là phiên bản mới nhất', duration: 3000 })
        } else if (data.hasChanges) {
          const parts = [`Cập nhật ${data.beforeCommit} → ${data.afterCommit}`]
          if (data.checkoutStats?.success) parts.push(`${data.checkoutStats.success} file đã cập nhật`)
          if (data.checkoutStats?.failed > 0) parts.push(`⚠️ ${data.checkoutStats.failed} file thất bại: ${data.checkoutStats.failedFiles?.join(', ')}`)
          if (data.depsChanged && data.installResult) parts.push('Dependencies đã cài đặt')
          if (data.schemaChanged) parts.push('Schema đã cập nhật — tự động chạy prisma generate & db:push')
          toast({ title: 'Pull thành công!', description: parts.join('. '), duration: 12000 })
        } else {
          toast({ title: 'Pull hoàn tất', description: data.output, duration: 3000 })
        }
        setGitPullDialogOpen(false)
      } else {
        toast({ title: 'Lỗi pull code', description: data.error || 'Lỗi không xác định', variant: 'destructive', duration: 10000 })
      }
    } catch (err) {
      toast({ title: 'Lỗi pull code', description: 'Không thể kết nối đến server. Vui lòng thử lại.', variant: 'destructive', duration: 5000 })
    } finally {
      setGitPullLoading(false)
    }
  }, [gitPullRepoUrl, gitPullApiToken, gitPullBranch, validateGitPullUrl, toast])

  // Restore persisted active module AFTER mount to avoid hydration mismatch.
  const moduleRestoredRef = useRef(false)
  useEffect(() => {
    if (!moduleRestoredRef.current) {
      moduleRestoredRef.current = true
      try {
        const saved = localStorage.getItem('graphrag-active-module')
        if (saved) {
          const validModules = ['smolab', 'agents', 'database']
          const validModule = validModules.includes(saved) ? saved as 'smolab' | 'agents' | 'database' : 'database'
          setActiveModule(validModule)
          if (validModule !== saved) localStorage.setItem('graphrag-active-module', validModule)
        }
      } catch { /* ignore */ }
    }
  }, [])

  /** Auto mode: when enabled, after a doc finishes processing, the next uploaded doc auto-starts.
   *  When disabled (default), the user must manually click "Xử lý" on each document.
   *  Persisted in localStorage so it survives page reloads. */
  const [autoMode, setAutoMode] = useState(() => {
    if (typeof window !== 'undefined') {
      try { const saved = localStorage.getItem('graphrag-auto-mode'); return saved === 'true' } catch {}
    }
    return false
  })
  /** Wallpaper URL — dynamic so we can update it without page reload */
  const [wallpaperUrl, setWallpaperUrl] = useState('/bg/wallpaper_tmp.png')
  const wallpaperInputRef = useRef<HTMLInputElement>(null)

  /** Upload wallpaper handler */
  const handleWallpaperUpload = useCallback(async () => {
    const files = wallpaperInputRef.current?.files
    if (!files || files.length === 0) return
    const file = files[0]
    const formData = new FormData()
    formData.append('wallpaper', file)
    try {
      const res = await fetch('/api/wallpaper', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        toast({ title: 'Lỗi upload wallpaper', description: err.error || 'Unknown error', variant: 'destructive' })
        return
      }
      const data = await res.json()
      if (data.url) {
        setWallpaperUrl(data.url)
        toast({ title: '✅ Wallpaper đã cập nhật!', description: `${file.name} (${(file.size / 1024).toFixed(0)}KB)` })
      }
    } catch (err) {
      toast({ title: 'Lỗi upload wallpaper', description: String(err), variant: 'destructive' })
    }
    // Reset input
    if (wallpaperInputRef.current) wallpaperInputRef.current.value = ''
  }, [])

  const fetchHealth = useCallback(async () => {
    setHealthRefreshing(true)
    // FIX: add a per-request timeout + real error handling. Previously errors were
    // swallowed by `catch {}` and non-200 responses were ignored, so when /api/health
    // failed (server busy, Qdrant down, network hiccup) the status bar stayed stuck
    // at "Đang kiểm tra kết nối..." forever with no feedback and no visible retry state.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetch('/api/health', { signal: controller.signal })
      if (res.ok) {
        const data = await res.json()
        setHealth(data)
        setHealthError(null)
        setHealthLastChecked(new Date())
        // Notify user about daily quota exhaustion
        if (data.dailyQuotaStatus) {
          const exhausted: string[] = []
          for (const [name, q] of Object.entries(data.dailyQuotaStatus)) {
            if (q.dailyQuotaExhaustedKeys > 0) exhausted.push(`${name} (${q.dailyQuotaExhaustedKeys}/${q.totalKeys} key hết hạn mức)`)
          }
          if (exhausted.length > 0) {
            sonnerToast.warning('API Key hết hạn mức ngày', {
              description: exhausted.join(' · ') + ' — sẽ tự động reset vào nửa đêm',
              duration: 10000,
              id: 'daily-quota-exhausted', // Dedupe — only show once
            })
          }
        }
      } else {
        // Non-200 response (e.g. 500) — surface it instead of silently keeping the spinner
        setHealthError(`Lỗi HTTP ${res.status}`)
      }
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'AbortError'
        ? 'Hết thời gian chờ (20s)'
        : 'Không kết nối được server'
      setHealthError(msg)
    } finally {
      clearTimeout(timeoutId)
    }
    setHealthRefreshing(false)
  }, [])

  const fetchDocuments = useCallback(async (forceReconcile = false, page?: number, options?: { lite?: boolean }) => {
    const currentPage = docPageRef.current
    const isPageChange = page !== undefined && page !== currentPage

    // FIX: Only abort in-flight requests for page changes (user explicitly navigating).
    // For polling calls (no page param), DON'T abort — this was causing:
    // 1. Every 2-3s poll aborts the previous in-flight request
    // 2. If API takes >3s, no request ever completes → documents list disappears
    // 3. Multiple AbortControllers fighting each other
    if (isPageChange) {
      fetchDocsAbortRef.current?.abort()
    }
    const abortController = new AbortController()
    fetchDocsAbortRef.current = abortController

    if (isPageChange) setDocLoading(true)

    try {
      const p = page ?? currentPage
      const params = new URLSearchParams({ page: String(p), pageSize: String(docPageSize) })
      if (forceReconcile) params.set('reconcile', 'true')
      // Lite mode: skip heavy reconciliation and chunk coverage recomputation.
      // Used for page changes AND polling — makes both nearly instant (~50ms vs 1-5s).
      // Full reconciliation only runs on explicit user actions (upload, delete, tab change, manual refresh).
      const useLite = options?.lite || (isPageChange && !forceReconcile)
      if (useLite && !forceReconcile) params.set('lite', 'true')
      const res = await fetch(`/api/ingestion/upload?${params.toString()}`, { signal: abortController.signal })
      if (res.ok) {
        const data = await res.json()
        // Merge chunk coverage into documents
        const docs = (data.documents || []) as DocumentRecord[]

        // GUARD: Never replace the document list with an empty array during polling.
        // If the API temporarily returns 0 docs (cache miss, Qdrant blip, etc.),
        // keep the previous list to prevent the UI from flashing empty and then
        // repopulating — this was the cause of "document list disappearing".
        // Only allow empty list on:
        // 1. Explicit page changes (user navigating)
        // 2. Forced reconciliation (manual refresh)
        // 3. First load (current docs is empty — we have nothing to protect)
        // 4. API returned a warning (error case — but we should still show the empty state
        //    so the user sees the warning message instead of stale data)
        if (docs.length === 0 && !isPageChange && !forceReconcile && !data.warning) {
          const currentDocs = documentsRef.current
          if (currentDocs.length > 0) {
            // Skip this update — keep the existing list
            return
          }
        }
        const coverage = data.chunkCoverage as Record<string, ChunkCoverage> | undefined
        if (coverage) {
          for (const doc of docs) {
            if (coverage[doc.id]) {
              doc.chunk_coverage = coverage[doc.id]
            }
          }
        }
        // FIX (perf): this runs every 3s during processing. Setting a fresh array
        // reference every tick re-rendered the whole Home + document list subtree
        // even when nothing changed. Skip the state update when the visible fields
        // are identical (same ids + statuses + percent + coverage presence).
        setDocuments(prev => {
          const changed =
            prev.length !== docs.length ||
            docs.some((d, i) => {
              const p = prev[i]
              return !p || p.id !== d.id || p.status !== d.status ||
                p.processing_percent !== d.processing_percent ||
                p.error_message !== d.error_message ||
                (!d.chunk_coverage) !== (!p.chunk_coverage)
            })
          return changed ? docs : prev
        })
        setDocTotal(data.total || 0)
        if (data.statusBreakdown) setDocStatusBreakdown(data.statusBreakdown)
        if (page !== undefined) setDocPage(page)

        // FIX: Sync extractingDocIds with the actual document states from the API.
        // 1. Clear extractingDocIds for documents that have completed (indexed/error/uploaded/partial).
        //    Partial docs need user action (click "Tiếp tục") to resume — they are NOT actively extracting.
        // 2. ADD docs in 'extracting'/'parsing'/'chunked' states that were started by
        //    auto-next (backend auto-chain) — the frontend didn't trigger these, so
        //    they aren't in extractingDocIds yet. Without this, auto-next docs don't
        //    show the "Tạm dừng" button and aren't polled for progress.
        // 3. STALE DOC DETECTION: If a doc is in 'extracting'/'parsing'/'chunked' but
        //    hasn't been updated for 5+ minutes, the backend process has likely died.
        //    Remove it from extractingDocIds so the UI shows "Tiếp tục" instead of "Tạm dừng".
        setExtractingDocIds(prev => {
          let changed = false
          const newSet = new Set(prev)

          // Remove completed/paused docs.
          // 'partial' docs are kept in extractingDocIds if the user did NOT explicitly pause them,
          // because auto-continue will re-trigger them. Only remove 'partial' docs that the user
          // explicitly paused (in userPausedDocIds) — those should show "Tiếp tục" button.
          for (const id of prev) {
            const doc = docs.find(d => d.id === id)
            if (!doc) { newSet.delete(id); changed = true; continue }
            if (['indexed', 'extracted', 'error', 'uploaded'].includes(doc.status)) {
              newSet.delete(id)
              changed = true
            }
            // Doc is 'partial' — keep in extractingDocIds unless user explicitly paused it.
            // Auto-continue will re-trigger, so we show "Đang tiếp tục..." instead of "Tiếp tục".
            if (doc.status === 'partial' && userPausedDocIdsRef.current.has(doc.id)) {
              newSet.delete(id)
              changed = true
            }
          }

          // Add docs that are actively processing but not yet tracked
          // This handles auto-next docs started by the backend auto-chain
          for (const doc of docs) {
            if (['extracting', 'parsing', 'chunked'].includes(doc.status) && !newSet.has(doc.id)) {
              // Only add if the doc was recently updated (actively processing, not stale)
              const updatedRecently = doc.updated_at && (Date.now() - new Date(doc.updated_at).getTime()) < 5 * 60 * 1000
              if (updatedRecently) {
                newSet.add(doc.id)
                changed = true
              }
            }
          }

          // STALE DOC DETECTION: Remove docs from extractingDocIds if they haven't
          // been updated in 5+ minutes. This means the backend process has died
          // (hot-reload, OOM, unhandled error) and the doc is stuck in 'extracting'.
          // The doc should show "Tiếp tục" button, not "Tạm dừng".
          for (const id of newSet) {
            const doc = docs.find(d => d.id === id)
            if (doc) {
              const isStale = doc.updated_at && (Date.now() - new Date(doc.updated_at).getTime()) > 5 * 60 * 1000
              if (isStale) {
                newSet.delete(id)
                changed = true
              }
            }
          }

          return changed ? newSet : prev
        })

        // Also sync processingIds — clear for completed/paused docs, add for auto-next docs
        setProcessingIds(prev => {
          let changed = false
          const newSet = new Set(prev)

          for (const id of prev) {
            const doc = docs.find(d => d.id === id)
            if (!doc) { newSet.delete(id); changed = true; continue }
            if (['indexed', 'extracted', 'error', 'uploaded'].includes(doc.status)) {
              newSet.delete(id)
              changed = true
            }
            // 'partial' docs: keep in processingIds unless user explicitly paused
            if (doc.status === 'partial' && userPausedDocIdsRef.current.has(doc.id)) {
              newSet.delete(id)
              changed = true
            }
          }

          for (const doc of docs) {
            if (['extracting', 'parsing', 'chunked'].includes(doc.status) && !newSet.has(doc.id)) {
              const updatedRecently = doc.updated_at && (Date.now() - new Date(doc.updated_at).getTime()) < 5 * 60 * 1000
              if (updatedRecently) {
                newSet.add(doc.id)
                changed = true
              }
            }
          }

          // STALE DOC DETECTION (same as extractingDocIds)
          for (const id of newSet) {
            const doc = docs.find(d => d.id === id)
            if (doc) {
              const isStale = doc.updated_at && (Date.now() - new Date(doc.updated_at).getTime()) > 5 * 60 * 1000
              if (isStale) {
                newSet.delete(id)
                changed = true
              }
            }
          }

          return changed ? newSet : prev
        })
      }
    } catch (err) {
      // Ignore AbortError — this means a newer request superseded this one
      if (err instanceof DOMException && err.name === 'AbortError') return
    } finally {
      setDocLoading(false)
    }
  }, [docPageSize])

  // fetchEntities and fetchRelationships removed — tabs removed, data available via Analytics

  const fetchEmbeddingStatus = useCallback(async () => {
    try { const res = await fetch('/api/query?action=embed-status'); if (res.ok) { const data = await res.json(); setEmbeddingStatus(data) } } catch {}
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/query?action=stats')
      if (res.ok) {
        const data = await res.json()
        setEntityTotal(data.totalEntities || 0)
        setRelationshipTotal(data.totalRelationships || 0)
        setResolvedEntityTotal(data.totalResolvedEntities || 0)
        setDbStats(data)
      }
    } catch { /* ignore */ }
  }, [])

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab)
    try { localStorage.setItem('graphrag-active-tab', tab) } catch { /* ignore */ }
    if (tab === 'documents') fetchDocuments()
    if (tab === 'explorer') fetchEmbeddingStatus()
    if (tab === 'analytics') {
      fetchStats() // Always refresh DB stats for accurate analytics
      fetchEmbeddingStatus()
      fetchHealth()  // Refresh health to get latest Neo4j stats
    }
    // TokenUsageSection handles its own data fetching via useEffect
  }, [fetchDocuments, fetchEmbeddingStatus, fetchHealth, fetchStats])

  const handleProcessDoc = useCallback(async (documentId: string) => {
    setProcessingIds(prev => new Set([...prev, documentId]))
    setExtractingDocIds(prev => new Set([...prev, documentId]))
    // Clear paused state — user is resuming this document
    setPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
    setUserPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })

    // NOTE: No separate progressPoll here — the auto-poll useEffect already polls every 3s
    // when processingIds or extractingDocIds has entries. Previously, having a separate
    // progressPoll (2s) + auto-poll (2s) + tab refresh (10s) caused overlapping fetchDocuments()
    // calls that fought each other via AbortController.

    try {
      // Use async (fire-and-forget) mode to prevent HTTP timeout on large documents
      // The pipeline runs in the background and we poll for progress
      // Retry up to 3 times with increasing delay for transient network errors
      const MAX_POST_RETRIES = 3
      let res: Response | null = null
      let lastPostError: Error | null = null

      for (let attempt = 1; attempt <= MAX_POST_RETRIES; attempt++) {
        try {
          res = await fetch('/api/ingestion/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentIds: [documentId], async: true, autoNext: autoMode }),
          })
          break // Success — exit retry loop
        } catch (fetchErr) {
          lastPostError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr))
          if (attempt < MAX_POST_RETRIES) {
            const retryDelay = attempt * 2000 // 2s, 4s
            console.warn(`[ProcessDoc] POST attempt ${attempt}/${MAX_POST_RETRIES} failed, retrying in ${retryDelay / 1000}s:`, lastPostError.message)
            await new Promise(resolve => setTimeout(resolve, retryDelay))
          }
        }
      }

      if (!res) {
        throw new Error(`Không thể kết nối server sau ${MAX_POST_RETRIES} lần thử: ${lastPostError?.message || 'lỗi mạng'}`)
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        // Handle "busy" response — too many documents being processed concurrently
        if (res.status === 503 && errorData.busy) {
          // In auto mode, auto-retry after a delay (keys will free as docs finish)
          if (autoMode) {
            sonnerToast.info('Đang chờ key trống', {
              description: `Đang trích xuất ${errorData.extractingCount || '?'} tài liệu. Sẽ tự động thử lại sau 10 giây.`,
              duration: 6000,
            })
            // Wait for keys to free, then retry
            await new Promise(resolve => setTimeout(resolve, 10_000))
            try {
              const retryRes = await fetch('/api/ingestion/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentIds: [documentId], async: true, autoNext: true }),
              })
              if (retryRes.ok) {
                // Success on retry — use this response and continue below
                res = retryRes
              } else {
                // Retry also failed — give up gracefully
                const retryData = await retryRes.json().catch(() => ({}))
                sonnerToast.warning(retryRes.status === 503 ? 'Vẫn quá tải' : 'Lỗi xử lý', {
                  description: retryRes.status === 503 ? 'Tất cả key vẫn đang bận. Vui lòng thử lại sau.' : (retryData.error || 'Lỗi không xác định'),
                  duration: 8000,
                })
                setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
                setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
                return
              }
            } catch {
              setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
              setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
              return
            }
          } else {
            // Not auto mode — show warning and stop
            sonnerToast.warning('Đang xử lý quá tải', {
              description: `Đang trích xuất ${errorData.extractingCount || '?'} tài liệu. Tối đa ${errorData.maxConcurrent || 16} tài liệu cùng lúc. Bật chế độ Tự động hoặc thử lại sau.`,
              duration: 8000,
            })
            setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
            setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
            return
          }
        }
        throw new Error(errorData.error || 'Process API error')
      }

      const data = await res.json()
      if (data.error) throw new Error(data.error)

      // Async mode: the pipeline is now running in the background with auto-chain
      // The backend will automatically continue extraction when a batch times out.
      // Progress will be tracked via polling (progressPoll interval)
      sonnerToast.info('Đang xử lý tài liệu', {
        description: autoMode
          ? '4 keys × 4 docs/key (tối đa 16 song song) — xong key nào tự chuyển tài liệu tiếp.'
          : 'Đang trích xuất — cần bấm "Xử lý" cho tài liệu tiếp theo.',
        duration: 4000,
      })

      // Keep polling until the document is fully processed.
      // When extraction times out (partial), we auto-trigger the next batch.
      // This loop continues until: indexed/extracted (done), error, or max time exceeded.
      const maxTotalWaitMs = 120 * 60 * 1000 // 2 hours max for very large documents
      const totalStartTime = Date.now()
      let batchCount = 0

      const waitForCompletionAndAutoContinue = async () => {
        let lastPartialTime = 0
        const PARTIAL_RETRY_DELAY = 15_000 // Re-trigger if stuck in 'partial' for 15 seconds — enough for backend recovery, not too long for user

        while (Date.now() - totalStartTime < maxTotalWaitMs) {
          batchCount++

          // Poll this batch until it finishes
          const batchResult = await pollBatchUntilDone(documentId)

          if (batchResult === 'done') {
            // Document is fully indexed/extracted
            setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
            sonnerToast.success('Xử lý hoàn thành!', { description: 'Tài liệu đã được xử lý thành công', duration: 5000 })
            return
          } else if (batchResult === 'error') {
            setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
            return
          } else if (batchResult === 'partial') {
            // If the user paused this doc, stop waiting — don't re-trigger
            if (pausedDocIdsRef.current.has(documentId)) {
              console.log(`[ProcessDoc] Document ${documentId.slice(0, 8)}... is paused — stopping waitForCompletion`)
              setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
              return
            }
            // Backend auto-chain handles partial batches.
            // Only re-trigger if the doc has been stuck in 'partial' for too long
            // (this handles the case where the backend auto-chain breaks, e.g., server crash)
            const now = Date.now()
            if (lastPartialTime === 0) {
              lastPartialTime = now
            } else if (now - lastPartialTime > PARTIAL_RETRY_DELAY) {
              // Stuck for too long — re-trigger the pipeline
              console.log(`[ProcessDoc] Document stuck in 'partial' for ${PARTIAL_RETRY_DELAY / 1000}s — re-triggering pipeline`)
              try {
                const nextRes = await fetch('/api/ingestion/process', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ documentIds: [documentId], async: true, autoNext: autoMode }),
                })
                if (!nextRes.ok) {
                  const errorData = await nextRes.json().catch(() => ({}))
                  throw new Error(errorData.error || 'Process API error')
                }
                lastPartialTime = 0 // Reset timer
                sonnerToast.info(`Tiếp tục trích xuất (retry #${batchCount})`, {
                  description: 'Tài liệu bị kẹt — đã tự động thử lại.',
                  duration: 5000,
                })
              } catch (err) {
                console.error('[ProcessDoc] Auto-continue retry failed:', err)
                setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
                sonnerToast.error('Lỗi tự động tiếp tục', {
                  description: err instanceof Error ? err.message : 'Không thể tiếp tục trích xuất',
                  duration: 6000,
                })
                return
              }
            }
            // Keep polling — the backend auto-chain should resume shortly
            continue
          } else {
            // Unknown result — stop
            break
          }
        }
        // Max wait exceeded
        setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        sonnerToast.error('Hết thời gian chờ', { description: 'Quá trình trích xuất đã kéo dài quá 2 giờ.', duration: 8000 })
      }

      /** Poll a single batch until it reaches a terminal state (partial/indexed/extracted/error).
       *  Includes network error recovery with exponential backoff and max failure threshold.
       *  This prevents "TypeError: Failed to fetch" from crashing the entire polling loop. */
      const pollBatchUntilDone = async (docId: string): Promise<'done' | 'partial' | 'error' | 'unknown'> => {
        let partialConfirmCount = 0
        let consecutiveFetchFailures = 0
        const MAX_FETCH_FAILURES = 10  // Bail after 10 consecutive failures (~30s-5min depending on backoff)

        while (Date.now() - totalStartTime < maxTotalWaitMs) {
          await new Promise(resolve => setTimeout(resolve, 3000))

          // Early exit if the user paused this document
          if (pausedDocIdsRef.current.has(docId)) {
            return 'partial'
          }

          try {
            const docRes = await fetch('/api/ingestion/process?action=progress&documentId=' + docId)

            if (!docRes.ok) {
              consecutiveFetchFailures++
              if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) {
                console.error(`[PollBatch] ${MAX_FETCH_FAILURES} consecutive HTTP errors (last: ${docRes.status}) — giving up`)
                return 'error'
              }
              continue
            }

            // Reset failure counter on successful response
            consecutiveFetchFailures = 0
            const docData = await docRes.json()
            const doc = docData.document
            if (!doc) return 'unknown'

            // Only update stats (lightweight) — auto-poll useEffect already calls fetchDocuments()
            // Removing fetchDocuments() here eliminates the duplicate reconciliation requests (2× per 3s → 1×)
            fetchStats()

            if (['indexed', 'extracted', 'partial', 'error'].includes(doc.status)) {
              if (doc.status === 'error') {
                sonnerToast.error('Xử lý thất bại', { description: doc.error_message || 'Lỗi không xác định', duration: 8000 })
                return 'error'
              } else if (doc.status === 'partial') {
                // Confirm genuine partial (3 consecutive reads)
                partialConfirmCount++
                if (partialConfirmCount < 3) continue
                return 'partial'
              } else {
                // indexed or extracted — fully done
                return 'done'
              }
            }
            // Status is back to processing (e.g. 'extracting') — reset partial counter
            partialConfirmCount = 0
          } catch (networkErr) {
            // TypeError: Failed to fetch — network error, server down, DNS failure, etc.
            // Without this catch, the error propagates up and crashes the entire polling loop.
            consecutiveFetchFailures++
            if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) {
              console.error(`[PollBatch] ${MAX_FETCH_FAILURES} consecutive network errors — giving up:`, networkErr)
              return 'error'
            }
            // Exponential backoff: 3s → 6s → 12s → 24s → max 30s
            const backoffDelay = Math.min(30_000, 3_000 * Math.pow(2, consecutiveFetchFailures - 1))
            console.warn(`[PollBatch] Fetch failed (${consecutiveFetchFailures}/${MAX_FETCH_FAILURES}), retrying in ${backoffDelay / 1000}s:`, networkErr instanceof Error ? networkErr.message : String(networkErr))
            await new Promise(resolve => setTimeout(resolve, backoffDelay))
          }
        }
        return 'unknown'
      }

      // Wait for completion (with auto-continue) in the background
      void waitForCompletionAndAutoContinue().finally(() => {
        setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        fetchDocuments(); fetchEmbeddingStatus(); fetchHealth(); fetchStats()
      })

    } catch (err) {
      console.error('Failed to process document:', err)
      sonnerToast.error('Lỗi xử lý tài liệu', {
        description: err instanceof Error ? err.message : 'Lỗi không xác định',
        duration: 6000,
      })
      setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
    }
  }, [fetchDocuments, fetchEmbeddingStatus, fetchHealth, fetchStats, autoMode])

  const handleProcessAll = useCallback(async () => {
    setProcessingAll(true)
    // Clear all paused states — user is starting batch processing
    setPausedDocIds(new Set())
    // Start polling for status updates during batch processing
    const pollInterval = setInterval(() => { fetchDocuments(false, undefined, { lite: true }) }, 3000)
    try {
      // Use async mode to prevent HTTP timeout
      const res = await fetch('/api/ingestion/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, async: true, autoNext: autoMode }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        // Handle 503 busy — auto-retry in auto mode
        if (res.status === 503 && errData.busy && autoMode) {
          sonnerToast.info('Đang chờ key trống', {
            description: `Sẽ tự động thử lại sau 15 giây...`,
            duration: 8000,
          })
          await new Promise(resolve => setTimeout(resolve, 15_000))
          const retryRes = await fetch('/api/ingestion/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true, async: true, autoNext: true }),
          })
          if (retryRes.ok) {
            const retryData = await retryRes.json()
            sonnerToast.info('Đang xử lý hàng loạt', {
              description: retryData.message || 'Đã bắt đầu xử lý tài liệu.',
              duration: 5000,
            })
            // Continue with the same polling logic
            const maxWaitMs = 60 * 60 * 1000
            const startTime = Date.now()
            const waitAll = async () => {
              while (Date.now() - startTime < maxWaitMs) {
                await new Promise(resolve => setTimeout(resolve, 5000))
                fetchDocuments(false, undefined, { lite: true })
                const docsRes = await fetch('/api/ingestion/upload?lite=true')
                if (docsRes.ok) {
                  const docsData = await docsRes.json()
                  const docs = (docsData.documents || []) as DocumentRecord[]
                  const stillProcessing = docs.some((d: DocumentRecord) => ['parsing', 'chunked', 'extracting'].includes(d.status))
                  if (!stillProcessing) break
                }
              }
            }
            void waitAll().finally(() => {
              clearInterval(pollInterval)
              setProcessingAll(false)
              fetchDocuments(); fetchEmbeddingStatus(); fetchHealth(); fetchStats()
            })
            return // Exit early — retry succeeded
          }
        }
        let errorMsg = 'Process all API error'
        errorMsg = errData.error || errData.message || errorMsg
        throw new Error(errorMsg)
      }
      const data = await res.json()
      if (data.error) console.error('Batch processing error:', data.error)

      sonnerToast.info('Đang xử lý hàng loạt', {
        description: autoMode
          ? (data.message || '4 keys × 4 docs/key (tối đa 16 song song) — xong key nào → tự chuyển tài liệu mới.')
          : (data.message || 'Pipeline đang chạy trong nền — không tự động chuyển tài liệu tiếp.'),
        duration: 5000,
      })

      // Poll until all documents are done (check every 5s)
      // Stop when no documents are in processing state; partial docs show "Tiếp tục" button
      const maxWaitMs = 60 * 60 * 1000
      const startTime = Date.now()
      const waitAll = async () => {
        while (Date.now() - startTime < maxWaitMs) {
          await new Promise(resolve => setTimeout(resolve, 5000))
          fetchDocuments(false, undefined, { lite: true })
          // Check if any documents are still processing
          const docsRes = await fetch('/api/ingestion/upload?lite=true')
          if (docsRes.ok) {
            const docsData = await docsRes.json()
            const docs = (docsData.documents || []) as DocumentRecord[]
            const stillProcessing = docs.some(
              (d: DocumentRecord) => ['parsing', 'chunked', 'extracting'].includes(d.status)
            )
            if (!stillProcessing) break
          }
        }
      }
      void waitAll().finally(() => {
        clearInterval(pollInterval)
        setProcessingAll(false)
        fetchDocuments(); fetchEmbeddingStatus(); fetchHealth(); fetchStats()
      })
    } catch (err) {
      console.error('Failed to process all:', err)
      clearInterval(pollInterval)
      setProcessingAll(false)
    }
  }, [fetchDocuments, fetchEmbeddingStatus, fetchHealth, fetchStats, autoMode])

  const handleDeleteDoc = useCallback(async (documentId: string) => {
    setProcessingIds(prev => new Set([...prev, documentId]))
    try {
      const res = await fetch(`/api/ingestion/upload?documentId=${documentId}`, { method: 'DELETE' })
      if (!res.ok) {
        let errorMsg = 'Delete API error'
        try { const errData = await res.json(); errorMsg = errData.error || errData.message || errorMsg } catch {}
        throw new Error(errorMsg)
      }
      const data = await res.json()
      if (data.success) {
        sonnerToast.success('Đã xóa tài liệu', {
          description: `Xóa thành công: ${data.stats?.title || documentId}`,
          duration: 4000,
        })
        // After delete, check if current page becomes empty and adjust
        const newTotal = docTotal - 1
        const totalPages = Math.max(1, Math.ceil(newTotal / docPageSize))
        const adjustedPage = docPage > totalPages ? totalPages : docPage
        fetchDocuments(false, adjustedPage); fetchEmbeddingStatus(); fetchHealth(); fetchStats()
      } else {
        sonnerToast.error('Lỗi xóa tài liệu', {
          description: data.error || 'Unknown error',
          duration: 5000,
        })
      }
    } catch (err) {
      console.error('Failed to delete document:', err)
      sonnerToast.error('Lỗi xóa tài liệu', {
        description: err instanceof Error ? err.message : 'Network error',
        duration: 5000,
      })
    }
    setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
  }, [fetchDocuments, fetchEmbeddingStatus, fetchHealth, fetchStats])

  const handlePauseDoc = useCallback(async (documentId: string) => {
    // OPTIMISTIC UI UPDATE: Immediately mark as paused so the button changes from
    // "Tạm dừng" to "Tiếp tục" without waiting for the server response.
    // Save previous state for rollback on failure.
    const wasInExtracting = extractingDocIds.has(documentId)
    const wasInProcessing = processingIds.has(documentId)

    setPausedDocIds(prev => new Set([...prev, documentId]))
    setUserPausedDocIds(prev => new Set([...prev, documentId]))
    setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
    setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })

    try {
      const res = await fetch('/api/ingestion/process', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        sonnerToast.success('Đã tạm dừng', {
          description: data.message || 'Đã tạm dừng trích xuất tài liệu',
          duration: 3000,
        })
        // Refresh document list to show updated status
        fetchDocuments()
      } else {
        // Revert ALL optimistic updates on failure
        setPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        setUserPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        if (wasInExtracting) setExtractingDocIds(prev => new Set([...prev, documentId]))
        if (wasInProcessing) setProcessingIds(prev => new Set([...prev, documentId]))
        sonnerToast.error('Không thể tạm dừng', {
          description: data.error || 'Lỗi không xác định',
          duration: 5000,
        })
      }
    } catch (err) {
      // Revert ALL optimistic updates on error
      setPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      setUserPausedDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      if (wasInExtracting) setExtractingDocIds(prev => new Set([...prev, documentId]))
      if (wasInProcessing) setProcessingIds(prev => new Set([...prev, documentId]))
      sonnerToast.error('Lỗi kết nối', {
        description: err instanceof Error ? err.message : 'Network error',
        duration: 5000,
      })
    }
  }, [fetchDocuments, extractingDocIds, processingIds])

  const handleReExtractDoc = useCallback(async (documentId: string) => {
    // Find the doc to get its name and coverage info for the confirmation
    const doc = documents.find(d => d.id === documentId)
    const missingChunks = doc?.chunk_coverage?.missing || 0
    const totalChunks = doc?.chunk_coverage?.total || '?'

    if (!window.confirm(`Trích xuất lại ${missingChunks} chunks thiếu cho "${doc?.title || 'tài liệu này'}"? (${doc?.chunk_coverage?.extracted || '?'}/${totalChunks} chunks đã trích xuất)`)) return

    setProcessingIds(prev => new Set([...prev, documentId]))
    setExtractingDocIds(prev => new Set([...prev, documentId]))

    // No separate progressPoll — auto-poll useEffect handles polling when extractingDocIds has entries

    try {
      const res = await fetch('/api/ingestion/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, async: true, reExtract: true, autoNext: autoMode }),
      })

      if (res.ok) {
        sonnerToast.info('Đang trích xuất lại', {
          description: `${missingChunks} chunks thiếu sẽ được trích xuất, các chunks đã trích xuất sẽ được giữ nguyên`,
          duration: 5000,
        })
      } else {
        const errorData = await res.json().catch(() => ({}))
        if (res.status === 503 && errorData.busy) {
          sonnerToast.warning('Đang xử lý quá tải', {
            description: 'Vui lòng thử lại sau khi tài liệu hiện tại hoàn thành',
            duration: 5000,
          })
        } else {
          sonnerToast.error('Lỗi', {
            description: errorData.error || 'Không thể trích xuất lại',
            duration: 5000,
          })
        }
        setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      }
    } catch {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
    }
  }, [documents, fetchDocuments, autoMode])

  const handleEmbedOnlyDoc = useCallback(async (documentId: string) => {
    const doc = documents.find(d => d.id === documentId)
    if (!doc) return
    if (!window.confirm(`Tạo embeddings cho "${doc.title}"?\n\nEntities đã có sẵn trong Neo4j (từ phiên trước) — sẽ KHÔNG chạy lại LLM extraction.\n\nPipeline: tải PDF từ R2 → parse → chunk → tạo embeddings (NVIDIA) → lưu Qdrant.\nSau khi xong: tài liệu sẽ chuyển sang 'indexed' và Vector Search sẽ hoạt động.`)) return

    setProcessingIds(prev => new Set([...prev, documentId]))
    setExtractingDocIds(prev => new Set([...prev, documentId]))

    try {
      const res = await fetch('/api/ingestion/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, embedOnly: true }),
      })

      if (res.ok) {
        const data = await res.json()
        sonnerToast.success('Tạo embedding xong', {
          description: `${data.indexed || 0} tài liệu đã index, ${data.failed || 0} lỗi. Embeddings đã lưu vào Qdrant.`,
          duration: 5000,
        })
        fetchDocuments(false, docPage)
        fetchStats()
        fetchEmbeddingStatus()
      } else {
        const errorData = await res.json().catch(() => ({}))
        sonnerToast.error('Lỗi tạo embedding', {
          description: errorData.error || 'Không thể tạo embedding',
          duration: 5000,
        })
      }
    } catch (err) {
      sonnerToast.error('Lỗi tạo embedding', {
        description: err instanceof Error ? err.message : 'Lỗi không xác định',
        duration: 5000,
      })
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
    }
  }, [documents, fetchDocuments, fetchStats, fetchEmbeddingStatus, docPage])

  const handleRegenerateEmbeddings = useCallback(async () => {
    try {
      sonnerToast.info('Đang tạo embedding', { description: 'Chuyển đổi pseudo embeddings thành real embeddings...', duration: 3000 })
      const res = await fetch('/api/query?action=embed-regenerate', { method: 'POST' })
      if (!res.ok) {
        let errorMsg = 'Embed regenerate API error'
        try { const errData = await res.json(); errorMsg = errData.error || errData.message || errorMsg } catch {}
        throw new Error(errorMsg)
      }
      const data = await res.json()
      fetchEmbeddingStatus()
      console.log('Embedding regeneration:', data)
      sonnerToast.success('Tạo embedding thành công', { description: data.message || 'Embeddings đã được cập nhật', duration: 4000 })
    } catch (err) {
      console.error('Failed to regenerate embeddings:', err)
      sonnerToast.error('Lỗi tạo embedding', { description: err instanceof Error ? err.message : 'Lỗi không xác định', duration: 5000 })
    }
  }, [fetchEmbeddingStatus])

  // Force-recover all stuck documents: calls PUT /api/ingestion/process with force=true
  // to reset all docs in 'extracting'/'parsing'/'chunked' to 'partial'/'uploaded'
  const handleForceRecover = useCallback(async () => {
    try {
      const res = await fetch('/api/ingestion/process', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const data = await res.json()
      if (res.ok && data.recovered > 0) {
        sonnerToast.success('Đã phục hồi', {
          description: `${data.recovered} tài liệu đã được phục hồi từ trạng thái kẹt`,
          duration: 5000,
        })
        // Clear all paused states since the docs are being reset
        setPausedDocIds(new Set())
        fetchDocuments()
      } else if (res.ok) {
        sonnerToast.info('Không cần phục hồi', {
          description: 'Không có tài liệu nào bị kẹt',
          duration: 3000,
        })
      } else {
        sonnerToast.error('Lỗi phục hồi', {
          description: data.error || 'Không thể phục hồi tài liệu',
          duration: 5000,
        })
      }
    } catch (err) {
      sonnerToast.error('Lỗi kết nối', {
        description: err instanceof Error ? err.message : 'Network error',
        duration: 5000,
      })
    }
  }, [fetchDocuments])

  // Recovery polling: every 60 seconds, call the recovery endpoint to reset stuck documents
  // and check for documents in error status. Only runs after initial load and when on Documents tab.
  useEffect(() => {
    // Only start recovery polling after initial data is loaded AND user is on documents tab
    if (!initializedRef.current || activeTab !== 'documents') return

    const recoveryPoll = async () => {
      try {
        const res = await fetch('/api/ingestion/process', { method: 'PUT' })
        if (res.ok) {
          const data = await res.json()
          if (data.recovered > 0) {
            sonnerToast.success('Phục hồi tự động', { description: data.message })
            fetchDocuments(false, undefined, { lite: true })
          }
        }
      } catch { /* ignore */ }
    }
    // Do NOT run immediately on mount — only on the interval
    const interval = setInterval(recoveryPoll, 60000)
    return () => clearInterval(interval)
  }, [fetchDocuments, activeTab])

  // Auto-poll for documents being processed: refresh every 3s when any doc is in processing state.
  // FIX: Use refs instead of `documents` state as dependency to prevent interval churn.
  // Previously, `documents` was a dependency — every fetchDocuments() call → setDocuments() →
  // effect re-runs → old interval cleared, new one created → this caused:
  // 1. Interval churn (new interval every 2s = no actual polling)
  // 2. AbortController race conditions (new fetch cancels in-flight request)
  // 3. Documents list disappearing (all requests aborted before completing)
  // NOTE: documentsRef is now defined alongside the documents state (line ~12152)
  //
  // PERFORMANCE: Polling now uses lite=true to avoid triggering expensive reconciliation
  // on every 3s tick. Reconciliation only runs when the user explicitly refreshes,
  // changes tabs, or triggers an action. This reduces API response time from 1-5s → ~50ms.

  useEffect(() => {
    const hasProcessingDocs = documentsRef.current.some(d =>
      ['parsing', 'chunked', 'extracting'].includes(d.status)
    ) || processingIds.size > 0 || extractingDocIds.size > 0

    if (!hasProcessingDocs) return

    const pollInterval = setInterval(() => {
      // Use lite mode for polling — much faster (3 SQLite queries vs 250+)
      // Full reconciliation runs only on explicit user actions
      fetchDocuments(false, undefined, { lite: true }).catch(() => {})
    }, 3000) // 3s — slower than before to reduce API load and prevent AbortController races

    return () => clearInterval(pollInterval)
  }, [processingIds, extractingDocIds, fetchDocuments])

  // Auto-continue useEffect REMOVED — extraction should ONLY start when the user
  // explicitly clicks "Tiếp tục" or "Xử lý". The autoMode toggle still controls
  // the `autoNext` parameter passed to the backend, which auto-processes the next
  // uploaded doc after finishing the current one, but never auto-triggers on page load.

  // Restore persisted tab AFTER mount to avoid hydration mismatch.
  // Server always renders 'chat' tab, client reads localStorage on mount and updates.
  // If the saved tab was 'entities' or 'relationships' (removed tabs), redirect to 'analytics'.
  const tabRestoredRef = useRef(false)
  useEffect(() => {
    if (!tabRestoredRef.current) {
      tabRestoredRef.current = true
      try {
        const saved = localStorage.getItem('graphrag-active-tab')
        if (saved && saved !== 'chat') {
          // FIX: 'autolearn' was missing from the whitelist — reloading while on the
          // Auto-Learn tab silently dumped the user onto Analytics and overwrote the
          // saved tab, permanently losing it.
          const validTab = ['chat', 'explorer', 'documents', 'analytics', 'token', 'autolearn'].includes(saved) ? saved : 'analytics'
          setActiveTab(validTab)
          if (validTab !== saved) localStorage.setItem('graphrag-active-tab', validTab)
          // Trigger data loading for the restored tab
          if (validTab === 'explorer') fetchEmbeddingStatus()
          if (validTab === 'analytics') { fetchStats(); fetchEmbeddingStatus(); fetchHealth() }
          // TokenUsageSection handles its own data fetching
        }
      } catch { /* ignore */ }
    }
  }, [fetchEmbeddingStatus, fetchHealth, fetchStats])

  // Load initial data
  const initializedRef = useRef(false)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      const load = async () => {
        await Promise.allSettled([
          fetch('/api/health')
            .then(res => res.ok ? res.json() : Promise.reject(`health error (HTTP ${res.status})`))
            .then(data => { setHealth(data); setHealthError(null); setHealthLastChecked(new Date()) })
            .catch((e) => { setHealthError(String(e).includes('health error') ? String(e).replace('health error ', '') : 'Không kết nối được server') }),
          // Use fetchDocuments for initial doc load so pagination state is properly initialized
          fetchDocuments(),
          fetch('/api/query?action=embed-status')
            .then(res => res.ok ? res.json() : Promise.reject('embed error'))
            .then(data => setEmbeddingStatus(data))
            .catch(() => {}),
          fetch('/api/query?action=stats')
            .then(res => res.ok ? res.json() : Promise.reject('stats error'))
            .then(data => { setEntityTotal(data.totalEntities || 0); setRelationshipTotal(data.totalRelationships || 0); setResolvedEntityTotal(data.totalResolvedEntities || 0); setDbStats(data) })
            .catch(() => {}),
        ])
      }
      void load()
    }
  }, [fetchDocuments])

  // Auto-refresh: periodically refresh stats and health for real-time data display
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      // FIX (perf): skip while the browser tab is hidden — this interval hits
      // /api/query?action=stats (Neo4j Aura cloud round trips) + /api/health every
      // 10s, even with the tab in the background. Polling resumes automatically
      // when the tab becomes visible again (interval keeps running, just no-ops).
      if (typeof document !== 'undefined' && document.hidden) return
      fetchStats()
      fetchHealth()
      fetchEmbeddingStatus()
    }, 10000) // Every 10 seconds — fast enough to see entity count changes during processing
    return () => clearInterval(refreshInterval)
  }, [fetchStats, fetchHealth, fetchEmbeddingStatus])

  // Auto-refresh stats more frequently during active extraction (every 5s when extracting)
  useEffect(() => {
    if (extractingDocIds.size > 0) {
      const interval = setInterval(() => {
        // FIX (perf): same visibility gate as above — avoid stacking Neo4j cloud
        // calls (10s poll + 5s poll = 3 stats calls per 10s) while the tab is hidden.
        if (typeof document !== 'undefined' && document.hidden) return
        fetchStats()
      }, 5000)
      return () => clearInterval(interval)
    }
  }, [extractingDocIds.size, fetchStats])

  // Check for existing user wallpaper on mount
  useEffect(() => {
    fetch('/api/wallpaper')
      .then(res => res.json())
      .then(data => {
        if (data.exists && data.url) setWallpaperUrl(data.url)
      })
      .catch(() => {}) // Silently fail — default wallpaper is fine
  }, [])

  // Auto-refresh documents list every 10 seconds when on Documents tab
  useEffect(() => {
    if (activeTab !== 'documents') return
    const docRefreshInterval = setInterval(() => {
      fetchDocuments(false, undefined, { lite: true })
    }, 10000) // Every 10 seconds — lite mode for speed
    return () => clearInterval(docRefreshInterval)
  }, [activeTab, fetchDocuments])

  return (
    <div className="h-screen min-w-0 flex flex-col relative overflow-x-hidden overflow-y-hidden">
      {/* Background Image */}
      <div className="fixed inset-0 z-0">
        <img src={wallpaperUrl} alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-blue-950/30" />
      </div>
      {/* Header — high-tech frame with transparent background, text overlaid */}
      <div className="nc-wrap nc-cyan nc-corner-glow relative z-30">
      <header className="nc-panel nc-sm nc-border-cyan z-20 flex-shrink-0">
        <div className="relative w-full h-8 sm:h-10 md:h-12 lg:h-14 flex items-center justify-center">
          {/* Transparent tech frame — fills full header height, stretched horizontally */}
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
            <img
              src="/bg/tech_frame_transparent.png"
              alt=""
              className="tech-frame-glow h-full w-auto select-none pointer-events-none"
              style={{ transform: 'scaleX(3.6)', transformOrigin: 'center center', objectFit: 'fill' }}
              draggable={false}
            />
          </div>
          {/* Text overlay — same size, same line, tech cyan style */}
          <h1 className="tech-title text-[10px] sm:text-xs md:text-sm lg:text-base font-black tracking-[0.1em] sm:tracking-[0.2em] uppercase select-none relative z-10 whitespace-nowrap overflow-hidden text-ellipsis">
            THE MAGNUM OPUS
          </h1>
        </div>
        {/* Overlay controls — sidebar toggle & wallpaper */}
        <div className="absolute inset-0 flex items-center justify-between px-2 z-20">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 hover:bg-cyan-500/20 text-stone-400 hover:text-cyan-400 transition-all btn-glow flex-shrink-0 rounded-lg"
            title={sidebarOpen ? 'Thu gọn sidebar' : 'Mở sidebar'}
          >
            {sidebarOpen ? <ChevronsLeft className="h-4 w-4" /> : <ChevronsRight className="h-4 w-4" />}
          </button>
          <div className="flex items-center gap-1">
            {/* Hidden wallpaper upload input */}
            <input ref={wallpaperInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleWallpaperUpload} />
            <button
              onClick={() => wallpaperInputRef.current?.click()}
              className="p-2 rounded-lg hover:bg-cyan-500/20 text-stone-500 hover:text-cyan-400 transition-all btn-glow"
              title="Đổi ảnh nền"
            >
              <Layers className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>
      </div>

      {/* Body: Sidebar + Main Content — below header */}
      <div className="flex flex-1 min-h-0 relative z-10">
        {/* ====== SIDEBAR ====== */}
        {/* Mobile overlay backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-20 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div className="nc-wrap nc-cyan self-stretch">
        <aside
          className={`nc-panel nc-sm nc-border-cyan sidebar-transition flex-shrink-0 flex flex-col overflow-hidden h-full ${
            sidebarOpen
              ? 'w-56 fixed md:relative z-30 md:z-auto'
              : 'w-12 hidden md:flex'
          }`}
        >
          {/* Top spacer — toggle is in the header now */}
          <div className={`flex-shrink-0 ${sidebarOpen ? 'px-3 py-2' : 'py-2'}`}>
            {sidebarOpen && (
              <span className="text-[10px] font-semibold tracking-wider text-stone-400 uppercase">Modules</span>
            )}
          </div>

          {/* Module navigation */}
          <nav className="flex-1 py-2 flex flex-col">
            {([
              { id: 'smolab' as const, label: 'Smolab', icon: Sparkles, desc: 'AI Micro Lab' },
              { id: 'agents' as const, label: 'Agents', icon: Bot, desc: 'AI Agents' },
              { id: 'database' as const, label: 'Database', icon: Database, desc: 'GraphRAG KB' },
            ]).map((mod) => {
              const isActive = activeModule === mod.id
              const IconComp = mod.icon
              return (
                <button
                  key={mod.id}
                  onClick={() => {
                    setActiveModule(mod.id)
                    try { localStorage.setItem('graphrag-active-module', mod.id) } catch { /* ignore */ }
                  }}
                  className={`sidebar-module-btn chamfer-sm flex items-center gap-3 mx-1.5 my-0.5 rounded-lg border border-transparent ${
                    sidebarOpen ? 'px-3 py-2.5' : 'px-0 py-2.5 justify-center'
                  } ${isActive ? 'active border-gold-700/30' : ''}`}
                  title={mod.label}
                >
                  <IconComp className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-amber-400' : 'text-stone-400'}`} />
                  {sidebarOpen && (
                    <div className="flex flex-col items-start min-w-0">
                      <span className={`text-xs font-semibold truncate ${isActive ? 'text-amber-300' : 'text-stone-300'}`}>
                        {mod.label}
                      </span>
                      <span className="text-[9px] text-stone-400 truncate">{mod.desc}</span>
                    </div>
                  )}
                </button>
              )
            })}
          </nav>

          {/* Pull code button — bottom of sidebar */}
          <div className="flex-shrink-0 mt-auto border-t border-cyan-400/35">
            <button
              onClick={handleGitPullDialogOpen}
              className={`w-full flex items-center gap-3 mx-0 my-0 rounded-none border border-transparent transition-colors ${
                sidebarOpen ? 'px-3 py-2.5' : 'px-0 py-2.5 justify-center'
              } hover:bg-cyan-950/40`}
              title="Pull code từ GitHub"
            >
              <ArrowDownToLine className="h-4 w-4 flex-shrink-0 text-cyan-400" />
              {sidebarOpen && (
                <span className="text-[11px] font-medium text-stone-300">Pull code</span>
              )}
            </button>
          </div>

          {/* Collapsed: golden logo at bottom */}
          {!sidebarOpen && (
            <div className="flex-shrink-0 py-3 flex justify-center border-t border-cyan-400/35">
              <span className="sidebar-logo-mini text-lg font-bold select-none" style={{ fontFamily: "'Cormorant Infant', 'Georgia', serif" }}>M</span>
            </div>
          )}
        </aside>
        </div>

        {/* ====== MAIN CONTENT AREA ====== */}
        <div className={`flex-1 flex flex-col min-w-0 ${activeModule !== 'smolab' ? 'overflow-y-auto' : ''}`}>
          {activeModule !== 'smolab' && (
          <main className="container mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5">
            {/* Only Database module has content for now */}
            {activeModule === 'database' ? (<>
              {/* Token SSE Provider — wraps both StatsOverview and TokenUsageSection */}
              <TokenStreamProvider>
              {/* Stats */}
              <StatsOverview docTotal={docTotal} docStatusBreakdown={docStatusBreakdown} entities={entityTotal} relationships={relationshipTotal} resolvedEntities={resolvedEntityTotal} embeddingStatus={embeddingStatus} processingCount={(docStatusBreakdown['parsing'] || 0) + (docStatusBreakdown['chunked'] || 0) + (docStatusBreakdown['extracting'] || 0)} />

              {/* Tabs */}
              <div className="mt-5">
                <Tabs value={activeTab} onValueChange={handleTabChange}>
                  <TabsList className="w-full bg-slate-950/60 border border-cyan-400/35 shadow-sm rounded-xl h-11 p-1">
                    <TabsTrigger value="chat" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-chat data-[state=active]:bg-gradient-to-r data-[state=active]:from-emerald-500/80 data-[state=active]:to-teal-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><MessageCircle className="h-3 w-3 mr-1" /> Chat</TabsTrigger>
                    <TabsTrigger value="explorer" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-explorer data-[state=active]:bg-gradient-to-r data-[state=active]:from-orange-500/80 data-[state=active]:to-amber-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><Target className="h-3 w-3 mr-1" /> Explorer</TabsTrigger>
                    <TabsTrigger value="documents" className="chamfer-sm neon-double-cyan flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-documents data-[state=active]:bg-gradient-to-r data-[state=active]:from-teal-500/80 data-[state=active]:to-cyan-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><BookOpen className="h-3 w-3 mr-1" /> Tài liệu</TabsTrigger>
                    <TabsTrigger value="analytics" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-analytics data-[state=active]:bg-gradient-to-r data-[state=active]:from-purple-500/80 data-[state=active]:to-fuchsia-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><BarChart3 className="h-3 w-3 mr-1" /> Analytics</TabsTrigger>
                    <TabsTrigger value="token" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-token data-[state=active]:bg-gradient-to-r data-[state=active]:from-purple-500/80 data-[state=active]:to-violet-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><Activity className="h-3 w-3 mr-1" /> Token</TabsTrigger>
                    <TabsTrigger value="autolearn" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-autolearn data-[state=active]:bg-gradient-to-r data-[state=active]:from-rose-500/80 data-[state=active]:to-pink-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><Brain className="h-3 w-3 mr-1" /> Auto-Learn</TabsTrigger>
                  </TabsList>

                  <TabsContent value="chat" className="mt-4">
                    <div className="nc-wrap nc-cyan nc-corner-glow">
                    <Card className="nc-panel nc-md nc-border-cyan">
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-2.5"><div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600"><Bot className="h-4 w-4 text-white" /></div><CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Magnum Opus Chat</CardTitle></div>
                        <CardDescription className="text-xs text-stone-400">Hỏi đáp với Knowledge Base sử dụng Hybrid Retrieval (Vector + Graph + RRF Fusion)</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {embeddingStatus && embeddingStatus.realRatio === 0 && (
                          <div className="mb-3 p-3 rounded-xl bg-amber-950/40 border border-amber-500/55 text-xs text-amber-400 flex items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                            <span>Vector Search chưa hoạt động: Embedding API không khả dụng. Đang dùng Text Search + Graph Search thay thế.</span>
                          </div>
                        )}
                        <ChatSection />
                      </CardContent>
                    </Card>
                    </div>
                  </TabsContent>

                  <TabsContent value="explorer" className="mt-4">
                    <KnowledgeExplorer />
                  </TabsContent>

                  <TabsContent value="documents" className="mt-4">
                      <DocumentsList documents={documents} onProcessDoc={handleProcessDoc} onDeleteDoc={handleDeleteDoc} onPauseDoc={handlePauseDoc} onReExtractDoc={handleReExtractDoc} onForceRecover={handleForceRecover} processingIds={processingIds} extractingDocIds={extractingDocIds} pausedDocIds={pausedDocIds} userPausedDocIds={userPausedDocIds} docPage={docPage} docTotal={docTotal} docPageSize={docPageSize} onPageChange={(p) => fetchDocuments(false, p)} docStatusBreakdown={docStatusBreakdown} docLoading={docLoading} autoMode={autoMode} onToggleAuto={() => { const newMode = !autoMode; setAutoMode(newMode); try { localStorage.setItem('graphrag-auto-mode', String(newMode)) } catch {} ; sonnerToast.success(newMode ? 'Đã bật chế độ Tự động' : 'Đã tắt chế độ Tự động', { description: newMode ? '4 keys × 4 docs/key (tối đa 16 song song) — Ưu tiên tài liệu trích xuất dở trước, xong key nào → tự chuyển tài liệu mới' : 'Không tự động — cần bấm "Tiếp tục" thủ công', duration: 3000 }) }} onRegenerateEmbeddings={handleRegenerateEmbeddings} embeddingPseudoCount={embeddingStatus?.pseudo || 0} onEmbedOnlyDoc={handleEmbedOnlyDoc} uploadSlot={<UploadSection onUploadComplete={(uploadedDocIds: string[]) => { fetchDocuments(true, 1); fetchStats() }} existingDocNames={existingDocNames} />} />
                  </TabsContent>

                  <TabsContent value="analytics" className="mt-4">
                    <AnalyticsSection data={{
                      documents,
                      embeddingStatus,
                      loading,
                      dbStats,
                    }} onRefreshStats={() => fetchStats()} />
                  </TabsContent>

                  <TabsContent value="token" className="mt-4">
                    <TokenUsageSection health={health} />
                  </TabsContent>

                  <TabsContent value="autolearn" className="mt-4">
                    <AutoLearnSection />
                  </TabsContent>
                </Tabs>
              </div>

              {/* Architecture Info */}
              <div className="mt-8">
                <div className="nc-wrap nc-cyan nc-corner-glow">
                <Card className="nc-panel nc-md nc-border-cyan">
                  <CardHeader className="pb-4">
                    <div className="flex items-center gap-2.5"><div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600"><BarChart3 className="h-4 w-4 text-white" /></div><CardTitle className="text-sm font-semibold tracking-tight text-stone-100">Hybrid Query Pipeline</CardTitle></div>
                  </CardHeader>
                  <CardContent>
                    <div className="waveform-shimmer grid grid-cols-1 sm:grid-cols-7 gap-2">
                      {[
                        { step: 1, name: 'Query', icon: MessageCircle, desc: 'User đặt câu hỏi', color: 'bg-cyan-950/50 text-cyan-400 border-cyan-500/55' },
                        { step: 2, name: 'Classify', icon: Target, desc: 'LLM phân loại câu hỏi', color: 'bg-amber-950/50 text-amber-400 border-amber-500/55' },
                        { step: 3, name: 'Vector', icon: Database, desc: 'Qdrant similarity search', color: 'bg-teal-950/50 text-teal-400 border-teal-500/55' },
                        { step: 4, name: 'Graph', icon: GitBranch, desc: 'Neo4j Cypher traversal', color: 'bg-orange-950/50 text-orange-400 border-orange-500/55' },
                        { step: 5, name: 'RRF Fuse', icon: Layers, desc: 'Reciprocal Rank Fusion', color: 'bg-violet-950/50 text-violet-400 border-violet-500/55' },
                        { step: 6, name: 'Generate', icon: Sparkles, desc: 'LLM tạo câu trả lời', color: 'bg-pink-950/50 text-pink-400 border-pink-500/55' },
                        { step: 7, name: 'Answer', icon: CheckCircle2, desc: 'Trả lời + Sources + Confidence', color: 'bg-emerald-950/50 text-emerald-400 border-emerald-500/55' },
                      ].map((s, i) => (
                        <div key={s.step} className="">
                          <div className={`chamfer-sm p-2.5 rounded border ${s.color}`}>
                            <div className="flex items-center gap-2">
                              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-950/80 flex items-center justify-center text-[10px] font-bold text-stone-200">{s.step}</span>
                              <s.icon className="h-3.5 w-3.5" />
                              <span className="text-xs font-semibold text-stone-200">{s.name}</span>
                            </div>
                            <p className="text-[10px] mt-1 opacity-80 text-stone-300">{s.desc}</p>
                          </div>
                          {i < 6 && <div className="flex justify-center mt-1 sm:hidden"><ArrowRight className="h-3 w-3 text-muted-foreground rotate-90" /></div>}
                        </div>
                      ))}
                    </div>
                    <div className="hidden sm:flex items-center justify-between mt-[-2px] px-4">
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
                </div>
              </div>
              </TokenStreamProvider>
            </>) : activeModule === 'agents' ? (
              <AgentsModule />
            ) : null}
          </main>
          )}
        </div>

        {/* Smolab module — absolute positioned overlay that can extend to sidebar and screen edges */}
        {activeModule === 'smolab' && (
          <SmolabModule sidebarOpen={sidebarOpen} />
        )}
      </div>

      {/* Pull Code Dialog */}
      <Dialog open={gitPullDialogOpen} onOpenChange={setGitPullDialogOpen}>
        <DialogContent className="bg-slate-950 border-cyan-400/35 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-cyan-300">
              <ArrowDownToLine className="h-5 w-5" />
              Pull Code từ GitHub
            </DialogTitle>
            <DialogDescription className="text-stone-400 text-xs">
              Tải code mới nhất từ kho lưu trữ. Dữ liệu tài liệu, database và uploads của bạn sẽ được bảo vệ.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {/* Repo URL */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-stone-300">Địa chỉ kho lưu trữ (Repo URL)</label>
              <input
                type="text"
                value={gitPullRepoUrl}
                onChange={e => setGitPullRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                className={`w-full rounded-md border bg-slate-900 px-3 py-2 text-xs text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-cyan-400 ${
                  gitPullRepoUrl && validateGitPullUrl(gitPullRepoUrl) 
                    ? 'border-red-400/60 focus:ring-red-400' 
                    : 'border-cyan-400/30'
                }`}
              />
              {gitPullRepoUrl && validateGitPullUrl(gitPullRepoUrl) && (
                <p className="text-[10px] text-red-400">{validateGitPullUrl(gitPullRepoUrl)}</p>
              )}
              <p className="text-[10px] text-stone-500">
                Hỗ trợ: https://github.com/... hoặc git@github.com:...
              </p>
            </div>

            {/* API Token */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-stone-300">API Token (GitHub PAT)</label>
              <input
                type="password"
                value={gitPullApiToken}
                onChange={e => setGitPullApiToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full rounded-md border border-cyan-400/30 bg-slate-900 px-3 py-2 text-xs text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              />
              {gitPullApiToken ? (
                <p className="text-[10px] text-emerald-400">✓ Token đã được cung cấp</p>
              ) : (
                <p className="text-[10px] text-amber-400/70">⚠️ Cần API Token để truy cập private repo</p>
              )}
            </div>

            {/* Branch */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-stone-300">Nhánh (Branch)</label>
              <input
                type="text"
                value={gitPullBranch}
                onChange={e => setGitPullBranch(e.target.value.replace(/[^a-zA-Z0-9\-_\/\.]/g, ''))}
                placeholder="main"
                className="w-full rounded-md border border-cyan-400/30 bg-slate-900 px-3 py-2 text-xs text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              />
            </div>

            {/* Not a git repo warning */}
            {gitPullDefaultConfig && !gitPullDefaultConfig.isGitRepo && (
              <div className="rounded-md bg-amber-950/30 border border-amber-400/30 px-3 py-2">
                <p className="text-[10px] text-amber-300">
                  ⚠️ Thư mục chưa phải Git repository. Hệ thống sẽ tự động khởi tạo git khi bạn pull code lần đầu.
                </p>
              </div>
            )}

            {/* Current commit info */}
            {gitPullDefaultConfig && gitPullDefaultConfig.isGitRepo && (
              <div className="rounded-md bg-slate-900/60 border border-stone-700/50 px-3 py-2">
                <p className="text-[10px] text-stone-400">
                  Phiên bản hiện tại: <span className="text-cyan-400 font-mono">{gitPullDefaultConfig.currentCommit || '(chưa có commit)'}</span>
                  {' · '}
                  Nhánh: <span className="text-cyan-400">{gitPullDefaultConfig.currentBranch || gitPullBranch}</span>
                </p>
              </div>
            )}

            {/* Safety info */}
            <div className="rounded-md bg-emerald-950/30 border border-emerald-400/20 px-3 py-2">
              <p className="text-[10px] text-emerald-300">
                🔒 Dữ liệu được bảo vệ: Database (db/), Tài liệu tải lên (upload/), Vector DB (qdrant-storage/), Agent Context (agent-ctx/). File .env: giá trị local được giữ nguyên, khóa mới từ remote được tự động thêm vào.
              </p>
            </div>

            {/* Dry run result */}
            {gitPullDryRunResult && (
              <div className="rounded-md border border-amber-400/30 bg-amber-950/20 px-3 py-2 max-h-40 overflow-y-auto">
                <p className="text-[10px] font-medium text-amber-300 mb-1">
                  {gitPullDryRunResult.files.length === 0 
                    ? '✓ Đã là phiên bản mới nhất'
                    : `${gitPullDryRunResult.files.length} file sẽ thay đổi:`}
                </p>
                {gitPullDryRunResult.files.length > 0 && (
                  <ul className="text-[9px] text-stone-400 space-y-0.5">
                    {gitPullDryRunResult.files.map((f, i) => (
                      <li key={i} className={f.includes('schema.prisma') || f === 'package.json' ? 'text-amber-300 font-medium' : ''}>
                        {f.includes('schema.prisma') && '⚠️ '}{f === 'package.json' && '📦 '}{f}
                      </li>
                    ))}
                  </ul>
                )}
                {gitPullDryRunResult.depsChanged && (
                  <p className="text-[10px] text-amber-400 mt-1">
                    📦 Dependencies thay đổi — sẽ tự động chạy bun install sau khi pull
                  </p>
                )}
                {gitPullDryRunResult.schemaChanged && (
                  <p className="text-[10px] text-amber-400 mt-1">
                    ⚠️ Schema Prisma thay đổi — sẽ tự động chạy prisma generate &amp; db:push sau khi pull
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="flex-row gap-2 sm:justify-between">
            <button
              onClick={handleGitPullDryRun}
              disabled={gitPullLoading || !gitPullRepoUrl || !!validateGitPullUrl(gitPullRepoUrl)}
              className="flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-950/30 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-950/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {gitPullLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              Kiểm tra trước
            </button>
            <button
              onClick={() => setGitPullConfirmOpen(true)}
              disabled={gitPullLoading || !gitPullRepoUrl || !!validateGitPullUrl(gitPullRepoUrl)}
              className="flex items-center gap-1.5 rounded-md bg-cyan-600 px-4 py-1.5 text-[11px] font-medium text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {gitPullLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
              Pull code
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation dialog before pull */}
      <Dialog open={gitPullConfirmOpen} onOpenChange={setGitPullConfirmOpen}>
        <DialogContent className="bg-slate-950 border-amber-400/35 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="h-5 w-5" />
              Xác nhận Pull Code
            </DialogTitle>
            <DialogDescription className="text-stone-400 text-xs">
              Thao tác này sẽ cập nhật code từ GitHub. Các file local có thể bị ghi đè.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-stone-300">
              Pull code từ <span className="text-cyan-400 font-mono">{gitPullRepoUrl}</span> nhánh <span className="text-cyan-400">{gitPullBranch}</span>?
            </p>
            {gitPullDryRunResult && gitPullDryRunResult.files.length > 0 && (
              <p className="text-[10px] text-amber-400 mt-2">
                {gitPullDryRunResult.files.length} file sẽ thay đổi.
              </p>
            )}
            <p className="text-[10px] text-stone-500 mt-2">
              Dữ liệu db/, upload/, qdrant-storage/, agent-ctx/ và giá trị .env local được bảo vệ.
            </p>
          </div>
          <DialogFooter className="flex-row gap-2 sm:justify-end">
            <button
              onClick={() => setGitPullConfirmOpen(false)}
              className="rounded-md border border-stone-600 px-3 py-1.5 text-[11px] text-stone-300 hover:bg-stone-800 transition-colors"
            >
              Hủy
            </button>
            <button
              onClick={handleGitPull}
              disabled={gitPullLoading}
              className="flex items-center gap-1.5 rounded-md bg-cyan-600 px-4 py-1.5 text-[11px] font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
            >
              {gitPullLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
              Xác nhận Pull
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connection Status Footer — always visible */}
      <ConnectionStatus
        health={health}
        lastChecked={healthLastChecked}
        onRefresh={fetchHealth}
        refreshing={healthRefreshing}
        error={healthError}
      />
    </div>
  )
}

// ==================== 3D KNOWLEDGE GRAPH (glowing nodes + light connections) ====================

/**
 * KnowledgeGraph3D — 3D force-directed graph with glowing nodes + animated light connections.
 * Uses 3d-force-graph (three.js + d3-force-3d wrapper).
 *
 * Visual design:
 *   - Nodes are glowing spheres (emissive material + bloom-like halo)
 *   - Connections are glowing lines (animated particles flowing along edges)
 *   - Camera orbits with mouse drag, zoom with scroll
 *   - Click node → expand (calls onNodeClick)
 *
 * Performance: handles up to ~500 nodes smoothly on modern GPUs.
 */
function KnowledgeGraph3D({ nodes, links, getNodeColor, getNodeRadius, onNodeClick }: {
  nodes: GraphNode[]
  links: GraphLink[]
  getNodeColor: (type: string) => string
  getNodeRadius: (occurrences: number) => number
  onNodeClick: (name: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphInstanceRef = useRef<unknown>(null)

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return

    // Dynamic import to keep three.js out of initial bundle
    let destroyed = false
    Promise.all([
      import('3d-force-graph'),
      import('three'),
    ]).then(([{ default: ForceGraph3D }, THREE]) => {
      if (destroyed || !containerRef.current) return

      // Build graph data
      const graphData = {
        nodes: nodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          val: getNodeRadius(n.occurrences || 1),  // node size
          color: getNodeColor(n.type),
          occurrences: n.occurrences || 1,
        })),
        links: links.map(l => ({
          source: l.source as string,
          target: l.target as string,
          relType: l.relType,
          color: 'rgba(180, 200, 255, 0.4)',
        })),
      }

      // Convert hex colors to numeric for emissive
      const hexToInt = (hex: string) => {
        const h = hex.replace('#', '')
        return parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
      }

      const graph = new ForceGraph3D(containerRef.current)
        .graphData(graphData)
        .backgroundColor('rgba(0,0,0,0)')
        .nodeRelSize(6)
        .nodeVal((node: { val?: number }) => node.val || 6)
        .nodeColor((node: { color?: string }) => node.color || '#9ca3af')
        .nodeOpacity(0.95)
        .nodeLabel((node: { name?: string; type?: string }) => {
          const n = node as { name?: string; type?: string; occurrences?: number }
          return `<div style="background:rgba(15,23,42,0.95);padding:6px 10px;border-radius:6px;border:1px solid rgba(34,211,238,0.4);color:#e2e8f0;font-size:11px;"><b>${n.name}</b><br/><span style="color:#67e8f9;">${n.type}</span>${n.occurrences ? `<br/><span style="color:#94a3b8;">×${n.occurrences} occurrences</span>` : ''}</div>`
        })
        .nodeThreeObject((node: { color?: string; val?: number }) => {
          const n = node as { color?: string; val?: number }
          // Glowing sphere with emissive material
          const colorHex = n.color || '#9ca3af'
          const geometry = new THREE.SphereGeometry(Math.max(0.5, (n.val || 6) / 4), 16, 16)
          const material = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.9,
          })
          const mesh = new THREE.Mesh(geometry, material)
          // Add glow halo (transparent larger sphere)
          const haloGeo = new THREE.SphereGeometry(Math.max(0.8, (n.val || 6) / 3), 12, 12)
          const haloMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.25,
          })
          const halo = new THREE.Mesh(haloGeo, haloMat)
          mesh.add(halo)
          return mesh
        })
        .linkColor((link: { color?: string }) => (link as { color?: string }).color || 'rgba(180,200,255,0.4)')
        .linkWidth(0.8)
        .linkOpacity(0.6)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(0.6)
        .linkDirectionalParticleColor(() => 'rgba(120, 200, 255, 0.8)')
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalArrowLength(3.5)
        .linkDirectionalArrowRelPos(1)
        .linkLabel((link: { relType?: string }) => {
          const l = link as { relType?: string }
          return l.relType ? `<div style="background:rgba(15,23,42,0.9);padding:3px 6px;border-radius:4px;color:#94a3b8;font-size:9px;">${l.relType}</div>` : ''
        })
        .onNodeClick((node: { name?: string }) => {
          const n = node as { name?: string }
          if (n.name) onNodeClick(n.name)
        })
        .cooldownTicks(100)
        .warmupTicks(50)

      // Camera position + initial zoom
      graph.cameraPosition({ z: 250 })

      // Enable orbit controls
      const controls = graph.controls() as unknown as { autoRotate?: boolean; autoRotateSpeed?: number; enableDamping?: boolean; dampingFactor?: number }
      if (controls) {
        controls.enableDamping = true
        controls.dampingFactor = 0.3
      }

      // Resize handler
      const handleResize = () => {
        if (containerRef.current) {
          graph.width(containerRef.current.clientWidth)
          graph.height(500)
        }
      }
      window.addEventListener('resize', handleResize)
      handleResize()

      graphInstanceRef.current = graph
    })

    return () => {
      destroyed = true
      const g = graphInstanceRef.current as { _destructor?: () => void } | null
      if (g?._destructor) g._destructor()
      graphInstanceRef.current = null
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [nodes, links, getNodeColor, getNodeRadius, onNodeClick])

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ height: 500, background: 'radial-gradient(ellipse at center, rgba(15,23,42,0.4) 0%, rgba(2,6,23,0.6) 100%)' }}
    />
  )
}
