/**
 * Writes the coaching report's public data bundle
 * (docs/reports/coaching-2026-11/data/) from the saved runs in the working
 * folder, scrubbed (scripts/exportCoachingData.ts says what goes in and what
 * the scrub does). Makes no calls.
 *
 *   cd api
 *   npm run replay:export-coaching -- --deny <your user name>,<your surname>
 *
 * --scratch <dir>: the working folder holding benchmark-coaching/ and
 * benchmark-after/; default .scratch at the repo root.
 * --repo-root <dir>: the absolute path the runs were made under, made
 * repo-relative in the bundle; default the parent of --scratch.
 * --out <dir>: default ../docs/reports/coaching-2026-11/data. Emptied first,
 * except its README.md.
 * --deny <word>,...: words that must not appear anywhere in the bundle,
 * matched ignoring case (a user name, a surname). They are given here, never
 * written into a file.
 *
 * Exits non-zero, after listing them, when any written file still holds a home
 * folder, a private address, a key, an email address or a denied word.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORT_SOURCES, exportBundle } from "./exportCoachingData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

const SCRATCH = path.resolve(flagValue("--scratch") ?? path.join(repo, ".scratch"));
const REPO_ROOT = path.resolve(flagValue("--repo-root") ?? path.dirname(SCRATCH));
const OUT = path.resolve(flagValue("--out") ?? path.join(repo, "docs/reports/coaching-2026-11/data"));
const DENY = (flagValue("--deny") ?? "").split(",").map((w) => w.trim()).filter(Boolean);

const r = exportBundle({ scratch: SCRATCH, out: OUT, repoRoot: REPO_ROOT, deny: DENY });
console.log(`export: ${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB, into ${path.relative(process.cwd(), OUT) || "."}`);
for (const s of EXPORT_SOURCES) if (!r.missing.includes(s.from)) console.log(`  ${s.to}: ${s.what}`);
for (const m of r.missing) console.log(`  missing, skipped: ${m}`);
if (DENY.length === 0) console.log("  no --deny words given: only paths, addresses, keys and emails were checked.");
if (r.leaks.length) {
  for (const l of r.leaks) console.error(`  leak: ${l.file}: ${l.found.join(", ")}`);
  console.error(`${r.leaks.length} file${r.leaks.length === 1 ? "" : "s"} still hold something that must not be published; fix the scrub and export again.`);
  process.exit(1);
}
console.log("  scrub check: clean.");
