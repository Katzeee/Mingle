import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentEnv } from "./AgentEnv.tsx";
import type { Navigate } from "./App.tsx";
import {
  type AccessRequest,
  type Activity,
  type AgentView,
  ApiError,
  api,
  type ConnectionView,
  type HandoffView,
  type Harness,
  type Reminder,
  type Task,
} from "./api.ts";
import {
  BotPage,
  ChatAppList,
  ChevronIcon,
  ClaimCode,
  connectionDetail,
  focusChatAppRow,
  ReconnectButton,
} from "./ChatApps.tsx";
import { fetchCached, peek, remember, useCached } from "./cache.ts";
import { HandoffItem, HandoffSection } from "./Handoff.tsx";
import { errorText, type MessageKey, statusDetailText, useI18n } from "./i18n.ts";
import { ModelPicker } from "./NewAgent.tsx";
import { online, useOnline } from "./online.ts";
import { Profile } from "./Profile.tsx";
import { PlatformIcon } from "./platforms.tsx";
import { usePolling } from "./poll.ts";
import { OnlineRows } from "./Settings.tsx";
import {
  AgentStatusText,
  ApiKeyHint,
  Avatar,
  Button,
  copyText,
  Group,
  GroupRow,
  HarnessIcon,
  PageHeader,
  PauseIcon,
  PlayIcon,
  Problem,
  relativeTime,
  Section,
  Segmented,
  Select,
  StatusDot,
  Step,
  Steps,
  shortDateTime,
  Textarea,
  Waiting,
} from "./ui.tsx";

type WorkData = { tasks: Task[]; reminders: Reminder[] };

