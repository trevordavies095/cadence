/**
 * Minimal Server-Sent Events reader for the Anthropic Messages streaming API.
 * Reassembles the stream into the message object the non-streaming API returns
 * (id, type, role, model, content[], stop_reason, usage) so logs keep one shape.
 */

type Json = Record<string, unknown>;

export type StreamedMessage = Json & {
  content: Json[];
  stop_reason: string | null;
  usage: Json;
};

export type StreamReadResult = {
  /** Reassembled message so far; null when no message_start arrived. */
  message: StreamedMessage | null;
  /** True once message_stop was seen. */
  complete: boolean;
  /** Set for a mid-stream `error` event, an abort, or a body read failure. */
  streamError: string | null;
  /** Raw text received, kept only while no message_start has been seen. */
  rawText: string;
};

const RAW_TEXT_CAP = 1_000_000;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Accumulator = {
  message: StreamedMessage | null;
  /** Partial tool JSON by content index. */
  partialJson: Map<number, string>;
  complete: boolean;
  errorEvent: string | null;
};

function finishToolBlock(acc: Accumulator, index: number): void {
  const block = acc.message?.content[index];
  const partial = acc.partialJson.get(index);
  if (!block || block.type !== "tool_use" || partial === undefined) return;
  acc.partialJson.delete(index);
  if (partial.trim() === "") {
    block.input = {};
    return;
  }
  try {
    block.input = JSON.parse(partial) as unknown;
  } catch {
    // Keep the unparseable text visible in the log; validation will reject it.
    block.input = { _unparsed_partial_json: partial };
  }
}

function applyEvent(acc: Accumulator, data: Json): void {
  const type = data.type;
  switch (type) {
    case "message_start": {
      const m = isObj(data.message) ? data.message : {};
      acc.message = {
        ...m,
        content: [],
        stop_reason: null,
        usage: isObj(m.usage) ? { ...m.usage } : {},
      } as StreamedMessage;
      return;
    }
    case "content_block_start": {
      const index = typeof data.index === "number" ? data.index : -1;
      if (!acc.message || index < 0 || !isObj(data.content_block)) return;
      acc.message.content[index] = { ...data.content_block };
      if (data.content_block.type === "tool_use") {
        acc.partialJson.set(index, "");
      }
      return;
    }
    case "content_block_delta": {
      const index = typeof data.index === "number" ? data.index : -1;
      const block = acc.message?.content[index];
      if (!block || !isObj(data.delta)) return;
      const delta = data.delta;
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
      } else if (
        delta.type === "signature_delta" &&
        typeof delta.signature === "string"
      ) {
        block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature}`;
      } else if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        acc.partialJson.set(
          index,
          `${acc.partialJson.get(index) ?? ""}${delta.partial_json}`,
        );
      }
      return;
    }
    case "content_block_stop": {
      if (typeof data.index === "number") finishToolBlock(acc, data.index);
      return;
    }
    case "message_delta": {
      if (!acc.message) return;
      if (isObj(data.delta)) {
        for (const [k, v] of Object.entries(data.delta)) {
          if (k === "stop_reason") {
            acc.message.stop_reason = typeof v === "string" ? v : null;
          } else {
            acc.message[k] = v;
          }
        }
      }
      if (isObj(data.usage)) {
        acc.message.usage = { ...acc.message.usage, ...data.usage };
      }
      return;
    }
    case "message_stop": {
      // Close any tool block whose content_block_stop never arrived.
      for (const index of [...acc.partialJson.keys()]) {
        finishToolBlock(acc, index);
      }
      acc.complete = true;
      return;
    }
    case "error": {
      const err = isObj(data.error) ? data.error : {};
      const t = typeof err.type === "string" ? err.type : "error";
      const msg = typeof err.message === "string" ? err.message : "";
      acc.errorEvent = msg ? `${t}: ${msg}` : t;
      return;
    }
    default:
      // ping and unknown future events are ignored.
      return;
  }
}

function parseSseBlock(block: string): Json | null {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as unknown;
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read a streaming Messages response to the end. `signal` aborts the read;
 * `onActivity` fires for every chunk received (idle-timer reset).
 */
export async function readMessageStream(
  response: Response,
  options: { signal: AbortSignal; onActivity: () => void },
): Promise<StreamReadResult> {
  const { signal, onActivity } = options;
  const acc: Accumulator = {
    message: null,
    partialJson: new Map(),
    complete: false,
    errorEvent: null,
  };
  let rawText = "";
  let streamError: string | null = null;

  const result = (): StreamReadResult => ({
    message: acc.message,
    complete: acc.complete,
    streamError: streamError ?? acc.errorEvent,
    rawText,
  });

  if (!response.body) return result();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) fire();
    else signal.addEventListener("abort", fire, { once: true });
  });
  aborted.catch(() => {});

  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      onActivity();
      const chunk = decoder.decode(value, { stream: true });
      if (!acc.message && rawText.length < RAW_TEXT_CAP) rawText += chunk;
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = parseSseBlock(block);
        if (data) applyEvent(acc, data);
      }
      if (acc.errorEvent) break;
    }
    const tail = parseSseBlock(buffer + decoder.decode());
    if (tail) applyEvent(acc, tail);
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
  } finally {
    reader.cancel().catch(() => {});
  }
  return result();
}
