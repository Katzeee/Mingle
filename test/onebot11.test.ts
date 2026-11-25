import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/channels/channel.ts";
import { download, incoming, onebotChannel, outgoing } from "../src/channels/onebot11/onebot11.ts";

const { peer } = vi.hoisted(() => ({
  peer: { push: (_frame: unknown) => {}, actions: [] as string[], reply: undefined as unknown },
}));
vi.mock("undici", () => ({
  WebSocket: class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      super();
      peer.push = (frame) => this.onmessage?.({ data: JSON.stringify(frame) });
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const { action, echo } = JSON.parse(raw);
      peer.actions.push(action);
      const data =
        action === "get_login_info"
          ? { user_id: 9, nickname: "Bot" }
          : action === "get_msg"
            ? peer.reply
            : { message_id: 7 };
      queueMicrotask(() => peer.push({ status: "ok", retcode: 0, data, echo }));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  },
}));

it("supplies the quoted message on demand and takes background messages in arrival order", async () => {
  const received: InboundMessage[] = [];
  let resolveQuote: (() => InboundMessage | undefined | Promise<InboundMessage | undefined>) | undefined;
  const c = await onebotChannel().connect(
    { url: "ws://localhost:1234", account: "9" },
    {
      onMessage: (m, read) => {
        received.push(m);
        resolveQuote = read;
      },
      onState() {},
      onMembership() {},
    },
  );
  const raw = {
    post_type: "message",
    self_id: 9,
    time: 123,
    group_id: 71,
    message_type: "group",
    user_id: 8,
    sender: { nickname: "Alice" },
  };
  try {
    peer.reply = { ...raw, message_id: 30, message: [{ type: "text", data: { text: "Original" } }] };
    peer.push({ ...raw, message_id: 31, message: "[CQ:reply,id=30][CQ:at,qq=9]Please review" });
    peer.push({ ...raw, message_id: 32, message: "[CQ:reply,id=30]Background" });
    peer.push({ ...raw, self_id: 999, message_id: 33, message: "other account" });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((m) => [m.platformId, m.earlier ?? false, m.mentioned, m.text])).toEqual([
      ["31", false, true, "Please review"],
      ["32", false, false, "Background"],
    ]);
    expect(peer.actions).not.toContain("get_msg");
    expect(await resolveQuote?.()).toMatchObject({ platformId: "30", text: "Original" });
    expect(peer.actions.filter((a) => a === "get_msg")).toHaveLength(1);
    expect(received[1]?.replyTo).toBe("30");
    expect(
      await c.send({ chat: { kind: "group", platformId: "group:71" }, text: "Done", replyTo: "31" }),
    ).toMatchObject({ kind: "sent", platformId: "7" });
  } finally {
    await c.close();
  }
});

it("preserves literal CQ text, attachment handles and other users' mentions", () => {
  const m = incoming(
    {
      message_type: "private",
      message_id: -41,
      user_id: 8,
      time: 1,
      message: "&#91;CQ:at,qq=9&#93;[CQ:at,qq=7,name=Bob][CQ:file,file_id=a&#44;b,name=notes.txt]",
    },
    "backend:",
    "9",
  );
  expect(m?.mentioned).toBe(false);
  expect(m?.text).toBe("[CQ:at,qq=9]@Bob");
  expect(JSON.parse(m?.attachments[0]?.id ?? "null")).toMatchObject({ file: "a,b", kind: "dm", peer: "8" });
  expect(
    outgoing({ chat: { kind: "dm", platformId: "dm:8" }, text: "Hi @Bob", mentions: m?.mentions ?? [] }, "backend:"),
  ).toEqual([
    { type: "text", data: { text: "Hi " } },
    { type: "at", data: { qq: "7" } },
  ]);
});

it("uses an endpoint-hosted media URL and rejects unrelated private origins", async () => {
  const server = createServer((_req, res) => res.end("media")).listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "onebot-origin-"));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing port");
    const origin = `http://127.0.0.1:${addr.port}`;
    const handle = JSON.stringify({ type: "file", url: `${origin}/pic` });
    const file = join(root, "pic");
    const call = vi.fn(async () => undefined);
    await expect(download(call, handle, file, "http://other.example")).rejects.toThrow();
    await download(call, handle, file, origin);
    expect(await readFile(file, "utf8")).toBe("media");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
