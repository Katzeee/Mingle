import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { type AgentView, api } from "./api.ts";
import { errorText, useI18n } from "./i18n.ts";
import { Avatar, Button, Group, GroupRow, Input, Section } from "./ui.tsx";

/** The crop square on screen, and the picture Mingle keeps: square, sharp on a Retina sidebar. */
const STAGE = 176;
const OUTPUT = 256;
const MAX_ZOOM = 4;
/** Bigger files are almost always a mistake (a RAW photo); decoding them would stall the page. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

interface Crop {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  /** The picture's centre, from the stage's centre, in stage pixels. */
  readonly x: number;
  readonly y: number;
}

/** How big the picture is drawn at this zoom, and how far it may move before a gap shows. */
function frame(crop: Crop, zoom = crop.zoom) {
  const scale = (STAGE / Math.min(crop.width, crop.height)) * zoom;
  const w = crop.width * scale;
  const h = crop.height * scale;
  return { scale, w, h, maxX: (w - STAGE) / 2, maxY: (h - STAGE) / 2 };
}

function clampCrop(crop: Crop): Crop {
  const { maxX, maxY } = frame(crop);
  return { ...crop, x: Math.max(-maxX, Math.min(maxX, crop.x)), y: Math.max(-maxY, Math.min(maxY, crop.y)) };
}

/** The square the person framed, as a PNG. */
async function render(crop: Crop): Promise<Blob> {
  const image = new Image();
  image.src = crop.url;
  await image.decode();
  const { scale, w, h } = frame(crop);
  const left = (STAGE - w) / 2 + crop.x;
  const top = (STAGE - h) / 2 + crop.y;
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, -left / scale, -top / scale, STAGE / scale, STAGE / scale, 0, 0, OUTPUT, OUTPUT);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"),
  );
}

/** The framed picture at any size: the crop stage itself, and the previews beside it. */
function Framed({ crop, size }: { crop: Crop; size: number }) {
  const k = size / STAGE;
  const { w, h } = frame(crop);
  return (
    <span
      aria-hidden
      className="relative block shrink-0 overflow-hidden bg-bg3"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <img
        alt=""
        src={crop.url}
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{
          width: w * k,
          height: h * k,
          left: ((STAGE - w) / 2 + crop.x) * k,
          top: ((STAGE - h) / 2 + crop.y) * k,
        }}
      />
    </span>
  );
}

