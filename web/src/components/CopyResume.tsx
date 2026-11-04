import { useState } from "react"
import { Check, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "@/components/IconAction"
import { cn } from "@/lib/utils"

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The async clipboard can be refused (focus, permissions); the old copy command still works on a click.
    const t = document.createElement("textarea")
    t.value = text
    t.style.position = "fixed"
    t.style.opacity = "0"
    document.body.appendChild(t)
    t.select()
    const ok = document.execCommand("copy")
    t.remove()
    return ok
  }
}

/** Copies a session's resume command and shows what was copied; `full` also shows the command beside the button. */
export function CopyResume({ command, open, full = false, className }: { command: string; open?: boolean; full?: boolean; className?: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const copy = async () => {
    setCopied(await copyText(command))
    setTimeout(() => setCopied(null), 2500)
  }
  const label = open ? "Copy resume command (still open in another terminal)" : "Copy resume command"
  const toast = copied !== null && (
    <div role="status" className="fixed right-4 bottom-4 z-50 flex max-w-[min(90vw,70ch)] flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-xs shadow-lg">
      <span className={copied ? "text-foreground" : "text-failed"}>{copied ? "Copied resume command" : "Could not copy; select it below"}</span>
      <code className="font-mono break-all text-muted-foreground select-all">{command}</code>
    </div>
  )
  if (!full) {
    return (
      <>
        <IconAction label={label} className={className} onClick={copy}>
          {copied ? <Check /> : <TerminalSquare />}
        </IconAction>
        {toast}
      </>
    )
  }
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface/40 px-2 py-1", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={command}>{command}</code>
      <Button variant="ghost" size="xs" onClick={copy}>
        {copied ? <Check /> : <TerminalSquare />}
        {copied ? "copied" : "copy resume"}
      </Button>
      {toast}
    </div>
  )
}
