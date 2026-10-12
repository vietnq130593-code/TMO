-- BRAIN-UX §9.7 (blueprint §9 — user chốt 2026-10-12): bảng nháp kiến trúc
-- brain cho editor UX-1/UX-2. Additive — model thứ 100 (99 → 100).
-- Draft ≠ runtime (§9.1-1): KHÔNG đụng BrainModel.

-- CreateTable
CREATE TABLE "BrainSpecDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brain" TEXT NOT NULL,
    "specJson" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BrainSpecDraft_brain_key" ON "BrainSpecDraft"("brain");
