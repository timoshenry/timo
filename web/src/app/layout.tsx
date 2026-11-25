import type { Metadata } from "next";
import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { GitHubIcon } from "@/components/Icons";
import { repoUrl } from "@/lib/env";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-inter-tight", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "TIMO — Ticket & Invoice Management Onchain", template: "%s · TIMO" },
  description: "Event tickets paid in tUSD8 on QDay Aevum testnet, with escrow-held funds and automatic refunds on cancellation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${jetbrains.variable}`}>
      <body>
        <Providers>
          <Header />
          {children}
          <footer className="site-footer">
            <div className="shell site-footer-inner">
              <span className="site-footer-brand">TIMO — Ticket &amp; Invoice Management Onchain · Aevum testnet</span>
              <span className="site-footer-note">
                Testnet demo — all events, names and funds on this site are fictional test content. No real tickets are
                sold, and test tokens have no value.
              </span>
              <nav className="site-footer-links" aria-label="Footer">
                <a href={repoUrl} target="_blank" rel="noreferrer" title="Source code on GitHub">
                  <GitHubIcon />
                  <span>GitHub</span>
                </a>
                <Link href="/docs">Docs</Link>
                <a href="https://t.me/Nyollo1" target="_blank" rel="noreferrer">
                  Telegram
                </a>
              </nav>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
