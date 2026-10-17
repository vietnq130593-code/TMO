/**
 * ALISTA — Rules (deterministic) (v1.3)
 * =======================================
 * Mỗi rule function nhận data của 1 check → trả Finding[] (đã có dedupe key +
 * category + priority + evidence + direction + successCriteria). LLM KHÔNG quyết
 * priority/category (chống ảo giác) — chỉ dùng direction để viết văn proposal.
 *
 * v1.3: mỗi finding kèm successCriteria (metric + current + target + recheck
 * window) — tiêu chí xác nhận hiệu quả giải pháp, machine-checkable. Recheck
 * window lấy từ types.ts recheckWindowFor (single source of truth — verify
 * loop dùng đúng map này để quyết định đo lại NGAY hay HOÃN).
 *
 * Nguyên tắc:
 *   - Rule đơn giản: 1 điều kiện = 1 finding (hoặc gộp nếu cùng target).
 *   - Cap/run áp dụng SAU khi collect findings (slice top N theo priority).
 *   - Mỗi finding có `key` theo format `[ALISTA] <slug>:<target>:<yyyymm>`.
 */

import type {
  Finding, CheckId, StepEntry, SuccessCriteria,
} from './types'
import { makeDedupeKey, STEP_LABELS, STEP_ICONS, recheckWindowFor } from './types'
import type {
  ToolsHealthData, AgentRunsData, EscalationsData, DomainCoverageData,
  ThreeLayersData, SelfAssessmentData, DatabaseSystemData,
} from './collectors'
// P3-c (task 31-f) — ngưỡng tuổi artifact backup cho rule ⑦(i)
import { SQLITE_BACKUP_MAX_AGE_HOURS, WEEKLY_SNAPSHOT_MAX_AGE_HOURS } from './db-backup-core'

// ==================== COMMON HELPERS ====================

/** Phần criteria không có recheck (recheck tự fill từ recheckWindowFor) */
type CriteriaSpec = Pick<SuccessCriteria, 'metric' | 'current' | 'target' | 'operator'>

/** Tạo Finding đầy đủ với metadata auto-fill + successCriteria (v1.3) */
function makeFinding(
  checkId: CheckId,
  slug: string,
  target: string,
  category: Finding['category'],
  priority: Finding['priority'],
  evidence: Record<string, unknown>,
  direction: string,
  criteria?: CriteriaSpec,
): Finding {
  const rw = recheckWindowFor(slug, target)
  return {
    key: makeDedupeKey(slug, target),
    checkId,
    checkLabel: STEP_LABELS[checkId],
    category,
    priority,
    evidence,
    direction,
    target,
    successCriteria: criteria
      ? { ...criteria, recheckAfterMs: rw.ms, recheckWhy: rw.why }
      : undefined,
  }
}

/** Sắp xếp findings theo priority rank (critical > high > medium > low) + slice top N */
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
function topByPriority(findings: Finding[], cap: number): Finding[] {
  return [...findings]
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99))
    .slice(0, cap)
}

// ==================== ① TOOLS HEALTH ====================

export function rulesForTools(data: ToolsHealthData): Finding[] {
  const out: Finding[] = []
  for (const t of data.tools) {
    if (t.calls >= 10 && t.successRate < 0.5) {
      out.push(makeFinding(1, 'tool', t.toolName, 'tool_failure', 'high', {
        tool: t.toolName, calls: t.calls, errors: t.errors,
        successRate: Math.round(t.successRate * 100) / 100,
        topErrorTag: t.topErrorTag, sampleErrors: t.sampleErrors,
        window: '7d',
      }, `Tool "${t.toolName}" tỷ lệ thành công chỉ ${Math.round(t.successRate * 100)}% trên ${t.calls} lần gọi (7d) — chủ yếu lỗi "${t.topErrorTag || 'unknown'}". Cần điều tra root cause (input/timeout/quyền) + sửa hoặc thêm retry/fallback với backoff, sau đó chạy test hồi quy 20 lần gọi liên tiếp để verify.`, {
        metric: `tool "${t.toolName}" successRate (cửa sổ 7 ngày)`,
        current: `${Math.round(t.successRate * 100)}%`,
        target: '80%',
        operator: 'gte',
      }))
    } else if (t.calls >= 20 && t.successRate >= 0.5 && t.successRate < 0.8) {
      out.push(makeFinding(1, 'tool', t.toolName, 'tool_failure', 'medium', {
        tool: t.toolName, calls: t.calls, errors: t.errors,
        successRate: Math.round(t.successRate * 100) / 100,
        topErrorTag: t.topErrorTag, window: '7d',
      }, `Tool "${t.toolName}" tỷ lệ thành công ${Math.round(t.successRate * 100)}% trên ${t.calls} lần gọi (7d) — dưới ngưỡng lành mạnh 80%. Phân tích lỗi hay gặp, bổ sung input validation, retry cho lỗi tạm thời.`, {
        metric: `tool "${t.toolName}" successRate (cửa sổ 7 ngày)`,
        current: `${Math.round(t.successRate * 100)}%`,
        target: '80%',
        operator: 'gte',
      }))
    } else if (t.avgDurationMs > 30_000 && t.calls >= 5) {
      out.push(makeFinding(1, 'tool', t.toolName, 'improvement', 'low', {
        tool: t.toolName, calls: t.calls, avgDurationMs: t.avgDurationMs, window: '7d',
      }, `Tool "${t.toolName}" chạy trung bình ${(t.avgDurationMs / 1000).toFixed(1)}s trên ${t.calls} lần — chậm. Cân nhắc tối ưu (cache, batch, async) hoặc thêm timeout cứng + graceful degrade.`, {
        metric: `tool "${t.toolName}" avgDurationMs`,
        current: t.avgDurationMs,
        target: 30_000,
        operator: 'lte',
      }))
    }
  }
  // Cap ≤3/run — top offender theo errors
  return topByPriority(out, 3)
}

