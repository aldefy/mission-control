import { toHash } from "@/lib/route"
import { useRemoteStatus } from "@/lib/remote"
import { cn } from "@/lib/utils"

/** Top-bar indicator: "Remote on" / "Remote off" from /api/remote/status, linking to the Remote page (C44). */
export function RemoteChip({ f }: { f?: typeof fetch }) {
  const { status } = useRemoteStatus(3000, f)
  if (!status) return null
  return (
    <a
      href={toHash({ view: "remote" })}
      data-tour="remote"
      className={cn("flex h-8 items-center gap-1.5 rounded-md border px-2 font-mono text-xs whitespace-nowrap hover:border-ring", status.enabled ? "text-running" : "text-faint")}
    >
      <span className={cn("size-1.5 rounded-full", status.enabled ? "bg-running" : "bg-faint")} aria-hidden />
      {status.enabled ? "Remote on" : "Remote off"}
    </a>
  )
}