export function AgentPage({
  agent,
  onNavigate,
  onChanged,
}: {
  agent: AgentView;
  onNavigate: Navigate;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  // The last activity and work seen for an agent show at once when its page opens again.
  const [activity, setActivity] = useState<Activity[] | null>(() => peek<Activity[]>(`activity:${agent.id}`) ?? null);
  const [work, setWork] = useState<WorkData | null>(() => peek<WorkData>(`work:${agent.id}`) ?? null);
  const [handoffs, setHandoffs] = useState<HandoffView[] | null>(
    () => peek<HandoffView[]>(`handoffs:${agent.id}`) ?? null,
  );
  const [activityError, setActivityError] = useState(false);
  const [workError, setWorkError] = useState(false);
  const activityPending = useRef(false);
  const workPending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"activity" | "settings">("activity");
  const connectionsRef = useRef<HTMLElement>(null);
  const handoffRef = useRef<HTMLDivElement>(null);
  const [handoffRequest, setHandoffRequest] = useState(0);
  const [manageRequest, setManageRequest] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The bot whose own page is open in settings; null shows the settings list.
  const [bot, setBot] = useState<string | null>(null);
  const openBot = agent.connections.find((c) => c.id === bot);
  // Back from a bot's page lands on its row; a removed bot has no row to land on.
  const [backTo, setBackTo] = useState<string | null>(null);

  // From the getting-started card: land on the handoff section of the settings.
  useLayoutEffect(() => {
    if (handoffRequest === 0) return;
    handoffRef.current?.scrollIntoView({ block: "start" });
    handoffRef.current?.focus({ preventScroll: true });
  }, [handoffRequest]);

  // From the side panel's Manage: land on the settings chat apps, even when already there.
  useLayoutEffect(() => {
    if (manageRequest === 0) return;
    connectionsRef.current?.scrollIntoView({ block: "start" });
    connectionsRef.current?.focus({ preventScroll: true });
  }, [manageRequest]);

  // A bot's page opens at its top; back on the list, its row is where the eye was.
  useLayoutEffect(() => {
    if (bot) scrollerRef.current?.scrollTo({ top: 0 });
  }, [bot]);
  useLayoutEffect(() => {
    if (!backTo || bot) return;
    focusChatAppRow(backTo);
    setBackTo(null);
  }, [backTo, bot]);
  // The bot was removed (here or elsewhere): its page has nothing left to show.
  useEffect(() => {
    if (bot && !openBot) setBot(null);
  }, [bot, openBot]);

  // Each resource guards itself: a slow call is not superseded by the next poll, and one
  // request in flight does not hold back the other resource. `fresh` lets a remount read
  // again even if a previous mount's read is still resolving; only the latest read caches.
  const refreshActivity = useCallback(async () => {
    if (activityPending.current) return;
    activityPending.current = true;
    try {
      const [items, handed] = await Promise.all([
        fetchCached(`activity:${agent.id}`, () => api.activity(agent.id), true),
        fetchCached(`handoffs:${agent.id}`, () => api.handoffs(agent.id), true),
      ]);
      setActivity(items);
      setHandoffs(handed);
      setActivityError(false);
    } catch {
      setActivityError(true);
    } finally {
      activityPending.current = false;
    }
  }, [agent.id]);
  const refreshWork = useCallback(async () => {
    if (workPending.current) return;
    workPending.current = true;
    try {
      setWork(await fetchCached(`work:${agent.id}`, () => api.work(agent.id), true));
      setWorkError(false);
    } catch {
      setWorkError(true);
    } finally {
      workPending.current = false;
    }
  }, [agent.id]);
  /** The owner closed a task or cancelled a reminder: gone from the list at once, then read again. */
  const dropWork = useCallback(
    (kind: "tasks" | "reminders", id: string) => {
      setWork((current) => {
        if (!current) return current;
        const next =
          kind === "tasks"
            ? { ...current, tasks: current.tasks.filter((x) => x.id !== id) }
            : { ...current, reminders: current.reminders.filter((x) => x.id !== id) };
        return remember(`work:${agent.id}`, next);
      });
      void refreshWork();
    },
    [agent.id, refreshWork],
  );
  const refresh = useCallback(() => {
    void refreshActivity();
    void refreshWork();
  }, [refreshActivity, refreshWork]);

  // Switching to another agent starts from what was last seen for it.
  useEffect(() => {
    setActivity(peek<Activity[]>(`activity:${agent.id}`) ?? null);
    setWork(peek<WorkData>(`work:${agent.id}`) ?? null);
    setHandoffs(peek<HandoffView[]>(`handoffs:${agent.id}`) ?? null);
    setActivityError(false);
    setWorkError(false);
    setConfirmDelete(false);
    setPauseFailure(null);
    setNotice(null);
    setTab("activity");
    setManageRequest(0);
    setHandoffRequest(0);
    setBot(null);
    setBackTo(null);
  }, [agent.id]);
  usePolling(refresh, 2500);

  // A notice answers one click; it must not outlive what it describes.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a notice belongs to the tab it was shown on
  useEffect(() => setNotice(null), [tab]);

  const busy = agent.status === "thinking" || agent.status === "working";
  const paused = agent.status === "paused";
  const [switching, setSwitching] = useState(false);
  const [pauseFailure, setPauseFailure] = useState<string | null>(null);
  // The settings row answers in place, where the click was: it already reads "paused" or not, and
  // a failure shows under it. The top notice is only for the paused card, which sits up there.
  const setPaused = async (pause: boolean, from: "card" | "row" = "card") => {
    setSwitching(true);
    setPauseFailure(null);
    try {
      await (pause ? api.pause(agent.id) : api.resume(agent.id));
      if (from === "card") setNotice(t(pause ? "agent.pausedNotice" : "agent.resumed", { name: agent.name }));
    } catch (error) {
      if (from === "row") setPauseFailure(errorText(t, error));
      else setNotice(errorText(t, error));
    } finally {
      setSwitching(false);
    }
    await onChanged();
    refresh();
  };
  const retry = async (ids: string[]) => {
    try {
      const { retried, offline } = await api.retry(agent.id, ids);
      const bots = agent.connections
        .filter((c) => offline.includes(c.id))
        .map((c) => c.bot ?? t(`platform.${c.platform}` as MessageKey));
      setNotice(
        retried.length > 0
          ? t("agent.retrying", { count: String(retried.length), name: agent.name })
          : bots.length > 0
            ? t("agent.retryOffline", { bot: bots.join(", ") })
            : t("agent.retryNothing"),
      );
    } catch (error) {
      setNotice(errorText(t, error));
    }
    refresh();
  };
  const ignore = async (ids: string[]) => {
    try {
      const { ignored } = await api.ignore(agent.id, ids);
      const changed = new Set(ignored);
      setActivity((items) => items?.map((m) => (changed.has(m.id) ? { ...m, state: "ignored" } : m)) ?? null);
      setNotice(
        ignored.length ? t("agent.ignoredNotice", { count: String(ignored.length) }) : t("agent.ignoreUnchanged"),
      );
    } catch (error) {
      setNotice(errorText(t, error));
    }
    refresh();
  };
  const decide = async (request: AccessRequest, access: "allowed" | "blocked") => {
    const name = requestName(t, request);
    try {
      await api.setAccess(agent.id, request.kind, request.id, access);
      setNotice(t(access === "allowed" ? "needs.allowed" : "needs.declined", { name, agent: agent.name }));
    } catch (error) {
      setNotice(errorText(t, error));
    }
    await onChanged();
    refresh();
  };
  const connect = () => onNavigate({ kind: "connect", slug: agent.slug });
  const unanswered = (activity ?? []).filter((m) => m.direction === "in" && m.state === "unanswered");
  const failed = (activity ?? []).filter((m) => m.direction === "in" && m.state === "failed");
  const troubled = agent.connections.filter((c) => c.state === "error" || c.state === "awaiting_approval");

  // With no bot left, the side panel is where to add one again (the getting-started card is gone by then).
  const hasNeeds =
    agent.connections.length > 0 ||
    agent.hasReplied ||
    troubled.length > 0 ||
    agent.requests.length > 0 ||
    unanswered.length > 0 ||
    failed.length > 0;
  const needsYou = hasNeeds ? (
    <NeedsYou
      agent={agent}
      unanswered={unanswered.map((m) => m.id)}
      failed={failed.map((m) => m.id)}
      troubled={troubled}
      onRetry={retry}
      onIgnore={ignore}
      onDecide={decide}
      onConnect={connect}
    />
  ) : null;

  return (
    <>
      <PageHeader
        leading={<Avatar name={agent.name} src={agent.avatar} size={26} />}
        title={agent.name}
        meta={
          agent.remote?.reachable === false ? (
            t("ssh.unknown")
          ) : (
            <AgentStatusText status={agent.status} detail={agent.statusDetail} />
          )
        }
        actions={
          <>
            <Segmented
              label={t("agent.view")}
              value={tab}
              onChange={setTab}
              options={[
                { value: "activity", label: t("agent.tabActivity") },
                { value: "settings", label: t("agent.tabSettings") },
              ]}
            />
            {busy ? (
              <Button
                small
                title={t("agent.stopHint")}
                onClick={async () => {
                  try {
                    const { stopped } = await api.stop(agent.id);
                    setNotice(t(stopped ? "agent.stopped" : "agent.idleNothing"));
                  } catch (error) {
                    setNotice(errorText(t, error));
                  }
                }}
              >
                {t("agent.stop")}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="flex max-w-[680px] flex-col gap-7 px-6 py-6 md:px-8">
            {agent.remote ? (
              <p className="selectable break-words text-small text-ink2">
                {t("ssh.runningOn", { host: agent.remote.host })}
                {agent.remote.reachable ? ` · ${t("ssh.independent")}` : null}
              </p>
            ) : null}
            {agent.remote?.reachable === false ? (
              <p role="status" className="rounded-control border border-line bg-bg2 p-3 text-small text-ink2">
                {t("ssh.unreachable")}
              </p>
            ) : null}
            {notice ? <p className="rise -mb-3 text-small text-ink2">{notice}</p> : null}
            {paused ? <PausedCard name={agent.name} disabled={switching} onResume={() => setPaused(false)} /> : null}
            {agent.status === "error" ? <AgentError agent={agent} /> : null}

            {tab === "settings" && openBot ? (
              <BotPage
                agent={agent}
                connection={openBot}
                onBack={() => {
                  setBackTo(openBot.id);
                  setBot(null);
                }}
                onChanged={() => {
                  void onChanged();
                  // A renamed person shows by the new name in the activity right away.
                  void refreshActivity();
                }}
              />
            ) : tab === "settings" ? (
              <>
                <Profile agent={agent} onSaved={onChanged} />
                <RoleEditor agent={agent} onSaved={onChanged} />
                <Brain agent={agent} onSaved={onChanged} />
                <section
                  ref={connectionsRef}
                  aria-label={t("agent.chatApps")}
                  tabIndex={-1}
                  className="rounded-card focus:outline-2 focus:outline-offset-4 focus:outline-accent"
                >
                  <ChatAppList
                    agent={agent}
                    onOpen={setBot}
                    onConnect={connect}
                    onChanged={() => {
                      void onChanged();
                      void refreshActivity();
                    }}
                  />
                </section>
                <AgentEnv agent={agent} />
                <div ref={handoffRef} tabIndex={-1} className="rounded-card focus:outline-none">
                  <HandoffSection agent={agent} handoffs={handoffs} onSent={() => void refreshActivity()} />
                </div>
                <Section title={t("agent.lifecycle")}>
                  <Group>
                    <GroupRow className="flex-wrap">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>
                          {paused
                            ? t("agent.pausedTitle", { name: agent.name })
                            : t("agent.pauseTitle", { name: agent.name })}
                        </span>
                        <span className="text-caption text-ink2">
                          {paused
                            ? t("agent.pausedBody")
                            : busy
                              ? `${t("agent.pauseBody")} ${t("agent.pauseBusy")}`
                              : t("agent.pauseBody")}
                        </span>
                      </span>
                      {paused ? (
                        <Button small disabled={switching} onClick={() => setPaused(false, "row")}>
                          <PlayIcon />
                          {t("agent.resume")}
                        </Button>
                      ) : (
                        <Button small disabled={switching} onClick={() => setPaused(true, "row")}>
                          <PauseIcon />
                          {t("agent.pause")}
                        </Button>
                      )}
                      {pauseFailure ? <p className="w-full text-caption text-red">{pauseFailure}</p> : null}
                    </GroupRow>
                    <ResetRow key={agent.id} agent={agent} busy={busy} disabled={switching} />
                    <DiagnosticsRow key={`d-${agent.id}`} agent={agent} />
                  </Group>
                </Section>
                <Section title={t("agent.home")}>
                  <Group>
                    <GroupRow>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>{t("agent.homeTitle")}</span>
                        <span className="selectable truncate font-mono text-caption text-ink2" title={agent.home}>
                          {agent.home}
                        </span>
                      </span>
                      {!agent.remote ? (
                        <Button small onClick={() => api.openHome(agent.id)}>
                          {t("agent.openHome")}
                        </Button>
                      ) : null}
                    </GroupRow>
                    <DeleteRow
                      agent={agent}
                      confirming={confirmDelete}
                      onAsk={() => setConfirmDelete(true)}
                      onCancel={() => setConfirmDelete(false)}
                      onDeleted={async () => {
                        // Refresh first: with the old list, "home" would pick the deleted agent again.
                        await onChanged();
                        onNavigate({ kind: "home" }, { replace: true });
                      }}
                    />
                  </Group>
                </Section>
              </>
            ) : (
              <>
                {!agent.hasReplied ? (
                  <GettingStarted
                    agent={agent}
                    heard={(activity ?? []).some((m) => m.direction === "in" && m.state !== "held")}
                    onConnect={connect}
                    onChanged={onChanged}
                    onHandoff={() => {
                      setTab("settings");
                      setBot(null);
                      setHandoffRequest((n) => n + 1);
                    }}
                  />
                ) : null}
                {agent.connections.some((c) => c.state === "connected") ? <KeepOnline /> : null}
                {/* Narrow windows have no right panel: what needs the person comes first. */}
                {needsYou ? <div className="flex flex-col gap-7 min-[1140px]:hidden">{needsYou}</div> : null}
                <Section title={t("agent.activity")}>
                  {activityError ? <LoadProblem title={t("agent.activityFailed")} onRetry={refreshActivity} /> : null}
                  {activity === null ? (
                    activityError ? null : (
                      <Waiting>{t("agent.activityLoading")}</Waiting>
                    )
                  ) : activity.length > 0 || (handoffs ?? []).length > 0 ? (
                    <ActivityList
                      agent={agent}
                      items={activity}
                      handoffs={handoffs ?? []}
                      onRetry={retry}
                      onIgnore={ignore}
                    />
                  ) : activityError ? null : (
                    <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-bg2 p-5">
                      <svg
                        width="28"
                        height="28"
                        viewBox="0 0 24 24"
                        fill="none"
                        className="text-ink2"
                        aria-hidden="true"
                      >
                        <path
                          d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                        <path d="M7 10h8M7 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <div className="flex flex-col gap-1">
                        <h3 className="font-semibold">{t("agent.noActivity")}</h3>
                        <p className="text-small text-ink2">{t("agent.noActivityBody")}</p>
                        {agent.connections.length === 0 ? (
                          <p className="text-small text-ink2">{t("agent.noActivityConnect")}</p>
                        ) : null}
                      </div>
                      {agent.hasReplied && agent.connections.length === 0 ? (
                        <Button onClick={connect}>{t("start.connectAction")}</Button>
                      ) : null}
                    </div>
                  )}
                </Section>
                <div className="flex flex-col gap-7 min-[1140px]:hidden">
                  <Work agentId={agent.id} work={work} error={workError} onRetry={refreshWork} onDropped={dropWork} />
                </div>
              </>
            )}
          </div>
        </div>
        <aside className="hidden w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-wing px-4 py-5 min-[1140px]:flex">
          {needsYou}
          {/* Settings lists the same bots with their controls; the panel glances at them only beside the activity. */}
          {tab === "activity" && agent.connections.length ? (
            <ChatAppsSummary
              agent={agent}
              onManage={(connectionId) => {
                setTab("settings");
                setBot(connectionId ?? null);
                if (!connectionId) setManageRequest((n) => n + 1);
              }}
            />
          ) : null}
          <Work agentId={agent.id} work={work} error={workError} onRetry={refreshWork} onDropped={dropWork} />
        </aside>
      </div>
    </>
  );
}

/** Until the agent has answered someone: the steps that get it there, and where it is. */
function GettingStarted({
  agent,
  heard,
  onConnect,
  onChanged,
  onHandoff,
}: {
  agent: AgentView;
  heard: boolean;
  onConnect: () => void;
  onChanged: () => Promise<void> | void;
  onHandoff: () => void;
}) {
  const { t } = useI18n();
  const connected = agent.connections.find((c) => c.state === "connected");
  // A bot that does not know its owner yet: claiming it is how to say hello, or the first message waits.
  const unclaimed = agent.connections.find((c) => c.state === "connected" && c.claim);
  const any = agent.connections.length > 0;
  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-card px-5 py-4 shadow-card">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-headline font-semibold">{t("start.title")}</h2>
        <p className="text-small text-ink2">{t("start.body", { name: agent.name })}</p>
      </div>
      <Steps>
        <Step n={1} state="done" title={t("start.created")} />
        <Step n={2} state={any ? "done" : "now"} title={t("start.connect")}>
          <p className="text-small text-ink2">{t("start.connectBody")}</p>
          <Button variant="primary" className="self-start" onClick={onConnect}>
            {t("start.connectAction")}
          </Button>
        </Step>
        <Step n={3} state={!any ? "later" : heard && !unclaimed ? "done" : "now"} title={t("start.say")}>
          {unclaimed ? (
            <ClaimCode connection={unclaimed} onChanged={onChanged} />
          ) : (
            <>
              <p className="text-small text-ink2">
                {connected ? t(`${connected.platform}.qr3` as MessageKey) : t("start.sayBody")}
              </p>
              {connected ? <Waiting>{t("start.waiting")}</Waiting> : <Waiting>{t("start.waitingConnection")}</Waiting>}
            </>
          )}
        </Step>
        <Step n={4} state={heard && !unclaimed ? "now" : "later"} title={t("start.reply")}>
          {agent.status === "paused" ? (
            <p className="text-small text-ink2">{t("start.replyPaused", { name: agent.name })}</p>
          ) : agent.status === "error" ? (
            <p className="text-small text-red">{t("start.replyFailed", { name: agent.name })}</p>
          ) : !connected ? (
            <p className="text-small text-ink2">{t("start.replyDisconnected")}</p>
          ) : agent.status === "thinking" || agent.status === "working" ? (
            <Waiting>{t("start.replying", { name: agent.name })}</Waiting>
          ) : (
            <p className="text-small text-ink2">{t("start.replyIdle", { name: agent.name })}</p>
          )}
        </Step>
      </Steps>
      <p className="border-t border-line pt-3 text-small text-ink2">
        {t("handoff.startHint", { name: agent.name })}{" "}
        <button type="button" className="text-accent hover:underline" onClick={onHandoff}>
          {t("handoff.startAction", { name: agent.name })}
        </button>
      </p>
    </section>
  );
}

/**
 * A paused agent, on both tabs: what pausing means for the people who write to it, and the way
 * back. Not a problem box: the owner chose this, nothing is broken.
 */
function PausedCard({ name, disabled, onResume }: { name: string; disabled: boolean; onResume: () => void }) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("agent.pausedTitle", { name })}
      className="rise flex flex-col gap-3 rounded-card border border-line bg-bg2 px-4 py-3.5 sm:flex-row sm:items-start"
    >
      <PauseIcon className="mt-0.5 hidden text-ink2 sm:block" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-headline font-semibold wrap-anywhere">{t("agent.pausedTitle", { name })}</h2>
        <p className="text-small text-ink2">{t("agent.pausedBody")}</p>
      </div>
      <Button variant="primary" className="self-start" disabled={disabled} onClick={onResume}>
        <PlayIcon />
        {t("agent.resume")}
      </Button>
    </section>
  );
}