// ==================== ② AGENT RUNS ====================

export function rulesForAgentRuns(data: AgentRunsData): Finding[] {
  const out: Finding[] = []

  // Failure signatures — failed≥3, ≥2 ngày khác nhau, run gần nhất vẫn fail
  const sigsToReport = data.window7d.failureSignatures.filter(s =>
    s.occurrences >= 3 && s.distinctDays >= 2 && s.recentStillFailing,
  )
  for (const s of sigsToReport.slice(0, 2)) {
    const priority = s.occurrences >= 5 ? 'high' : 'medium'
    out.push(makeFinding(2, 'run', `${s.agentName || 'unknown'}_${s.stopReason || 'unknown'}`, 'improvement', priority, {
      agentName: s.agentName, stopReason: s.stopReason,
      occurrences: s.occurrences, distinctDays: s.distinctDays,
      recentRunAt: s.recentRunAt?.toISOString() ?? null,
    }, `Agent "${s.agentName || 'unknown'}" gặp pattern ${s.stopReason} ${s.occurrences} lần trên ${s.distinctDays} ngày khác nhau trong 7d — run gần nhất vẫn fail (chưa resolved). Cần khảo sát log run gần nhất, xác định root cause (tool/LLM/context overflow), sửa hoặc thêm guard để không lặp lại pattern.`, {
      metric: `pattern fail "${s.stopReason}" của agent "${s.agentName || 'unknown'}" (run gần nhất có còn fail?)`,
      current: 'vẫn fail',
      target: 'run gần nhất pass (không còn fail)',
      operator: 'eq',
    }))
  }

  // Zombies — status=running >30'
  if (data.zombies.length > 0) {
    out.push(makeFinding(2, 'zombie', 'agent_runs', 'improvement', 'medium', {
      count: data.zombies.length,
      agents: data.zombies.slice(0, 5).map(z => ({
        id: z.id, agentName: z.agentName,
        startedAt: z.startedAt?.toISOString() ?? null,
      })),
    }, `Có ${data.zombies.length} AgentRunRecord đang ở status='running' quá 30' (zombie) — server crash giữa chừng hoặc worker chết không ghi end. Cần (1) dọn dẹp zombie về 'failed' kèm reason='zombie_orphan', (2) đảm bảo exit hook của worker luôn ghi end ngay cả khi crash.`, {
      metric: 'số AgentRunRecord zombie (running >30\' không in-flight)',
      current: data.zombies.length,
      target: 0,
      operator: 'lte',
    }))
  }

  return out
}

// ==================== ③ ESCALATIONS ====================

export function rulesForEscalations(data: EscalationsData): Finding[] {
  const out: Finding[] = []
  for (const esc of data.escalations) {
    if (esc.occurrences >= 3 && (esc.occurrences - esc.resolved) >= 2) {
      const priority = (esc.occurrences - esc.resolved) >= 10 ? 'high' : 'medium'
      out.push(makeFinding(3, 'escalation', esc.rootCause || 'unknown', 'improvement', priority, {
        rootCause: esc.rootCause, occurrences: esc.occurrences,
        unresolved: esc.occurrences - esc.resolved,
        recentErrors: esc.recentErrors.slice(0, 3),
      }, `Pattern lỗi "${esc.rootCause}" lặp ${esc.occurrences} lần (trong đó ${esc.occurrences - esc.resolved} chưa resolve) — đã thành escalation. Cần nghiên cứu root cause hệ thống (không chỉ dọn từng occurrence), nếu cần cải tiến hệ thống thì đề xuất phương án (ví dụ: thêm guard input, retry layer, alert early).`, {
        metric: `số occurrence chưa resolve của rootCause "${esc.rootCause}"`,
        current: esc.occurrences - esc.resolved,
        target: 1,
        operator: 'lte',
      }))
    }
  }
  return topByPriority(out, 2)
}

// ==================== ④ DOMAIN COVERAGE ====================

const STANDARD_DOMAINS = ['programming', 'algorithm', 'ml', 'data', 'devops', 'security', 'business', 'mixed']

export function rulesForDomainCoverage(data: DomainCoverageData): Finding[] {
  const out: Finding[] = []
  const now = Date.now()

  // Tổng entity <500 — gap high
  if (data.totalEntities < 500) {
    out.push(makeFinding(4, 'domain', 'kb_total', 'gap', 'high', {
      totalEntities: data.totalEntities,
      totalRelationships: data.totalRelationships,
      source: data.source,
    }, `Kho tri thức chỉ có ${data.totalEntities} entity (ngưỡng lành mạnh ≥500) — quá nghèo cho GraphRAG. Cần nạp thêm tài liệu nền tảng qua Database > Tài liệu + chạy pipeline extraction đầy đủ (parse → chunk → entity → embedding → index).`, {
      metric: 'tổng entity trong kho tri thức (Neo4j)',
      current: data.totalEntities,
      target: 500,
      operator: 'gte',
    }))
  }

  // Domain chuẩn <20 entity — gap medium (gộp 1 proposal)
  const weakDomains = STANDARD_DOMAINS.filter(d => (data.domainDistribution[d] ?? 0) < 20)
  if (weakDomains.length > 0) {
    out.push(makeFinding(4, 'domain', 'weak_domains', 'gap', 'medium', {
      weakDomains: weakDomains.map(d => ({ domain: d, count: data.domainDistribution[d] ?? 0 })),
      allDomains: data.domainDistribution,
    }, `Các domain chuẩn còn yếu (<20 entity): ${weakDomains.join(', ')}. Cần bổ sung tài liệu chuyên sâu cho từng domain yếu — ưu tiên domain cốt lõi (${weakDomains.slice(0, 3).join(', ')}).`, {
      metric: 'số domain chuẩn còn dưới 20 entity',
      current: weakDomains.length,
      target: 0,
      operator: 'lte',
    }))
  }

  // Domain >30 ngày không cập nhật — gap low
  const staleDomains: Array<{ domain: string; lastUpdated: string | null }> = []
  for (const d of STANDARD_DOMAINS) {
    const last = data.domainLastUpdated[d]
    if (last) {
      const days = (now - new Date(last).getTime()) / (24 * 3600_000)
      if (days > 30) staleDomains.push({ domain: d, lastUpdated: last })
    }
  }
  if (staleDomains.length > 0) {
    out.push(makeFinding(4, 'domain', 'stale_domains', 'gap', 'low', {
      staleDomains,
    }, `Các domain không cập nhật quá 30 ngày: ${staleDomains.map(d => `${d.domain} (${d.lastUpdated})`).join(', ')} — tri thức có thể lỗi thời. Cần nạp tài liệu mới cho các domain này để giữ KB cập nhật.`, {
      metric: 'số domain chuẩn >30 ngày không cập nhật',
      current: staleDomains.length,
      target: 0,
      operator: 'lte',
    }))
  }

  // Cap ≤1 (gộp) — nhưng để pipeline xử lý cap chung, trả tối đa 3 (để LLM có
  // thể tách thành 3 proposal nếu cần). Cap thực ở proposals.ts (≤6 total).
  return out.slice(0, 3)
}

