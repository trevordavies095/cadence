import { describe, expect, it, vi } from "vitest";
import { createAnthropicLlmPort, toStrictSchema } from "../src/llm/anthropic.js";
import { buildStubWeeklyReply } from "../src/llm/index.js";
import { buildModelPacket } from "../src/packet/index.js";
import { anthropicStreamResponse, anthropicToolMessage } from "./helpers.js";

const packet = buildModelPacket({
  dossier: { versionId: 1, body: "Easy base building." },
  recapMarkdown: "## Summary\nSteady week.",
  thread: [],
  attachments: [],
  week: {
    isoWeek: "2026-W43",
    start: "2026-10-19T00:00:00.000Z",
    end: "2026-10-25T23:59:59.999Z",
    weekSessionId: "00000000-0000-4000-8000-000000000001",
  },
});

type Tool = { name: string; strict?: boolean; input_schema: Record<string, unknown> };

async function weeklyTool(): Promise<Tool> {
  let tool: Tool | undefined;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    tool = (JSON.parse(String(init?.body)) as { tools: Tool[] }).tools[0];
    return anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", buildStubWeeklyReply(packet)));
  }) as unknown as typeof globalThis.fetch;
  await createAnthropicLlmPort({ fetchImpl, readApiKey: async () => "sk-ant-test" }).generateWeeklyReply(packet);
  return tool!;
}

/** Every node of a schema, with the path to it. */
function walk(node: unknown, path: string, visit: (n: Record<string, unknown>, path: string) => void): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`, visit));
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "properties" && typeof v === "object" && v) {
      for (const [p, s] of Object.entries(v)) walk(s, `${path}.${p}`, visit);
    } else if (typeof v === "object") walk(v, `${path}.${k}`, visit);
  }
}

describe("the weekly reply tool is strict", () => {
  it("asks for grammar-constrained input, so the plan always arrives as an object", async () => {
    const tool = await weeklyTool();
    expect(tool.name).toBe("submit_weekly_reply");
    expect(tool.strict).toBe(true);
  });

  it("sends only what strict mode can compile, within its documented limits", async () => {
    const { input_schema } = await weeklyTool();
    let optional = 0;
    let unions = 0;
    walk(input_schema, "$", (node, path) => {
      for (const banned of ["maxItems", "maxLength", "minLength", "minimum", "maximum", "multipleOf"]) {
        expect(node, `${path} has ${banned}`).not.toHaveProperty(banned);
      }
      if (typeof node.minItems === "number") expect(node.minItems, path).toBeLessThanOrEqual(1);
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.includes("object")) {
        expect(node.additionalProperties, `${path} needs additionalProperties: false`).toBe(false);
        const props = Object.keys((node.properties as object) ?? {});
        const required = new Set((node.required as string[]) ?? []);
        optional += props.filter((p) => !required.has(p)).length;
      }
      if (Array.isArray(node.type) || Array.isArray(node.anyOf)) unions += 1;
    });
    // Documented ceilings across all strict schemas in a request.
    expect(optional).toBeLessThanOrEqual(24);
    expect(unions).toBeLessThanOrEqual(16);
  });

  it("strips only keywords, never a property that happens to share a keyword's name", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { maxItems: { type: "string", maxLength: 5 }, days: { type: "array", minItems: 7, maxItems: 7, items: { type: "string" } } },
    };
    expect(toStrictSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { maxItems: { type: "string" }, days: { type: "array", items: { type: "string" } } },
    });
  });
});
