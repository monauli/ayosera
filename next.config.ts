import type { NextConfig } from "next";

// Header statis (tidak butuh nonce per-request) — berlaku untuk semua route
// termasuk /api, aman di dev maupun production. Content-Security-Policy
// SENGAJA tidak di sini karena butuh nonce per-request untuk skrip bootstrap
// tema inline (app/layout.tsx) — lihat middleware.ts.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Semua fitur browser sensitif dimatikan — dashboard internal ini tidak
  // memakai kamera/mikrofon/lokasi/dll.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
