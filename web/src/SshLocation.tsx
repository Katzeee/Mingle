import { useEffect, useRef, useState } from "react";
import { ApiError, api, type SshHost, type SshInstallJob } from "./api.ts";
import { errorText, useI18n } from "./i18n.ts";
import { RemoteInstall } from "./RemoteInstall.tsx";
import { Button, Field, Input, Select, Spinner } from "./ui.tsx";

export function SshLocation({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<SshHost[]>([]);
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
  const change = useRef(onChange);
  change.current = onChange;
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
          const ready = next.result;
          setNodeMissing(false);
          setHosts((items) => [...items.filter((item) => item.id !== ready.id), ready]);
          change.current(ready.id);
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
  useEffect(() => {
    alive.current = true;
    void api
      .sshHosts()
      .then((items) => {
        if (alive.current) setHosts(items);
      })
      .catch((e) => {
        if (alive.current) setError(errorText(t, e));
      });
    return () => {
      alive.current = false;
    };
  }, [t]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly invalidates the file snapshot.
  useEffect(() => {
    if (value !== "add") return;
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
  }, [value, refresh]);
  const selected = hosts.find((host) => host.id === value);
  function changeTarget(target: string) {
    setTarget(target);
    setError(null);
    setNodeMissing(false);
    setJob(null);
    setPollFailed(false);
  }
  async function install() {
    setBusy(true);
    setError(null);
    setPollFailed(false);
    try {
      const next = await api.installSshHost(selected?.host ?? target.trim(), selected?.home ?? home.trim());
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
      const ready = await api.addSshHost(selected?.host ?? target.trim(), selected?.home ?? home.trim());
      if (!alive.current) return;
      setHosts((items) => [...items.filter((item) => item.id !== ready.id), ready]);
      onChange(ready.id);
    } catch (e) {
      if (alive.current) {
        setError(errorText(t, e));
        setNodeMissing(e instanceof ApiError && e.code === "ssh_node_missing");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Field label={t("ssh.location")}>
        <Select
          value={value}
          disabled={disabled || busy}
          onChange={(e) => {
            setError(null);
            setNodeMissing(false);
            setJob(null);
            setPollFailed(false);
            onChange(e.target.value);
          }}
        >
          <option value="">{t("ssh.local")}</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.host} · {host.home}
            </option>
          ))}
          <option value="add">{t("ssh.add")}</option>
        </Select>
      </Field>
      {value ? (
        <div className="flex flex-col gap-3 rounded-control border border-line bg-bg2 p-4">
          <p className="text-small text-ink2">{t("ssh.description")}</p>
          {value === "add" ? (
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
            <p className="selectable break-all text-caption text-ink2">{selected?.home}</p>
          )}
          {error ? (
            <p role="alert" className="text-small text-red">
              {error}
            </p>
          ) : null}
          <RemoteInstall
            key={selected?.host ?? target}
            required={nodeMissing || job?.state === "failed" || job?.state === "running"}
            disabled={disabled || busy || (value === "add" && (!target.trim() || !home.trim()))}
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
            <Button
              disabled={disabled || busy || (value === "add" && (!target.trim() || !home.trim()))}
              onClick={() => void prepare()}
            >
              {busy ? (
                <>
                  <Spinner />
                  {t("ssh.preparing")}
                </>
              ) : (
                t(selected ? "ssh.reconnect" : "ssh.prepare")
              )}
            </Button>
          ) : null}
          {selected ? <p className="text-caption text-ink2">{t("ssh.reconnectHint")}</p> : null}
        </div>
      ) : null}
      {!value && error ? (
        <p role="alert" className="text-small text-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
