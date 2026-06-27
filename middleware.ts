import { NextResponse, type NextRequest } from "next/server";

const BETTER_AUTH_SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export function middleware(request: NextRequest) {
  const sessionCookie = BETTER_AUTH_SESSION_COOKIES.some((name) => request.cookies.has(name));
  const isLoginPage = request.nextUrl.pathname === "/login";

  if (!sessionCookie && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Catatan: sengaja TIDAK memantulkan /login -> / hanya karena cookie ada.
  // Cookie bisa masih ada tapi sesinya sudah kedaluwarsa; memantulkannya akan
  // bertabrakan dengan redirect 401 di client dan menyebabkan loop refresh.
  // Biarkan /login selalu bisa diakses supaya user dapat login ulang.
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
