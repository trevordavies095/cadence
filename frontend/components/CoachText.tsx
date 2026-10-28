import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./ui";

// Only these elements are ever rendered. Anything else is unwrapped to its text,
// and raw HTML in the source is shown as plain text, never as markup.
const ALLOWED = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "em", "strong", "del", "br", "hr",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "blockquote", "code", "pre", "a",
];

/**
 * Prose keeps to about 65 characters a line, so the eye finds the next line. Geist's
 * "0" is about a third wider than its average letter, so 50ch lands near 65 characters.
 */
const MEASURE = "max-w-[50ch]";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
};

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * A paragraph that opens with a bold run-in ending a sentence or a label, such as
 * "**Yes.**" or "**Thursday:**", followed by more text. The run-in reads as the lead.
 */
function opensWithLead(node: HastNode | undefined): boolean {
  const kids = (node?.children ?? []).filter(
    (c) => !(c.type === "text" && !(c.value ?? "").trim()),
  );
  const [first, ...rest] = kids;
  if (!first || first.type !== "element" || first.tagName !== "strong") return false;
  return rest.length > 0 && /[.?!:]$/.test(hastText(first).trim());
}

/** Level 3 and below: a small uppercase muted eyebrow. */
const EYEBROW = "m-0 mt-2 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-muted";

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  // One register below the app's section titles, so Coach Cade's headings never read as the app's.
  h1: (p) => <h3 className="m-0 mt-3 text-lg font-semibold leading-snug" {...strip(p)} />,
  h2: (p) => <h3 className="m-0 mt-3 text-lg font-semibold leading-snug" {...strip(p)} />,
  h3: (p) => <h4 className={EYEBROW} {...strip(p)} />,
  h4: (p) => <h5 className={EYEBROW} {...strip(p)} />,
  h5: (p) => <h5 className={EYEBROW} {...strip(p)} />,
  h6: (p) => <h6 className={EYEBROW} {...strip(p)} />,
  p: (p) => (
    <p
      className={cx(
        "m-0",
        MEASURE,
        opensWithLead(p.node as HastNode | undefined) && "[&>strong:first-child]:block",
      )}
      {...strip(p)}
    />
  ),
  ul: (p) => <ul className="m-0 flex list-disc flex-col gap-1 pl-5" {...strip(p)} />,
  ol: (p) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5" {...strip(p)} />,
  li: (p) => <li className={MEASURE} {...strip(p)} />,
  blockquote: (p) => (
    <blockquote className="m-0 border-l-4 border-border pl-4 text-muted" {...strip(p)} />
  ),
  code: (p) => (
    <code className="rounded bg-canvas px-1 py-0.5 font-mono text-sm" {...strip(p)} />
  ),
  pre: (p) => (
    <pre className="m-0 overflow-x-auto rounded-tempo border border-border bg-canvas p-3 font-mono text-sm" {...strip(p)} />
  ),
  hr: () => <hr className="my-1 border-border" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-accent decoration-2 underline-offset-4"
    >
      {children}
    </a>
  ),
  table: (p) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left tabular-nums" {...strip(p)} />
    </div>
  ),
  th: (p) => (
    <th className="border-b border-border px-3 py-2 font-semibold" {...strip(p)} />
  ),
  td: (p) => <td className="border-b border-border px-3 py-2" {...strip(p)} />,
};

/** react-markdown passes the parsed node as a prop; keep it off the DOM. */
function strip<T extends object>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props as T & { node?: unknown };
  void _node;
  return rest;
}

/** Coach-written text: headings, lists, bold, tables and links, never raw markup. */
export function CoachText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ALLOWED}
        unwrapDisallowed
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
