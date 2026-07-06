import { existsSync, readFileSync } from "fs";
import path from "path";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  [key: string]: unknown;
};

type EndpointSpec = {
  name: string;
  candidates: string[];
  params: Record<string, string>;
};

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";

loadLocalEnv();

async function main() {
  const appId = process.env.OLSERA_APP_ID;
  const secretKey = process.env.OLSERA_SECRET_KEY;

  if (!appId || !secretKey) {
    console.error("Missing OLSERA_APP_ID / OLSERA_SECRET_KEY in .env.local.");
    process.exit(1);
  }

  const accessToken = await authenticate(appId, secretKey);

  const today = wibDateString(0);
  const sevenDaysAgo = wibDateString(-7);

  const endpoints: EndpointSpec[] = [
    {
      name: "Close Order (default)",
      candidates: [`${API_PREFIX}/order/closeorder`],
      params: { per_page: "3" },
    },
    {
      name: `Close Order (7 hari terakhir: ${sevenDaysAgo} s/d ${today})`,
      candidates: [`${API_PREFIX}/order/closeorder`],
      params: { per_page: "3", start_date: sevenDaysAgo, end_date: today },
    },
    {
      name: "Open Order",
      candidates: [`${API_PREFIX}/order/openorder`],
      params: { per_page: "3" },
    },
    {
      name: "Cancelled Order",
      candidates: [
        `${API_PREFIX}/order/cancelledorder`,
        `${API_PREFIX}/order/cancelorder`,
        `${API_PREFIX}/order/cancelledorders`,
        `${API_PREFIX}/order/cancel`,
      ],
      params: { per_page: "3" },
    },
    {
      name: "Payment - List",
      candidates: [
        `${API_PREFIX}/payment`,
        `${API_PREFIX}/paymentmode`,
        `${API_PREFIX}/payment-method`,
        `${API_PREFIX}/payments`,
      ],
      params: { per_page: "3" },
    },
    {
      name: "Store - List",
      candidates: [`${API_PREFIX}/store`],
      params: {},
    },
    {
      name: "Product",
      candidates: [`${API_PREFIX}/product`],
      params: { per_page: "3" },
    },
  ];

  for (const endpoint of endpoints) {
    await exploreEndpoint(endpoint, accessToken);
    await sleep(400);
  }

  await exploreSalesItemsPerGroup(accessToken);
}

async function exploreSalesItemsPerGroup(accessToken: string) {
  const to = wibDateString(0);
  const from = `${to.slice(0, 8)}01`; // tanggal 1 bulan berjalan (WIB)

  console.log(`\n=== Report: Sales Items Per Group (${from} s/d ${to}) ===`);

  const url = new URL(`${BASE_URL}/api/open-api/v1/en/report/salesitemspergroup`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    console.log(`Request error: ${(error as Error).message}`);
    return;
  }

  const rawBody = await response.text();
  console.log(`HTTP      : ${response.status}`);

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.log("Body bukan JSON valid, raw response:");
    console.log(rawBody);
    return;
  }

  console.log("Response JSON lengkap:");
  console.log(JSON.stringify(body, null, 2));

  if (Array.isArray(body)) {
    console.log(`Jumlah total item dalam array: ${body.length}`);
  } else if (body && typeof body === "object") {
    const data = (body as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      console.log(`Jumlah total item dalam array data: ${data.length}`);
    }
  }
}

async function authenticate(appId: string, secretKey: string): Promise<string> {
  const form = new FormData();
  form.append("app_id", appId);
  form.append("secret_key", secretKey);
  form.append("grant_type", "secret_key");

  const response = await fetch(`${BASE_URL}${API_PREFIX}/token`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });

  const rawBody = await response.text();

  if (!response.ok) {
    console.error(`Auth failed: HTTP ${response.status}`);
    console.error(rawBody);
    process.exit(1);
  }

  let body: TokenResponse;
  try {
    body = JSON.parse(rawBody) as TokenResponse;
  } catch {
    console.error("Auth response was not valid JSON:");
    console.error(rawBody);
    process.exit(1);
  }

  if (!body.access_token) {
    console.error("Auth response did not contain access_token:");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log("Authenticated. Token type:", body.token_type ?? "(unknown)", "expires_in:", body.expires_in ?? "(unknown)");
  return body.access_token;
}

async function exploreEndpoint(endpoint: EndpointSpec, accessToken: string) {
  console.log("\n=== " + endpoint.name + " ===");

  for (const candidatePath of endpoint.candidates) {
    const url = new URL(BASE_URL + candidatePath);
    for (const [key, value] of Object.entries(endpoint.params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      console.log(`  [try] ${candidatePath} -> request error: ${(error as Error).message}`);
      continue;
    }

    const rawBody = await response.text();

    if (response.status === 404 && candidatePath !== endpoint.candidates.at(-1)) {
      console.log(`  [try] ${candidatePath} -> 404, mencoba path lain...`);
      continue;
    }

    console.log(`Path      : ${candidatePath}`);
    console.log(`HTTP      : ${response.status}`);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.log("Body bukan JSON valid, raw response:");
      console.log(rawBody.slice(0, 500));
      return;
    }

    const { count, firstItem } = describeResponse(body);
    console.log(`Jumlah data: ${count}`);
    console.log("Sample item pertama:");
    console.log(JSON.stringify(firstItem, null, 2));
    return;
  }
}

function describeResponse(body: unknown): { count: number | string; firstItem: unknown } {
  if (Array.isArray(body)) {
    return { count: body.length, firstItem: body[0] ?? null };
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    if (Array.isArray(record.data)) {
      const list = record.data as unknown[];
      return { count: list.length, firstItem: list[0] ?? null };
    }

    if (record.data && typeof record.data === "object") {
      const nested = record.data as Record<string, unknown>;
      if (Array.isArray(nested.data)) {
        const list = nested.data as unknown[];
        return { count: list.length, firstItem: list[0] ?? null };
      }
    }
  }

  return { count: "N/A (bukan array)", firstItem: body };
}

function wibDateString(offsetDays: number): string {
  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date(Date.now() + WIB_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Explore Olsera failed");
  process.exit(1);
});
