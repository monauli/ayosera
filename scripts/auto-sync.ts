import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * Worker auto-sync lokal.
 *
 * Memanggil endpoint cron (/api/cron/sync) pada dev server yang sedang jalan,
 * sekali saat start lalu berulang setiap 1 jam. Endpoint itu menjalankan kode
 * sinkronisasi yang sama persis dengan Vercel Cron di production.
 *
 * Prasyarat: dev server harus hidup (npm run dev).
 *
 * Jalankan: npm run sync:auto
 * Target lain: SYNC_TARGET_URL=http://localhost:3001 npm run sync:auto
 * Interval lain: SYNC_INTERVAL_MINUTES=30 npm run sync:auto
 */
loadLocalEnv();

const baseUrl = (process.env.SYNC_TARGET_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/$/, "");
const endpoint = `${baseUrl}/api/cron/sync`;
const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES) || 60;
const intervalMs = intervalMinutes * 60 * 1000;
const cronSecret = process.env.CRON_SECRET;
let running = false;

async function runSync() {
  if (running) {
    console.log(`[auto-sync] ${timestamp()} lewati — sync sebelumnya masih berjalan`);
    return;
  }

  running = true;
  try {
    const response = await fetch(endpoint, {
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : undefined,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      total_received?: number;
      inserted?: number;
      duplicate?: number;
      error?: string;
    };

    if (!response.ok) {
      console.error(`[auto-sync] ${timestamp()} GAGAL — HTTP ${response.status}: ${payload.error || "unknown"}`);
      return;
    }

    console.log(
      `[auto-sync] ${timestamp()} selesai — diterima ${payload.total_received ?? 0}; ` +
        `ditambahkan ${payload.inserted ?? 0}; duplikat ${payload.duplicate ?? 0}`,
    );
  } catch (error) {
    console.error(
      `[auto-sync] ${timestamp()} GAGAL menghubungi ${endpoint} —`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    running = false;
  }
}

function timestamp() {
  return new Date().toISOString();
}

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), fileName);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

console.log(`[auto-sync] mulai — target ${endpoint}, sync setiap ${intervalMinutes} menit. Tekan Ctrl+C untuk berhenti.`);
void runSync();
setInterval(() => {
  void runSync();
}, intervalMs);
