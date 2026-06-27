import { existsSync, readFileSync } from "fs";
import path from "path";
import { syncProductionListBookings } from "../lib/production-sync.ts";

type CliOptions = {
  date?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  help?: boolean;
};

loadLocalEnv();

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const result = await syncProductionListBookings({
    date: options.date,
    start_date: options.start_date,
    end_date: options.end_date,
    limit: options.limit,
    type: "manual",
    mirrorToMongo: false,
    logProgress: true,
    saveSamples: true,
  });

  console.log("Daily split sync completed");
  console.log(`total_received=${result.total_received}`);
  console.log(`inserted=${result.inserted}`);
  console.log(`updated=${result.updated}`);
  console.log(`duplicate=${result.duplicate}`);
  console.log(`error=${result.error}`);
  console.log(`total_days_synced=${result.total_days_synced}`);
  console.log(`warning_days=${result.warning_days}`);

  if (result.error > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();

    if (key === "page" || key === "offset") {
      throw new Error("page and offset are not supported for production sync.");
    }

    if (!["date", "start_date", "end_date", "limit"].includes(key)) {
      throw new Error(`Unsupported option: --${key}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (!inlineValue) index += 1;

    if (key === "limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer.");
      }
      options.limit = limit;
      continue;
    }

    options[key as "date" | "start_date" | "end_date"] = value;
  }

  return options;
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

function printUsage() {
  console.log("Usage:");
  console.log("npm run sync:prod -- --start_date=2026-05-01 --end_date=2026-05-31 --limit=100");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Production sync failed");
  process.exit(1);
});
