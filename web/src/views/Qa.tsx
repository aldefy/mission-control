import { useState } from "react"
import { qaRows } from "@/lib/extras"
import { qaActivity } from "@/lib/run-banner"
import { cn } from "@/lib/utils"

const TONE: Record<string, string> = { pass: "text-running", fail: "text-failed" }

/** The QA report card: the run's latest `qa` event as a score and a table. */
export default function Qa({ events }: { events: Record<string, any>[] }) {
  const rows = qaRows(events)
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const activity = qaActivity(events)
  // QA is working (or has not reported): show what it does, step by step, so it can be watched.
  if (!rows) return activity.length ? <QaActivity steps={activity} /> : <p className="py-10 text-center font-mono text-xs text-muted-foreground">QA has not reported yet.</p>
  const n = (s: string) => rows.filter((r) => r.status === s).length
  const score: [string, number, string][] = [["pass", n("pass"), "text-running"], ["fail", n("fail"), "text-failed"], ["not verified", rows.length - n("pass") - n("fail"), "text-foreground"]]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-6" aria-label="QA score">
        {score.map(([k, v, c]) => (
          <div key={k} className="flex flex-col"><b className={cn("font-mono text-2xl", c)}>{v}</b><span className="font-mono text-xs text-muted-foreground">{k}</span></div>
        ))}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead><tr className="text-left font-mono text-xs text-muted-foreground"><th className="border-b py-1 pr-3">id</th><th className="border-b py-1 pr-3">state</th><th className="border-b py-1">evidence</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="border-b py-1.5 pr-3 align-top font-mono">{r.id}</td>
              <td className={cn("border-b py-1.5 pr-3 align-top font-mono", TONE[r.status] ?? "text-muted-foreground")}>{r.status}</td>
              <td className="border-b py-1.5 align-top">
                <button type="button" aria-expanded={open.has(i)} className={cn("text-left text-muted-foreground", !open.has(i) && "line-clamp-2")}
                  onClick={() => setOpen((s) => { const t = new Set(s); t.has(i) ? t.delete(i) : t.add(i); return t })}>{r.evidence}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** QA's latest round as it happens: each step it takes, each check (pass or fail) and each thing it could not verify. */
function QaActivity({ steps }: { steps: { kind: string; text: string; ok?: boolean }[] }) {
  return (
    <section aria-label="QA at work" className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">QA at work <span className="font-mono text-xs text-faint">{steps.length} steps</span></h3>
      <ol className="flex flex-col font-mono text-xs">
        {steps.slice(-120).map((s, i) => (
          <li key={i} className={cn("grid grid-cols-[7rem_1fr] gap-2 border-b py-0.5", s.ok === false && "text-failed", s.ok === true && "text-running")}>
            <span className="truncate text-faint">{s.kind}</span>
            <span className="break-all">{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
