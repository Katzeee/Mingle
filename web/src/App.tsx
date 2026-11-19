import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPage } from "./AgentPage.tsx";
import { type AgentView, ApiError, api, captureToken } from "./api.ts";
import { ConnectPage } from "./Connect.tsx";
import { I18n, type MessageKey, translator, useI18n, useLocaleSettings } from "./i18n.ts";
import iconUrl from "./icon.svg";
import { NewAgent } from "./NewAgent.tsx";
import { onNavigateRequest } from "./online.ts";
import { usePolling } from "./poll.ts";
import { SettingsPage } from "./Settings.tsx";
import { KEYS, keysAria, useShellShortcuts } from "./shortcuts.ts";
import {
  AgentStatusText,
  Avatar,
  Button,
  Eyebrow,
  PlusIcon,
  SettingsIcon,
  Shortcut,
  UpdateIcon,
  Waiting,
} from "./ui.tsx";
import { updates, useUpdates } from "./updates.ts";
import { Welcome } from "./Welcome.tsx";

export type View =
  | { kind: "home" }
  | { kind: "new"; lead?: string }
  | { kind: "settings" }
  | { kind: "agent"; slug: string }
  | { kind: "connect"; slug: string; platform?: string };

function viewFromPath(): View {
  const path = location.pathname;
  if (path === "/new") {
    const lead = new URLSearchParams(location.search).get("lead");
    return lead ? { kind: "new", lead } : { kind: "new" };
  }
  if (path === "/settings") return { kind: "settings" };
  const connect = /^\/a\/([^/]+)\/connect(?:\/([^/]+))?/.exec(path);
  if (connect?.[1]) {
    const slug = decodeURIComponent(connect[1]);
    return connect[2] ? { kind: "connect", slug, platform: connect[2] } : { kind: "connect", slug };
  }
  const agent = /^\/a\/([^/]+)/.exec(path);
  return agent?.[1] ? { kind: "agent", slug: decodeURIComponent(agent[1]) } : { kind: "home" };
}

function pathFor(view: View): string {
  switch (view.kind) {
    case "agent":
      return `/a/${encodeURIComponent(view.slug)}`;
    case "connect":
      return `/a/${encodeURIComponent(view.slug)}/connect${view.platform ? `/${view.platform}` : ""}`;
    case "new":
      return view.lead ? `/new?lead=${encodeURIComponent(view.lead)}` : "/new";
    case "settings":
      return "/settings";
    default:
      return "/";
  }
}

// The desktop app's window injects `window.mygo`. On macOS the window is translucent and the
// sidebar shows its material; Windows and Linux windows are opaque and keep the usual colours.
if ("mygo" in window && /Mac/.test(navigator.userAgent)) document.documentElement.dataset.shell = "desktop";

export function App() {
  const { locale, localePreference, setLocale } = useLocaleSettings();
  const i18n = useMemo(
    () => ({ t: translator(locale), locale, localePreference, setLocale }),
    [locale, localePreference, setLocale],
  );
  return (
    <I18n.Provider value={i18n}>
      <Shell />
    </I18n.Provider>
  );
}

export type Navigate = (view: View, options?: { replace?: boolean }) => void;

