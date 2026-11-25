import { WebSocket } from "undici";

export type Fields = Record<string, unknown>;
export function object(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

export class ActionFailed extends Error {}
export type Call = (
  action: string,
  params?: Fields,
  onChunk?: (chunk: Fields) => void,
  timeoutMs?: number,
) => Promise<unknown>;

export async function openSocket(
  url: URL,
  token: string,
  event: (data: Fields) => void,
  disconnected: () => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const pending = new Map<string, { receive(frame: Fields): void; reject(reason: Error): void }>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    for (const item of pending.values()) item.reject(new Error("OneBot connection closed"));
    pending.clear();
    ws.close();
  };
  ws.onclose = () => {
    if (!closed) {
      close();
      disconnected();
    }
  };
  ws.onmessage = ({ data }) => {
    if (closed || typeof data !== "string") return;
    let frame: Fields;
    try {
      // Keep 64-bit account and conversation IDs exact before converting them to strings.
      frame = object(
        JSON.parse(data, (_key: string, value: unknown, context?: { source?: string }) =>
          typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
            ? context?.source
            : value,
        ),
      );
    } catch {
      return;
    }
    if (typeof frame.echo === "string") pending.get(frame.echo)?.receive(frame);
    else if (frame.post_type === "message") event(frame);
  };
  const opening = AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error("OneBot WebSocket handshake failed"));
      opening.addEventListener("abort", fail, { once: true });
      ws.onopen = () => {
        opening.removeEventListener("abort", fail);
        resolve();
      };
      ws.onerror = fail;
      ws.addEventListener("close", fail, { once: true });
    });
  } catch (error) {
    close();
    throw error;
  }
  signal?.addEventListener("abort", close, { once: true });
  const call: Call = async (action, params = {}, onChunk, timeoutMs = onChunk ? 120_000 : 12_000) => {
    if (ws.readyState !== WebSocket.OPEN || closed) throw new Error("OneBot is offline");
    const echo = crypto.randomUUID();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        const renew = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("OneBot action timed out")), timeoutMs);
        };
        renew();
        pending.set(echo, {
          reject,
          receive(frame) {
            // An accepted async send has no final delivery receipt or message ID.
            if (frame.status === "async" && frame.retcode === 1) {
              resolve(undefined);
              return;
            }
            if (frame.status !== "ok" || frame.retcode !== 0) {
              reject(new ActionFailed("OneBot rejected the action"));
              return;
            }
            const data = object(frame.data);
            if (onChunk && data.type === "stream") {
              renew();
              try {
                onChunk(data);
              } catch (error) {
                reject(error);
              }
            } else resolve(frame.data);
          },
        });
        ws.send(JSON.stringify({ action, params, echo }));
      });
    } finally {
      clearTimeout(timer);
      pending.delete(echo);
    }
  };
  return {
    call,
    close,
    get closed() {
      return closed;
    },
  };
}