// ==================== ⑤ 3 TẦNG DỮ LIỆU + INFRA (v1.3) ====================

export function rulesFor3Layers(data: ThreeLayersData): Finding[] {
  const out: Finding[] = []

  // Qdrant disconnected → critical
  if (!data.qdrant.connected) {
    out.push(makeFinding(5, 'layer', 'qdrant', 'improvement', 'critical', {
      connected: false, error: data.qdrant.error,
      collections: data.qdrant.collections,
    }, `Qdrant DISCONNECTED — Vector Search và nhiều pipeline KB dựa vào Qdrant sẽ fail. Cần (1) kiểm tra binary Qdrant đang chạy (port 6333), (2) khởi động lại nếu cần, (3) verify collections tồn tại (theopus_chunks + theopus_episodes).`, {
      metric: 'Qdrant connectivity (GET /collections)',
      current: 'disconnected',
      target: 'connected',
      operator: 'eq',
    }))
  }

  // Neo4j disconnected → critical
  if (!data.neo4j.connected) {
    out.push(makeFinding(5, 'layer', 'neo4j', 'improvement', 'critical', {
      connected: false, error: data.neo4j.error,
    }, `Neo4j DISCONNECTED — GraphRAG và Episodic Memory không truy cập được. Cần (1) kiểm tra AuraDB instance 6e688b02.databases.neo4j.io sống, (2) verify credentials trong .env (NEO4J_PASSWORD 64 ký tự), (3) restart app để reset driver.`, {
      metric: 'Neo4j AuraDB connectivity',
      current: 'disconnected',
      target: 'connected',
      operator: 'eq',
    }))
  }

  // (v1.3) R2 disconnected (đã configure) → high — backup/PDF fail âm thầm
  if (data.infra.r2.configured && !data.infra.r2.connected) {
    out.push(makeFinding(5, 'layer', 'r2', 'improvement', 'high', {
      connected: false, error: data.infra.r2.error,
      objectCount: data.infra.r2.objectCount ?? 0,
    }, `Cloudflare R2 DISCONNECTED (đã configure) — backup DB + lưu trữ PDF/tài liệu đang fail âm thầm. Cần (1) verify R2_SECRET_ACCESS_KEY đủ 64 ký tự, (2) check bucket "themagnumopus" còn tồn tại, (3) test S3 auth thủ công rồi restart app.`, {
      metric: 'R2 S3 connectivity (ListObjectsV2)',
      current: 'disconnected',
      target: 'connected',
      operator: 'eq',
    }))
  }

  // (v1.3) Supabase disconnected (đã configure) → medium — sync backup fail
  if (data.infra.supabase.configured && !data.infra.supabase.connected) {
    out.push(makeFinding(5, 'layer', 'supabase', 'improvement', 'medium', {
      connected: false, error: data.infra.supabase.error,
      tableCount: data.infra.supabase.tableCount,
    }, `Supabase DISCONNECTED (đã configure) — sync backup 24 bảng SQLite sang cloud đang fail. Cần (1) verify SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY còn hiệu lực, (2) check service role key chưa bị rotate, (3) test auth rồi restart sync.`, {
      metric: 'Supabase connectivity (auth probe)',
      current: 'disconnected',
      target: 'connected',
      operator: 'eq',
    }))
  }

  // (v1.3) 0 NVIDIA key → critical — mọi agent LLM chết
  if (data.infra.llmKeys.nvidiaConfigured === 0) {
    out.push(makeFinding(5, 'layer', 'llm_keys', 'improvement', 'critical', {
      nvidiaConfigured: 0,
    }, `KHÔNG có NVIDIA_API_KEY nào được configure (1-4) — mọi agent LLM (kimi-k3 chain) sẽ fail. Cần (1) nạp lại .env với ít nhất 1 key còn quota, (2) restart app (PM2) để nạp env, (3) verify health NVIDIA chip xanh.`, {
      metric: 'số NVIDIA_API_KEY configured trong env',
      current: 0,
      target: 1,
      operator: 'gte',
    }))
  }

  // (v1.3) Disk gần đầy → high/medium — SQLite + Qdrant storage cùng volume
  if (data.infra.disk && data.infra.disk.freePct != null) {
    const freePct = data.infra.disk.freePct
    if (freePct < 15) {
      out.push(makeFinding(5, 'layer', 'disk', 'improvement', 'high', {
        freePct, availableBytes: data.infra.disk.availableBytes,
        totalBytes: data.infra.disk.totalBytes, path: data.infra.disk.path,
      }, `Disk chỉ còn ${freePct}% trống (${(data.infra.disk.availableBytes! / 1024 / 1024 / 1024).toFixed(1)}GB/${(data.infra.disk.totalBytes! / 1024 / 1024 / 1024).toFixed(1)}GB) — dưới 15% nguy cơ SQLite write fail + Qdrant segment lỗi. Cần (1) dọn file log/backup cũ, (2) archival + VACUUM DB, (3) theo dõi sát nếu vẫn giảm.`, {
        metric: 'disk free % (volume chứa app + SQLite + Qdrant storage)',
        current: `${freePct}%`,
        target: '15%',
        operator: 'gte',
      }))
    } else if (freePct < 30) {
      out.push(makeFinding(5, 'layer', 'disk', 'improvement', 'medium', {
        freePct, availableBytes: data.infra.disk.availableBytes,
        totalBytes: data.infra.disk.totalBytes, path: data.infra.disk.path,
      }, `Disk còn ${freePct}% trống — dưới ngưỡng an toàn 30%. Cân nhắc dọn file tạm/log cũ + lập kế hoạch archival để tránh sụt xuống vùng nguy hiểm (<15%).`, {
        metric: 'disk free % (volume chứa app + SQLite + Qdrant storage)',
        current: `${freePct}%`,
        target: '30%',
        operator: 'gte',
      }))
    }
  }

  // pointCount=0 mà KB có document → high (re-embed)
  if (data.qdrant.connected && data.qdrant.totalChunks === 0 && data.qdrant.totalDocuments > 0) {
    out.push(makeFinding(5, 'layer', 'qdrant_empty', 'improvement', 'high', {
      totalDocuments: data.qdrant.totalDocuments,
      totalChunks: data.qdrant.totalChunks,
    }, `Qdrant connected nhưng 0 chunk index trong khi có ${data.qdrant.totalDocuments} document — embedding pipeline bị đứt. Cần chạy regenerate embeddings (nút trong module Database) để backfill vector.`, {
      metric: 'số chunk có vector trong Qdrant',
      current: 0,
      target: 1,
      operator: 'gte',
    }))
  }

  // realRatio<50% / hasRealEmbeddings=false → high
  if (data.embed.total > 0 && (data.embed.realRatio < 0.5 || !data.embed.hasRealEmbeddings)) {
    out.push(makeFinding(5, 'layer', 'embed_low', 'improvement', 'high', {
      total: data.embed.total, real: data.embed.real,
      realRatio: Math.round(data.embed.realRatio * 100) / 100,
      hasRealEmbeddings: data.embed.hasRealEmbeddings,
    }, `Tỷ lệ embedding thật chỉ ${Math.round(data.embed.realRatio * 100)}% (${data.embed.real}/${data.embed.total}) — dưới ngưỡng lành mạnh 50%. Cần re-embed các chunk thiếu vector + verify NVIDIA_API_KEY còn hiệu lực.`, {
      metric: 'tỷ lệ embedding thật (vectorsIndexed / totalChunks)',
      current: `${Math.round(data.embed.realRatio * 100)}%`,
      target: '50%',
      operator: 'gte',
    }))
  }

  // nodeCount sụt >20% vs lần trước → high
  if (data.previousSnapshot?.neo4jNodes != null && data.neo4j.nodeCount != null) {
    const prev = data.previousSnapshot.neo4jNodes
    const cur = data.neo4j.nodeCount
    if (prev > 0 && cur < prev * 0.8) {
      out.push(makeFinding(5, 'layer', 'neo4j_drop', 'improvement', 'high', {
        previousNodes: prev, currentNodes: cur,
        dropPct: Math.round((1 - cur / prev) * 100),
        previousRunAt: data.previousSnapshot.runAt,
      }, `Neo4j nodeCount sụt ${Math.round((1 - cur / prev) * 100)}% so với lần check trước (${prev} → ${cur}) — có thể dữ liệu bị xóa nhầm hoặc sync từ SQLite sang Neo4j bị lỗi. Cần đối chiếu log sync + restore nếu có backup.`, {
        metric: 'Neo4j nodeCount',
        current: cur,
        target: Math.round(prev * 0.8),
        operator: 'gte',
      }))
    }
  }

  // vectorsIndexed sụt >20% vs lần trước → high
  if (data.previousSnapshot?.qdrantVectors != null) {
    const prev = data.previousSnapshot.qdrantVectors
    const cur = data.qdrant.vectorsIndexed
    if (prev > 0 && cur < prev * 0.8) {
      out.push(makeFinding(5, 'layer', 'qdrant_drop', 'improvement', 'high', {
        previousVectors: prev, currentVectors: cur,
        dropPct: Math.round((1 - cur / prev) * 100),
        previousRunAt: data.previousSnapshot.runAt,
      }, `Qdrant vectorsIndexed sụt ${Math.round((1 - cur / prev) * 100)}% so với lần check trước (${prev} → ${cur}) — collection có thể bị xóa hoặc re-create. Cần verify collection + re-embed nếu cần.`, {
        metric: 'Qdrant vectorsIndexed',
        current: cur,
        target: Math.round(prev * 0.8),
        operator: 'gte',
      }))
    }
  }

  return out
}

