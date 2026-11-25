import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { closeSync, createWriteStream, openSync, writeSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { basename, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  Channel,
  ChannelConnection,
  ChannelEvents,
  Credentials,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  Sender,
  SendResult,
} from "../channel.ts";
import { withTextSent } from "../channel.ts";
import { mentionSpots } from "../mention.ts";
import { ActionFailed, type Call, type Fields, object, openSocket } from "./socket.ts";

class InvalidCredentials extends Error {}
function endpointOf(credentials: Credentials) {
  const url = URL.parse(credentials.url ?? "");
  if (!url || !["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new InvalidCredentials("Provide a WebSocket endpoint and put its token in the token field");
  return url;
}

async function connect(
  credentials: Credentials,
  events?: ChannelEvents,
  signal?: AbortSignal,
): Promise<ChannelConnection> {
  const url = endpointOf(credentials);
  const endpointOrigin = `${url.protocol === "ws:" ? "http:" : "https:"}//${url.host}`;
  const scope = `${createHash("sha256").update(url.href).digest("hex").slice(0, 32)}:`;
  let self = "";
  let queued: Fields[] = [];
  let chain = Promise.resolve();
  const groupNames = new Map<string, string>();
  const socket = await openSocket(
    url,
    credentials.token ?? "",
    (frame) => {
      if (!events) return;
      if (!self) queued.push(frame);
      else enqueue(frame);
    },
    () => events?.onState({ kind: "error", code: "network" }),
    signal,
  );
  function enqueue(frame: Fields) {
    chain = chain
      .then(async () => {
        if (!events || socket.closed || id(frame.self_id) !== self || id(frame.user_id) === self) return;
        const message = incoming(frame, scope, self);
        if (!message) return;
        let chat = message.chat;
        if (chat.kind === "group") {
          const groupId = id(frame.group_id);
          if (chat.name) groupNames.set(groupId, chat.name);
          else {
            if (!groupNames.has(groupId)) {
              const info = object(
                await socket.call("get_group_info", { group_id: wireId(groupId) }).catch(() => undefined),
              );
              groupNames.set(groupId, id(info.group_name));
            }
            const name = groupNames.get(groupId);
            if (name) chat = { ...chat, name };
          }
        }
        const ref = message.replyTo;
        if (!socket.closed)
          events.onMessage(
            { ...message, chat },
            ref
              ? async () => incoming(object(await socket.call("get_msg", { message_id: wireId(ref) })), scope, self)
              : undefined,
          );
      })
      .catch(() => {
        /* Isolate malformed events from subsequent deliveries. */
      });
  }
  try {
    const login = object(await socket.call("get_login_info"));
    self = id(login.user_id);
    if (!self || (credentials.account && credentials.account !== self))
      throw new InvalidCredentials("OneBot account mismatch");
    if (socket.closed) throw new Error("OneBot disconnected");
    for (const e of queued) enqueue(e);
    queued = [];
    return {
      bot: { id: scope + self, name: id(login.nickname) || self },
      capabilities: () => ({
        quoteReply: true,
        mentions: true,
        typingIndicator: false,
        reactions: false,
        fileUpload: true,
        fileDownload: true,
        listMembers: true,
        maxTextLength: 4000,
      }),
      async send(m) {
        const peer = m.chat.platformId.slice(m.chat.platformId.indexOf(":") + 1);
        const group = m.chat.kind === "group";
        if (!m.chat.platformId.startsWith(group ? "group:" : "dm:") || !peer)
          return { kind: "failed", code: "chat_gone", retryable: false };
        const send = async (message: Segment[], attachment = false) => {
          const sent = object(
            await socket.call(
              group ? "send_group_msg" : "send_private_msg",
              {
                [group ? "group_id" : "user_id"]: wireId(peer),
                message,
              },
              undefined,
              attachment ? 120_000 : undefined,
            ),
          );
          return id(sent.message_id);
        };
        const degraded = m.inThread ? (["thread_dropped"] as const) : [];
        let textId = "";
        let lastId = "";
        const failed = (failure: Extract<SendResult, { kind: "failed" }>): SendResult => {
          if (textId) return withTextSent(failure, textId);
          if (lastId) return { kind: "sent", platformId: lastId, degraded: [...degraded, "files_dropped"] };
          return failure;
        };
        try {
          if (m.text) {
            lastId = textId = await send(outgoing(m, scope));
            if (!textId) return { kind: "uncertain" };
          }
          for (const file of m.files ?? []) {
            const media = await attachmentSegment(file);
            if ("kind" in media) return failed(media);
            // QQ can hide other segments behind a file card in a mixed message.
            const quote = lastId ? [] : outgoing(m, scope);
            const messageId = await send([...quote, media], true);
            if (!messageId) return { kind: "uncertain" };
            const receipt = object(
              await socket.call("get_msg", { message_id: wireId(messageId) }).catch(() => undefined),
            );
            if (!Array.isArray(receipt.message) && typeof receipt.message !== "string") return { kind: "uncertain" };
            if (!segments(receipt.message).some((part) => part.type === media.type))
              return failed({ kind: "failed", code: "unknown", retryable: false, detail: "file_not_delivered" });
            lastId = messageId;
          }
          return {
            kind: "sent",
            platformId: textId || lastId,
            degraded,
          };
        } catch (error) {
          return error instanceof ActionFailed
            ? failed({ kind: "failed", code: "unknown", retryable: false })
            : { kind: "uncertain" };
        }
      },
      async openDirect(user) {
        if (!user.startsWith(scope)) throw new Error("Unknown OneBot account");
        return `dm:${user.slice(scope.length)}`;
      },
      async listMembers(chat) {
        if (chat.kind !== "group") return [];
        const rows = await socket
          .call("get_group_member_list", { group_id: wireId(chat.platformId.slice(6)) })
          .catch(() => undefined);
        return Array.isArray(rows)
          ? rows
              .map(object)
              .filter((row) => id(row.user_id))
              .map((row) => ({
                id: scope + id(row.user_id),
                name: id(row.card) || id(row.nickname),
                isBot: row.is_bot === true || id(row.user_id) === self,
              }))
          : [];
      },
      async react() {},
      async setTyping() {},
      download: (a, path) => download(socket.call, a.id, path, endpointOrigin),
      async close() {
        socket.close();
      },
    };
  } catch (error) {
    socket.close();
    if (error instanceof InvalidCredentials) events?.onState({ kind: "error", code: "credentials_revoked" });
    throw error;
  }
}

export function onebotChannel(): Channel {
  return {
    platform: "onebot11",
    groupMessages: true,
    onboarding: {
      kind: "credentials",
      fields: [
        { key: "url", labelKey: "onebot11.url", secret: false },
        { key: "token", labelKey: "onebot11.token", secret: true, optional: true },
      ],
    },
    async *onboard(input, signal) {
      if (!input?.url) {
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      try {
        const live = await connect({ url: input.url, token: input.token ?? "" }, undefined, signal);
        const { bot } = live;
        await live.close();
        yield {
          kind: "succeeded",
          bot,
          credentials: {
            url: endpointOf(input).href,
            token: input.token ?? "",
            account: bot.id.slice(bot.id.indexOf(":") + 1),
          },
        };
      } catch (error) {
        yield {
          kind: "failed",
          code: signal.aborted ? "cancelled" : error instanceof InvalidCredentials ? "invalid_credentials" : "network",
        };
      }
    },
    connect,
  };
}

function id(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function wireId(value: string): unknown {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return value;
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number;
  return (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(value);
}

interface Segment {
  type: string;
  data: Fields;
}

const IMAGE_EXTENSIONS = new Set([".apng", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".amr", ".m4a", ".mp3", ".ogg", ".opus", ".silk", ".wav"]);
// Leave room for Base64 and message framing within typical OneBot WebSocket frame limits.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

async function attachmentSegment(
  file: NonNullable<OutboundMessage["files"]>[number],
): Promise<Segment | Extract<SendResult, { kind: "failed" }>> {
  const name = basename(file.name || file.path);
  const extension = extname(name).toLowerCase();
  const type = IMAGE_EXTENSIONS.has(extension)
    ? "image"
    : VIDEO_EXTENSIONS.has(extension)
      ? "video"
      : AUDIO_EXTENSIONS.has(extension)
        ? "record"
        : "file";
  try {
    const info = await stat(file.path);
    if (!info.isFile() || info.size === 0) throw new Error("Expected a nonempty file");
    if (info.size > MAX_UPLOAD_BYTES) return { kind: "failed", code: "too_large", retryable: false };
    const bytes = await readFile(file.path);
    if (!bytes.length) throw new Error("Empty file");
    if (bytes.length > MAX_UPLOAD_BYTES) return { kind: "failed", code: "too_large", retryable: false };
    return { type, data: { file: `base64://${bytes.toString("base64")}`, name } };
  } catch {
    return { kind: "failed", code: "unknown", retryable: false, detail: "file_unreadable" };
  }
}
function unescapeCq(text: string) {
  return text.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&");
}

function segments(message: unknown): Segment[] {
  if (Array.isArray(message)) return message.map(object).map((s) => ({ type: id(s.type), data: object(s.data) }));
  if (typeof message !== "string") return [];
  const result: Segment[] = [];
  let from = 0;
  function text(end: number) {
    if (end > from) result.push({ type: "text", data: { text: unescapeCq(messageText.slice(from, end)) } });
  }
  const messageText = message;
  for (const m of message.matchAll(/\[CQ:(\w+)((?:,[^\]]*)?)\]/g)) {
    text(m.index);
    const data: Fields = Object.create(null);
    for (const pair of (m[2] ?? "").slice(1).split(",")) {
      const i = pair.indexOf("=");
      if (i > 0) data[pair.slice(0, i)] = unescapeCq(pair.slice(i + 1).replaceAll("&#44;", ","));
    }
    result.push({ type: m[1] as string, data });
    from = m.index + m[0].length;
  }
  text(message.length);
  return result;
}

export function incoming(e: Fields, scope: string, self: string): InboundMessage | undefined {
  const sender = object(e.sender);
  const user = id(e.user_id ?? sender.user_id);
  const kind = e.message_type === "group" ? "group" : e.message_type === "private" ? "dm" : undefined;
  const peer = kind === "group" ? id(e.group_id) : user === self ? id(e.target_id) : user;
  const platformId = id(e.message_id);
  if (!kind || !peer || !user || !platformId || !Number.isFinite(Number(e.time))) return;
  const attachments: InboundAttachment[] = [];
  const mentions: Sender[] = [];
  const text: string[] = [];
  let mentioned = false;
  let replyTo = "";
  for (const { type, data } of segments(e.message)) {
    if (type === "text") text.push(id(data.text));
    else if (type === "at") {
      const who = id(data.qq);
      if (who === self) mentioned = true;
      else if (who) {
        const name = id(data.name) || who;
        text.push(`@${name}`);
        if (who !== "all") mentions.push({ id: scope + who, name, isBot: false });
      }
    } else if (type === "reply") replyTo = id(data.id);
    else if (["image", "record", "video", "file"].includes(type)) {
      const file = id(data.file_id) || id(data.file);
      const url = id(data.url);
      const name = (id(data.file_name) || id(data.name) || id(data.file) || type).split(/[\\/]/).pop() || type;
      const size = Number(data.file_size ?? data.size);
      attachments.push({
        id: JSON.stringify({
          type,
          file,
          url,
          kind,
          peer,
          ...(/^https?:\/\//i.test(id(data.file)) && data.file_id ? { sourceFile: id(data.file) } : {}),
        }),
        name,
        ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
        ...(typeof data.mime === "string" ? { mime: data.mime } : {}),
      });
    } else if (type) text.push(`[${type}${data.id !== undefined ? ` ${id(data.id)}` : ""}]`);
  }
  return {
    platformId,
    chat: { kind, platformId: `${kind}:${peer}`, ...(e.group_name ? { name: id(e.group_name) } : {}) },
    sender: {
      id: scope + user,
      name: id(sender.card) || id(sender.nickname),
      isBot: user === self || sender.is_bot === true,
    },
    text: text.join("").trim(),
    attachments,
    mentions,
    mentioned,
    addressedToBot: mentioned,
    sentAt: Number(e.time) * 1000,
    ...(replyTo ? { replyTo } : {}),
  };
}

export function outgoing(m: OutboundMessage, scope: string): Segment[] {
  const result: Segment[] = [];
  if (m.replyTo) result.push({ type: "reply", data: { id: m.replyTo } });
  let pos = 0;
  for (const spot of mentionSpots(m.text, m.mentions ?? [])) {
    if (!spot.mention.id.startsWith(scope)) continue;
    if (spot.start > pos) result.push({ type: "text", data: { text: m.text.slice(pos, spot.start) } });
    result.push({ type: "at", data: { qq: spot.mention.id.slice(scope.length) } });
    pos = spot.end;
  }
  if (pos < m.text.length) result.push({ type: "text", data: { text: m.text.slice(pos) } });
  return result;
}

// Media URLs originate in chat events. Pin each lookup to a public address,
// except for the owner-configured endpoint itself.
const privateV4 = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(address, bits);
function publicAddress(ip: string) {
  return isIP(ip) === 4
    ? !privateV4.check(ip)
    : /^[23][0-9a-f]{3}:/i.test(ip) && !ip.startsWith("2002:") && !ip.startsWith("2001:0:");
}

async function fromUrl(raw: string, path: string, endpointOrigin: string) {
  let url = new URL(raw);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Unsupported attachment URL");
    const trusted = url.origin === endpointOrigin;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!trusted && isIP(host) && !publicAddress(host)) throw new Error("Invalid attachment address");
    const client = url.protocol === "https:" ? https : http;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      client
        .get(
          url,
          {
            signal: AbortSignal.timeout(120000),
            agent: false,
            lookup: (name, options, cb) =>
              lookup(name, { ...options, all: true }, (error, addresses) => {
                const allowed = addresses?.filter((item) => trusted || publicAddress(item.address));
                const first = allowed?.[0];
                if (error || !first) cb(error ?? new Error("Invalid attachment address"), "", 4);
                else if (options.all) cb(null, allowed);
                else cb(null, first.address, first.family);
              }),
          },
          resolve,
        )
        .on("error", reject);
    });
    if (response.statusCode === 200) {
      await pipeline(response, createWriteStream(path));
      return;
    }
    response.destroy();
    if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0) || !response.headers.location) break;
    url = new URL(response.headers.location, url);
  }
  throw new Error("Attachment URL is unavailable");
}