/** Failure classes the console explains; anything else shows the generic text. */
const FAILURES = ["auth", "quota", "billing", "model_unavailable", "busy", "input_too_large", "not_installed"] as const;

function failureKey(failure: string | null): (typeof FAILURES)[number] | "unknown" {
  if (failure === "rate_limited" || failure === "overloaded" || failure === "provider") return "busy";
  return (FAILURES as readonly string[]).includes(failure ?? "") ? (failure as (typeof FAILURES)[number]) : "unknown";
}

/** Why the agent stopped, in plain words and with the next step; the harness's own words underneath. */
function AgentError({ agent }: { agent: AgentView }) {
  const { t } = useI18n();
  if (agent.statusDetail) {
    const detail = statusDetailText(t, agent.statusDetail);
    if (detail !== agent.statusDetail) {
      return (
        <Problem title={t("failure.unknown.title" as MessageKey, { name: agent.name })} tone="red">
          <span className="selectable wrap-anywhere">{detail}</span>
        </Problem>
      );
    }
  }
  const key = failureKey(agent.statusFailure);
  const vars = { harness: agent.harnessName, name: agent.name };
  return (
    <Problem title={t(`failure.${key}.title` as MessageKey, vars)} tone="red">
      <p>{t(`failure.${key}.body` as MessageKey, vars)}</p>
      {key === "auth" ? <ApiKeyHint harness={agent.harness} /> : null}
      {agent.statusDetail ? (
        <p className="selectable mt-1 font-mono text-caption text-ink3 wrap-anywhere">{agent.statusDetail}</p>
      ) : null}
    </Problem>
  );
}