// ==================== ⑥ TỰ-ĐÁNH-GIÁ ALISTA ====================

export function rulesForSelfAssessment(data: SelfAssessmentData): Finding[] {
  const out: Finding[] = []
  if (data.failedCollectors.length > 0) {
    out.push(makeFinding(6, 'self', 'collector_failures', 'long_term', 'low', {
      failedCollectors: data.failedCollectors,
      recentRunStats: data.recentRunStats,
      toolsCount: data.toolsCount,
    }, `Trong ca trực này có ${data.failedCollectors.length} collector fail (${data.failedCollectors.map(f => f.label).join(', ')}). Cần (1) điều tra root cause của từng collector fail, (2) thêm retry/fallback, (3) cân nhắc mở rộng tool whitelist (hiện ${data.toolsCount} tool) cho ALISTA nếu thiếu năng lực khảo sát.`))
  } else if (data.recommendations.length > 0) {
    // Nếu không có collector fail nhưng có recommendation — vẫn đề xuất nâng cấp
    out.push(makeFinding(6, 'self', 'self_improvement', 'long_term', 'low', {
      recommendations: data.recommendations,
      recentRunStats: data.recentRunStats,
      toolsCount: data.toolsCount,
    }, `Tự-đánh-giá ALISTA: ${data.recommendations.join(' | ')}. Cân nhắc bổ sung năng lực/quyền hạn cho ALISTA để làm nhiệm vụ tốt hơn.`))
  }
  return out.slice(0, 1)
}

