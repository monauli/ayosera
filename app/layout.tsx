import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AYO Transaction Dashboard",
  description: "Real-time transaction monitoring dashboard for AYO integrations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="white">
      <body>{children}</body>
    </html>
  );
}
