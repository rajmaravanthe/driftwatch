import type { RunStatus, StepStatus } from "../../shared/types.js";

export function StatusPill({ status }: { status: RunStatus | null }) {
  const label = status ?? "never run";
  return (
    <span className={`status-pill status-pill--${status ?? "none"}`}>
      {label}
    </span>
  );
}

export function ResourceCount({ count }: { count: number }) {
  return <span className='resource-count'>{count} resources</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`sev-badge sev-${severity}`}>{severity}</span>;
}

export function StepDot({ status }: { status: StepStatus }) {
  return <span className={`step__dot step__dot--${status}`} />;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatClock(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
