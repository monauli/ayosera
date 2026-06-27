import { NextResponse } from "next/server";
import { z } from "zod";
import { auth, ensureDefaultAdmin } from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  try {
    const body = loginSchema.parse(await request.json());
    await ensureDefaultAdmin();

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
