import { useEffect, useRef, useState } from "react";
import { ApiError, api, type SshHost, type SshInstallJob } from "./api.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { RemoteInstall } from "./RemoteInstall.tsx";
import { Button, Field, Input, MoreMenu, Select, Spinner } from "./ui.tsx";

/** "" is this computer, "add" a host still being set up, anything else a prepared SSH host's id. */
export type Location = string;

/** The SSH hosts prepared so far. A failed read leaves the list empty: this computer still works. */
export function useSshHosts() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  useEffect(() => {
    let alive = true;
    void api
      .sshHosts()
      .then((items) => {
        if (alive) setHosts(items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const remember = (ready: SshHost) => setHosts((items) => [...items.filter((item) => item.id !== ready.id), ready]);
  return { hosts, remember };
}

/**
 * A sentence with the run location as a word in it: "The harness on [this computer ▾] that…".
 * Running elsewhere is rare, so it stays a word in the hint until someone opens it.
 */
export function LocationSentence({
  sentence,
  value,
  hosts,
  onChange,
}: {
  /** A message with a {location} placeholder. */
  sentence: MessageKey;
  value: Location;
  hosts: SshHost[];
  onChange: (value: Location) => void;
}) {
  const { t } = useI18n();
  const label = (host: SshHost) =>
    hosts.some((other) => other !== host && other.host === host.host) ? `${host.host} · ${host.home}` : host.host;
  const selected = hosts.find((host) => host.id === value);
  const word = value === "add" ? t("ssh.newHost") : selected ? label(selected) : t("ssh.localInline");
  // The translator spaces the word against Chinese text; split around it to make it a control.
  const text = t(sentence, { location: word });
  const at = text.indexOf(word);
  return (
    <>
      {text.slice(0, at)}
      <MoreMenu
        label={t("ssh.location")}
        trigger={<span className="wrap-anywhere">{word}</span>}
        items={[
          { label: t("ssh.local"), checked: value === "", onSelect: () => onChange("") },
          ...hosts.map((host) => ({
            label: label(host),
            checked: value === host.id,
            onSelect: () => onChange(host.id),
          })),
          { label: t("ssh.add"), checked: value === "add", onSelect: () => onChange("add") },
        ]}
      />
      {text.slice(at + word.length)}
    </>
  );
}

/**
 * Prepares an SSH host in place: a new one (`host` absent), or a known one again after it restarted.
 * Calls `onReady` with the host once remote Mingle answers.
 */
export function SshSetup({
  host: known,
  disabled,
  onReady,
  onCancel,
}: {
  host?: SshHost;
  disabled: boolean;
  onReady: (host: SshHost) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [home, setHome] = useState("~/.mingle-remote");
  const [submitting, setBusy] = useState(false);
  const [job, setJob] = useState<SshInstallJob | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [pollRetry, setPollRetry] = useState(0);
  const busy = submitting || job?.state === "running";
  const [error, setError] = useState<string | null>(null);
  const [nodeMissing, setNodeMissing] = useState(false);
  const [config, setConfig] = useState<{ hosts: string[]; incomplete: boolean } | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const jobId = job?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry restarts polling the retained job.
  useEffect(() => {
    if (!jobId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    setPollFailed(false);
    async function poll() {
      try {
        const next = await api.sshInstallation(jobId as string);
        if (!current) return;
        setJob(next);
        if (next.state === "running") timer = setTimeout(() => void poll(), 750);
        else if (next.state === "done" && next.result) {
          setNodeMissing(false);
          ready.current(next.result);
        } else setError(errorText(t, new ApiError(next.error ?? "ssh_install_failed", "", 400)));
      } catch (e) {
        if (!current) return;
        if (e instanceof ApiError && e.code === "ssh_install_missing") {
          setJob(null);
          setError(errorText(t, e));
        } else setPollFailed(true);
      }
    }
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [jobId, pollRetry, t]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly invalidates the file snapshot.
  useEffect(() => {
    if (known) return;
    let current = true;
    setConfigLoading(true);
    setConfigFailed(false);
    void api
      .sshConfig()
      .then((result) => {
        if (current) setConfig(result);
      })
      .catch(() => {
        if (current) setConfigFailed(true);
      })
      .finally(() => {
        if (current) setConfigLoading(false);
      });
    return () => {
      current = false;
    };
  }, [known, refresh]);
  function changeTarget(target: string) {
    setTarget(target);
    setError(null);
    setNodeMissing(false);
    setJob(null);
    setPollFailed(false);
  }
  const host = known?.host ?? target.trim();
  const dir = known?.home ?? home.trim();
  async function install() {
    setBusy(true);
    setError(null);
    setPollFailed(false);
    try {
      const next = await api.installSshHost(host, dir);
      if (alive.current) {
        setJob(next);
        // A repeated click may recover the same job after a dropped start response.
        setPollRetry((n) => n + 1);
      }
    } catch (e) {
      if (alive.current) setError(errorText(t, e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError(null);
    setNodeMissing(false);
    setJob(null);
    try {
      const result = await api.addSshHost(host, dir);
      if (alive.current) ready.current(result);
    } catch (e) {
      if (alive.current) {
        setError(errorText(t, e));
        setNodeMissing(e instanceof ApiError && e.code === "ssh_node_missing");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const incomplete = !host || !dir;
  return (
    <div className="rise flex flex-col gap-3 rounded-control border border-line bg-bg2 p-4">
      <p className="text-small text-ink2">{t("ssh.description")}</p>
      {!known ? (
        <>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label={t("ssh.config")}>
                <Select
                  value={config?.hosts.includes(target) ? target : ""}
                  disabled={disabled || busy || configLoading || !config?.hosts.length}
                  onChange={(e) => changeTarget(e.target.value)}
                >
                  <option value="">{t(configLoading ? "ssh.configLoading" : "ssh.configChoose")}</option>
                  {config?.hosts.map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button disabled={disabled || busy || configLoading} onClick={() => setRefresh((n) => n + 1)}>
              {t("ssh.configRefresh")}
            </Button>
          </div>
          {!configLoading && (configFailed || config?.incomplete) ? (
            <p role="status" className="text-caption text-amber">
              {t(configFailed ? "ssh.configFailed" : "ssh.configIncomplete")}
            </p>
          ) : !configLoading && config?.hosts.length === 0 ? (
            <p className="text-caption text-ink2">{t("ssh.configEmpty")}</p>
          ) : null}
          <Field label={t("ssh.target")} hint={t("ssh.targetHint")}>
            <Input
              value={target}
              disabled={busy}
              onChange={(e) => changeTarget(e.target.value)}
              placeholder="user@host"
              autoComplete="off"
            />
          </Field>
          <Field label={t("ssh.home")}>
            <Input value={home} disabled={busy} onChange={(e) => setHome(e.target.value)} autoComplete="off" />
          </Field>
          <p className="text-caption text-ink2">{t("ssh.requirements")}</p>
        </>
      ) : (
        <p className="text-caption text-ink2">{t("ssh.reconnectHint")}</p>
      )}
      {error ? (
        <p role="alert" className="text-small text-red">
          {error}
        </p>
      ) : null}
      <RemoteInstall
        key={host}
        required={nodeMissing || job?.state === "failed" || job?.state === "running"}
        disabled={disabled || busy || incomplete}
        onInstall={() => void install()}
      />
      {job?.state === "running" ? (
        <div role="status" className="flex flex-col gap-2 text-small text-ink2">
          {pollFailed ? (
            <>
              <p>{t("ssh.installPollFailed")}</p>
              <Button small className="self-start" onClick={() => setPollRetry((n) => n + 1)}>
                {t("ssh.installPollRetry")}
              </Button>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2">
                <Spinner />
                {t(job.phase === "installing" ? "ssh.installing" : "ssh.preparing")}
              </p>
              <p className="text-caption">{t("ssh.installKeepOpen")}</p>
            </>
          )}
        </div>
      ) : job?.state === "done" ? (
        <p role="status" className="text-small text-green">
          {t("ssh.installDone")}
        </p>
      ) : null}
      {job?.state !== "running" ? (
        <div className="flex items-center gap-2">
          <Button disabled={disabled || busy || incomplete} onClick={() => void prepare()}>
            {busy ? (
              <>
                <Spinner />
                {t("ssh.preparing")}
              </>
            ) : (
              t(known ? "ssh.reconnect" : "ssh.prepare")
            )}
          </Button>
          {onCancel ? (
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              {t("create.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
