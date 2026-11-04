import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { postTitle } from "@/lib/api"
import { cn } from "@/lib/utils"

/** Inline title editor: Enter or Save stores it, Escape or Cancel leaves it, Reset restores the source's own title. */
export function RenameForm({
  source,
  id,
  title,
  renamed,
  onDone,
  onCancel,
  compact = false,
}: {
  source: string
  id: string
  title: string
  /** The title was set on the page, so Reset has something to undo. */
  renamed: boolean
  onDone: () => void
  onCancel: () => void
  compact?: boolean
}) {
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const save = async (t: string) => {
    try {
      await postTitle(source, id, t)
      onDone()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }
  const size = compact ? "xs" : "sm"
  return (
    <form
      className={cn("flex min-w-0 flex-1 items-center gap-1.5", !compact && "flex-wrap gap-2")}
      onSubmit={(e) => { e.preventDefault(); save(draft) }}
    >
      <Input
        autoFocus
        aria-label="Title"
        className={compact ? "h-6 min-w-0 flex-1 px-1.5 text-xs md:text-xs" : "min-w-48 flex-1 text-lg font-bold"}
        maxLength={160}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel() }}
      />
      <Button type="submit" size={size}>Save</Button>
      {renamed && <Button type="button" variant="ghost" size={size} onClick={() => save("")}>Reset</Button>}
      {!compact && <Button type="button" variant="ghost" size={size} onClick={onCancel}>Cancel</Button>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  )
}
