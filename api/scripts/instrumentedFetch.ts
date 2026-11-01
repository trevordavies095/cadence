/**
 * A fetch wrapper the hand-run scripts pass to the Anthropic port as its
 * `fetchImpl`, to time each HTTP exchange from outside the adapter: when the
 * headers came, the first byte, and the first `content_block_delta` (the first
 * token the model sent). Shared by the smoke script and the replay harness, so
 * both measure time to first token the same way.
 */

/** One HTTP exchange as a script saw it: timings, headers and (when kept) the raw bytes. */
export type Exchange = {
  url: string;
  startedAt: number;
  headersAt: number | null;
  firstByteAt: number | null;
  /** First content_block_delta: the first token the model sent. */
  firstTokenAt: number | null;
  endedAt: number | null;
  status: number | null;
  headers: Record<string, string>;
  /** The response body as it arrived; empty when bodies are not kept. */
  chunks: Uint8Array[];
  error: string | null;
};

/**
 * A fetch that records every exchange it makes into `exchanges`, in order.
 * `keepBodies` (default true) keeps each response's bytes, for recording a stream.
 */
export function createInstrumentedFetch(options?: { keepBodies?: boolean }): {
  fetch: typeof globalThis.fetch;
  exchanges: Exchange[];
} {
  const keepBodies = options?.keepBodies ?? true;
  const exchanges: Exchange[] = [];
  const instrumented: typeof globalThis.fetch = async (input, init) => {
    const ex: Exchange = {
      url: String(input instanceof Request ? input.url : input),
      startedAt: Date.now(),
      headersAt: null,
      firstByteAt: null,
      firstTokenAt: null,
      endedAt: null,
      status: null,
      headers: {},
      chunks: [],
      error: null,
    };
    exchanges.push(ex);
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } catch (err) {
      ex.endedAt = Date.now();
      ex.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    ex.headersAt = Date.now();
    ex.status = response.status;
    response.headers.forEach((v, k) => {
      ex.headers[k] = v;
    });
    if (!response.body) {
      ex.endedAt = Date.now();
      return response;
    }
    const decoder = new TextDecoder();
    let tail = "";
    const tee = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const now = Date.now();
        ex.firstByteAt ??= now;
        if (keepBodies) ex.chunks.push(chunk);
        if (ex.firstTokenAt === null) {
          const text = tail + decoder.decode(chunk, { stream: true });
          if (text.includes("content_block_delta")) ex.firstTokenAt = now;
          tail = text.slice(-32);
        }
        controller.enqueue(chunk);
      },
      flush() {
        ex.endedAt = Date.now();
      },
    });
    return new Response(response.body.pipeThrough(tee), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: instrumented, exchanges };
}

/** Milliseconds from sending the request to the first token; null when no token came. */
export function timeToFirstTokenMs(ex: Exchange | undefined): number | null {
  return ex?.firstTokenAt != null ? ex.firstTokenAt - ex.startedAt : null;
}

export function bytesOf(ex: Exchange): Buffer {
  return Buffer.concat(ex.chunks.map((c) => Buffer.from(c)));
}

/**
 * Characters of thinking in a logged reply (the message JSON the call log
 * keeps); null when no thinking block came back. A fallback measure for
 * servers that never report thinking tokens, such as oMLX.
 */
export function thinkingCharsOf(responseRaw: string | null): number | null {
  if (!responseRaw) return null;
  try {
    const message = JSON.parse(responseRaw) as { content?: Array<{ type?: string; thinking?: string }> };
    const blocks = (message.content ?? []).filter((b) => b?.type === "thinking");
    if (!blocks.length) return null;
    return blocks.reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
  } catch {
    return null;
  }
}
