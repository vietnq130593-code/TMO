-- CreateTable
CREATE TABLE "BrainModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brain" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "inputMode" TEXT NOT NULL,
    "specJson" TEXT NOT NULL,
    "weightsJson" TEXT NOT NULL,
    "trainMetaJson" TEXT NOT NULL,
    "trainedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BrainModel_brain_active_idx" ON "BrainModel"("brain", "active");

-- CreateIndex
CREATE UNIQUE INDEX "BrainModel_brain_version_key" ON "BrainModel"("brain", "version");
