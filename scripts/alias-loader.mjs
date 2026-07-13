// Resolver kecil agar import alias "@/..." (tsconfig paths) bisa dipakai saat
// menjalankan lib project langsung lewat Node CLI (--experimental-strip-types).
// Pakai: node --import ./scripts/alias-register.mjs <script>
import path from "path";
import { pathToFileURL } from "url";

const ROOT = process.cwd();

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let target = path.join(ROOT, specifier.slice(2));
    if (!/\.[a-z]+$/i.test(target)) target += ".ts";
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