/** The agent's name and picture, at the top of its settings. */
export function Profile({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  return (
    <Section title={t("profile.title")}>
      <Group>
        <PictureRow agent={agent} onSaved={onSaved} />
        <NameRow agent={agent} onSaved={onSaved} />
      </Group>
      <p className="px-1 text-caption text-ink3">{t("profile.onlyHere")}</p>
    </Section>
  );
}

function PictureRow({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The object URL lives as long as the crop that shows it.
  const url = crop?.url;
  useEffect(() => (url ? () => URL.revokeObjectURL(url) : undefined), [url]);

  function open(file: File | undefined) {
    if (!file) return;
    setFailure(null);
    if (file.size > MAX_INPUT_BYTES) {
      setFailure(t("profile.tooLarge"));
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        URL.revokeObjectURL(url);
        setFailure(t("profile.unreadable"));
        return;
      }
      setCrop({ url, width: image.naturalWidth, height: image.naturalHeight, zoom: 1, x: 0, y: 0 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setFailure(t("profile.unreadable"));
    };
    image.src = url;
  }

  async function save() {
    if (!crop) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.setAvatar(agent.id, await render(crop));
      setCrop(null);
      onSaved();
    } catch (error) {
      // Keep the crop open, so the framing is not lost.
      setFailure(errorText(t, error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      await api.clearAvatar(agent.id);
      onSaved();
    } catch (error) {
      setFailure(errorText(t, error));
    } finally {
      setBusy(false);
    }
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      open(e.dataTransfer.files[0]);
    },
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => {
        open(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );

  if (crop) {
    return (
      <div className="flex flex-col gap-4 px-4 py-4" {...drop}>
        {picker}
        <div className="rise flex flex-wrap items-center gap-6">
          <CropStage crop={crop} onChange={setCrop} />
          <div className="flex min-w-[180px] flex-1 flex-col gap-4">
            <Zoom crop={crop} onChange={setCrop} />
            <div className="flex items-end gap-3">
              <Framed crop={crop} size={44} />
              <Framed crop={crop} size={28} />
            </div>
            <p className="text-caption text-ink3">{t("profile.adjust")}</p>
          </div>
        </div>
        {failure ? <p className="text-small text-red">{failure}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" small disabled={busy} onClick={save}>
            {t("agent.save")}
          </Button>
          <Button variant="ghost" small disabled={busy} onClick={() => input.current?.click()}>
            {t("profile.another")}
          </Button>
          <Button variant="ghost" small disabled={busy} onClick={() => setCrop(null)}>
            {t("agent.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div {...drop} className={`flex flex-col transition-colors duration-[120ms] ${dragging ? "bg-accent-tint" : ""}`}>
      {picker}
      <GroupRow className="flex-wrap">
        <button
          type="button"
          aria-label={agent.avatar ? t("profile.change") : t("profile.choose")}
          disabled={busy}
          onClick={() => input.current?.click()}
          className="group relative shrink-0 rounded-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Avatar name={agent.name} src={agent.avatar} size={44} />
          <span
            aria-hidden
            className="absolute inset-0 rounded-[12px] ring-1 ring-black/5 ring-inset transition-colors duration-[120ms] group-hover:bg-black/15 dark:ring-white/10"
          />
        </button>
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{t("profile.picture")}</span>
          <span className="text-caption text-ink3">{dragging ? t("profile.dropNow") : t("profile.pictureHint")}</span>
        </span>
        <span className="flex shrink-0 gap-1.5">
          {agent.avatar ? (
            <Button variant="ghost" small disabled={busy} onClick={remove}>
              {t("profile.remove")}
            </Button>
          ) : null}
          <Button small disabled={busy} onClick={() => input.current?.click()}>
            {agent.avatar ? t("profile.change") : t("profile.choose")}
          </Button>
        </span>
      </GroupRow>
      {failure ? <p className="px-4 pb-3 text-small text-red">{failure}</p> : null}
    </div>
  );
}

/** Drag the picture to frame it; arrow keys move it, + and − zoom. */
function CropStage({ crop, onChange }: { crop: Crop; onChange: (crop: Crop) => void }) {
  const { t } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; from: Crop } | null>(null);
  const latest = useRef(crop);
  latest.current = crop;

  // A trackpad pinch or a wheel zooms; listened to natively so the page does not scroll as well.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = latest.current;
      const zoom = Math.max(1, Math.min(MAX_ZOOM, c.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
      onChange(clampCrop({ ...c, zoom, x: (c.x * zoom) / c.zoom, y: (c.y * zoom) / c.zoom }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [onChange]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: crop };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    onChange(clampCrop({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }));
  };
  const up = () => {
    drag.current = null;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 16 : 4;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const by = moves[e.key];
    if (by) {
      e.preventDefault();
      onChange(clampCrop({ ...crop, x: crop.x + by[0], y: crop.y + by[1] }));
    } else if (e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault();
      const zoom = Math.max(1, Math.min(MAX_ZOOM, crop.zoom + (e.key === "-" ? -0.1 : 0.1)));
      onChange(clampCrop({ ...crop, zoom, x: (crop.x * zoom) / crop.zoom, y: (crop.y * zoom) / crop.zoom }));
    }
  };

  return (
    <div
      ref={stage}
      role="slider"
      tabIndex={0}
      aria-label={t("profile.stage")}
      aria-valuetext={t("profile.adjust")}
      aria-valuemin={100}
      aria-valuemax={MAX_ZOOM * 100}
      aria-valuenow={Math.round(crop.zoom * 100)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      className="relative shrink-0 cursor-grab touch-none rounded-[49px] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent active:cursor-grabbing"
    >
      <Framed crop={crop} size={STAGE} />
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[49px] ring-1 ring-line ring-inset" />
    </div>
  );
}

function Zoom({ crop, onChange }: { crop: Crop; onChange: (crop: Crop) => void }) {
  const { t } = useI18n();
  const glyph = (size: number) => (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="shrink-0 text-ink3">
      <rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m3.5 11.5 3-3 2 2 1.5-1.5 2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
  return (
    <label className="flex items-center gap-2.5">
      <span className="sr-only">{t("profile.zoom")}</span>
      {glyph(12)}
      <input
        type="range"
        min={1}
        max={MAX_ZOOM}
        step={0.01}
        value={crop.zoom}
        onChange={(e) => {
          const zoom = Number(e.target.value);
          onChange(clampCrop({ ...crop, zoom, x: (crop.x * zoom) / crop.zoom, y: (crop.y * zoom) / crop.zoom }));
        }}
        className="h-1 min-w-0 flex-1 accent-[var(--accent)]"
      />
      {glyph(16)}
    </label>
  );
}

function NameRow({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(agent.name);
  }, [agent.name, editing]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (draft.trim() === agent.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await api.updateAgent(agent.id, { name: draft });
      setEditing(false);
      onSaved();
    } catch (error) {
      setFailure(errorText(t, error));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-2 px-4 py-2.5">
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">{t("profile.name")}</span>
          <Input
            autoFocus
            aria-label={t("profile.name")}
            className="!w-[220px] max-w-full"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
        </div>
        {failure ? <p className="text-small text-red">{failure}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" small disabled={busy} onClick={() => setEditing(false)}>
            {t("agent.cancel")}
          </Button>
          <Button variant="primary" small type="submit" disabled={busy || !draft.trim()}>
            {t("agent.save")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <GroupRow>
      <span className="shrink-0">{t("profile.name")}</span>
      <span className="min-w-0 flex-1 truncate text-right text-ink2" title={agent.name}>
        {agent.name}
      </span>
      <Button
        variant="ghost"
        small
        onClick={() => {
          setFailure(null);
          setEditing(true);
        }}
      >
        {t("agent.edit")}
      </Button>
    </GroupRow>
  );
}