function Shell() {
  const { t } = useI18n();
  const [token, setToken] = useState(captureToken);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [version, setVersion] = useState("");
  const [problem, setProblem] = useState<"offline" | "unauthorized" | null>(token ? null : "unauthorized");
  const [view, setView] = useState<View>(viewFromPath);
  const [menuOpen, setMenuOpen] = useState(() => new URLSearchParams(location.search).get("menu") === "1");
  const [collapsed, toggleTeam] = useCollapsedTeams();

  const navigate: Navigate = useCallback((next, options) => {
    if (options?.replace) history.replaceState(null, "", pathFor(next));
    else history.pushState(null, "", pathFor(next));
    setView(next);
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    const onPop = () => setView(viewFromPath());
    // A fresh `mingle open` link pasted into an existing tab only changes the fragment.
    const onHash = () => {
      const next = captureToken();
      setToken(next);
      setView(viewFromPath());
      if (next) setProblem(null);
    };
    addEventListener("popstate", onPop);
    addEventListener("hashchange", onHash);
    // The menu bar icon opens an agent's page in the desktop app.
    const offNavigate = onNavigateRequest((path) => {
      history.pushState(null, "", path);
      setView(viewFromPath());
      setMenuOpen(false);
    });
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("hashchange", onHash);
      offNavigate();
    };
  }, []);

  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const status = await api.status();
      if (version !== refreshVersion.current) return;
      setAgents(status.agents);
      setVersion(status.version);
      setProblem(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setProblem(e instanceof ApiError && e.status === 401 ? "unauthorized" : "offline");
    }
  }, []);

  usePolling(refresh, 2000, Boolean(token));

  useShellShortcuts({
    newAgent: () => navigate({ kind: "new" }),
    settings: () => navigate({ kind: "settings" }),
    agent: (index) => {
      // ⌘1–⌘9 count the rows the sidebar shows, members under their lead.
      const agent = sidebarRows(agents ?? [], collapsed)[index]?.agent;
      if (agent) navigate({ kind: "agent", slug: agent.slug });
    },
    escape: () => setMenuOpen(false),
  });

  // A new agent goes into the list right away, so routing to its page does not race the next
  // status poll and fall back to the first agent.
  const created = useCallback(
    async (agent: AgentView) => {
      setAgents((list) => (list && !list.some((a) => a.id === agent.id) ? [...list, agent] : list));
      await refresh();
    },
    [refresh],
  );

  if (problem === "unauthorized") return <Unauthorized />;

  const slug = view.kind === "agent" || view.kind === "connect" ? view.slug : undefined;
  const current = slug ? agents?.find((a) => a.slug === slug) : undefined;

  let page: React.ReactNode =
    agents === null && problem === null ? (
      <div className="px-6 py-6 md:px-8">
        <Waiting>{t("app.loading")}</Waiting>
      </div>
    ) : null;
  if (agents !== null) {
    if (view.kind === "settings") page = <SettingsPage version={version} />;
    else if (view.kind === "new")
      page = (
        <NewAgent
          first={agents.length === 0}
          taken={agents.map((a) => a.name)}
          lead={view.lead ? agents.find((a) => a.slug === view.lead || a.id === view.lead) : undefined}
          onNavigate={navigate}
          onCreated={created}
        />
      );
    else if (view.kind === "connect" && current)
      page = <ConnectPage agent={current} platform={view.platform} onNavigate={navigate} onChanged={refresh} />;
    else if (current)
      page = <AgentPage key={current.id} agent={current} agents={agents} onNavigate={navigate} onChanged={refresh} />;
    else if (agents.length === 0) page = <Welcome onStart={() => navigate({ kind: "new" })} />;
    else {
      // Nothing chosen, or a link to an agent that is gone: show the first one.
      const first = agents[0] as AgentView;
      queueMicrotask(() => navigate({ kind: "agent", slug: first.slug }, { replace: true }));
    }
  }

  // The first run is one focused flow: no sidebar until the first agent exists.
  const bare = agents !== null && agents.length === 0 && view.kind !== "settings";

  return (
    <div className="flex h-full">
      {bare ? null : (
        <aside className="sidebar hidden w-[220px] shrink-0 border-r border-line bg-wing md:flex">
          <Sidebar
            agents={agents ?? []}
            view={view}
            currentId={current?.id}
            onNavigate={navigate}
            collapsed={collapsed}
            onToggleTeam={toggleTeam}
          />
        </aside>
      )}

      {menuOpen && !bare ? (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="flex w-[260px] max-w-[85%] bg-wing shadow-card">
            <Sidebar
              agents={agents ?? []}
              view={view}
              currentId={current?.id}
              onNavigate={navigate}
              collapsed={collapsed}
              onToggleTeam={toggleTeam}
            />
          </div>
          <button
            type="button"
            aria-label={t("nav.close")}
            className="flex-1 bg-black/25"
            onClick={() => setMenuOpen(false)}
          />
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {bare ? null : (
          <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
            <Button variant="ghost" small aria-label={t("nav.menu")} onClick={() => setMenuOpen(true)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Button>
            <span className="truncate font-semibold">{current?.name ?? t("app.title")}</span>
          </div>
        )}
        {problem === "offline" ? (
          <div role="alert" className="shrink-0 border-b border-amber-line bg-amber-tint px-6 py-2 text-small">
            {t("error.offline")}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">{page}</div>
      </main>
    </div>
  );
}

const COLLAPSED_KEY = "mingle.teams.collapsed";

/** Which leads' teams are folded in the sidebar, kept on this computer. */
function useCollapsedTeams(): [ReadonlySet<string>, (leadId: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((leadId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/**
 * The sidebar's rows (docs/spec.md 4.13, DESIGN.md "团队"): each agent in its place, a lead's
 * members right under it, one level deep. Members of a folded team are not shown.
 */
export function sidebarRows(
  agents: readonly AgentView[],
  collapsed: ReadonlySet<string>,
): { agent: AgentView; member: boolean; members: AgentView[] }[] {
  const ids = new Set(agents.map((a) => a.id));
  const membersOf = (lead: AgentView) => agents.filter((a) => a.leadId === lead.id && !a.remote);
  const rows: { agent: AgentView; member: boolean; members: AgentView[] }[] = [];
  for (const agent of agents) {
    // A member sits under its lead; one whose lead is not listed stands on its own.
    if (agent.leadId && ids.has(agent.leadId) && !agent.remote) continue;
    const members = agent.remote ? [] : membersOf(agent);
    rows.push({ agent, member: false, members });
    if (!collapsed.has(agent.id)) for (const m of members) rows.push({ agent: m, member: true, members: [] });
  }
  return rows;
}

function Sidebar({
  agents,
  view,
  currentId,
  onNavigate,
  collapsed,
  onToggleTeam,
}: {
  agents: AgentView[];
  view: View;
  currentId: string | undefined;
  onNavigate: Navigate;
  collapsed: ReadonlySet<string>;
  onToggleTeam: (leadId: string) => void;
}) {
  const { t } = useI18n();
  const update = useUpdates();
  const row =
    "flex w-full items-center gap-2.5 rounded-control px-2.5 text-left transition-colors duration-[120ms] hover:bg-black/5 dark:hover:bg-white/5 aria-[current=page]:bg-sel";
  // Only what needs the user: an update that is ready, or one they install themselves.
  // An update downloading in the background shows nothing until it is ready.
  const offer = update?.available && (update.ready || !update.automaticDownloads) ? update : null;
  return (
    <div className="flex min-w-0 flex-1 flex-col px-2 pb-3">
      {/* The brand row: in the desktop app it sits right of the traffic lights and moves the window. */}
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 pr-1.5 pl-[max(10px,calc(var(--mygo-titlebar-inset-left,0px)+2px))]">
        <span className="font-semibold">{t("app.title")}</span>
      </div>
      <Eyebrow>{t("sidebar.agents")}</Eyebrow>
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {sidebarRows(agents, collapsed).map(({ agent: a, member, members }, i, rows) => {
          const on = currentId === a.id;
          // One name per chat app, even with several bots in it.
          const apps = [...new Set(a.connections.map((c) => c.platform))]
            .map((p) => t(`platform.${p}` as MessageKey))
            .join(t("list.separator"));
          const keys = KEYS.agent(i);
          const folded = collapsed.has(a.id);
          // A folded team still says when someone in it is at work.
          const busy = folded ? members.filter((m) => m.status === "working" || m.status === "thinking").length : 0;
          const more = [apps, busy ? t("sidebar.teamBusy", { count: String(busy) }) : ""]
            .filter(Boolean)
            .join(t("list.separator"));
          const firstMember = member && !rows[i - 1]?.member;
          const lastMember = member && !rows[i + 1]?.member;
          // The hairline runs from the lead's avatar to the last member's, across the gaps between rows.
          const line = firstMember
            ? `-top-[11px] ${lastMember ? "h-[calc(50%+11px)]" : "bottom-0"}`
            : `-top-[2px] ${lastMember ? "h-[calc(50%+2px)]" : "bottom-0"}`;
          return (
            <div key={a.id} className={`group/row relative ${member ? "pl-[30px]" : ""}`}>
              {member ? (
                // One hairline joins a team's members to their lead, from its avatar down.
                <span aria-hidden className={`absolute left-[23px] w-px bg-line2 ${line}`} />
              ) : null}
              <Shortcut label={a.name} keys={keys} side="right">
                <button
                  type="button"
                  title={keys ? undefined : a.name}
                  aria-keyshortcuts={keys ? keysAria(keys) : undefined}
                  onClick={() => onNavigate({ kind: "agent", slug: a.slug })}
                  aria-current={on ? "page" : undefined}
                  className={`${row} ${member ? "min-h-[40px] gap-2 py-1" : "min-h-[46px] py-1.5"} ${members.length ? "pr-8" : ""}`}
                >
                  <Avatar name={a.name} src={a.avatar} size={member ? 22 : 28} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate font-medium ${member ? "text-small" : ""}`}>{a.name}</span>
                    <span className="truncate text-caption text-ink2">
                      <AgentStatusText status={a.status} where={a.remote} more={more} />
                    </span>
                  </span>
                </button>
              </Shortcut>
              {members.length ? (
                <button
                  type="button"
                  aria-expanded={!folded}
                  aria-label={t(folded ? "sidebar.teamExpand" : "sidebar.teamCollapse", { name: a.name })}
                  title={t(folded ? "sidebar.teamExpand" : "sidebar.teamCollapse", { name: a.name })}
                  onClick={() => onToggleTeam(a.id)}
                  className={`absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-small text-ink3 transition-[opacity,background-color] duration-[120ms] hover:bg-black/5 hover:text-ink2 focus-visible:opacity-100 dark:hover:bg-white/5 ${folded ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                    className={`transition-transform duration-[180ms] ${folded ? "-rotate-90" : ""}`}
                  >
                    <path
                      d="M2 3.5l3 3 3-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
          );
        })}
        <Shortcut label={t("agents.new")} keys={KEYS.newAgent} side="right">
          <button
            type="button"
            onClick={() => onNavigate({ kind: "new" })}
            aria-keyshortcuts={keysAria(KEYS.newAgent)}
            aria-current={view.kind === "new" ? "page" : undefined}
            className={`${row} h-8 text-ink2 hover:text-ink`}
          >
            <PlusIcon className="mx-1.5" />
            {t("agents.new")}
          </button>
        </Shortcut>
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-line pt-2">
        {offer ? (
          <button
            type="button"
            title={t(offer.ready ? "update.ready" : "update.available", { version: offer.available ?? "" })}
            onClick={() => (offer.ready ? updates.restart() : updates.check())}
            className="flex h-8 w-full items-center gap-2.5 rounded-control bg-accent-tint px-2.5 text-left font-medium text-accent transition-[filter] duration-[120ms] hover:brightness-95 dark:hover:brightness-125"
          >
            <UpdateIcon className="mx-1.5" />
            <span className="min-w-0 flex-1 truncate">
              {offer.ready ? t("update.restart") : t("update.install", { version: offer.available ?? "" })}
            </span>
          </button>
        ) : null}
        <Shortcut label={t("settings.title")} keys={KEYS.settings} side="right">
          <button
            type="button"
            onClick={() => onNavigate({ kind: "settings" })}
            aria-keyshortcuts={keysAria(KEYS.settings)}
            aria-current={view.kind === "settings" ? "page" : undefined}
            className={`${row} h-8 text-ink2 hover:text-ink aria-[current=page]:text-ink`}
          >
            <SettingsIcon className="mx-1.5" />
            {t("settings.title")}
          </button>
        </Shortcut>
      </div>
    </div>
  );
}

function Unauthorized() {
  const { t } = useI18n();
  return (
    <main className="drag flex h-full items-start justify-center bg-bg px-6">
      <div className="flex max-w-[440px] flex-col gap-3 pt-32">
        <img src={iconUrl} alt="" className="mb-2 size-12 rounded-[12px]" />
        <h1 className="text-title2 font-semibold">{t("auth.title")}</h1>
        <p className="text-ink2">{t("auth.body")}</p>
        <code className="self-start rounded-control bg-bg3 px-3 py-1.5 font-mono text-small">mingle open</code>
      </div>
    </main>
  );
}
