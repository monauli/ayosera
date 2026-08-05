import { randomInt } from "node:crypto";

// Hindari karakter ambigu (0/O, 1/l/I) supaya password acak ini tetap mudah
// disalin ulang manual bila diperlukan — dipakai oleh
// app/api/users/[id]/reset-password/route.ts (fitur Reset Password Bagian B).
export const PASSWORD_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

export function generatePassword(length = 14): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
  }
  return out;
}