/**
 * Once an agent can be reached, the desktop app offers what keeps it reachable: opening at
 * login and staying awake on power (docs/spec.md 9.1). Shown until the person closes it.
 */
function KeepOnline() {
  const { t } = useI18n();
  const state = useOnline();
  if (!state || state.cardDismissed) return null;
  return (
    <Section
      title={t("online.title")}
      action={
        <Button small onClick={() => online.dismissCard()}>
          {t("online.done")}
        </Button>
      }
    >
      <p className="px-1 text-small text-ink2">{t("online.body")}</p>
      <Group>
        <OnlineRows state={state} notifications={false} />
      </Group>
      <p className="px-1 text-caption text-ink3">{t("online.later")}</p>
    </Section>
  );
}

function NeedsYou({
  agent,
  unanswered,
  failed,
  troubled,
  onConnect,
  onRetry,
  onIgnore,
  onDecide,
}: {
  agent: AgentView;
  unanswered: string[];
  failed: string[];
  troubled: ConnectionView[];
  onConnect: () => void;
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
  onDecide: (request: AccessRequest, access: "allowed" | "blocked") => Promise<void>;
}) {
  const { t } = useI18n();
  // Retrying while the harness still fails only fails again; say so, but let the person try.
  const messageActions = (ids: string[]) => (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <MessageActions onRetry={() => onRetry(ids)} onIgnore={() => onIgnore(ids)} />
      {agent.status === "error" ? <span className="text-caption text-ink3">{t("needs.retryFirst")}</span> : null}
    </div>
  );
  const items = [
    ...troubled.map((c) => (
      <Problem
        key={c.id}
        tone={c.state === "error" ? "red" : "amber"}
        title={`${c.bot ?? t(`platform.${c.platform}` as MessageKey)} · ${t(`connection.${c.state}` as MessageKey)}`}
      >
        {c.state === "error" ? (
          <>
            {connectionDetail(t, c)}
            <div className="mt-2">
              <ReconnectButton connection={c} />
            </div>
          </>
        ) : (
          t("connection.approvalHint")
        )}
      </Problem>
    )),
    ...agent.requests.map((r) => (
      <AccessRequestItem key={`${r.kind}:${r.id}`} agent={agent} request={r} onDecide={onDecide} />
    )),
    ...(failed.length > 0
      ? [
          <Problem key="failed" tone="red" title={t("needs.failed", { count: String(failed.length) })}>
            {t("needs.failedBody", { name: agent.name })}
            {messageActions(failed)}
          </Problem>,
        ]
      : []),
    ...(unanswered.length > 0
      ? [
          <Problem key="unanswered" title={t("needs.unanswered", { count: String(unanswered.length) })}>
            {t("needs.unansweredBody", { name: agent.name })}
            {messageActions(unanswered)}
          </Problem>,
        ]
      : []),
  ];
  // No bot left (the last one removed): nobody can reach the agent, so that comes first.
  if (agent.connections.length === 0 && agent.hasReplied) {
    items.unshift(
      <Problem key="no-bot" title={t("connection.none")}>
        <div className="mt-1">
          <Button small onClick={onConnect}>
            {t("start.connectAction")}
          </Button>
        </div>
      </Problem>,
    );
  }
  if (agent.connections.length === 0 && items.length === 0) return null;
  return (
    <Section title={t("needs.title")}>
      {items.length ? (
        <div className="flex flex-col gap-2">{items}</div>
      ) : (
        <p className="flex items-center gap-2 px-1 text-small text-ink2">
          <StatusDot state="connected" /> {t("needs.none")}
        </p>
      )}
    </Section>
  );
}

