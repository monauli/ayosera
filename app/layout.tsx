import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "AYO Transaction Dashboard",
  description: "Real-time transaction monitoring dashboard for AYO integrations",
};

// Font loader resmi Next.js (next/font/google) — di-self-host otomatis saat
// build, tanpa @import CDN dan tanpa file font manual. Fallback sistem tetap
// dipakai sebagai jaring pengaman.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

// Skrip inline ini SENGAJA berjalan sebelum hydration (blocking, di <head>)
// supaya atribut data-mode sudah benar pada paint pertama — mencegah flash
// tema (light→dark atau sebaliknya) dan hydration warning akibat mismatch
// server/klien. Prioritas: localStorage tersimpan > prefers-color-scheme
// sistem > default terang.
const THEME_MODE_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem("ayo-mode");
    var mode = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-mode", mode);
  } catch (error) {
    document.documentElement.setAttribute("data-mode", "light");
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="white" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_MODE_BOOTSTRAP }} />
      </head>
      <body className={`${geistSans.variable} font-sans`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