// ==================== ⑦ DATABASE + MEMORY + LEARNING ====================

export function rulesForDatabaseSystem(data: DatabaseSystemData, threeLayersData?: ThreeLayersData): Finding[] {
  const out: Finding[] = []

  // (a) Schema drift
  if (data.schemaDrift.migrated) {
    out.push(makeFinding(7, 'db', 'schema_drift', 'improvement', 'high', {
      migrated: true, reason: data.schemaDrift.reason,
    }, `Schema drift detected — ensureDbReady đã tự migrate (${data.schemaDrift.reason || 'prisma db push'}). Nếu drift lặp lại nhiều lần trong 24h, có nghĩa là DB local đang bất ổn (code/schema mismatch). Cần verify git pull chưa pull schema mới + commit schema chuẩn.`, {
      metric: 'sự kiện schema drift trong ca trực (ensureDbReady migrated)',
      current: 'drift đã xảy ra',
      target: 'không còn drift',
      operator: 'eq',
    }))
  } else if (data.schemaDrift.reason && data.schemaDrift.reason.includes('failed')) {
    out.push(makeFinding(7, 'db', 'schema_check_fail', 'improvement', 'high', {
      reason: data.schemaDrift.reason,
    }, `ensureDbReady fail — không kiểm tra được schema drift. Lỗi: "${data.schemaDrift.reason}". Cần kiểm tra Prisma client generate + DB file permission.`, {
      metric: 'ensureDbReady probe',
      current: 'fail',
      target: 'ok (không migrate)',
      operator: 'eq',
    }))
  }

  // (b) Zombie rows — gộp 1 finding nếu có bất kỳ zombie nào
  const totalZombies = data.zombies.agentRunRunning6h + data.zombies.taskExecutionRunning24h + data.zombies.smolabTaskRunning30m + data.zombies.goalLoopJobRunning15m
  if (totalZombies > 0) {
    out.push(makeFinding(7, 'db', 'zombies', 'improvement', 'medium', {
      total: totalZombies,
      details: data.zombies.details.filter(d => d.count > 0),
    }, `Có ${totalZombies} zombie rows trong SQLite (AgentRunRecord/TaskExecution/SmolabTask/GoalLoopJob kẹt ở status='running' quá ngưỡng) — server crash giữa chừng không ghi end. Cần (1) dọn zombie về 'failed' với reason='zombie_orphan', (2) thêm exit hook worker để luôn ghi end khi crash.`, {
      metric: 'tổng zombie rows (AgentRun/TaskExecution/SmolabTask/GoalLoopJob)',
      current: totalZombies,
      target: 0,
      operator: 'lte',
    }))
  }

  // (c) Memory mirror drift >20%
  if (data.memoryDrift.neo4jReachable) {
    if (data.memoryDrift.episodeDriftPct > 20) {
      out.push(makeFinding(7, 'db', 'mirror_episode_drift', 'improvement', 'medium', {
        mirrorCount: data.memoryDrift.episodeMirrorCount,
        graphCount: data.memoryDrift.episodeGraphCount,
        driftPct: Math.round(data.memoryDrift.episodeDriftPct),
      }, `SQLite EpisodeRecord mirror thiếu ${Math.round(data.memoryDrift.episodeDriftPct)}% so với Neo4j Episode (${data.memoryDrift.episodeMirrorCount}/${data.memoryDrift.episodeGraphCount}) — mirror không còn là bản sao chính xác. Cần backfill mirror từ graph (pattern ngược với fallback hiện tại) để cả 2 nguồn đồng bộ.`, {
        metric: 'episode mirror drift % (SQLite vs Neo4j)',
        current: `${Math.round(data.memoryDrift.episodeDriftPct)}%`,
        target: '20%',
        operator: 'lte',
      }))
    }
    if (data.memoryDrift.lessonDriftPct > 20) {
      out.push(makeFinding(7, 'db', 'mirror_lesson_drift', 'improvement', 'medium', {
        mirrorCount: data.memoryDrift.lessonMirrorCount,
        graphCount: data.memoryDrift.lessonGraphCount,
        driftPct: Math.round(data.memoryDrift.lessonDriftPct),
      }, `SQLite LessonRecord mirror thiếu ${Math.round(data.memoryDrift.lessonDriftPct)}% so với Neo4j Lesson (${data.memoryDrift.lessonMirrorCount}/${data.memoryDrift.lessonGraphCount}) — mirror lệch. Cần backfill mirror từ graph để UI/mirror query trả đúng số liệu.`, {
        metric: 'lesson mirror drift % (SQLite vs Neo4j)',
        current: `${Math.round(data.memoryDrift.lessonDriftPct)}%`,
        target: '20%',
        operator: 'lte',
      }))
    }
  }

  // (d) Learning system health
  if (data.learning.autoLearn.failedIn24h > 5) {
    out.push(makeFinding(7, 'db', 'autolearn_failures', 'improvement', 'high', {
      failedIn24h: data.learning.autoLearn.failedIn24h,
      total: data.learning.autoLearn.total,
      completed: data.learning.autoLearn.completed,
    }, `Auto-Learn có ${data.learning.autoLearn.failedIn24h} bản ghi fail trong 24h — worker auto-learn đang gặp vấn đề. Cần điều tra log auto-learn fail gần đây, xác định root cause (LLM/Neo4j/Qdrant/key) + sửa.`, {
      metric: 'số bản ghi AutoLearnRecord fail trong 24h',
      current: data.learning.autoLearn.failedIn24h,
      target: 5,
      operator: 'lte',
    }))
  }
  if (data.learning.autoLearn.pendingStuck24h > 0) {
    out.push(makeFinding(7, 'db', 'autolearn_pending_stuck', 'improvement', 'high', {
      pendingStuck24h: data.learning.autoLearn.pendingStuck24h,
      totalPending: data.learning.autoLearn.pending,
    }, `Auto-Learn có ${data.learning.autoLearn.pendingStuck24h} bản ghi pending quá 24h — worker kẹt, không xử lý queue. Cần (1) restart worker, (2) nếu vẫn kẹt → điều tra deadlock/long-running task.`, {
      metric: 'số AutoLearnRecord pending quá 24h',
      current: data.learning.autoLearn.pendingStuck24h,
      target: 0,
      operator: 'lte',
    }))
  }
  if (data.learning.pendingWriteback > 20) {
    out.push(makeFinding(7, 'db', 'writeback_backlog', 'improvement', 'medium', {
      pendingWriteback: data.learning.pendingWriteback,
    }, `PendingWriteback backlog ${data.learning.pendingWriteback} writeback đang chờ review — nguy cơ tích lũy tri thức chưa kiểm chứng trong KB. Cần review từng mục trong Auto-Learn > writeback review (approve/reject kèm ghi chú lý do).`, {
      metric: 'số PendingWriteback status=pending',
      current: data.learning.pendingWriteback,
      target: 20,
      operator: 'lte',
    }))
  }
  if (data.learning.lessonsNeedReview > 10) {
    out.push(makeFinding(7, 'db', 'lessons_review_backlog', 'improvement', 'medium', {
      lessonsNeedReview: data.learning.lessonsNeedReview,
    }, `Có ${data.learning.lessonsNeedReview} lesson cần review (needsReview=true) — backlog đang lớn. Cần review từng lesson, approve mục đúng (bỏ needsReview), reject mục sai (kèm ghi chú để auto-learn học luật).`, {
      metric: 'số LessonRecord needsReview=true',
      current: data.learning.lessonsNeedReview,
      target: 10,
      operator: 'lte',
    }))
  }

  // (e) KnowledgeGraph sync drift
  if (data.kgSync.unsyncedResolvedEntities > 50) {
    out.push(makeFinding(7, 'db', 'kg_unsynced', 'improvement', 'medium', {
      unsyncedResolvedEntities: data.kgSync.unsyncedResolvedEntities,
    }, `Có ${data.kgSync.unsyncedResolvedEntities} LocalResolvedEntity chưa sync sang Neo4j (synced=false) — sync đang kẹt. Cần kick sync (chạy cron sync hoặc POST /api/sync-neo4j) để catch up.`, {
      metric: 'số LocalResolvedEntity synced=false',
      current: data.kgSync.unsyncedResolvedEntities,
      target: 50,
      operator: 'lte',
    }))
  }
  // Buffer to graph ratio — chỉ trigger nếu có graph count thật (từ ⑤)
  const graphCount = threeLayersData?.neo4j.nodeCount ?? 0
  if (graphCount > 0 && data.kgSync.rawBufferSize > graphCount * 2) {
    out.push(makeFinding(7, 'db', 'kg_buffer_overload', 'improvement', 'medium', {
      rawBufferSize: data.kgSync.rawBufferSize,
      graphEntityCount: graphCount,
      ratio: Math.round((data.kgSync.rawBufferSize / graphCount) * 10) / 10,
    }, `Raw buffer SQLite (${data.kgSync.rawBufferSize} LocalEntity) >2× so với graph Neo4j (${graphCount} entity) — sync dedup đang kẹt hoặc không xử lý kịp. Cần (1) kiểm tra cron sync có chạy đều không, (2) cân nhắc tăng batch size sync.`, {
      metric: 'tỷ lệ raw buffer / graph entity',
      current: Math.round((data.kgSync.rawBufferSize / graphCount) * 10) / 10,
      target: 2,
      operator: 'lte',
    }))
  }

  // (f) Token anomaly
  if (data.tokenAnomaly.agentsWithSpike.length > 0) {
    out.push(makeFinding(7, 'db', 'token_spike', 'improvement', 'medium', {
      agentsWithSpike: data.tokenAnomaly.agentsWithSpike,
    }, `Token spike detected: ${data.tokenAnomaly.agentsWithSpike.map(a => `${a.agentName} (z=${a.zScore}, ${a.today} vs mean ${a.mean7d})`).join(', ')}. Cần điều tra (cost leak, loop không thoát, LLM lặp tool call, hoặc budget cạn) — nếu là loop, thêm guard max_cycles/max_tokens.`, {
      metric: 'số agent có token spike (z>3 so với mean 7d)',
      current: data.tokenAnomaly.agentsWithSpike.length,
      target: 0,
      operator: 'lte',
    }))
  }
  if (data.tokenAnomaly.agentsWithDrop.length > 0) {
    out.push(makeFinding(7, 'db', 'token_drop', 'improvement', 'medium', {
      agentsWithDrop: data.tokenAnomaly.agentsWithDrop,
    }, `Token drop detected: ${data.tokenAnomaly.agentsWithDrop.map(a => `${a.agentName} (${a.today} vs mean ${a.mean7d})`).join(', ')}. Cần điều tra (agent có thể bị disable, model fallback không hoạt động, hoặc API key hết quota).`, {
      metric: 'số agent có token drop (hôm nay <10% mean 7d)',
      current: data.tokenAnomaly.agentsWithDrop.length,
      target: 0,
      operator: 'lte',
    }))
  }

  // (g) DB size & storage
  const dbSizeMb = data.dbStorage.sqliteBytes / (1024 * 1024)
  if (dbSizeMb > 500) {
    out.push(makeFinding(7, 'db', 'db_size', 'long_term', 'low', {
      sqliteBytes: data.dbStorage.sqliteBytes,
      sqliteSizeMb: Math.round(dbSizeMb),
      largeTables: data.dbStorage.largeTables,
    }, `SQLite DB size ${Math.round(dbSizeMb)}MB — vượt 500MB. Cần kế hoạch archival/vacuum: archive AgentRunRecord/ToolMetric >30 ngày sang table archive, VACUUM để thu hồi không gian.`, {
      metric: 'SQLite file size (MB)',
      current: Math.round(dbSizeMb),
      target: 500,
      operator: 'lte',
    }))
  }
  if (data.dbStorage.largeTables.length > 0) {
    out.push(makeFinding(7, 'db', 'large_tables', 'long_term', 'low', {
      largeTables: data.dbStorage.largeTables,
      allCounts: data.dbStorage.tableRowCounts,
    }, `Có ${data.dbStorage.largeTables.length} bảng >100K rows: ${data.dbStorage.largeTables.map(t => `${t.table} (${t.rows.toLocaleString()})`).join(', ')}. Cần kế hoạch archival + index review để đảm bảo query perf.`, {
      metric: 'số bảng >100K rows',
      current: data.dbStorage.largeTables.length,
      target: 0,
      operator: 'lte',
    }))
  }

  // (h) Scheduler health — "ai canh những người canh" (v1.3)
  // CronJob enabled+active nhưng nextRunAt trễ >1h → scheduler của job đó chết/kẹt
  if (data.scheduler.cronJobs.stuck.length > 0) {
    out.push(makeFinding(7, 'db', 'cron_stuck', 'improvement', 'high', {
      stuck: data.scheduler.cronJobs.stuck,
      total: data.scheduler.cronJobs.total,
      enabled: data.scheduler.cronJobs.enabled,
    }, `Có ${data.scheduler.cronJobs.stuck.length} CronJob enabled nhưng trễ lịch quá 1h (nextRunAt đã qua mà chưa chạy) — scheduler của các job này có thể chết/kẹt: ${data.scheduler.cronJobs.stuck.slice(0, 3).map(j => `agent=${j.agentId} (${j.hoursLate}h trễ, lệnh: ${j.taskPrompt.slice(0, 60)})`).join('; ')}. Cần (1) kiểm tra worker/scheduler tương ứng còn sống không, (2) kick nextRunAt tự lành, (3) nếu scheduler chết → restart + thêm monitoring.`, {
      metric: 'số CronJob enabled nhưng nextRunAt trễ >1h',
      current: data.scheduler.cronJobs.stuck.length,
      target: 0,
      operator: 'lte',
    }))
  }
  if (data.scheduler.jobQueue.stuckRunning1h > 0) {
    out.push(makeFinding(7, 'db', 'queue_stuck', 'improvement', 'medium', {
      stuckRunning1h: data.scheduler.jobQueue.stuckRunning1h,
      running: data.scheduler.jobQueue.running,
    }, `JobQueue có ${data.scheduler.jobQueue.stuckRunning1h} job kẹt 'running' quá 1h — worker chết giữa job không ghi end. Cần (1) đánh dấu job fail + re-queue, (2) điều tra worker vì sao chết.`, {
      metric: 'số JobQueue kẹt running >1h',
      current: data.scheduler.jobQueue.stuckRunning1h,
      target: 0,
      operator: 'lte',
    }))
  }
  if (data.scheduler.jobQueue.pending > 50 && (data.scheduler.jobQueue.oldestPendingHours ?? 0) > 24) {
    out.push(makeFinding(7, 'db', 'queue_backlog', 'improvement', 'medium', {
      pending: data.scheduler.jobQueue.pending,
      oldestPendingHours: data.scheduler.jobQueue.oldestPendingHours,
    }, `JobQueue backlog ${data.scheduler.jobQueue.pending} job pending, job cũ nhất ${data.scheduler.jobQueue.oldestPendingHours}h — worker không xử lý kịp. Cần (1) kiểm tra worker queue còn sống, (2) tăng throughput/batch, (3) re-queue các job fail vì lý do cũ đã hết.`, {
      metric: 'số JobQueue pending',
      current: data.scheduler.jobQueue.pending,
      target: 50,
      operator: 'lte',
    }))
  }
  if (data.scheduler.jobQueue.failedIn24h > 10) {
    out.push(makeFinding(7, 'db', 'queue_failures', 'improvement', 'medium', {
      failedIn24h: data.scheduler.jobQueue.failedIn24h,
    }, `JobQueue có ${data.scheduler.jobQueue.failedIn24h} job fail trong 24h — pipeline document (parse/extract/embed/sync) đang lỗi hàng loạt. Cần điều tra lỗi phổ biến (input/output JSON lỗi, Qdrant/Neo4j đứt) + sửa root cause.`, {
      metric: 'số JobQueue fail trong 24h',
      current: data.scheduler.jobQueue.failedIn24h,
      target: 10,
      operator: 'lte',
    }))
  }

  // (i) Backup freshness — P3-c (task 31-f): "alert qua ALISTA nếu 2 ngày liên
  // tiếp không có backup thành công". Chỉ alert khi ĐO ĐƯỢC (available=true;
  // R2 disconnected đã có rule layer:r2 riêng — không double-alert) và tuổi
  // artifact vượt ngưỡng: SQLite hằng ngày > 48h → high; snapshot Qdrant/Neo4j
  // hằng tuần > 192h (7 ngày + 1 ngày grace) → medium.
  if (data.backupFreshness.r2Configured) {
    const s = data.backupFreshness.sqlite
    if (s.available && (s.ageHours == null || s.ageHours > SQLITE_BACKUP_MAX_AGE_HOURS)) {
      const staleDesc = s.ageHours == null
        ? 'KHÔNG có artifact .db nào trong backups/sqlite/'
        : `artifact mới nhất ${Math.round(s.ageHours)}h tuổi (> ngưỡng ${SQLITE_BACKUP_MAX_AGE_HOURS}h)`
      out.push(makeFinding(7, 'db', 'backup_stale_sqlite', 'improvement', 'high', {
        ageHours: s.ageHours,
        maxAgeHours: SQLITE_BACKUP_MAX_AGE_HOURS,
        newestKey: s.newestKey,
        newestAt: s.newestAt,
        totalArtifacts: s.totalArtifacts,
      }, `Backup SQLite hằng ngày (P3-c, cron 03:00 VN executor DB-BACKUP) đang thất bại: ${staleDesc}${s.newestAt ? ` (lần cuối ${s.newestAt})` : ''}. Kịch bản mất dữ liệu: sandbox reset mà không có backup gần đây ≈ mất toàn bộ trạng thái document/agent. Cần (1) mở UI Automation check CronJob executor='DB-BACKUP' còn active + xem lastError, (2) chạy tay POST /api/storage/db-backup rồi xem response verify, (3) kiểm tra R2 endpoint/credentials nếu upload fail.`, {
        metric: 'tuổi artifact backup SQLite mới nhất trên R2 (giờ)',
        current: s.ageHours == null ? 'no_artifact' : Math.round(s.ageHours),
        target: SQLITE_BACKUP_MAX_AGE_HOURS,
        operator: 'lte',
      }))
    }

    const weeklyStores: Array<{ key: 'qdrant' | 'neo4j'; label: string; f: typeof s }> = [
      { key: 'qdrant', label: 'Qdrant snapshot', f: data.backupFreshness.qdrant },
      { key: 'neo4j', label: 'Neo4j cypher dump', f: data.backupFreshness.neo4j },
    ]
    for (const w of weeklyStores) {
      if (w.f.available && (w.f.ageHours == null || w.f.ageHours > WEEKLY_SNAPSHOT_MAX_AGE_HOURS)) {
        const staleDesc = w.f.ageHours == null
          ? 'KHÔNG có artifact nào'
          : `artifact mới nhất ${Math.round(w.f.ageHours)}h tuổi (> ngưỡng ${WEEKLY_SNAPSHOT_MAX_AGE_HOURS}h = 7 ngày + 1 ngày grace)`
        out.push(makeFinding(7, 'db', `backup_stale_${w.key}`, 'improvement', 'medium', {
          ageHours: w.f.ageHours,
          maxAgeHours: WEEKLY_SNAPSHOT_MAX_AGE_HOURS,
          newestKey: w.f.newestKey,
          newestAt: w.f.newestAt,
          totalArtifacts: w.f.totalArtifacts,
        }, `${w.label} hằng tuần (seed-weekly-backup-cron, Thứ 7 03:00) đang thất bại: ${staleDesc}${w.f.newestAt ? ` (lần cuối ${w.f.newestAt})` : ''}. Cần (1) chạy tay POST /api/storage/snapshot-full?store=all, (2) check CronJob weekly-backup còn active, (3) verify bucket R2 còn ghi được.`, {
          metric: `tuổi artifact ${w.label} mới nhất trên R2 (giờ)`,
          current: w.f.ageHours == null ? 'no_artifact' : Math.round(w.f.ageHours),
          target: WEEKLY_SNAPSHOT_MAX_AGE_HOURS,
          operator: 'lte',
        }))
      }
    }
  }

  // Cap ≤2 sub-proposal từ ⑦ (tránh spam) — nhưng để LLM tách được, trả tối đa
  // 5 (sẽ bị cap chung ở proposals.ts — v1.3: 4 → 5 vì thêm sub-check h)
  return topByPriority(out, 5)
}

// ==================== MAIN: ĐÁNH GIÁ RULES CHO 1 CHECK ====================

/** Đánh giá rules cho 1 check dựa trên collected data — trả Finding[] */
export function evaluateRules(
  checkId: CheckId,
  collected: unknown,
  threeLayersData?: ThreeLayersData,
): Finding[] {
  switch (checkId) {
    case 1: return rulesForTools(collected as ToolsHealthData)
    case 2: return rulesForAgentRuns(collected as AgentRunsData)
    case 3: return rulesForEscalations(collected as EscalationsData)
    case 4: return rulesForDomainCoverage(collected as DomainCoverageData)
    case 5: return rulesFor3Layers(collected as ThreeLayersData)
    case 6: return rulesForSelfAssessment(collected as SelfAssessmentData)
    case 7: return rulesForDatabaseSystem(collected as DatabaseSystemData, threeLayersData)
    default: return []
  }
}

/** Helper type-guard cho StepEntry — không dùng nhưng giữ cho eslint import clean */
export function _unusedStepEntry(): StepEntry | null { return null }
