import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const SOURCE_DIR = path.join(__dirname, "fixtures", "tempo-export-mini");

const GPSISH =
  /LineString|MultiLineString|routeGeoJson|"coordinates"\s*:|latitude|longitude/i;
const IDENTITYISH =
  /@[\w.-]+\.\w+|exportedBy"\s*:\s*"(?!cadence-fixture)[^"]+"/i;

function unzipList(zipPath: string): string {
  return execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
}

function unzipTo(zipPath: string, dest: string): void {
  execFileSync("unzip", ["-q", zipPath, "-d", dest]);
}

describe("Tempo export mini fixture (CI scrub pack)", () => {
  it("is small, committed, and free of routes geometry / media / identity PII", () => {
    expect(fs.existsSync(FIXTURE_ZIP)).toBe(true);
    const size = fs.statSync(FIXTURE_ZIP).size;
    expect(size).toBeGreaterThan(500);
    expect(size).toBeLessThan(256 * 1024);

    const listing = unzipList(FIXTURE_ZIP);
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("data/workouts.json");
    expect(listing).toContain("data/splits.json");
    expect(listing).toContain("data/time-series.json");
    expect(listing).not.toMatch(/workouts\/.+\/raw\//);
    expect(listing).not.toMatch(/\.(fit|gpx|jpg|jpeg|png|mp4)(\.gz)?\s/i);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-fixture-"));
    try {
      unzipTo(FIXTURE_ZIP, tmp);
      const routes = fs.readFileSync(
        path.join(tmp, "data/routes.json"),
        "utf8",
      );
      const media = fs.readFileSync(
        path.join(tmp, "data/media-metadata.json"),
        "utf8",
      );
      const settings = fs.readFileSync(
        path.join(tmp, "data/settings.json"),
        "utf8",
      );
      const workouts = fs.readFileSync(
        path.join(tmp, "data/workouts.json"),
        "utf8",
      );
      const manifest = fs.readFileSync(path.join(tmp, "manifest.json"), "utf8");

      expect(JSON.parse(media)).toEqual([]);
      expect(routes).not.toMatch(GPSISH);
      expect(workouts).not.toMatch(GPSISH);
      expect(settings).not.toMatch(/"age"\s*:/);
      expect(manifest).toMatch(/"exportedBy"\s*:\s*"cadence-fixture"/);
      expect(manifest).not.toMatch(IDENTITYISH);

      const routeArr = JSON.parse(routes) as Array<Record<string, unknown>>;
      expect(routeArr.length).toBeGreaterThan(0);
      for (const r of routeArr) {
        expect(r).not.toHaveProperty("routeGeoJson");
        expect(typeof r.workoutId).toBe("string");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("has packable source JSON next to the zip", () => {
    expect(fs.existsSync(path.join(SOURCE_DIR, "manifest.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(SOURCE_DIR, "data", "workouts.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(SOURCE_DIR, "data", "routes.json")),
    ).toBe(true);
  });
});
