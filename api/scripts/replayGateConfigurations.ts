/**
 * The replay gate's configurations (scripts/replay-gate.ts), one table for both
 * sets: the two the format gate runs (plan-as-text ticket 11) and the six of
 * the coaching run (coaching-quality ticket 06). `short` names a configuration
 * on the command line (--configs), in the record and in both bands; `folder`
 * is the replay's configuration folder, <provider>--<model>--<effort>.
 *
 * The control is `opus`, Opus 4.7 at xhigh, in both sets. A self-hosted
 * configuration is served at --base-url, or at the URL in its `baseUrlEnv`
 * when the flag is absent; an Anthropic one is keyed by ANTHROPIC_API_KEY,
 * never a flag.
 */

export type GateConfiguration = {
  short: string;
  provider: "anthropic" | "self_hosted";
  model: string;
  effort: string;
  /** The replay's configuration folder. */
  folder: string;
  /** Self-hosted only: the environment variable holding the server's URL when --base-url is absent. */
  baseUrlEnv: string | null;
};

const anthropic = (short: string, model: string, effort: string): GateConfiguration => ({
  short,
  provider: "anthropic",
  model,
  effort,
  folder: `anthropic--${model}--${effort}`,
  baseUrlEnv: null,
});

export const GATE_CONFIGURATIONS: readonly GateConfiguration[] = [
  anthropic("opus", "claude-opus-4-7", "xhigh"),
  {
    short: "gpt-oss-20b",
    provider: "self_hosted",
    model: "gpt-oss-20b-MXFP4-Q8",
    effort: "high",
    folder: "self_hosted--gpt-oss-20b-MXFP4-Q8--high",
    baseUrlEnv: "OMLX_BASE_URL",
  },
  anthropic("opus-high", "claude-opus-4-7", "high"),
  anthropic("haiku-5-5", "claude-haiku-5-5", "high"),
  anthropic("sonnet-5-5", "claude-sonnet-5-5", "xhigh"),
  anthropic("opus-5-5", "claude-opus-5-5", "xhigh"),
];

/** The control, in both sets. */
export const CONTROL = GATE_CONFIGURATIONS[0]!;

/** What each set runs when --configs is absent: the format gate both of its two, the coaching gate the control. */
export const DEFAULT_CONFIGURATIONS = { format: ["opus", "gpt-oss-20b"], coaching: ["opus"] } as const;

/** The configurations `names` picks, in the order given; an unknown name throws, listing the table. */
export function configurationsNamed(names: readonly string[]): GateConfiguration[] {
  return names.map((name) => {
    const c = GATE_CONFIGURATIONS.find((x) => x.short === name);
    if (!c) throw new Error(`Unknown configuration "${name}" in --configs: ${GATE_CONFIGURATIONS.map((x) => x.short).join(", ")}.`);
    return c;
  });
}
