// PM2 ecosystem config for Theopusflashlite (TMO — Multi-Agent AI Platform)
//
// PM2 keeps the Next.js UI (the app's interface) alive and auto-restarts it
// if it ever crashes. The 3 supporting mini-services (openclaw-gateway,
// opencode-server, gateway-bridge) are spawned and supervised by the app's
// own internal `service-manager.ts`, so we intentionally do NOT also manage
// them here (that would double-spawn and fight over ports 18789/18790/18791).
//
// Qdrant (vector DB) binary is installed at /home/z/qdrant/qdrant (v1.13.0).
// It is needed by the Knowledge Base module (Database > Tài liệu) — without it
// document ingestion/embeddings cannot run. Managed here so it auto-starts
// alongside the UI. Storage in /home/z/tmo-app/qdrant-storage.
//
// Neo4j (AuraDB cloud) is NOT managed here — it is a managed cloud service.
// Once AuraDB credentials are configured in .env, the app connects automatically.
//
// Usage:
//   pm2 start ecosystem.config.cjs        # launch Qdrant + UI together
//   pm2 status                            # see running processes
//   pm2 logs theopusflashlite             # tail the UI logs
//   pm2 restart theopusflashlite         # restart the UI
//   pm2 delete all                        # stop everything
//   pm2 save                              # persist process list
//
// The main app's stdout+stderr are written to /home/z/my-project/dev.log
// (appended via merge_logs, never truncated on restart) so the sandbox
// monitoring pipeline keeps working exactly as before.
//
// NOTE: Qdrant v1.13.2 binary is installed at /home/z/qdrant/qdrant. Managed
// here so it auto-starts alongside the UI and stays alive. Storage in
// /home/z/tmo-app/qdrant-storage.
module.exports = {
  apps: [
    {
      name: 'theopusflashlite',
      // Run the Next.js CLI directly (instead of `bun run dev`) so PM2 owns the
      // actual Next.js process and its `next-server` child. With `bun run dev`
      // there is an extra bun wrapper layer; a SIGKILL of the bun parent can
      // orphan the next-server grandchild which then holds port 3000 and causes
      // EADDRINUSE crash-loops on PM2 restart. Running next directly lets PM2
      // kill the whole process tree cleanly on restart/stop.
      // Wrapper script: trước khi start, tự dọn process mồ côi đang giữ
      // port 3000 (tình huống SIGKILL/OOM để lại orphan next-server gây
      // EADDRINUSE crash-loop). Wrapper exec sang `node next dev` nên PM2
      // vẫn sở hữu trực tiếp process Next.js như thiết kế ban đầu.
      script: 'scripts/pm2-start.sh',
      cwd: '/home/z/tmo-app',
      env: {
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        PORT: '3000',
        // Explicit absolute DB path so the app always uses the TMO SQLite
        // database (separate from the sandbox's own project DB), regardless
        // of the shell environment that launched PM2.
        DATABASE_URL: 'file:/home/z/tmo-app/db/custom.db',
        // Memory bound (2026-09-28 quan sát vận hành thật — 2 lần kernel OOM
        // giết next-server giữa chừng ở RSS 2.46GB (23:08) và 1.44GB (23:23),
        // memcg 4GB cạn tổng thể): PM2 max_memory_restart không bắt được vì
        // nó đo pid wrapper chứ không phải child next-server. Giới hạn V8
        // heap 1024MB để GC chủ động sớm + RSS ổn định ~1.3-1.6GB. Cặp với
        // in-app MemWatchdog (instrumentation — RSS >1.7GB 2 phút liên tiếp
        // → self-exit sạch, PM2 kéo dậy trong ~5s) + durable goal loop
        // (ENABLE_DURABLE_GOAL_LOOP=true — job RESUME từ checkpoint sau
        // restart → nhiệm vụ không mất).
        NODE_OPTIONS: '--max-old-space-size=1024',
      },
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      // Memory guard: max_memory_restart đo pid wrapper (pm2-start.sh exec →
      // node next dev) — RSS wrapper luôn thấp nên KHÔNG bao giờ tự kích hoạt
      // cho heap của child next-server (đã kiểm chứng 2026-09-28: OOM-kill ở
      // 2.46GB mà PM2 không kịp phát hiện). Vệ sinh thực sự nằm ở
      // NODE_OPTIONS heap cap phía trên + durable goal loop (job RESUME từ
      // checkpoint sau restart). Giữ 1G làm lưới an toàn cấp wrapper.
      max_memory_restart: '1G',
      // Route both stdout + stderr into the single monitored dev.log,
      // appending (merge_logs) on every restart so history is preserved.
      out_file: '/home/z/my-project/dev.log',
      error_file: '/home/z/my-project/dev.log',
      merge_logs: true,
      log_date_format: '',
      time: false,
      kill_timeout: 8000,
    },
    {
      // Qdrant vector database — stores document chunks + embeddings.
      // Port: 6333 (REST) + 6334 (gRPC). Storage in /home/z/tmo-app/qdrant-storage.
      name: 'qdrant',
      script: '/home/z/qdrant/qdrant',
      args: '--config-path /home/z/tmo-app/qdrant-config.yaml',
      cwd: '/home/z/tmo-app',
      env: {
        RUST_LOG: 'info',
      },
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      out_file: '/home/z/my-project/.zscripts/qdrant.log',
      error_file: '/home/z/my-project/.zscripts/qdrant.log',
      merge_logs: true,
      kill_timeout: 5000,
    },
  ],
};