/** What to call a person or group asking to talk to the agent. */
function requestName(t: ReturnType<typeof useI18n>["t"], r: { kind: string; name: string | null }): string {
  return r.name ?? (r.kind === "group" ? t("chat.group") : t("needs.someone"));
}

/**
 * Someone new, or a new group, wrote to the agent where anyone can find it (docs/spec.md 4.7): who,
 * where, the first thing they sent, and the two answers. The agent sees nothing until then.
 */
function AccessRequestItem({
  agent,
  request,
  onDecide,
}: {
  agent: AgentView;
  request: AccessRequest;
  onDecide: (request: AccessRequest, access: "allowed" | "blocked") => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const platform = t(`platform.${request.platform}` as MessageKey);
  const title =
    request.kind === "contact"
      ? t("needs.dmRequest", { name: request.name ?? t("needs.someone"), agent: agent.name })
      : request.name
        ? t("needs.groupRequest", { name: request.name, agent: agent.name })
        : t("needs.groupRequestUnnamed", { agent: agent.name });
  const answer = async (access: "allowed" | "blocked") => {
    setBusy(true);
    try {
      await onDecide(request, access);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Problem title={title}>
      <p className="flex min-w-0 items-center gap-1.5 text-caption text-ink3">
        <PlatformIcon platform={request.platform} size={14} />
        <span className="truncate">
          {platform}
          {request.count > 1 ? ` · ${t("needs.more", { count: String(request.count - 1) })}` : ""}
        </span>
      </p>
      <p className="selectable mt-1 line-clamp-3 wrap-anywhere text-ink">
        {request.kind === "group" && request.sender ? (
          <span className="text-ink2">{t("needs.groupSender", { name: request.sender })}</span>
        ) : null}
        {request.preview}
      </p>
      <p className="mt-1">
        {t(request.kind === "contact" ? "needs.dmRequestBody" : "needs.groupRequestBody", { agent: agent.name })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button small variant="primary" disabled={busy} onClick={() => answer("allowed")}>
          {t("needs.allow")}
        </Button>
        <Button small disabled={busy} onClick={() => answer("blocked")}>
          {t("needs.decline")}
        </Button>
      </div>
    </Problem>
  );
}

/** The agent's bots at a glance, in the side panel. Each row opens that bot in settings. */
function ChatAppsSummary({ agent, onManage }: { agent: AgentView; onManage: (connectionId?: string) => void }) {
  const { t } = useI18n();
  return (
    <Section
      title={t("agent.chatApps")}
      action={
        <Button variant="ghost" small onClick={() => onManage()}>
          {t("agent.manage")}
        </Button>
      }
    >
      <Group>
        {agent.connections.map((c) => (
          <GroupRow key={c.id} className="min-h-[44px]" onClick={() => onManage(c.id)}>
            <PlatformIcon platform={c.platform} size={22} />
            <span className="min-w-0 flex-1 truncate">
              {c.bot ?? t(`platform.${c.platform}` as MessageKey)}
              {/* Two bots of one platform look alike: say whose each is. */}
              {c.ownerShared ? (
                <span className="text-ink3">
                  {" · "}
                  {c.ownerContact?.name ?? t("connection.ownerUnnamed")}
                </span>
              ) : null}
            </span>
            <StatusDot state={c.state} />
            <ChevronIcon />
          </GroupRow>
        ))}
      </Group>
    </Section>
  );
}

/** A failed load explains itself and offers a retry; it is not shown as an empty list. */
function LoadProblem({ title, onRetry }: { title: string; onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <Problem title={title}>
      <div className="flex flex-col items-start gap-2">
        <p>{t("agent.loadRetry")}</p>
        <Button small onClick={onRetry}>
          {t("agent.retry")}
        </Button>
      </div>
    </Problem>
  );
}

function Work({
  agentId,
  work,
  error,
  onRetry,
  onDropped,
}: {
  agentId: string;
  work: WorkData | null;
  error: boolean;
  onRetry: () => Promise<void>;
  onDropped: (kind: "tasks" | "reminders", id: string) => void;
}) {
  const { t, locale } = useI18n();
  if (work === null) {
    return (
      <Section title={t("agent.work")}>
        {error ? (
          <LoadProblem title={t("agent.workFailed")} onRetry={onRetry} />
        ) : (
          <Waiting>{t("agent.workLoading")}</Waiting>
        )}
      </Section>
    );
  }
  return (
    <>
      {error ? <LoadProblem title={t("agent.workFailed")} onRetry={onRetry} /> : null}
      <Section title={t("agent.tasks")}>
        {work.tasks.length === 0 ? (
          <p className="px-1 text-small text-ink2">
            {t("agent.noTasks")}
            <span className="mt-1 block">{t("agent.noTasksBody")}</span>
          </p>
        ) : (
          <Group>
            {work.tasks.map((task) => (
              <WorkRow
                key={task.id}
                label={task.title}
                action={t("task.close")}
                actionLabel={t("task.closeLabel", { title: task.title })}
                ask={t("task.closeAsk")}
                confirm={t("task.closeYes")}
                run={() => api.closeTask(agentId, task.id)}
                onDone={() => onDropped("tasks", task.id)}
                aside={
                  <span className="shrink-0 rounded-full bg-bg3 px-2 py-0.5 text-caption text-ink2">
                    {t(`task.${task.status}` as MessageKey)}
                  </span>
                }
              />
            ))}
          </Group>
        )}
      </Section>
      <Section title={t("agent.reminders")}>
        {work.reminders.length === 0 ? (
          <p className="px-1 text-small text-ink2">
            {t("agent.noReminders")}
            <span className="mt-1 block">{t("agent.noRemindersBody")}</span>
          </p>
        ) : (
          <Group>
            {work.reminders.map((r) => (
              <WorkRow
                key={r.id}
                label={r.body}
                action={t("reminder.cancel")}
                actionLabel={t("reminder.cancelLabel", { body: r.body })}
                ask={t("reminder.cancelAsk")}
                confirm={t("reminder.cancelYes")}
                danger
                run={() => api.cancelReminder(agentId, r.id)}
                onDone={() => onDropped("reminders", r.id)}
                detail={
                  <>
                    {r.nextFireAt ? shortDateTime(r.nextFireAt, locale) : ""}
                    {r.lastFiredAt ? (
                      <span className="text-ink3">
                        {" · "}
                        {t("agent.reminderLastFired", { time: shortDateTime(r.lastFiredAt, locale) })}
                      </span>
                    ) : null}
                  </>
                }
              />
            ))}
          </Group>
        )}
      </Section>
    </>
  );
}

/**
 * A task or reminder. The agent owns them; the owner's one action (close, cancel) stays out of the
 * way until the row is hovered or focused, and asks once in place, since it cannot be undone.
 */
function WorkRow({
  label,
  detail,
  aside,
  action,
  actionLabel,
  ask,
  confirm,
  danger = false,
  run,
  onDone,
}: {
  label: string;
  detail?: ReactNode;
  aside?: ReactNode;
  action: string;
  actionLabel: string;
  ask: string;
  confirm: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) actionButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  return (
    <GroupRow
      className={`group relative min-h-[44px] flex-wrap transition-colors duration-[120ms] ${confirming ? (danger ? "bg-red-tint" : "bg-bg2") : ""}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 wrap-anywhere" title={label}>
          {label}
        </span>
        {detail ? <span className="text-caption text-ink2">{detail}</span> : null}
      </span>
      {confirming ? (
        <span className="flex w-full items-center justify-end gap-1.5">
          <span className="sr-only">{ask}</span>
          <Button
            small
            variant={danger ? "danger" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                await run();
                onDone();
              } catch (error) {
                // Already gone (the agent got there first): the list catches up.
                if (error instanceof ApiError && error.status === 404) onDone();
                else setFailure(errorText(t, error));
                setConfirming(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </Button>
          <Button small variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            {t("work.keep")}
          </Button>
        </span>
      ) : (
        <>
          {aside}
          {/* Over the row's end on hover or focus, so it takes no room from the text otherwise. */}
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 bg-card pl-1 opacity-0 shadow-[-14px_0_10px_-2px_var(--color-card)] transition-opacity duration-[120ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none">
            <Button
              ref={actionButton}
              small
              variant="ghost"
              aria-label={actionLabel}
              onClick={() => setConfirming(true)}
            >
              {action}
            </Button>
          </span>
        </>
      )}
      {failure ? <p className="w-full text-caption text-red">{failure}</p> : null}
    </GroupRow>
  );
}

function RoleEditor({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.role);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(agent.role);
  }, [agent.role, editing]);

  async function save() {
    setFailure(null);
    try {
      await api.setRole(agent.id, draft);
    } catch (error) {
      // Keep the editor open with the draft, so nothing typed is lost.
      setFailure(errorText(t, error));
      return;
    }
    setEditing(false);
    setSaved(true);
    onSaved();
  }

  return (
    <Section
      title={t("agent.role")}
      action={
        editing ? null : (
          <Button
            variant="ghost"
            small
            onClick={() => {
              setEditing(true);
              setSaved(false);
            }}
          >
            {t("agent.edit")}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" small onClick={save}>
              {t("agent.save")}
            </Button>
            <Button variant="ghost" small onClick={() => setEditing(false)}>
              {t("agent.cancel")}
            </Button>
          </div>
        </div>
      ) : agent.role.trim() ? (
        <div className="selectable rounded-card border border-line bg-card px-4 py-3 whitespace-pre-wrap wrap-anywhere">
          {agent.role.trim()}
        </div>
      ) : (
        // Empty, the card is the way to write one, as it says.
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setSaved(false);
          }}
          className="rounded-card border border-line bg-card px-4 py-3 text-left text-ink3 transition-colors duration-[120ms] hover:bg-bg2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {t("agent.roleEmpty")}
        </button>
      )}
      {failure ? <p className="px-1 text-small text-red">{failure}</p> : null}
      {saved ? <p className="px-1 text-small text-ink2">{t("agent.roleSaved")}</p> : null}
    </Section>
  );
}

/** Which harness and model drive the agent. A change applies from the next message. */
function Brain({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const { value: harnesses } = useCached<Harness[]>(
    `harnesses:${agent.remote?.id ?? "local"}`,
    () => api.harnesses(agent.remote?.id),
    [],
  );
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  async function save(patch: { harness?: string; model?: string | null }) {
    setState("saving");
    setError(null);
    try {
      await api.updateAgent(agent.id, patch);
      setState("saved");
      onSaved();
    } catch (e) {
      setError(errorText(t, e));
      setState("idle");
    }
  }

  const current = harnesses?.find((h) => h.id === agent.harness);
  const why = (h: Harness) =>
    h.disabled
      ? `${h.name}${h.version ? ` ${h.version}` : ""}: ${errorText(t, { code: h.disabled.code, next: h.disabled.reason })}`
      : "";
  // Only the harness this agent uses is explained here; others say why on hover.
  const blocker = current?.disabled ? why(current) : null;
  const missingCurrent = harnesses && !current ? agent.harness : null;
  return (
    <Section title={t("create.brain")}>
      <Group>
        <GroupRow>
          {current ? <HarnessIcon harness={current} size={24} /> : null}
          <span className="min-w-0 flex-1">{t("brain.harness")}</span>
          <Select
            aria-label={t("create.brain")}
            className="!w-[220px]"
            value={agent.harness}
            disabled={!harnesses || state === "saving"}
            onChange={(e) => save({ harness: e.target.value, model: null })}
          >
            {(harnesses ?? []).map((h) => (
              <option key={h.id} value={h.id} disabled={Boolean(h.disabled)} title={why(h) || undefined}>
                {h.disabled ? `${h.name} · ${t("brain.incompatible")}` : h.name}
              </option>
            ))}
            {harnesses && !current ? <option value={agent.harness}>{agent.harness}</option> : null}
          </Select>
        </GroupRow>
        {current && !current.disabled ? (
          <GroupRow>
            <span className="min-w-0 flex-1">{t("create.model")}</span>
            <ModelPicker
              inline
              harness={agent.harness}
              value={agent.model ?? ""}
              onChange={(id) => save({ model: id || null })}
            />
          </GroupRow>
        ) : null}
      </Group>
      {missingCurrent ? (
        <p className="px-1 text-small text-red">
          {missingCurrent}: {t("error.harness_unavailable")}
        </p>
      ) : null}
      {blocker ? <p className="px-1 text-small wrap-anywhere text-red">{blocker}</p> : null}
      {error ? <p className="px-1 text-small text-red">{error}</p> : null}
      {state === "saved" ? <p className="px-1 text-small text-ink2">{t("agent.brainSaved")}</p> : null}
    </Section>
  );
}

/** The delete row asks in place: the question replaces the row the click came from. */
function DeleteRow({
  agent,
  confirming,
  onAsk,
  onCancel,
  onDeleted,
}: {
  agent: AgentView;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirming);
  useLayoutEffect(() => {
    if (wasConfirming.current && !confirming) deleteButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const cancel = () => {
    setFailure(null);
    onCancel();
  };
  return (
    <GroupRow className={`flex-wrap transition-colors duration-[120ms] ${confirming ? "bg-red-tint" : ""}`}>
      <span className="flex min-w-0 flex-1 flex-col" aria-live="polite">
        <span className={confirming ? "font-medium" : undefined}>
          {confirming ? t("agent.deleteTitle", { name: agent.name }) : t("agent.delete")}
        </span>
        <span className="text-caption text-ink2">{t("agent.deleteBody")}</span>
      </span>
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape backs out of the question it belongs to
        <span
          className="flex shrink-0 items-center gap-1.5"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) cancel();
          }}
        >
          <Button
            small
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                await api.remove(agent.id);
              } catch (error) {
                setFailure(errorText(t, error));
                setBusy(false);
                return;
              }
              await onDeleted();
            }}
          >
            {t("agent.deleteYes")}
          </Button>
          <Button small autoFocus disabled={busy} onClick={cancel}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <Button ref={deleteButton} small variant="danger" onClick={onAsk}>
          {t("agent.delete")}
        </Button>
      )}
      {failure ? <p className="w-full text-caption text-red">{failure}</p> : null}
    </GroupRow>
  );
}

/**
 * Start the agent over in a new session, for a session that is stuck or muddled. Its history is
 * gone afterwards, so it asks in place first (DESIGN.md: no modal dialogs).
 */
function ResetRow({ agent, busy, disabled }: { agent: AgentView; busy: boolean; disabled: boolean }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // When the question closes (cancelled or done), keyboard focus goes back to the button that asked it.
  const resetButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirming);
  useLayoutEffect(() => {
    if (wasConfirming.current && !confirming) resetButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const cancel = () => setConfirming(false);
  return (
    <GroupRow className={`flex-wrap transition-colors duration-[120ms] ${confirming ? "bg-amber-tint" : ""}`}>
      <span className="flex min-w-0 flex-1 flex-col" aria-live="polite">
        <span className={confirming ? "font-medium" : undefined}>
          {confirming ? t("agent.resetAsk", { name: agent.name }) : t("agent.resetTitle")}
        </span>
        <span className="text-caption text-ink2">
          {busy ? `${t("agent.resetBody")} ${t("agent.resetBusy")}` : t("agent.resetBody")}
        </span>
      </span>
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape backs out of the question it belongs to
        <span
          className="flex shrink-0 items-center gap-1.5"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) cancel();
          }}
        >
          <Button
            small
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setResult(null);
              try {
                await api.resetSession(agent.id);
                setResult({ ok: true, text: t("agent.resetDone", { name: agent.name }) });
                setConfirming(false);
              } catch (error) {
                setResult({ ok: false, text: errorText(t, error) });
              } finally {
                setPending(false);
              }
            }}
          >
            {t("agent.reset")}
          </Button>
          <Button small autoFocus disabled={pending} onClick={cancel}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <Button
          ref={resetButton}
          small
          disabled={disabled}
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
        >
          {t("agent.reset")}
        </Button>
      )}
      {result ? <p className={`w-full text-caption ${result.ok ? "text-ink2" : "text-red"}`}>{result.text}</p> : null}
    </GroupRow>
  );
}

/**
 * Copy a prompt for a local agent (Claude Code, Codex) to find why this agent misbehaves and, once the
 * owner agrees, file it on GitHub. Where copying fails, the text shows in place to select by hand.
 */
function DiagnosticsRow({ agent }: { agent: AgentView }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<
    { kind: "copied" } | { kind: "manual"; text: string } | { kind: "error"; text: string } | null
  >(null);
  useEffect(() => {
    if (state?.kind !== "copied") return;
    const timer = setTimeout(() => setState(null), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <GroupRow className="flex-wrap">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{t("agent.diagnosticsTitle")}</span>
        <span className="text-caption text-ink2">{t("agent.diagnosticsBody")}</span>
      </span>
      <Button
        small
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            const { text } = await api.diagnosisPrompt(agent.id);
            setState((await copyText(text)) ? { kind: "copied" } : { kind: "manual", text });
          } catch (error) {
            setState({ kind: "error", text: errorText(t, error) });
          } finally {
            setPending(false);
          }
        }}
      >
        {state?.kind === "copied" ? t("agent.diagnosticsCopied") : t("agent.diagnosticsCopy")}
      </Button>
      {state?.kind === "manual" ? (
        <pre className="selectable w-full overflow-x-auto rounded-control bg-bg2 p-3 font-mono text-caption whitespace-pre-wrap wrap-anywhere text-ink2">
          {state.text}
        </pre>
      ) : null}
      {state?.kind === "error" ? <p className="w-full text-caption text-red">{state.text}</p> : null}
    </GroupRow>
  );
}

/** Retry or dismiss a message; disabled while the request runs, so a double click does not send it twice. */
function MessageActions({
  onRetry,
  onIgnore,
  inline = false,
}: {
  onRetry: () => Promise<void>;
  onIgnore: () => Promise<void>;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {inline ? (
        <>
          <button
            type="button"
            disabled={busy}
            className="min-h-7 px-1 font-medium text-accent hover:underline disabled:opacity-45"
            onClick={() => run(onRetry)}
          >
            {t("agent.retry")}
          </button>
          <button
            type="button"
            disabled={busy}
            className="min-h-7 px-1 font-medium text-ink2 hover:underline disabled:opacity-45"
            onClick={() => run(onIgnore)}
          >
            {t("agent.ignore")}
          </button>
        </>
      ) : (
        <>
          <Button small disabled={busy} onClick={() => run(onRetry)}>
            {t("agent.retry")}
          </Button>
          <Button small variant="ghost" disabled={busy} onClick={() => run(onIgnore)}>
            {t("agent.ignore")}
          </Button>
        </>
      )}
    </span>
  );
}

function ActivityList({
  agent,
  items,
  handoffs,
  onRetry,
  onIgnore,
}: {
  agent: AgentView;
  items: Activity[];
  handoffs: HandoffView[];
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  // Handoffs go in among the messages by time, no further back than the messages shown reach.
  const oldest = items.length >= 30 ? Math.min(...items.map((m) => m.createdAt)) : 0;
  const rows: ({ kind: "message"; at: number; m: Activity } | { kind: "handoff"; at: number; h: HandoffView })[] = [
    ...items.map((m) => ({ kind: "message" as const, at: m.createdAt, m })),
    ...handoffs.filter((h) => h.createdAt >= oldest).map((h) => ({ kind: "handoff" as const, at: h.createdAt, h })),
  ].sort((a, b) => b.at - a.at);
  return (
    <Group>
      {rows.map((row) => {
        if (row.kind === "handoff") return <HandoffItem key={row.h.id} handoff={row.h} agent={agent} />;
        const m = row.m;
        // "You" only when it cannot be two people: two WeChat accounts are each an owner.
        const who =
          m.sender ??
          (m.senderIsOnlyOwner
            ? t("activity.you")
            : m.contactId
              ? t("activity.unnamed", { id: m.contactId })
              : t("activity.someone"));
        const where = m.chat.kind === "dm" ? t("chat.dm") : (m.chat.name ?? t("chat.group"));
        return (
          <div key={m.id} className={`flex gap-3 px-4 py-3 ${m.direction === "out" ? "bg-bg2" : ""}`}>
            <PlatformIcon platform={m.platform} size={20} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline gap-2 text-small">
                <span className="max-w-[45%] shrink-0 truncate font-semibold" title={who}>
                  {who}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink3" title={where}>
                  {where}
                </span>
                <span className="shrink-0 whitespace-nowrap text-caption text-ink3">
                  {relativeTime(m.createdAt, locale)}
                </span>
              </div>
              <p className="selectable line-clamp-4 whitespace-pre-wrap wrap-anywhere">{m.body}</p>
              {m.files.length ? (
                <p className="truncate font-mono text-caption text-ink2" title={m.files.join(", ")}>
                  {m.files.join(", ")}
                </p>
              ) : null}
              {m.direction === "in" && m.state === "unanswered" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-amber">
                  <StatusDot state="awaiting_approval" />
                  {t("agent.unanswered")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "waiting" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink2">
                  <StatusDot state="reconnecting" />
                  {m.retryAt ? t("agent.waitingUntil", { time: shortDateTime(m.retryAt, locale) }) : t("agent.waiting")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "failed" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-red">
                  <StatusDot state="error" />
                  {t("agent.failed")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "held" ? (
                <p className="flex items-center gap-1.5 text-caption text-amber">
                  <StatusDot state="awaiting_approval" />
                  {t("agent.held")}
                </p>
              ) : null}
              {m.direction === "in" && m.triggers && m.state === "ignored" ? (
                <p className="text-caption text-ink3">{t("agent.ignored")}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </Group>
  );
}
