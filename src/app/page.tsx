'use client'

import dynamic from 'next/dynamic'
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Database, Network, CheckCircle2, XCircle, Loader2, RefreshCw, Brain, Zap, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Activity, AlertTriangle, FolderOpen, Key, Play, Pause, Info, Upload, FileText, Trash2, Search, Layers, GitBranch, BookOpen, Sparkles, FolderUp, BarChart3, Bot, MessageCircle, Target, TrendingUp, X, ChevronsLeft, ChevronsRight, User, ArrowDownToLine, Compass } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip as StatusTooltip, TooltipTrigger as StatusTooltipTrigger, TooltipContent as StatusTooltipContent } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { setApiToken } from '@/lib/api-auth'
// [perf-split] SelfDirectionModule → next/dynamic (xem dưới)
import { toast as sonnerToast } from 'sonner'
// [perf-split] RuntimeMetricsPanel → next/dynamic (xem dưới)
// [perf-split] EpisodicMemoryPanel → next/dynamic (xem dưới)
import { HealthResponse, DailyQuotaInfo, ChunkCoverage, DocumentRecord, EmbeddingStatus, DOMAIN_LABELS, DBStats, TokenStreamContext, useTokenStream, formatTokenCount, TokenUsageData } from '@/components/app-shared'
// [perf-split] AnalyticsSection → next/dynamic (xem dưới)
// [perf-split] TokenUsageSection → next/dynamic (xem dưới)
// [perf-split] AutoLearnSection → next/dynamic (xem dưới)
// [perf-split] SmolabModule → next/dynamic (xem dưới)
// [perf-split] AgentsModule → next/dynamic (xem dưới)

