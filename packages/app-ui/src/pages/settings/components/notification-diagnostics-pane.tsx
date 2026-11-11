import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotificationDiagnosticsCapability, NotificationSendObservation, NotificationSystemSnapshot } from "@silverhand/client";
import { NOTIFICATION_DIAGNOSTICS_FOREGROUND_EVENT } from "@silverhand/client";
import { t } from "@/lib/i18n";

const UNKNOWN: NotificationSystemSnapshot = { runtimePermission: "unknown", appEnabled: null, channel: "unknown", channelBlocked: null };
const codes = new Set([
  "suppressed-focused", "channel-disabled", "notifications-disabled", "not-authorized-or-undecided",
  "session-expired", "permission-request-busy", "diagnostic-unavailable", "diagnostic-invalid",
  "NOTIFICATION_FAILED", "BRIDGE_ERROR", "UNKNOWN_STATUS",
]);
const key = "settings.about.notificationDiagnostics." as const;

export function notificationObservationText(value: NotificationSendObservation | null): string {
  if (!value) return t(`${key}notStarted`);
  switch (value.status) {
    case "waiting-session": return t(`${key}waiting`);
    case "sending": return t(`${key}sending`);
    case "missing-session": return t(`${key}missingSession`);
    case "invalidated": return t(`${key}invalidated`);
    case "posted": return t(`${key}posted`);
    default: return codes.has(value.status) ? value.status : t(`${key}unknown`);
  }
}

function TestSlot({ mount }: { mount: NonNullable<NotificationDiagnosticsCapability["mountTestControl"]> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { if (host.current) return mount(host.current); }, [mount]);
  return <div ref={host} data-notification-test-slot />;
}

export function NotificationDiagnosticsPane({ capability }: { capability: NotificationDiagnosticsCapability }) {
  const local = useSyncExternalStore(capability.subscribeLocal, capability.getLocalSnapshot, capability.getLocalSnapshot);
  const [system, setSystem] = useState(UNKNOWN);
  const [queriedAt, setQueriedAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const read = () => {
      const request = ++sequence;
      let finished = false;
      const commit = (value: NotificationSystemSnapshot) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        timers.delete(timer);
        if (!alive || request !== sequence) return;
        setSystem(value);
        setQueriedAt(Date.now());
      };
      const timer = setTimeout(() => commit(UNKNOWN), 5000);
      timers.add(timer);
      void Promise.resolve().then(() => alive ? capability.readSystem() : UNKNOWN).then(commit, () => commit(UNKNOWN));
    };
    const visible = () => { if (document.visibilityState === "visible") read(); };
    visible();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(NOTIFICATION_DIAGNOSTICS_FOREGROUND_EVENT, visible);
    return () => {
      alive = false;
      sequence++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(NOTIFICATION_DIAGNOSTICS_FOREGROUND_EVENT, visible);
    };
  }, [capability]);
  const flag = (value: boolean | null) => t(`${key}${value === null ? "unknown" : value ? "enabled" : "disabled"}`);
  const permission = t(`${key}${system.runtimePermission === "granted" ? "granted" : system.runtimePermission === "not-granted" ? "notGranted" : system.runtimePermission === "not-required" ? "notRequired" : "unknown"}`);
  const session = t(`${key}${local.session === "present" ? "present" : local.session === "absent" ? "absent" : "unknown"}`);
  const channel = t(`${key}${system.channel === "present" ? "present" : system.channel === "absent" ? "absent" : "unknown"}`);
  const rows = [
    [t(`${key}permission`), `${permission} · ${t(`${key}appSwitch`)} ${flag(system.appEnabled)}`],
    [t(`${key}session`), session],
    [t(`${key}lastSend`), notificationObservationText(local.lastSend) + (local.lastSend ? ` · ${new Date(local.lastSend.at).toLocaleTimeString()}` : "")],
    [t(`${key}channel`), channel + (system.channel === "present" ? ` · ${flag(system.channelBlocked === null ? null : !system.channelBlocked)}` : "")],
  ];
  return <section className="flex max-w-2xl flex-col gap-3" data-notification-diagnostics>
    <h3 className="text-sm font-medium text-text-primary">{t(`${key}title`)}</h3>
    <dl className="divide-y divide-border-subtle rounded-(--control-radius) border border-border-subtle text-sm" aria-live="polite">
      {rows.map(([label, value]) => <div key={label} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
        <dt className="text-text-secondary">{label}</dt><dd className="text-right text-text-primary select-text">{value}</dd>
      </div>)}
    </dl>
    {capability.mountTestControl ? <TestSlot mount={capability.mountTestControl} /> : null}
    <p className="text-xs text-text-muted">{t(`${key}note`)}{queriedAt ? ` ${t(`${key}queried`)} ${new Date(queriedAt).toLocaleTimeString()}` : ""}</p>
  </section>;
}
