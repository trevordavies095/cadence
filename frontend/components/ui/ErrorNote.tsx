import type { UiError } from "@/lib/errors";

/** One error sentence, with technical details tucked behind a disclosure. */
export function ErrorNote({ error }: { error: UiError | null }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message;
  const details = typeof error === "string" ? undefined : error.details;
  return (
    <div role="alert" className="flex flex-col gap-1">
      <p className="m-0 text-danger">{message}</p>
      {details ? (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">Details</summary>
          <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
