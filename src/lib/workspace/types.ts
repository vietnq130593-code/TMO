// ============================================
// Workspace Types — Phase 1: Code Agent Execution Infrastructure
// ============================================

/** Workspace — thư mục làm việc được quản lý cho code agent */
export interface Workspace {
  id: string;
  name: string;
  rootPath: string; // Đường dẫn tuyệt đối, đã validate tồn tại
  isActive: boolean; // Chỉ một workspace active tại một thời điểm
  createdAt: Date;
  updatedAt: Date;
}

/** Trạng thái của một PendingEdit */
export type PendingEditStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "failed";

/** PendingEdit — file edit đang chờ approve/reject */
export interface PendingEdit {
  id: string;
  sessionId: string; // CodeTeamSession.sessionId hoặc AgentSession.sessionId
  filePath: string; // Relative path với workspace root
  oldContent: string; // Snapshot trước edit ("" nếu file mới)
  newContent: string; // Nội dung đề xuất
  diff: string; // Unified diff string (hiển thị UI)
  status: PendingEditStatus;
  agentName: string; // Agent đề xuất (RAMPAGE / SENTINEL / CATALYST / ...)
  createdAt: Date;
  resolvedAt?: Date | null;
}

/** Kết quả tạo workspace */
export interface CreateWorkspaceInput {
  name: string;
  rootPath: string;
}

/** Kết quả approve/reject pending edit */
export interface ResolvePendingEditInput {
  action: "approve" | "reject";
}

/** Thông tin checkout — commit hash + branch */
export interface FsCheckpointInfo {
  id: string;
  sessionId: string;
  workspaceId: string;
  commitHash: string;
  label: string;
  createdAt: Date;
}