import { useFreshness } from "@/lib/freshness"
import { cn } from "@/lib/utils"

/** The top bar's freshness: "live · 2s" from the last good answer, "stale · 40s · retrying" when the server went quiet. */
export function FreshnessBadge() {
  const f = useFreshness()
  const stale = f.state === "stale"
  return (
    <span
      data-freshness={f.state}
      data-tour="freshness"
      title={stale ? "No answer from the local server; still retrying. Pulses are paused." : "Last good answer from the local server"}
      className={cn("flex shrink-0 items-center gap-1.5 font-mono text-xs whitespace-nowrap tabular-nums", stale ? "font-semibold text-failed" : "text-faint")}
    >
      <i aria-hidden className={cn("inline-block size-1.5 rounded-full", stale ? "ring-1 ring-failed ring-inset" : f.state === "live" ? "bg-faint" : "bg-transparent ring-1 ring-faint ring-inset")} />
      {f.state === "connecting" ? "connecting…" : stale ? (f.ageS ? `stale · ${f.ageS}s · retrying` : "offline · retrying") : `live · ${f.ageS}s`}
      <span role="status" className="sr-only">
        {stale ? "Data is stale; the server is not answering." : ""}
      </span>
    </span>
  )
}
