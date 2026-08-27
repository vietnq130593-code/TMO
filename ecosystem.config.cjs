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
      script: 'node_modules/next/dist/bin/next',
      args: 'dev -p 3000',
      cwd: '/home/z/tmo-app',
      env: {
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        PORT: '3000',
        // Explicit absolute DB path so the app always uses the TMO SQLite
        // database (separate from the sandbox's own project DB), regardless
        // of the shell environment that launched PM2.
        DATABASE_URL: 'file:/home/z/tmo-app/db/custom.db',
      },
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      // Memory guard: dev-mode Next.js (Turbopack + 18k-line page.tsx + SQLite
      // + embedding pipelines) grows past 1GB RSS on this 4.1GB box and the
      // kernel OOM-killer SIGKILLs it (verified in dmesg — restarts with no
      // log trace, in-flight background agent tasks die). PM2 restarts
      // CLEANLY at 1GB instead: SQLite is durable (WAL), agent-run tracker
      // re-enqueues on boot (instrumentation crash recovery), mini-services
      // are orphan-killed + respawned by service-manager.
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
