/**
 * Barrel src/lib/stats — re-export TOÀN BỘ public API của 6 module P0-1.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 + mục 3 (manifest bước 1).
 * 21 hạng mục P1-P6 đều import từ đây (hoặc từ module con trực tiếp).
 *
 * Không re-export brierScore/ece từ calibration-metrics (tránh vòng import —
 * hai thư viện độc lập theo spec). Không side-effect.
 */

export * from "./descriptive";
export * from "./classification";
export * from "./ranking";
export * from "./text";
export * from "./cluster-quality";
export * from "./inference";
