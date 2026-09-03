'use client'

// ========================================================================
// app-shared — Shared symbols giữa page.tsx và các lazy chunks
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React from 'react'


// ==================== TYPES ====================

export interface HealthResponse {
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


export interface QdrantHealth { connected: boolean; version?: string; error?: string; documentsCollection?: { exists: boolean; pointCount?: number }; chunksCollection?: { exists: boolean; pointCount?: number; vectorCount?: number } }

export interface Neo4jHealth { connected: boolean; nodeCount: number; relationshipCount: number; labels: string[]; error?: string }

export interface SqliteHealth { connected: boolean; error?: string; tableCount?: number }

export interface R2Health { configured: boolean; connected: boolean; bucket?: string; objectCount?: number; error?: string }

export interface SupabaseHealth { configured: boolean; connected: boolean; tableCount?: number; error?: string }

export interface LLMHealthItem { available: boolean; model: string; error?: string; geoBlocked?: boolean }

export interface ProviderDiagnostic {
  keyCount: number; availableCount: number; totalTokensUsed: number; totalDailyTokensUsed: number; totalDailyRequests: number; dailyTokenLimit: number; dailyQuotaExhaustedCount: number
  keys: Array<{ index: number; available: boolean; rateLimited: boolean; exhausted: boolean; dailyQuotaExhausted: boolean; dailyQuotaResetAt: number; failureCount: number; totalTokensUsed: number; dailyTokensUsed: number; dailyRequestCount: number; dailyRequestDate: string }>
}

export interface DailyQuotaInfo {
  totalKeys: number; availableKeys: number; dailyQuotaExhaustedKeys: number
  dailyTokensUsed: number; dailyTokenLimit: number
  dailyRequestsUsed: number; dailyRequestLimit: number
  keys: Array<{ index: number; dailyQuotaExhausted: boolean; dailyQuotaResetAt: number; dailyTokensUsed: number; dailyRequestCount: number; minutesUntilReset: number }>
}


export interface ProcessingStep {
  name: string; label: string; status: 'pending' | 'running' | 'completed' | 'error'
  startedAt: string | null; completedAt: string | null; detail: string | null
}


export interface ChunkCoverage {
  total: number; extracted: number; missing: number; entityCount?: number; relationshipCount?: number
}


export interface DocumentRecord {
  id: string; title: string; file_path: string; domain: string
  page_count: number | null; status: string; error_message: string | null
  processing_steps: ProcessingStep[]; processing_percent: number
  created_at: string; updated_at: string
  chunk_coverage?: ChunkCoverage
}


export interface EmbeddingStatus {
  total: number; real: number; pseudo: number; realRatio: number; dimension?: number
}

export const DOMAIN_LABELS: Record<string, string> = {
  programming: 'Lập trình', algorithm: 'Thuật toán', ml: 'Machine Learning',
  meta_cognitive: 'Siêu nhận thức', linux: 'Linux', security: 'Bảo mật', ux_ui: 'Thiết kế UX/UI', mixed: 'Tổng hợp',
}


export interface DBStats {
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


// ==================== TOKEN SSE REALTIME CONTEXT ====================

/** Context for sharing real-time token data across components.
 *  Uses Server-Sent Events (SSE) instead of polling — single connection,
 *  instant updates (< 500ms), zero wasted requests when idle. */
export const TokenStreamContext = React.createContext<TokenUsageData | null>(null)


/** Hook for components to access real-time token data from SSE stream. */
export function useTokenStream(): TokenUsageData | null {
  return React.useContext(TokenStreamContext)
}


// ==================== STATS OVERVIEW ====================

/** Format token count: e.g., 1234 → "1.2K", 1500000 → "1.5M" */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}


// ==================== TOKEN USAGE SECTION ====================

export interface TokenUsageData {
  date: string
  tokens: number
  providers: Record<string, number>
  slots: Record<string, Record<number, number>> // provider → { keyIndex → tokens }
  models: Record<string, Record<string, number>> // provider → { modelName → tokens }
}

