import { NextResponse } from "next/server";
import { z } from "zod";
import { auth, ensureDefaultAdmin, ensureSupervisorAccount } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { checkRateLimitSafe, clientIp } from "@/lib/rate-limit";

// `email` menerima EMAIL atau USERNAME (satu kolom input di UI, lihat
// app/login/page.tsx) — deteksi otomatis lewat keberadaan "@" di bawah,
// pendekatan paling sederhana yang tidak butuh UI/state tambahan.
const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(8),
});

// Cukup longgar untuk salah ketik password wajar, cukup ketat untuk
// memperlambat brute force otomatis dari satu IP.
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_SECONDS = 300;

export async function POST(request: Request) {
  const rate = await checkRateLimitSafe(`login:${clientIp(request)}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Terlalu banyak percobaan login. Coba lagi sebentar lagi." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  try {
    const body = loginSchema.parse(await request.json());
    await ensureDefaultAdmin();
    await ensureSupervisorAccount();

    const identifier = body.email.trim().toLowerCase();
    const db = await getDb();
    const users = db.collection<{ email: string; username?: string; disabled?: boolean }>("user");

    // Tanpa "@" berarti input adalah username — cari email aslinya lebih
    // dulu (better-auth signInEmail hanya menerima email). User LAMA tanpa
    // field username tidak terpengaruh sama sekali: mereka selalu login
    // lewat cabang email di bawah.
    let resolvedEmail = identifier;
    if (!identifier.includes("@")) {
      const byUsername = await users.findOne({ username: identifier });
      if (!byUsername) {
        return NextResponse.json({ error: "Email atau password tidak valid." }, { status: 401 });
      }
      resolvedEmail = byUsername.email;
    }

    // Akun yang dinonaktifkan supervisor tidak boleh login sama sekali.
    const existing = await users.findOne({ email: resolvedEmail });
    if (existing?.disabled) {
      return NextResponse.json({ error: "Akun dinonaktifkan. Hubungi supervisor." }, { status: 403 });
    }

    return auth.api.signInEmail({
      body: {
        email: resolvedEmail,
        password: body.password,
        rememberMe: true,
      },
      asResponse: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid login payload" }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
