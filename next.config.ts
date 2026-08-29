import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // Post-deploy audit fix (2026-08-25): Next 16 blocks cross-origin requests to
  // dev resources (/_next/*, /_next/hmr) unless the Origin host is allow-listed.
  // Default allowlist only covers localhost/**.localhost — NOT 127.0.0.1 (direct
  // IP / gateway access) and NOT the sandbox preview domain (*.space-z.ai).
  // Symptom of the missing config: the HMR WebSocket gets 403'd by the server,
  // the Flight debug channel never completes, and React hydration silently
  // stalls forever — the page renders (SSR) but is completely non-interactive.
  allowedDevOrigins: ["127.0.0.1", "*.space-z.ai"],

  // Packages that need to run outside the bundler (native modules)
  serverExternalPackages: ["neo4j-driver", "pdf-parse"],

  // PREVIEW SAME-ORIGIN PROXY (fix 2026-09-10): iframe Preview trỏ tới
  // /api/opencode/preview/proxy/<port>/ (CÓ trailing slash — để relative URL
  // trong HTML của app được preview resolve đúng). Next mặc định 308-redirect
  // URL có trailing slash → redirect đó phá resolve relative URL của trang
  // được proxy + phát sinh round-trip. Tắt redirect — TMO là SPA 1 trang,
  // không route nào phụ thuộc hành vi mặc định này.
  skipTrailingSlashRedirect: true,

  // Allow large file uploads through the dev server proxy.
  // Default is 10MB which causes 400 errors when uploading large PDFs.
  // Individual file limit: 100MB. Frontend uploads files ONE AT A TIME.
  experimental: {
    proxyClientMaxBodySize: '100mb',
  },
};

export default nextConfig;
