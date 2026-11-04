/**
 * The coaching report's public data bundle (scripts/exportCoachingData.ts):
 * what the scrub rewrites, what the leak check catches, and that an export
 * copies the named sources, keeps the bundle's README, never copies the form's
 * raw responses, and reports anything left that must not be published. Every
 * path, address and name here is made up.
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportBundle, findLeaks, scrubText, withoutAnswers } from "../scripts/exportCoachingData.js";

const ROOT = "/Users/someone/code/cadence";

describe("scrubText", () => {
  it("makes the repo's paths repo-relative and any other home folder <local>", () => {
    const text = `"inputs": "${ROOT}/api/tests/fixtures/seasons/season-packets", from \`${ROOT}/.scratch/x\` and ${ROOT}; also /Users/other/Downloads/a.csv and /home/pat/b`;
    expect(scrubText(text, ROOT)).toBe(
      `"inputs": "api/tests/fixtures/seasons/season-packets", from \`.scratch/x\` and .; also <local>/Downloads/a.csv and <local>/b`,
    );
  });

  it("drops a worktree's folder so its paths read as the repo's", () => {
    expect(scrubText(`${ROOT}/.claude/worktrees/agent-1/api/scripts/a.ts`, ROOT)).toBe("api/scripts/a.ts");
  });

  it("replaces private addresses, keys and email addresses, and keeps JSON valid", () => {
    const json = JSON.stringify({
      baseUrlHost: "10.0.0.7:8000",
      url: "http://192.168.1.50:8000/v1",
      key: "sk-ant-api03-abcDEF_123-xyz",
      other: "sk-abcdefghijklmnopqrstuvwx",
      auth: "Bearer abc.def-ghi_jkl",
      who: "runner.one+bench@example.com",
      kept: "1.2.3.4 and 172.32.0.1 are not private",
    });
    const out = scrubText(json, ROOT);
    expect(JSON.parse(out)).toEqual({
      baseUrlHost: "<macbook>:8000",
      url: "http://<macbook>:8000/v1",
      key: "<key>",
      other: "<key>",
      auth: "Bearer <key>",
      who: "<email>",
      kept: "1.2.3.4 and 172.32.0.1 are not private",
    });
  });
});

describe("findLeaks", () => {
  it("finds home folders, private addresses, keys, emails and denied words, ignoring case", () => {
    expect(findLeaks("/Users/x/a 192.168.0.2 sk-ant-1 a@b.co Somebody", ["somebody"])).toEqual([
      "a home folder",
      "a private address",
      "an Anthropic key",
      "an email address",
      '"somebody"',
    ]);
  });

  it("finds nothing in scrubbed text", () => {
    const scrubbed = scrubText(`${ROOT}/a /Users/x/b 192.168.0.2 sk-ant-1 a@b.co`, ROOT);
    expect(findLeaks(scrubbed)).toEqual([]);
  });
});

describe("exportBundle", () => {
  function scratch(): { scratch: string; out: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "export-coaching-"));
    const s = path.join(dir, "scratch");
    mkdirSync(path.join(s, "runs/cfg"), { recursive: true });
    mkdirSync(path.join(s, "form/returned"), { recursive: true });
    writeFileSync(path.join(s, "runs/cfg/config.json"), JSON.stringify({ inputs: `${ROOT}/api/x`, baseUrlHost: "192.168.4.9:8000" }));
    writeFileSync(path.join(s, "runs/cfg/01.1.json"), JSON.stringify({ new: { headline: "Easy week." } }));
    writeFileSync(path.join(s, "form/key.json"), "{}");
    writeFileSync(path.join(s, "form/responses.csv"), "Who is filling this in?\nA Person\n");
    writeFileSync(path.join(s, "form/returned/responses.csv"), "Who is filling this in?\nA Person\n");
    const out = path.join(dir, "out");
    mkdirSync(path.join(out, "stale"), { recursive: true });
    writeFileSync(path.join(out, "README.md"), "# Kept\n");
    writeFileSync(path.join(out, "stale/old.json"), "{}");
    return { scratch: s, out };
  }

  it("copies the sources scrubbed, keeps the README, empties the rest and never copies responses", () => {
    const { scratch: s, out } = scratch();
    const r = exportBundle({
      scratch: s,
      out,
      repoRoot: ROOT,
      sources: [
        { from: "runs", to: "baseline", what: "replies" },
        { from: "form", to: "coach-packet", what: "the form" },
        { from: "absent", to: "absent", what: "a run not made" },
      ],
    });
    expect(r).toMatchObject({ files: 3, missing: ["absent"], leaks: [] });
    expect(JSON.parse(readFileSync(path.join(out, "baseline/cfg/config.json"), "utf8"))).toEqual({ inputs: "api/x", baseUrlHost: "<macbook>:8000" });
    expect(readFileSync(path.join(out, "README.md"), "utf8")).toBe("# Kept\n");
    expect(existsSync(path.join(out, "stale"))).toBe(false);
    expect(existsSync(path.join(out, "coach-packet/responses.csv"))).toBe(false);
    expect(existsSync(path.join(out, "coach-packet/returned"))).toBe(false);
  });

  it("reports a denied word left in the bundle", () => {
    const { scratch: s, out } = scratch();
    writeFileSync(path.join(s, "runs/cfg/02.1.json"), JSON.stringify({ note: "Sam's MacBook" }));
    const r = exportBundle({ scratch: s, out, repoRoot: ROOT, deny: ["sam"], sources: [{ from: "runs", to: "baseline", what: "replies" }] });
    expect(r.leaks).toEqual([{ file: "baseline/cfg/02.1.json", found: ['"sam"'] }]);
  });

  it("refuses a file that is not text rather than copying it unscrubbed", () => {
    const { scratch: s, out } = scratch();
    writeFileSync(path.join(s, "runs/cfg/trace.bin"), Buffer.from([0, 1, 2]));
    expect(() => exportBundle({ scratch: s, out, repoRoot: ROOT, sources: [{ from: "runs", to: "baseline", what: "replies" }] })).toThrow(/not a text file/);
  });

  it("keeps a calibration's summary and drops the reviewer's case-by-case picks", () => {
    const json = JSON.stringify({ bar: { ratingMad: 1.17 }, judges: [{ judge: "j", pickAgreement: 0.32, cases: [{ case: 1, coachPick: "A", judgePick: "B" }] }] });
    const kept = JSON.parse(withoutAnswers("judge-2/calibration.json", json));
    expect(kept.judges[0]).toEqual({ judge: "j", pickAgreement: 0.32 });
    const md = "# Coaching judge calibration\n\n| Judge | Pick agreement |\n| j | 32% |\n\n## j\n\n| Case | Coach's pick |\n| 1 | A |\n";
    const out = withoutAnswers("calibration.md", md);
    expect(out).toContain("| j | 32% |");
    expect(out).not.toContain("Coach's pick");
    expect(withoutAnswers("01.1.json", "{}")).toBe("{}");
  });

  it("never copies the review form or a comparison of the answers", () => {
    const { scratch: s, out } = scratch();
    mkdirSync(path.join(s, "runs/coach-packet"), { recursive: true });
    writeFileSync(path.join(s, "runs/coach-packet/form.gs"), "form");
    writeFileSync(path.join(s, "runs/comparison.md"), "answers");
    exportBundle({ scratch: s, out, repoRoot: ROOT, sources: [{ from: "runs", to: "baseline", what: "replies" }] });
    expect(existsSync(path.join(out, "baseline/coach-packet"))).toBe(false);
    expect(existsSync(path.join(out, "baseline/comparison.md"))).toBe(false);
  });
});
