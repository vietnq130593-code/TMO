import type { Metadata } from "next";
import { Geist, Geist_Mono, Cormorant_Infant } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ChunkErrorRecovery } from "@/components/chunk-error-recovery";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cormorantInfant = Cormorant_Infant({
  variable: "--font-cormorant-infant",
  subsets: ["latin", "vietnamese"],
  weight: ["600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "THE MAGNUM OPUS",
  description: "Hệ thống Knowledge Base sử dụng GraphRAG - Kết hợp Qdrant Vector Database, Neo4j Graph Database và LLM APIs để trích xuất, lập luận và truy vấn tri thức.",
  keywords: ["GraphRAG", "Knowledge Base", "Neo4j", "Qdrant", "LLM", "Vector Database", "Graph Database", "NLP", "AI"],
  authors: [{ name: "Magnum Opus Team" }],
  icons: {
    icon: "/favicon.ico",
  },
  openGraph: {
    title: "THE MAGNUM OPUS",
    description: "Hệ thống Knowledge Base sử dụng GraphRAG với Qdrant, Neo4j và LLM APIs",
    siteName: "THE MAGNUM OPUS",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "THE MAGNUM OPUS",
    description: "Hệ thống Knowledge Base sử dụng GraphRAG với Qdrant, Neo4j và LLM APIs",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cormorantInfant.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          {/* [chunk-retry] L2 — lưới an toàn toàn cục cho ChunkLoadError (trace 1a0f3586be589739) */}
          <ChunkErrorRecovery />
          <Toaster />
          <SonnerToaster position="bottom-right" richColors closeButton duration={5000} />
        </ThemeProvider>
      </body>
    </html>
  );
}
