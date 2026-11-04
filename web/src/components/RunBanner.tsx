import { CheckCircle2, CircleAlert, Loader2, PauseCircle } from "lucide-react"
import { latestPreview, runBanner } from "@/lib/run-banner"
import { cn } from "@/lib/utils"

const rawUrl = (runId: string, path: string, v: string) => `/api/x/raw/${encodeURIComponent(runId)}?path=${encodeURIComponent(path)}${v ? `&v=${encodeURIComponent(v)}` : ""}`

function List({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  if (!items.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      <span className={cn("font-mono text-xs uppercase tracking-wide", tone ?? "text-faint")}>{title} ({items.length})</span>
      <ul className="list-disc pl-4 text-xs text-muted-foreground">
        {items.slice(0, 6).map((t, i) => <li key={i}>{t}</li>)}
        {items.length > 6 && <li className="list-none text-faint">and {items.length - 6} more in the handoff</li>}
      </ul>
    </div>
  )
}

/**
 * The top of a run's page: is it done (and verified?), waiting for you, or working, said once and plainly,
 * with the app as the run last saw it. Finished must be obvious; so must "built, but nobody verified this".
 */
export function RunBannerView({ runId, events, live, canPreview }: { runId: string; events: Record<string, any>[]; live: boolean; canPreview: boolean }) {
  const b = runBanner(events, live)
  const shot = canPreview ? latestPreview(events) : null
  if (!b && !shot) return null
  const tone =
    b?.kind === "done" ? (b.verified ? "border-done/60 bg-done/10" : "border-looping/60 bg-looping/10")
      : b?.kind === "stopped" ? "border-needs-you/50 bg-needs-you/10"
        : "border-border bg-card/40"
  return (
    <section data-run-banner={b?.kind ?? "preview"} className={cn("flex flex-wrap items-start gap-4 rounded-xl border p-4", tone)}>
      <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
        {b?.kind === "done" && (
          <>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              {b.verified ? <CheckCircle2 className="size-5 text-done" /> : <CircleAlert className="size-5 text-looping" />}
              {b.verified ? "Done and verified" : `Built, not verified${b.unverified.length ? `: ${b.unverified.length} open` : ""}`}
            </h2>
            <p className="text-xs text-muted-foreground">
              {b.branch ? <>On <code>{b.branch}</code>. </> : null}
              {b.verified ? "Every final check passed and nothing is left unverified or open." : "Try it before merging; what is left is below."}
            </p>
            <List title="Not verified" items={b.unverified} tone="text-looping" />
            <List title="Questions for you" items={b.questions} tone="text-failed" />
            <List title="Assumed without asking" items={b.assumed} />
            {b.findings > 0 && <p className="text-xs text-failed">Review left {b.findings} finding{b.findings > 1 ? "s" : ""} open.</p>}
          </>
        )}
        {b?.kind === "stopped" && (
          <>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <PauseCircle className="size-5 text-needs-you" />
              Needs you{b.stage ? ` at ${b.stage}` : ""} <span className="font-mono text-xs font-normal text-faint">{b.rule}</span>
            </h2>
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{b.detail.slice(0, 800)}</p>
            <p className="text-xs text-faint">Answer in the chat tab; Resume accepts what is listed as known.</p>
          </>
        )}
        {b?.kind === "running" && (
          <>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Loader2 className="size-5 animate-spin text-faint" />
              Working{b.stage ? `: ${b.stage}` : ""}
            </h2>
            {b.doing && <p className="truncate font-mono text-xs text-muted-foreground">{b.doing}</p>}
          </>
        )}
      </div>
      {shot && (
        <figure className="flex flex-col items-center gap-1">
          <img src={rawUrl(runId, shot.path, shot.v)} alt="The app, as the run last saw it" className="max-h-56 rounded-lg border" />
          <figcaption className="font-mono text-[11px] text-faint">{live ? "live preview" : "last preview"}</figcaption>
        </figure>
      )}
    </section>
  )
}
