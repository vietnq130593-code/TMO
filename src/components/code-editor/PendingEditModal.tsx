'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, ChevronDown, ChevronRight, CheckCircle2, XCircle, Play } from 'lucide-react'
import { DiffViewer } from './DiffViewer'
import { detectLanguage } from './CodeEditor'

export interface PendingEditModalProps {
  edits: Array<Record<string, unknown>>
  onRefresh: () => void
  onClose: () => void
}

interface EditRecord {
  id?: string
  filePath?: string
  operation?: string
  agentName?: string
  status?: string
  riskLevel?: string
  before?: string
  after?: string
  oldContent?: string
  newContent?: string
}

const OPERATION_BADGES: Record<string, string> = {
  create: 'bg-emerald-950/50 text-emerald-300 border-emerald-400/35',
  update: 'bg-blue-950/50 text-blue-300 border-blue-400/35',
  edit: 'bg-blue-950/50 text-blue-300 border-blue-400/35',
  delete: 'bg-red-950/50 text-red-300 border-red-400/35',
}

/**
 * Phase 9 — PendingEdit review modal.
 *
 * REAL API shape (GET /api/openclaw/pending-edits?status=pending): each edit
 * carries `before`/`after` (legacy: `oldContent`/`newContent`) — there is NO
 * originalContent/summary field, so agentName doubles as the fallback label.
 * Approve/reject REQUIRE { id, reviewerId } (400 when reviewerId missing);
 * apply requires { id } only and writes to the filesystem.
 */
export function PendingEditModal({ edits, onRefresh, onClose }: PendingEditModalProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)

  const records: EditRecord[] = (edits || []).map((e) => e as EditRecord)

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const act = async (edit: EditRecord, action: 'approve' | 'reject' | 'apply') => {
    const id = String(edit.id ?? '')
    if (!id || busyId) return
    setBusyId(id)
    try {
      const body: Record<string, string> = action === 'apply' ? { id } : { id, reviewerId: 'smolab-user' }
      const res = await fetch(`/api/openclaw/pending-edits?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({ ok: false }))
      if (data.ok) onRefresh()
    } catch {
      /* swallow — refresh anyway to re-sync */
      onRefresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col bg-slate-950 border-emerald-500/20 p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-emerald-500/10 shrink-0">
          <DialogTitle className="text-sm font-mono text-emerald-300 flex items-center gap-2">
            📝 Pending Edits ({records.length})
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2" style={{ scrollbarWidth: 'thin' }}>
          {records.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-stone-500">
              <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-500/50" />
              <p className="text-xs">Không có edit nào chờ duyệt</p>
            </div>
          )}
          {records.map((edit, i) => {
            const id = String(edit.id ?? `idx-${i}`)
            const filePath = edit.filePath || '(không rõ file)'
            const before = edit.before ?? edit.oldContent ?? ''
            const after = edit.after ?? edit.newContent ?? ''
            const label = edit.agentName || edit.operation || 'AI edit'
            const opBadge = OPERATION_BADGES[edit.operation || ''] || 'bg-slate-800 text-stone-300 border-stone-600/40'
            const isOpen = expanded.has(id)
            const busy = busyId === id
            return (
              <div key={id} className="border border-emerald-500/10 rounded-sm bg-slate-900/50">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    className="text-stone-500 hover:text-emerald-300 flex-shrink-0"
                    onClick={() => toggle(id)}
                    title={isOpen ? 'Thu gọn diff' : 'Xem diff'}
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-[10px] font-mono text-stone-300 truncate flex-1" title={filePath}>
                    {filePath.split('/').pop()}
                    <span className="text-stone-600"> {filePath.includes('/') ? `· ${filePath}` : ''}</span>
                  </span>
                  <Badge className={`text-[8px] border ${opBadge}`}>{edit.operation || 'edit'}</Badge>
                  <Badge className="text-[8px] bg-slate-800 text-stone-400 border border-stone-600/40 max-w-[140px] truncate" title={label}>
                    {label}
                  </Badge>
                  {edit.riskLevel && (
                    <Badge className="text-[8px] bg-amber-950/50 text-amber-300 border border-amber-400/35">{edit.riskLevel}</Badge>
                  )}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      size="sm"
                      className="h-6 text-[9px] px-2 bg-emerald-600 hover:bg-emerald-500 text-white"
                      disabled={busy}
                      onClick={() => void act(edit, 'approve')}
                      title="Duyệt edit này"
                    >
                      {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />} Duyệt
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[9px] px-2 border-red-400/40 text-red-300 hover:bg-red-500/10"
                      disabled={busy}
                      onClick={() => void act(edit, 'reject')}
                      title="Từ chối edit này"
                    >
                      <XCircle className="h-2.5 w-2.5 mr-0.5" /> Từ chối
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[9px] px-2 border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/10"
                      disabled={busy}
                      onClick={() => void act(edit, 'apply')}
                      title="Ghi ra filesystem"
                    >
                      <Play className="h-2.5 w-2.5 mr-0.5" /> Apply
                    </Button>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-emerald-500/10" style={{ height: '340px' }}>
                    <DiffViewer
                      originalContent={before}
                      modifiedContent={after}
                      language={detectLanguage(filePath)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-emerald-500/10 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-3 text-[10px] border-stone-600/50 text-stone-300 hover:bg-slate-800"
            onClick={onClose}
          >
            Đóng
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
