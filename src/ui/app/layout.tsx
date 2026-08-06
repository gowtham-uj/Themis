import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "agenteval",
  description: "General agent evaluation platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-800 bg-slate-900/80">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
            <a href="/projects" className="text-lg font-semibold text-white">
              agenteval
            </a>
            <nav className="flex gap-3 text-sm text-slate-400">
              <a href="/projects">Projects</a>
              <a href="/settings">Settings</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
