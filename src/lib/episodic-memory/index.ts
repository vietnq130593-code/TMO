/**
 * EPISODIC MEMORY — barrel export (A6)
 *
 * 3 phần gắn kết (file upload A6.rtf):
 *   A. Episodic Memory Schema cho Neo4j — types.ts (node shapes) +
 *      episodic-neo4j.ts (graph) + episode-store.ts (Qdrant index) +
 *      episodic-db.ts (SQLite mirror) + recorder.ts (pipeline A.5)
 *   B. Error Taxonomy — taxonomy.ts (6 root causes R1-R6 + manifestations
 *      + playbook B.2 + quy trình phân loại B.3)
 *   C. Learning Loop — preact.ts (nhịp 1 PRE-ACT) + lessons.ts (nhịp 3
 *      EVALUATE + nhịp 4 CONSOLIDATE) — wiring vào agent-goal-loop.ts
 */

export * from './types'
export {
  MANIFESTATIONS,
  ROOT_CAUSE_PLAYBOOKS,
  getPlaybook,
  classifyRootCause,
  buildLessonStatement,
  listTaxonomy,
} from './taxonomy'
export type { ClassifyInput, ClassificationResult } from './taxonomy'
export {
  ensureEpisodicSchema,
  writeEpisodeGraph,
  linkEpisodeToKB,
  linkEpisodeYieldedLessons,
  upsertLessonNode,
  getLessonsForContext,
  findSimilarResolvedErrors,
  linkErrorTaughtLesson,
  linkSamePatternErrors,
  decayEpisodes,
  getErrorDashboard,
  getEscalationCandidates,
  getRecentEpisodes,
  getAllLessonNodes,
  getEpisodicGraphCounts,
  getEpisodeDetail,
  touchEpisode,
  lessonExists,
  getEpisodeInsights,
  extractContextEntities,
} from './episodic-neo4j'
export type { ErrorDashboardRow, EpisodeInsight, PreActSimilarError } from './episodic-neo4j'
export {
  ensureEpisodeCollection,
  upsertEpisodeEmbedding,
  searchSimilarEpisodes,
  getEpisodePointCount,
} from './episode-store'
export type { EpisodePointPayload, EpisodeSearchHit } from './episode-store'
export {
  upsertEpisodeRecord,
  countEpisodeRecords,
  findRecentEpisodeRecords,
  upsertLessonRecord,
  findLessonsByStatementFragment,
  findAllLessonRecords,
  findLessonRecordById,
  countLessonRecords,
  setLessonNeedsReview,
} from './episodic-db'
export type { EpisodeRecordRow, LessonRecordRow } from './episodic-db'
export {
  consolidateLesson,
  validateAppliedLessons,
  teachLesson,
  formatEscalationProposal,
} from './lessons'
export type { ConsolidateLessonInput, ConsolidateLessonResult, ValidateLessonsResult } from './lessons'
export { mapOutcome, recordEpisodeFromRun } from './recorder'
export { buildPreActContext } from './preact'
