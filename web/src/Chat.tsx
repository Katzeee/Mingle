import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type AgentView, api, type ChatFile, type ChatMessage, type ChatUpload } from "./api.ts";
import { peek, remember } from "./cache.ts";
import { errorText, type MessageKey, statusDetailText, type Translate, useI18n } from "./i18n.ts";
import { Markdown } from "./markdown.tsx";
import { usePolling } from "./poll.ts";
import { Avatar, Problem, Spinner, StatusDot, shortDateTime } from "./ui.tsx";

/**
 * The owner's private chat with the agent (docs/spec.md 6.9, DESIGN.md "Agent · 私聊"): the same
 * agent and memory as in the chat apps, one conversation with no sessions. The owner's messages sit
 * right on a quiet fill; the agent's read as the page, without a bubble.
 */

type Pending = { key: string; text: string; files: ChatUpload[]; state: "sending" | "failed"; error?: string };
type Attachment = { key: string; name: string; state: "uploading" | "ready" | "failed"; upload?: ChatUpload };

const draftKey = (id: string) => `mingle.chatDraft.${id}`;

function readDraft(id: string): string {
  try {
    return localStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(id: string, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {}
}

/** Where the person's system shows a file: Finder, Explorer, or the folder elsewhere. */
function revealLabel(): MessageKey {
  const ua = navigator.userAgent;
  return /Mac/.test(ua)
    ? "privateChat.revealMac"
    : /Windows/.test(ua)
      ? "privateChat.revealWindows"
      : "privateChat.revealOther";
}

export function PrivateChat({
  agent,
  top,
  onRetry,
  onIgnore,
}: {
  agent: AgentView;
  /** What the page says above the chat: paused, unreachable, a notice. */
  top?: ReactNode;
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const cacheKey = `chat:${agent.id}`;
  const [messages, setMessages] = useState<ChatMessage[] | null>(() => peek<ChatMessage[]>(cacheKey) ?? null);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState(() => readDraft(agent.id));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const keep = useRef<number | null>(null);
  const reading = useRef(false);

  const paused = agent.status === "paused";
  const busy = agent.status === "thinking" || agent.status === "working";
  const waitingForAnswer =
    !paused &&
    (messages ?? []).some((m) => m.direction === "in" && (m.state === "received" || m.state === "delivered"));

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const page = await api.chat(agent.id, { watching: document.hasFocus() });
      setMessages((current) => {
        const ids = new Set(page.messages.map((m) => m.id));
        // Earlier pages the owner scrolled back to, and a message just sent that this read began
        // too early to see, stay; the latest page replaces what it covers.
        const kept = (current ?? []).filter((m) => !ids.has(m.id));
        if (!kept.some((m) => m.createdAt <= (page.messages[0]?.createdAt ?? 0))) setMore(page.more);
        const merged = [...kept, ...page.messages].sort((a, b) => a.createdAt - b.createdAt);
        return remember(cacheKey, merged);
      });
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      reading.current = false;
    }
  }, [agent.id, cacheKey]);
  usePolling(refresh, waitingForAnswer || busy || pending.length > 0 ? 1000 : 3000);

  // Another agent: its own chat, draft and attachments.
  useEffect(() => {
    setMessages(peek<ChatMessage[]>(cacheKey) ?? null);
    setMore(false);
    setLoadError(false);
    setPending([]);
    setAttachments([]);
    setText(readDraft(agent.id));
    nearBottom.current = true;
  }, [agent.id, cacheKey]);

  useEffect(() => saveDraft(agent.id, text), [agent.id, text]);

  // New messages keep the view at the bottom, unless the owner scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what is shown changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, waitingForAnswer]);

  const loadEarlier = async () => {
    const first = messages?.[0];
    if (!first || earlier || !more) return;
    setEarlier(true);
    try {
      const page = await api.chat(agent.id, { before: first.id });
      const el = scroller.current;
      if (el) keep.current = el.scrollHeight - el.scrollTop;
      setMessages((current) => {
        const known = new Set((current ?? []).map((m) => m.id));
        return [...page.messages.filter((m) => !known.has(m.id)), ...(current ?? [])];
      });
      setMore(page.more);
    } catch {
      // The next scroll up tries again.
    } finally {
      setEarlier(false);
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120) void loadEarlier();
  };

  // ------------------------------------------------------------ composing

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(grow, [text]);

  const attach = (files: readonly File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      setAttachments((list) => [...list, { key, name: file.name, state: "uploading" }]);
      api
        .upload(agent.id, file)
        .then((upload) =>
          setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: "ready", upload } : a))),
        )
        .catch(() => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: "failed" } : a))));
    }
    input.current?.focus();
  };

  const ready = attachments.filter((a) => a.state === "ready" && a.upload).map((a) => a.upload as ChatUpload);
  const uploading = attachments.some((a) => a.state === "uploading");
  const canSend = !paused && !uploading && (text.trim().length > 0 || ready.length > 0);

  const deliver = async (item: Pending) => {
    try {
      const sent = await api.say(
        agent.id,
        item.text,
        item.files.map((f) => f.id),
      );
      // In the list at once, in the same render the pending copy leaves: no gap while a read is in flight.
      setMessages((current) =>
        current?.some((m) => m.id === sent.id) ? current : remember(cacheKey, [...(current ?? []), sent]),
      );
      setPending((list) => list.filter((p) => p.key !== item.key));
      void refresh();
    } catch (error) {
      setPending((list) =>
        list.map((p) => (p.key === item.key ? { ...p, state: "failed", error: errorText(t, error) } : p)),
      );
    }
  };

  const send = () => {
    if (!canSend) return;
    const item: Pending = { key: `p${Date.now()}`, text: text.trim(), files: ready, state: "sending" };
    setPending((list) => [...list, item]);
    setText("");
    setAttachments([]);
    nearBottom.current = true;
    void deliver(item);
  };

  const onDrag = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files") || paused) return;
    event.preventDefault();
    setDragging(event.type !== "dragleave" || event.currentTarget.contains(event.relatedTarget as Node | null));
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length || paused) return;
    event.preventDefault();
    setDragging(false);
    attach([...event.dataTransfer.files]);
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!event.clipboardData.files.length) return;
    event.preventDefault();
    attach([...event.clipboardData.files]);
  };

  const placeholder = paused
    ? t("privateChat.placeholderPaused", { name: agent.name })
    : dragging
      ? t("privateChat.drop")
      : busy && waitingForAnswer
        ? t("privateChat.placeholderBusy", { name: agent.name })
        : t("privateChat.placeholder", { name: agent.name });

  const empty = messages !== null && messages.length === 0 && pending.length === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files anywhere on the chat adds them
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onDrag}
      onDrop={onDrop}
    >
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[680px] flex-col px-6 pt-6 pb-2 md:px-8">
          {top ? <div className="mb-6 flex flex-col gap-4">{top}</div> : null}
          {loadError && messages === null ? (
            <Problem title={t("privateChat.loadFailed")} />
          ) : messages === null ? (
            <p role="status" className="flex items-center gap-2 text-small text-ink2">
              <Spinner />
              {t("privateChat.loading")}
            </p>
          ) : empty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 pb-10 text-center">
              <Avatar name={agent.name} src={agent.avatar} size={56} />
              <h2 className="mt-3 text-title3 font-semibold">{t("privateChat.emptyTitle", { name: agent.name })}</h2>
              <p className="max-w-[400px] text-ink2">{t("privateChat.emptyBody", { name: agent.name })}</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {earlier ? (
                <p role="status" className="mb-4 flex items-center justify-center gap-2 text-caption text-ink3">
                  <Spinner size={12} />
                  {t("privateChat.loadingEarlier")}
                </p>
              ) : null}
              <MessageList
                agent={agent}
                messages={messages}
                pending={pending}
                onRetry={onRetry}
                onIgnore={onIgnore}
                onResend={(item) => {
                  setPending((list) => list.map((p) => (p.key === item.key ? { ...p, state: "sending" } : p)));
                  void deliver(item);
                }}
              />
              {waitingForAnswer || pending.some((p) => p.state === "sending") ? <Typing agent={agent} t={t} /> : null}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pt-2 pb-5 md:px-8">
        <div
          className={`mx-auto max-w-[680px] rounded-card border transition-[border-color,box-shadow,background-color] duration-[120ms] ${
            dragging
              ? "border-dashed border-accent bg-accent-tint"
              : "border-line2 bg-card focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20"
          } ${paused ? "opacity-55" : ""}`}
        >
          {attachments.length ? (
            <div className="flex flex-wrap gap-2 px-3 pt-2.5">
              {attachments.map((a) => (
                <span
                  key={a.key}
                  className={`flex h-7 max-w-[240px] items-center gap-1.5 rounded-control border pr-1 pl-2 text-caption ${
                    a.state === "failed" ? "border-red-line bg-red-tint text-red" : "border-line2 bg-bg2 text-ink2"
                  }`}
                  title={a.state === "failed" ? t("privateChat.uploadFailed", { name: a.name }) : a.name}
                >
                  {a.state === "uploading" ? <Spinner size={12} /> : <FileIcon />}
                  <span className="min-w-0 truncate">{a.name}</span>
                  <button
                    type="button"
                    aria-label={t("privateChat.remove", { name: a.name })}
                    onClick={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
                    className="flex size-5 shrink-0 items-center justify-center rounded-small text-ink3 hover:bg-bg3 hover:text-ink"
                  >
                    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={input}
            rows={1}
            value={text}
            disabled={paused}
            aria-label={t("privateChat.placeholder", { name: agent.name })}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              // Return sends, as in every chat; Shift-Return starts a new line.
              if (event.shiftKey) return;
              event.preventDefault();
              send();
            }}
            className="selectable block max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-body text-ink outline-none placeholder:text-ink3 disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 px-2 pt-1 pb-2">
            <button
              type="button"
              disabled={paused}
              aria-label={t("privateChat.attach")}
              title={t("privateChat.attach")}
              onClick={() => picker.current?.click()}
              className="flex size-7 items-center justify-center rounded-small text-ink2 enabled:hover:bg-bg3 enabled:hover:text-ink disabled:opacity-45"
            >
              <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M13.5 7.5 7.9 13.1a3.3 3.3 0 0 1-4.7-4.7l5.9-5.9a2.2 2.2 0 0 1 3.1 3.1l-5.9 5.9a1.1 1.1 0 0 1-1.6-1.6l5.4-5.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attach([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <span className="flex-1" />
            <button
              type="button"
              aria-label={t("privateChat.send")}
              title={t("privateChat.send")}
              disabled={!canSend}
              onClick={send}
              className="flex size-7 items-center justify-center rounded-control bg-accent-btn text-white transition-[background-color,filter] duration-[120ms] enabled:hover:brightness-110 disabled:bg-bg3 disabled:text-ink3"
            >
              <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 12V2M2.5 6.5 7 2l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        {empty || paused ? null : (
          <p className="mx-auto mt-1.5 max-w-[680px] truncate text-center text-caption text-ink3">
            {t("privateChat.hint", { name: agent.name })}
          </p>
        )}
      </div>
    </div>
  );
}

/** The day a run of messages was said on: "Today", "Yesterday", or the date. */
function dayLabel(ms: number, locale: string): string {
  const date = new Date(ms);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(date) - start(new Date())) / 86_400_000);
  if (days === 0 || days === -1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    weekday: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function MessageList({
  agent,
  messages,
  pending,
  onRetry,
  onIgnore,
  onResend,
}: {
  agent: AgentView;
  messages: ChatMessage[];
  pending: Pending[];
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
  onResend: (item: Pending) => void;
}) {
  const { t, locale } = useI18n();
  const rows: ReactNode[] = [];
  let day = "";
  for (const m of messages) {
    const label = dayLabel(m.createdAt, locale);
    if (label !== day) {
      day = label;
      rows.push(
        <p key={`d${m.id}`} className="my-3 text-center text-caption text-ink3 first:mt-0">
          {label}
        </p>,
      );
    }
    rows.push(
      m.direction === "in" ? (
        <OwnerMessage key={m.id} agent={agent} message={m} onRetry={onRetry} onIgnore={onIgnore} />
      ) : (
        <AgentMessage key={m.id} agent={agent} message={m} />
      ),
    );
  }
  for (const p of pending) {
    rows.push(
      <div key={p.key} className="rise mb-5 flex flex-col items-end gap-1.5">
        {p.text ? <Bubble text={p.text} /> : null}
        {p.files.map((f) => (
          <span
            key={f.id}
            className="flex max-w-[78%] items-center gap-2 rounded-card border border-line bg-card px-3 py-2"
          >
            <FileIcon />
            <span className="truncate text-small">{f.name}</span>
          </span>
        ))}
        {p.state === "failed" ? (
          <p className="flex flex-wrap items-center justify-end gap-1.5 text-caption text-red">
            <StatusDot state="error" />
            {t("privateChat.notSent")}
            {p.error ? <span className="text-ink3">{p.error}</span> : null}
            <button
              type="button"
              className="min-h-7 px-1 font-medium text-accent hover:underline"
              onClick={() => onResend(p)}
            >
              {t("privateChat.sendAgain")}
            </button>
          </p>
        ) : null}
      </div>,
    );
  }
  return <>{rows}</>;
}

function Bubble({ text }: { text: string }) {
  return (
    <p className="selectable max-w-[78%] rounded-card bg-bg3 px-3 py-2 whitespace-pre-wrap wrap-anywhere">{text}</p>
  );
}

function OwnerMessage({
  agent,
  message: m,
  onRetry,
  onIgnore,
}: {
  agent: AgentView;
  message: ChatMessage;
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const actions = (
    <>
      <button
        type="button"
        className="min-h-7 px-1 font-medium text-accent hover:underline"
        onClick={() => void onRetry([m.id])}
      >
        {t("agent.retry")}
      </button>
      <button
        type="button"
        className="min-h-7 px-1 font-medium text-ink2 hover:underline"
        onClick={() => void onIgnore([m.id])}
      >
        {t("agent.ignore")}
      </button>
    </>
  );
  return (
    <div className="mb-5 flex flex-col items-end gap-1.5">
      {m.body ? <Bubble text={m.body} /> : null}
      {m.files.map((f) => (
        <FileCard key={f.id} agent={agent} file={f} mine />
      ))}
      {m.line?.started ? (
        <p className="flex max-w-[78%] min-w-0 items-center gap-1.5 text-caption text-ink3">
          <LineArrow />
          <span className="truncate">
            {t("line.started", { title: m.line.title })}
            {" · "}
            {m.line.state === "running" ? t("line.now") : t(`line.${m.line.state}` as MessageKey)}
          </span>
        </p>
      ) : null}
      {m.state === "waiting" ? (
        <p className="flex flex-wrap items-center justify-end gap-1.5 text-caption text-amber">
          <StatusDot state="awaiting_approval" />
          {m.retryAt ? t("agent.waitingUntil", { time: shortDateTime(m.retryAt, locale) }) : t("agent.waiting")}
        </p>
      ) : m.state === "failed" ? (
        <p className="flex flex-wrap items-center justify-end gap-1.5 text-caption text-red">
          <StatusDot state="error" />
          {t("agent.failed")}
          {actions}
        </p>
      ) : m.state === "unanswered" ? (
        <p className="flex flex-wrap items-center justify-end gap-1.5 text-caption text-amber">
          <StatusDot state="awaiting_approval" />
          {t("agent.unanswered")}
          {actions}
        </p>
      ) : m.state === "ignored" ? (
        <p className="text-caption text-ink3">{t("agent.ignored")}</p>
      ) : null}
    </div>
  );
}

function AgentMessage({ agent, message: m }: { agent: AgentView; message: ChatMessage }) {
  const { locale } = useI18n();
  const time = new Date(m.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="rise mb-5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Avatar name={agent.name} src={agent.avatar} size={20} />
        <span className="font-semibold">{agent.name}</span>
        <span className="text-caption text-ink3">{time}</span>
      </div>
      <div className="selectable flex flex-col gap-2 pl-7 wrap-anywhere">
        {m.body ? <Markdown text={m.body} /> : null}
        {m.files.map((f) => (
          <FileCard key={f.id} agent={agent} file={f} />
        ))}
      </div>
    </div>
  );
}

/** The agent at work on what the owner said: the same words as the page header. */
function Typing({ agent, t }: { agent: AgentView; t: Translate }) {
  const working = agent.status === "working";
  return (
    <div role="status" className="rise mb-5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Avatar name={agent.name} src={agent.avatar} size={20} />
        <span className="font-semibold">{agent.name}</span>
      </div>
      <p className="flex min-w-0 items-center gap-2 pl-7 text-small text-ink3">
        <Spinner size={12} />
        <span className="truncate">
          {working ? t("privateChat.working") : t("privateChat.thinking")}
          {working && agent.statusDetail ? ` · ${statusDetailText(t, agent.statusDetail)}` : ""}
        </span>
      </p>
    </div>
  );
}

function formatSize(bytes: number | null, locale: string): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u ? 1 : 0 }).format(n)} ${units[u]}`;
}

/** A file in the chat: a picture shows itself; anything can be saved, or shown where it is on this computer. */
function FileCard({ agent, file, mine = false }: { agent: AgentView; file: ChatFile; mine?: boolean }) {
  const { t, locale } = useI18n();
  const image = Boolean(file.mime?.startsWith("image/")) && file.mime !== "image/heic";
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!image) return;
    let url: string | null = null;
    let live = true;
    api
      .chatFile(agent.id, file.id)
      .then((blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [agent.id, file.id, image]);
  const save = async () => {
    const blob = await api.chatFile(agent.id, file.id).catch(() => null);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const kind = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toUpperCase() : "";
  return (
    <div className={`flex max-w-[78%] flex-col gap-1.5 ${mine ? "items-end" : "items-start"}`}>
      {preview ? (
        <img
          src={preview}
          alt={file.name}
          className="max-h-60 max-w-full rounded-card border border-line object-contain"
          draggable={false}
        />
      ) : null}
      <div className="flex max-w-full items-center gap-2.5 rounded-card border border-line bg-card py-2 pr-3 pl-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-small bg-bg2 text-ink2">
          <FileIcon />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-small font-medium" title={file.name}>
            {file.name}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-caption text-ink3">
            {[kind, formatSize(file.size, locale)].filter(Boolean).join(" · ")}
            {agent.remote ? null : (
              <button
                type="button"
                className="font-medium text-accent hover:underline"
                onClick={() => void api.revealFile(agent.id, file.id).catch(() => {})}
              >
                {t(revealLabel())}
              </button>
            )}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => void save()}>
              {t("privateChat.save")}
            </button>
          </span>
        </span>
      </div>
    </div>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <path d="M3 1.5h5l3 3v8H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function LineArrow() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
      <path
        d="M2 2.5v3.5a2 2 0 0 0 2 2h5.5M7.5 6l2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
