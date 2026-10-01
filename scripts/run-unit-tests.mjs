// Menjalankan semua suite di package.json "unitSuites" satu per satu dan
// melaporkan SEMUA yang gagal (rantai `&&` lama berhenti di kegagalan pertama
// dan menyembunyikan suite sesudahnya).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { unitSuites } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failed = [];
for (const suite of unitSuites) {
  console.log(`\n=== npm run ${suite}`);
  const result = spawnSync(npm, ["run", suite], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) failed.push(suite);
}
console.log(failed.length ? `\nSuite gagal (${failed.length}/${unitSuites.length}): ${failed.join(", ")}` : `\nSemua ${unitSuites.length} suite lulus.`);
process.exit(failed.length ? 1 : 0);