// ==== PERF (2026-09-03): code-split — module nặng tải theo yêu cầu.
// Logic component không đổi; chỉ trì hoãn việc parse bundle đến khi user mở module. ====
const ModuleLoading = () => (
  <div className="flex-1 flex items-center justify-center py-16" aria-busy="true" aria-label="Đang tải module">
    <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
  </div>
)
const SmolabModule = dynamic(() => import('@/components/smolab/smolab-module').then(m => m.default), { loading: ModuleLoading })
const AgentsModule = dynamic(() => import('@/components/agents/agents-module').then(m => m.AgentsModule), { loading: ModuleLoading })
const SelfDirectionModule = dynamic(() => import('@/components/self-direction/self-direction-module').then(m => m.default), { loading: ModuleLoading })
const AnalyticsSection = dynamic(() => import('@/components/database/analytics-section').then(m => m.AnalyticsSection), { loading: ModuleLoading })
const TokenUsageSection = dynamic(() => import('@/components/database/token-usage-section').then(m => m.TokenUsageSection), { loading: ModuleLoading })
const AutoLearnSection = dynamic(() => import('@/components/database/auto-learn-section').then(m => m.AutoLearnSection), { loading: ModuleLoading })
const RuntimeMetricsPanel = dynamic(() => import('@/components/analytics/runtime-metrics-panel').then(m => m.RuntimeMetricsPanel), { loading: ModuleLoading })
const EpisodicMemoryPanel = dynamic(() => import('@/components/analytics/episodic-memory-panel').then(m => m.EpisodicMemoryPanel), { loading: ModuleLoading })


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
const DOMAIN_COLORS: Record<string, string> = {
  programming: 'bg-teal-950/50 text-teal-400 border-teal-500/55', algorithm: 'bg-violet-950/50 text-violet-400 border-violet-500/55',
  ml: 'bg-fuchsia-950/50 text-fuchsia-400 border-fuchsia-500/55', meta_cognitive: 'bg-pink-950/50 text-pink-400 border-pink-500/55',
  linux: 'bg-orange-950/50 text-orange-400 border-orange-500/55', security: 'bg-red-950/50 text-red-400 border-red-500/55',
  ux_ui: 'bg-lime-950/50 text-lime-400 border-lime-500/55', mixed: 'bg-slate-950/50 text-stone-400 border-cyan-400/35',
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
                            {/* Lucide icon không nhận prop `title` — bọc span để giữ tooltip */}
                            <span title="Đã trích xuất entities (lưu trong Neo4j)"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /></span>
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
                                        {/* Fallback: show raw detail if no structured data parsed
                                            (nhánh chỉ chạy khi status là 'running' | 'completed' theo guard
                                             ở trên — nhánh 'error' là dead code, bỏ để hết TS2367) */}
                                        {!chunkMatch && !entityMatch && !relMatch && (
                                          <p className="text-[9px] text-stone-400">
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
  // Neo4j restore state — "Ánh xạ lại dữ liệu" button inside the Neo4j tooltip
  const [neo4jRestoring, setNeo4jRestoring] = useState(false)
  const [neo4jRestoreMsg, setNeo4jRestoreMsg] = useState<string | null>(null)
  const handleRestoreNeo4j = useCallback(async () => {
    setNeo4jRestoring(true)
    setNeo4jRestoreMsg(null)
    try {
      const res = await fetch('/api/storage/restore-neo4j', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetSynced: true, regenerateEmbeddings: false }),
      })
      const data = await res.json()
      if (data.success) {
        const n = data.neo4j || {}
        setNeo4jRestoreMsg(`✅ Đã ánh xạ ${n.totalEntitiesSynced || 0} entities, ${n.totalRelationshipsSynced || 0} relationships, ${n.totalResolvedEntitiesSynced || 0} resolved entities vào Neo4j (${data.durationMs ? Math.round(data.durationMs / 1000) : '?'}s)`)
        onRefresh() // refresh health to show updated node/rel counts
      } else {
        setNeo4jRestoreMsg(`❌ ${data.message || data.error || 'Khôi phục thất bại'}`)
      }
    } catch (err) {
      setNeo4jRestoreMsg(`❌ ${err instanceof Error ? err.message : 'Lỗi kết nối'}`)
    } finally {
      setNeo4jRestoring(false)
    }
  }, [onRefresh])

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
            <StatusTooltipContent side="top" className="bg-slate-900 border border-cyan-400/30 text-stone-200 text-[10px] max-w-[320px]">
              <div className="space-y-1.5">
                <div className="font-semibold text-stone-100">Neo4j Graph DB</div>
                {neo4j.connected ? (<>
                  <div>Nodes: {neo4j.nodeCount.toLocaleString()}</div>
                  <div>Relationships: {neo4j.relationshipCount.toLocaleString()}</div>
                  {neo4j.labels.length > 0 && <div>Labels: {neo4j.labels.slice(0, 10).join(', ')}{neo4j.labels.length > 10 ? ` +${neo4j.labels.length - 10}` : ''}</div>}
                </>) : <div className="text-red-400">Error: {neo4jError || 'Không kết nối được'}</div>}
                <div className="pt-1.5 mt-1 border-t border-slate-700">
                  <button
                    onClick={handleRestoreNeo4j}
                    disabled={neo4jRestoring}
                    className="flex items-center gap-1 px-2 py-1 text-[9px] bg-violet-950/60 text-violet-200 rounded border border-violet-500/40 hover:bg-violet-900/60 hover:text-violet-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-full justify-center"
                    title="Ánh xạ lại entities + relationships từ SQLite buffer vào Neo4j Aura (idempotent MERGE — không trùng lặp)"
                  >
                    {neo4jRestoring ? (
                      <><Loader2 className="h-2.5 w-2.5 animate-spin" /> Đang ánh xạ...</>
                    ) : (
                      <><RefreshCw className="h-2.5 w-2.5" /> Ánh xạ lại từ SQLite</>
                    )}
                  </button>
                  {neo4jRestoreMsg && (
                    <div className={`mt-1 text-[9px] leading-tight ${neo4jRestoreMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>
                      {neo4jRestoreMsg}
                    </div>
                  )}
                </div>
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

function StatsOverview({ docTotal, docStatusBreakdown, entities, relationships, resolvedEntities, embeddingStatus, processingCount, knowledgeSource, bufferCounts }: {
  docTotal: number; docStatusBreakdown: Record<string, number>; entities: number; relationships: number; resolvedEntities: number; embeddingStatus: EmbeddingStatus | null; processingCount: number; knowledgeSource?: 'neo4j' | 'sqlite-buffer' | null; bufferCounts?: { entities: number; relationships: number } | null
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
        <div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-violet-950/50"><Layers className="h-4 w-4 text-violet-400" /></div><div><p className="text-xl font-bold tracking-tight text-stone-100">{entities}</p><p className="text-[10px] text-stone-400" title={knowledgeSource === 'neo4j' ? `Neo4j knowledge graph (đã dedup)${bufferCounts ? ` · SQLite buffer thô: ${bufferCounts.entities.toLocaleString('vi-VN')} rows` : ''}` : 'SQLite raw extraction buffer (Neo4j chưa kết nối)'}>Entities{resolvedEntities > 0 && entities > resolvedEntities ? ` (${resolvedEntities} đã hợp nhất)` : ''}</p></div></div>
      </Card></div>
      <div className="nc-wrap nc-lime"><Card className="nc-panel nc-sm nc-border-lime metric-sparkle p-4">
        <div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-orange-950/50"><GitBranch className="h-4 w-4 text-orange-400" /></div><div><p className="text-xl font-bold tracking-tight text-stone-100">{relationships}</p><p className="text-[10px] text-stone-400" title={knowledgeSource === 'neo4j' ? `Neo4j knowledge graph (đã dedup)${bufferCounts ? ` · SQLite buffer thô: ${bufferCounts.relationships.toLocaleString('vi-VN')} rows` : ''}` : 'SQLite raw extraction buffer (Neo4j chưa kết nối)'}>Relationships</p></div></div>
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
  // FIX 2026-09-10: nguồn số liệu KG — 'neo4j' (graph thật, đã dedup) hay
  // 'sqlite-buffer' (raw extraction, fallback khi Neo4j không kết nối được)
  const [knowledgeSource, setKnowledgeSource] = useState<'neo4j' | 'sqlite-buffer' | null>(null)
  const [bufferCounts, setBufferCounts] = useState<{ entities: number; relationships: number } | null>(null)
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
  const [activeTab, setActiveTab] = useState('documents')
  // v1.1 — ALISTA UI: bộ chọn khoảng ngày cho 2 panel Analytics (live mode = null).
  // Khi có range, cả RuntimeMetrics + EpisodicMemory chuyển sang chế độ lịch sử:
  // fetch 1 lần với ?from=&to=, dừng poll, hiển thị badge + nút ✕ để clear range.
  const [analyticsRange, setAnalyticsRange] = useState<{ from: string; to: string } | null>(null)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  /** Sidebar state: collapsed = thin strip with logo only, expanded = full sidebar panel */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activeModule, setActiveModule] = useState<'smolab' | 'agents' | 'database' | 'selfdirection'>('database')

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
  // FIX 2026-09-25 (preview iframe 401): cookie SameSite=Lax bị chặn trong
  // cross-site iframe (preview panel) → authedFetch 401 mãi. Setup giờ trả
  // token trong body → lưu localStorage để authedFetch gửi header
  // x-tmo-api-token (header hoạt động ở mọi context, kể cả iframe).
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/setup', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data?.ok) {
          // Cookie đã set — các request tiếp theo tự mang theo.
          // Token lưu localStorage cho đường header (iframe-safe).
          if (typeof data.token === 'string' && data.token.length >= 16) {
            setApiToken(data.token)
          }
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
  const [gitPullDefaultConfig, setGitPullDefaultConfig] = useState<{currentRemote: string | null, currentBranch: string | null, currentCommit: string | null, repoUrl: string | null, hasToken: boolean, isGitRepo?: boolean, savedToken?: string | null, savedTokenPreview?: string | null, hasSavedToken?: boolean, savedAt?: string | null} | null>(null)
  // Default repo khi không có git remote (user request 2026-08-29)
  const GIT_PULL_DEFAULT_REPO = 'https://github.com/nguyenquocviety2c-code/TMO'

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
      // Repo URL: git remote hiện tại > default repo TMO (user request 2026-08-29
      // — dialog luôn có địa chỉ mặc định điền sẵn)
      setGitPullRepoUrl(data.repoUrl || data.defaultRepoUrl || GIT_PULL_DEFAULT_REPO)
      // API Token: token đã lưu → điền sẵn (user request 2026-08-29 — token
      // nhập lần trước được tự động lưu server-side và pre-fill lần sau)
      setGitPullApiToken(data.savedToken || '')
      // Branch: LUÔN mặc định 'main' (user request 2026-08-29). Nhánh hiện tại
      // vẫn hiển thị trong ô thông tin "Phiên bản hiện tại" phía dưới.
      setGitPullBranch('main')
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
        setGitPullDryRunResult({ files: data.changedFiles || [], schemaChanged: data.schemaChanged || false, depsChanged: data.depsChanged || false })
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
          if (data.skipped?.protectedCount > 0) parts.push(`${data.skipped.protectedCount} file dữ liệu bảo vệ được GIỮ NGUYÊN`)
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

  /** Xóa token đã lưu (nút "Xóa token đã lưu" trong dialog) */
  const handleGitPullForgetToken = useCallback(async () => {
    try {
      const res = await fetch('/api/git-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forgetToken: true })
      })
      const data = await res.json()
      setGitPullApiToken('')
      setGitPullDefaultConfig(prev => prev ? { ...prev, hasSavedToken: false, savedToken: undefined, savedTokenPreview: null } : prev)
      toast({ title: data.success ? 'Đã xóa token' : 'Lỗi', description: data.message || 'Token đã lưu đã được xóa khỏi server.', duration: 4000 })
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể kết nối đến server.', variant: 'destructive', duration: 4000 })
    }
  }, [toast])

  // Restore persisted active module AFTER mount to avoid hydration mismatch.
  const moduleRestoredRef = useRef(false)
  useEffect(() => {
    if (!moduleRestoredRef.current) {
      moduleRestoredRef.current = true
      // (queueMicrotask: defer setActiveModule ra khỏi body effect — tránh
      // setState đồng bộ trong effect + vẫn tránh hydration mismatch)
      queueMicrotask(() => {
        try {
          const saved = localStorage.getItem('graphrag-active-module')
          if (saved) {
            const validModules = ['smolab', 'agents', 'database', 'selfdirection']
            const validModule = validModules.includes(saved) ? saved as 'smolab' | 'agents' | 'database' | 'selfdirection' : 'database'
            setActiveModule(validModule)
            if (validModule !== saved) localStorage.setItem('graphrag-active-module', validModule)
          }
        } catch { /* ignore */ }
      })
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

  const fetchHealth = useCallback(async (force: boolean = false) => {
    setHealthRefreshing(true)
    // FIX: add a per-request timeout + real error handling. Previously errors were
    // swallowed by `catch {}` and non-200 responses were ignored, so when /api/health
    // failed (server busy, Qdrant down, network hiccup) the status bar stayed stuck
    // at "Đang kiểm tra kết nối..." forever with no feedback and no visible retry state.
    // FIX #8: when force=true, append ?force=true so the server bypasses its 20s
    // Neo4j health cache — used right after a "Tiếp tục" pipeline finishes so the
    // Neo4j nodes/rels counts in the dashboard refresh immediately instead of being
    // stuck on the pre-pipeline cached value.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetch('/api/health' + (force ? '?force=true' : ''), { signal: controller.signal })
      if (res.ok) {
        const data = await res.json()
        setHealth(data)
        setHealthError(null)
        setHealthLastChecked(new Date())
        // Notify user about daily quota exhaustion
        if (data.dailyQuotaStatus) {
          const exhausted: string[] = []
          // Object.entries(any) → [string, unknown][] — ép về Record<string, DailyQuotaInfo>
          // (khớp kiểu HealthResponse.dailyQuotaStatus) để truy cập field an toàn
          for (const [name, q] of Object.entries(data.dailyQuotaStatus as Record<string, DailyQuotaInfo>)) {
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

  const fetchStats = useCallback(async (force: boolean = false) => {
    try {
      // FIX #8: when force=true, append &force=true so the server bypasses its
      // 30s stats cache. Used right after a "Tiếp tục" pipeline finishes so the
      // Entities/Relationships cards refresh immediately.
      const res = await fetch('/api/query?action=stats' + (force ? '&force=true' : ''))
      if (res.ok) {
        const data = await res.json()
        setEntityTotal(data.totalEntities || 0)
        setRelationshipTotal(data.totalRelationships || 0)
        setResolvedEntityTotal(data.totalResolvedEntities || 0)
        if (data.knowledgeSource) setKnowledgeSource(data.knowledgeSource)
        if (typeof data.bufferEntities === 'number') {
          setBufferCounts({ entities: data.bufferEntities, relationships: data.bufferRelationships || 0 })
        }
        setDbStats(data)
      }
    } catch { /* ignore */ }
  }, [])

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab)
    try { localStorage.setItem('graphrag-active-tab', tab) } catch { /* ignore */ }
    if (tab === 'documents') fetchDocuments()
    // v1.1 — tab 'chat' và 'explorer' đã bị xóa khỏi module Database.
    // Chức năng chat vẫn đầy đủ ở module Smolab (Single Agent Chat).
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

      // FIX #9 (BUG C): when the backend skipped ALL requested docs (not found
      // anywhere, or already being extracted by the backend auto-chain), the old
      // code still showed the generic "Đang xử lý tài liệu" toast — a silent
      // no-op that looked like "nothing changed" to the user. Surface the real
      // reason from the response instead.
      if (data.skipped === true && (!data.documentIds || data.documentIds.length === 0)) {
        sonnerToast.warning('Không bắt đầu xử lý', {
          description: data.message || 'Tài liệu bị bỏ qua — có thể đang được xử lý ở backend hoặc không tìm thấy dữ liệu.',
          duration: 8000,
        })
        setProcessingIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
        fetchDocuments() // refresh list — status may have changed server-side
        return
      }

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
      const maxTotalWaitMs = Number.MAX_SAFE_INTEGER // No timeout — extraction runs until completion regardless of duration
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
        // Loop exited (safety cleanup — with MAX_SAFE_INTEGER this only runs if the loop breaks internally)
        setExtractingDocIds(prev => { const next = new Set(prev); next.delete(documentId); return next })
      }

      /** Poll a single batch until it reaches a terminal state (partial/indexed/extracted/error).
       *  Includes network error recovery with exponential backoff and max failure threshold.
       *  This prevents "TypeError: Failed to fetch" from crashing the entire polling loop. */
      const pollBatchUntilDone = async (docId: string): Promise<'done' | 'partial' | 'error' | 'unknown'> => {
        let partialConfirmCount = 0
        let consecutiveFetchFailures = 0
        let pollIteration = 0
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

            // FIX #8 (display bug): every 5th iteration (~15s), also refresh health
            // so the Neo4j info panel + footer status bar reflect nodes/rels written
            // by the in-progress pipeline. Without this, the panel only updates once
            // on mount and the user sees "no change" while the pipeline is writing.
            if (pollIteration > 0 && pollIteration % 5 === 0) {
              fetchHealth()
            }
            pollIteration++

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
        fetchDocuments(); fetchEmbeddingStatus()
        // FIX #8 (display bug): force-refresh health + stats after pipeline finishes
        // so the Neo4j nodes/rels counts in the dashboard reflect the freshly-written
        // data immediately, bypassing the 20s health cache and 30s stats cache.
        fetchHealth(true); fetchStats(true)
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
    // UI-refresh poller (3s, lite mode, skipped while the tab is hidden).
    // PERF FIX: this used to run alongside TWO more fetch streams inside waitAll()
    // (a duplicate fetchDocuments every 5s + a direct /api/ingestion/upload fetch
    // every 5s) — 3 overlapping pollers hitting the same endpoint. waitAll now
    // only polls the status check; the UI refresh stays here.
    const pollInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      fetchDocuments(false, undefined, { lite: true })
    }, 3000)
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
            const maxWaitMs = Number.MAX_SAFE_INTEGER // No timeout — extraction runs until completion
            const startTime = Date.now()
            const waitAll = async () => {
              while (Date.now() - startTime < maxWaitMs) {
                await new Promise(resolve => setTimeout(resolve, 5000))
                // PERF FIX: fetchDocuments() removed here — the 3s pollInterval above
                // already refreshes the UI; only the authoritative status check remains.
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
      const maxWaitMs = Number.MAX_SAFE_INTEGER // No timeout — extraction runs until completion
      const startTime = Date.now()
      const waitAll = async () => {
        while (Date.now() - startTime < maxWaitMs) {
          await new Promise(resolve => setTimeout(resolve, 5000))
          // PERF FIX: fetchDocuments() removed here — the 3s pollInterval above
          // already refreshes the UI; only the authoritative status check remains.
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
  // Server always renders 'documents' tab (v1.1 — 'chat' đã xóa), client reads
  // localStorage on mount and updates. If the saved tab was 'chat', 'explorer',
  // 'entities' or 'relationships' (removed tabs), redirect to 'documents'.
  const tabRestoredRef = useRef(false)
  useEffect(() => {
    if (!tabRestoredRef.current) {
      tabRestoredRef.current = true
      // (queueMicrotask: defer setActiveTab + các loader ra khỏi body effect —
      // tránh setState đồng bộ trong effect + vẫn tránh hydration mismatch)
      queueMicrotask(() => {
        try {
          const saved = localStorage.getItem('graphrag-active-tab')
          if (saved && saved !== 'documents') {
            // v1.1 — whitelist chỉ còn 4 tab: documents, analytics, token, autolearn.
            // Saved cũ 'chat'/'explorer' → redirect sang 'documents' + persist lại.
            const validTab = ['documents', 'analytics', 'token', 'autolearn'].includes(saved) ? saved : 'documents'
            setActiveTab(validTab)
            if (validTab !== saved) localStorage.setItem('graphrag-active-tab', validTab)
            // Trigger data loading for the restored tab
            if (validTab === 'analytics') { fetchStats(); fetchEmbeddingStatus(); fetchHealth() }
            // TokenUsageSection handles its own data fetching
          }
        } catch { /* ignore */ }
      })
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
            .then(data => { setEntityTotal(data.totalEntities || 0); setRelationshipTotal(data.totalRelationships || 0); setResolvedEntityTotal(data.totalResolvedEntities || 0); if (data.knowledgeSource) setKnowledgeSource(data.knowledgeSource); if (typeof data.bufferEntities === 'number') setBufferCounts({ entities: data.bufferEntities, relationships: data.bufferRelationships || 0 }); setDbStats(data) })
            .catch(() => {}),
        ])
      }
      void load()
    }
  }, [fetchDocuments])

  // Recovery polling: every 60 seconds, call the recovery endpoint to reset stuck documents
  // and check for documents in error status. Only runs after initial load and when on Documents tab.
  // (ĐÃ DỜI xuống dưới effect "Load initial data" — effect ghi initializedRef phải
  // khai báo TRƯỚC effect đọc nó, nếu không React Compiler báo immutability)
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
              { id: 'selfdirection' as const, label: 'Self-Direction', icon: Compass, desc: 'Tự đề xuất & duyệt' },
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
              <StatsOverview docTotal={docTotal} docStatusBreakdown={docStatusBreakdown} entities={entityTotal} relationships={relationshipTotal} resolvedEntities={resolvedEntityTotal} embeddingStatus={embeddingStatus} processingCount={(docStatusBreakdown['parsing'] || 0) + (docStatusBreakdown['chunked'] || 0) + (docStatusBreakdown['extracting'] || 0)} knowledgeSource={knowledgeSource} bufferCounts={bufferCounts} />

              {/* Tabs */}
              <div className="mt-5">
                <Tabs value={activeTab} onValueChange={handleTabChange}>
                  <TabsList className="w-full bg-slate-950/60 border border-cyan-400/35 shadow-sm rounded-xl h-11 p-1">
                    {/* v1.1 — tab 'chat' và 'explorer' đã bị xóa khỏi module Database.
                        Chức năng chat vẫn đầy đủ ở module Smolab (Single Agent Chat). */}
                    <TabsTrigger value="documents" className="chamfer-sm neon-double-cyan flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-documents data-[state=active]:bg-gradient-to-r data-[state=active]:from-teal-500/80 data-[state=active]:to-cyan-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><BookOpen className="h-3 w-3 mr-1" /> Tài liệu</TabsTrigger>
                    <TabsTrigger value="analytics" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-analytics data-[state=active]:bg-gradient-to-r data-[state=active]:from-purple-500/80 data-[state=active]:to-fuchsia-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><BarChart3 className="h-3 w-3 mr-1" /> Analytics</TabsTrigger>
                    <TabsTrigger value="token" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-token data-[state=active]:bg-gradient-to-r data-[state=active]:from-purple-500/80 data-[state=active]:to-violet-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><Activity className="h-3 w-3 mr-1" /> Token</TabsTrigger>
                    <TabsTrigger value="autolearn" className="chamfer-sm flex-1 text-xs rounded-lg text-stone-300 bg-slate-950/40 border border-transparent tab-glow-autolearn data-[state=active]:bg-gradient-to-r data-[state=active]:from-rose-500/80 data-[state=active]:to-pink-600/80 data-[state=active]:backdrop-blur-md data-[state=active]:text-white data-[state=active]:shadow-sm data-[state=active]:border-cyan-400/40"><Brain className="h-3 w-3 mr-1" /> Auto-Learn</TabsTrigger>
                  </TabsList>

                  <TabsContent value="documents" className="mt-4">
                      <DocumentsList documents={documents} onProcessDoc={handleProcessDoc} onDeleteDoc={handleDeleteDoc} onPauseDoc={handlePauseDoc} onReExtractDoc={handleReExtractDoc} onForceRecover={handleForceRecover} processingIds={processingIds} extractingDocIds={extractingDocIds} pausedDocIds={pausedDocIds} userPausedDocIds={userPausedDocIds} docPage={docPage} docTotal={docTotal} docPageSize={docPageSize} onPageChange={(p) => fetchDocuments(false, p)} docStatusBreakdown={docStatusBreakdown} docLoading={docLoading} autoMode={autoMode} onToggleAuto={() => { const newMode = !autoMode; setAutoMode(newMode); try { localStorage.setItem('graphrag-auto-mode', String(newMode)) } catch {} ; sonnerToast.success(newMode ? 'Đã bật chế độ Tự động' : 'Đã tắt chế độ Tự động', { description: newMode ? '4 keys × 4 docs/key (tối đa 16 song song) — Ưu tiên tài liệu trích xuất dở trước, xong key nào → tự chuyển tài liệu mới' : 'Không tự động — cần bấm "Tiếp tục" thủ công', duration: 3000 }) }} onRegenerateEmbeddings={handleRegenerateEmbeddings} embeddingPseudoCount={embeddingStatus?.pseudo || 0} onEmbedOnlyDoc={handleEmbedOnlyDoc} uploadSlot={<UploadSection onUploadComplete={(uploadedDocIds: string[]) => { fetchDocuments(true, 1); fetchStats() }} existingDocNames={existingDocNames} />} />
                  </TabsContent>

                  <TabsContent value="analytics" className="mt-4">
                    <div className="mb-5">
                      <div className="flex items-center gap-2.5">
                        <div className="p-1.5 rounded-lg bg-gradient-to-br from-rose-500 to-amber-600"><Activity className="h-4 w-4 text-white" /></div>
                        <div>
                          <h3 className="text-sm font-semibold tracking-tight text-stone-100">🩺 Runtime Metrics — giám sát real-time</h3>
                          <p className="text-[11px] text-stone-400">Token burn · tool health · agent runs — 1 endpoint tập trung, poll 10s, fail-open</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        {/* v1.1 — pass analyticsRange để panel chuyển sang chế độ lịch sử khi owner chọn khoảng ngày */}
                        <RuntimeMetricsPanel analyticsRange={analyticsRange} />
                      </div>
                    </div>
                    <div className="mb-5">
                      <div className="flex items-center gap-2.5">
                        <div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600"><Brain className="h-4 w-4 text-white" /></div>
                        <div>
                          <h3 className="text-sm font-semibold tracking-tight text-stone-100">🧠 Episodic Memory — học từ trải nghiệm</h3>
                          <p className="text-[11px] text-stone-400">Episodes · lessons · error taxonomy — Neo4j + Qdrant, poll 15s</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        {/* v1.1 — EpisodicMemoryPanel renders range picker + nút Kiểm tra toàn diện trong toolbar,
                            và nhận analyticsRange để chuyển chế độ lịch sử */}
                        <EpisodicMemoryPanel analyticsRange={analyticsRange} onAnalyticsRangeChange={setAnalyticsRange} />
                      </div>
                    </div>
                    <AnalyticsSection data={{
                      documents,
                      embeddingStatus,
                      loading,
                      dbStats,
                      // FIX #8: pass parent's health so Neo4jVerification auto-updates
                      // when fetchHealth() polls (every 10s) or fires force=true after a
                      // pipeline finishes (see handleProcessDoc .finally() block).
                      health,
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
            ) : activeModule === 'selfdirection' ? (
              <SelfDirectionModule />
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
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-stone-300">API Token (GitHub PAT)</label>
                {gitPullDefaultConfig?.hasSavedToken && (
                  <button
                    onClick={handleGitPullForgetToken}
                    className="text-[10px] text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
                    title="Xóa token đã lưu khỏi server (db/.github-token.json)"
                  >
                    Xóa token đã lưu
                  </button>
                )}
              </div>
              <input
                type="password"
                value={gitPullApiToken}
                onChange={e => setGitPullApiToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full rounded-md border border-cyan-400/30 bg-slate-900 px-3 py-2 text-xs text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              />
              {gitPullApiToken ? (
                gitPullApiToken === gitPullDefaultConfig?.savedToken ? (
                  <p className="text-[10px] text-emerald-400">
                    ✓ Token đã lưu sẵn ({gitPullDefaultConfig?.savedTokenPreview || '****'}) — tự động điền từ lần nhập trước. Nhập token khác nếu muốn thay thế.
                  </p>
                ) : (
                  <p className="text-[10px] text-cyan-400">
                    Token mới — sẽ tự động lưu thay cho token cũ sau khi pull/kiểm tra.
                  </p>
                )
              ) : gitPullDefaultConfig?.hasSavedToken ? (
                <p className="text-[10px] text-emerald-400">
                  ✓ Đã có token lưu sẵn ({gitPullDefaultConfig?.savedTokenPreview || '****'}) — server sẽ tự dùng, để trống vẫn pull được.
                </p>
              ) : (
                <p className="text-[10px] text-amber-400/70">⚠️ Cần API Token để truy cập private repo — nhập 1 lần, tự động lưu để điền sẵn lần sau</p>
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
