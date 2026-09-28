import type { Metadata } from "next";

import { Sidebar } from "@/components/shell";
import "./globals.css";
import "./leadgen.css";

export const metadata: Metadata = {
  title: "Lead Gen Engine",
  description: "Reads the lead sheet, finds and verifies emails, and pushes each lane to its Instantly campaign.",
};

// Every screen shows live state, so nothing here is cached.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Loaded by link rather than next/font so a build never depends on reaching Google.
            The stack falls back to the system sans if it fails. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Sidebar />
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
