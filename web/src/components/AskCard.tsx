import { useState } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AskField, RunBanner } from "@/lib/run-banner"

type Asking = Extract<NonNullable<RunBanner>, { kind: "asking" }>
type Act = (name: string, body: object) => Promise<unknown>

/**
 * An agent inside a run is paused on a question (a form with fields) or a permission request. Answer it here:
 * the adapter's `reply` action ({ id, answer: { key: value | value[] } }) or `approve` ({ id, decision }), which
 * the run's watchdog hands back to the waiting agent. Without those actions, it says where to answer.
 */
export function AskCard({ ask, act, canReply, canApprove }: { ask: Asking; act: Act; canReply: boolean; canApprove: boolean }) {
  const [values, setValues] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle")

  const send = async (name: string, body: object) => {
    setState("sending")
    try { await act(name, body); setState("sent") } catch (e) { setState((e as Error).message) }
  }

  if (state === "sent") return <p className="text-sm text-done">Sent. The agent picks it up within a few seconds.</p>

  if (!ask.question) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm"><b>{ask.stage ?? "an agent"}</b> wants to {ask.action}{ask.resources.length ? <>: <code className="text-xs">{ask.resources.join(", ")}</code></> : null}</p>
        {ask.message && <p className="text-xs text-muted-foreground">{ask.message}</p>}
        {canApprove ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => send("approve", { id: ask.id, decision: "once" })} disabled={state === "sending"}>Allow once</Button>
            <Button size="sm" variant="outline" onClick={() => send("approve", { id: ask.id, decision: "always" })} disabled={state === "sending"}>Always allow</Button>
            <Button size="sm" variant="outline" onClick={() => send("approve", { id: ask.id, decision: "reject" })} disabled={state === "sending"}>Reject</Button>
          </div>
        ) : <p className="text-xs text-faint">Answer it in the harness's own terminal or dashboard.</p>}
        {state !== "idle" && state !== "sending" && <p role="alert" className="text-xs text-destructive">{state}</p>}
      </div>
    )
  }

  const pick = (f: AskField, v: string) => setValues((s) => {
    const cur = s[f.key] ?? []
    const multi = f.type === "multiselect"
    return { ...s, [f.key]: multi ? (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) : [v] }
  })
  const answerOf = (f: AskField) => {
    const own = custom[f.key]?.trim()
    const chosen = values[f.key] ?? []
    if (f.type === "multiselect") return own ? [...chosen, own] : chosen
    return own || chosen[0] || ""
  }
  const complete = ask.fields.every((f) => { const a = answerOf(f); return Array.isArray(a) ? a.length > 0 : a !== "" })

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (complete) send("reply", { id: ask.id, answer: Object.fromEntries(ask.fields.map((f) => [f.key, answerOf(f)])) }) }}>
      {ask.fields.map((f) => (
        <fieldset key={f.key} className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium">{f.title ?? f.key}</legend>
          {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
          <div className="flex flex-col gap-1">
            {(f.options ?? []).map((o) => {
              const on = (values[f.key] ?? []).includes(o.value)
              return (
                <label key={o.value} className={`flex cursor-pointer gap-2 rounded-md border px-2 py-1.5 text-xs ${on ? "border-foreground/50 bg-muted" : "border-border"}`}>
                  <input type={f.type === "multiselect" ? "checkbox" : "radio"} name={f.key} checked={on} onChange={() => pick(f, o.value)} className="mt-0.5" />
                  <span><b className="font-medium">{o.label ?? o.value}</b>{o.description ? <span className="text-muted-foreground"> · {o.description}</span> : null}</span>
                </label>
              )
            })}
            {(f.custom || !(f.options ?? []).length) && (
              <input aria-label={`${f.title ?? f.key}: your own answer`} value={custom[f.key] ?? ""} onChange={(e) => setCustom((s) => ({ ...s, [f.key]: e.target.value }))}
                placeholder={(f.options ?? []).length ? "Or type your own answer" : "Your answer"} className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs" />
            )}
          </div>
        </fieldset>
      ))}
      {canReply ? (
        <Button type="submit" size="sm" className="self-start" disabled={!complete || state === "sending"}>Send answer</Button>
      ) : <p className="text-xs text-faint">Answer it in the harness's own terminal or dashboard.</p>}
      {state !== "idle" && state !== "sending" && <p role="alert" className="text-xs text-destructive">{state}</p>}
    </form>
  )
}

export const AskIcon = MessageCircleQuestion