export async function download(call: Call, handle: string, target: string, endpointOrigin: string) {
  const { type, file, url, kind, peer, sourceFile } = JSON.parse(handle) as Record<string, string>;
  const temp = `${target}.${randomUUID()}.part`;
  async function retrieve() {
    if (await saveResult({ url, file: sourceFile || file })) return;
    if (!file) throw new Error("Attachment is unavailable");
    const action =
      type === "file"
        ? kind === "group"
          ? "get_group_file_url"
          : "get_private_file_url"
        : type === "record"
          ? "get_record"
          : type === "image"
            ? "get_image"
            : "get_file";
    const params =
      type === "file"
        ? { file_id: file, ...(kind === "group" ? { group_id: wireId(peer ?? "") } : { user_id: wireId(peer ?? "") }) }
        : { file, ...(type === "record" ? { out_format: "mp3" } : {}) };
    async function saveResult(result: Fields) {
      if (typeof result.base64 === "string") {
        await writeFile(temp, Buffer.from(result.base64, "base64"));
        return true;
      }
      for (const location of new Set([id(result.url), id(result.file)].filter(Boolean))) {
        if (/^https?:\/\//i.test(location)) {
          try {
            await fromUrl(location, temp, endpointOrigin);
            return true;
          } catch {}
        }
      }
      return false;
    }
    if (await saveResult(object(await call(action, params).catch(() => undefined)))) return;
    if (type === "file" && (await saveResult(object(await call("get_file", { file_id: file }).catch(() => undefined)))))
      return;
    const fd = openSync(temp, "w");
    let index = 0,
      bytes = 0;
    try {
      const done = object(
        await call("download_file_stream", { file_id: file }, (chunk) => {
          if (chunk.data_type === "file_info") return;
          if (chunk.data_type !== "file_chunk" || chunk.index !== index || typeof chunk.data !== "string")
            throw new Error("Invalid attachment stream");
          const data = Buffer.from(chunk.data, "base64");
          if (chunk.size !== data.length || writeSync(fd, data) !== data.length)
            throw new Error("Incomplete attachment chunk");
          bytes += data.length;
          index++;
        }),
      );
      if (done.data_type !== "file_complete" || done.total_chunks !== index || done.total_bytes !== bytes)
        throw new Error("Incomplete attachment stream");
    } finally {
      closeSync(fd);
    }
  }
  try {
    await retrieve();
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
