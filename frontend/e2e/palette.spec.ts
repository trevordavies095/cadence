import { expect, test, type Page } from "@playwright/test";

// The palette's rules, checked against the tokens the browser actually resolves.
// Never pins a hex value: retune a token within its rule and this still passes;
// drop a divider back to invisible and it fails. Rationale: docs/adr/0001-color-scheme.md.

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

const TOKENS = [
  "canvas",
  "raised",
  "line",
  "line-strong",
  "ink",
  "muted",
  "accent",
  "ok",
  "warn",
  "danger",
  "coach-bg",
] as const;
type Token = (typeof TOKENS)[number];

/** Text colors must be readable on both surfaces. */
const TEXT: Token[] = ["ink", "muted", "accent", "ok", "warn", "danger"];

/** Structural marks must be visible against the page. */
const VISIBLE: Array<[Token, number]> = [
  ["raised", 1.1],
  ["line", 1.3],
  ["line-strong", 1.8],
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = [...h].map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Not a hex color: "${hex}"`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function openIn(page: Page, theme: Theme) {
  await page.addInitScript((t) => localStorage.setItem("cadence-appearance", t), theme);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  const html = page.locator("html");
  if (theme === "dark") await expect(html).toHaveClass(/\bdark\b/);
  else await expect(html).not.toHaveClass(/\bdark\b/);
}

async function readTokens(page: Page): Promise<Record<Token, string>> {
  return page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(`--${n}`).trim()]));
  }, [...TOKENS]) as Promise<Record<Token, string>>;
}

test.describe("palette", () => {
  for (const theme of THEMES) {
    test(`${theme}: text is readable and structure is visible`, async ({ page }) => {
      await openIn(page, theme);
      const t = await readTokens(page);

      const failures: string[] = [];
      const check = (label: string, ratio: number, min: number) => {
        if (ratio < min) failures.push(`${theme} ${label}: ${ratio.toFixed(2)}:1, needs ${min}:1`);
      };

      for (const name of TEXT) {
        check(`${name} on canvas`, contrast(t[name], t.canvas), 4.5);
        check(`${name} on raised`, contrast(t[name], t.raised), 4.5);
      }
      for (const [name, min] of VISIBLE) {
        check(`${name} on canvas`, contrast(t[name], t.canvas), min);
      }
      check("ink on coach-bg", contrast(t.ink, t["coach-bg"]), 4.5);

      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

/** The volt token as the browser paints it, so it compares against computed backgrounds. */
async function voltBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--volt)";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
}

/** Visible elements painted volt, described for a readable failure. */
async function voltElements(page: Page): Promise<string[]> {
  const volt = await voltBackground(page);
  return page.evaluate((v) => {
    const found: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(el);
      if (style.backgroundColor !== v) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      found.push(`<${el.tagName.toLowerCase()}> ${(el.textContent ?? "").trim().slice(0, 40)}`);
    }
    return found;
  }, volt);
}

async function settle(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Loading…")).toHaveCount(0);
}

test.describe("one volt per page", () => {
  // Route, and the most volt elements it may show.
  const PAGES: Array<[string, number]> = [
    ["/", 1],
    ["/plan", 1],
    ["/chat", 1],
    ["/weeks", 0],
  ];

  for (const theme of THEMES) {
    test(`${theme}: volt marks at most one thing, and none on History`, async ({ page }) => {
      await openIn(page, theme);
      for (const [route, max] of PAGES) {
        await settle(page, route);
        const volt = await voltElements(page);
        expect(volt.length, `${theme} ${route} volt elements:\n${volt.join("\n")}`).toBeLessThanOrEqual(
          max,
        );
      }
    });

    test(`${theme}: the current page in the header is underlined, not volt`, async ({ page }) => {
      await openIn(page, theme);
      const volt = await voltBackground(page);
      for (const [route] of PAGES) {
        await settle(page, route);
        const current = page
          .getByRole("navigation", { name: "Main" })
          .locator('[aria-current="page"]');
        await expect(current).toHaveCount(1);
        const mark = await current.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            background: s.backgroundColor,
            border:
              parseFloat(s.borderBottomWidth) > 0 &&
              s.borderBottomStyle !== "none" &&
              s.borderBottomColor !== "rgba(0, 0, 0, 0)",
            shadow: s.boxShadow !== "none",
            underline: s.textDecorationLine.includes("underline"),
          };
        });
        expect(mark.background, `${theme} ${route} active nav background`).not.toBe(volt);
        expect(
          mark.border || mark.shadow || mark.underline,
          `${theme} ${route} active nav has no visible underline`,
        ).toBe(true);
      }
    });

    test(`${theme}: About you's submit is not volt while the box is empty`, async ({ page }) => {
      await openIn(page, theme);
      const volt = await voltBackground(page);
      await settle(page, "/dossier");
      await expect(page.getByLabel("What should Coach Cade know?")).toHaveValue("");
      const submit = page.getByRole("button", { name: "Tell Coach Cade" });
      await expect(submit).toBeDisabled();
      const background = await submit.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).not.toBe(volt);
    });
  }
});
