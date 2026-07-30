import { NextResponse } from "next/server";
import { z } from "zod";
import { auth, ensureDefaultAdmin, ensureSupervisorAccount } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { checkRateLimitSafe, clientIp } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
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

    // Akun yang dinonaktifkan supervisor tidak boleh login sama sekali.
    const db = await getDb();
    const existing = await db
      .collection<{ email: string; disabled?: boolean }>("user")
      .findOne({ email: body.email.toLowerCase() });
    if (existing?.disabled) {
      return NextResponse.json({ error: "Akun dinonaktifkan. Hubungi supervisor." }, { status: 403 });
    }

    return auth.api.signInEmail({
      body: {
        email: body.email,
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
