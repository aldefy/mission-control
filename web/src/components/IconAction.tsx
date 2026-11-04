import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

/** A small icon button whose label shows at once on hover or focus (a native title waits about a second). */
export function IconAction({ label, onClick, className, children }: { label: string; onClick?: () => void; className?: string; children: ReactNode }) {
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} className={className} onClick={onClick} />}>
          {children}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** An info icon whose text shows at once on hover or focus. */
export function InfoTip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} role="img" aria-label={text} />}
          className="flex shrink-0 cursor-help items-center rounded p-0.5 hover:text-muted-foreground focus-visible:text-muted-foreground [&_svg]:size-3"
        >
          {children}
        </TooltipTrigger>
        <TooltipContent className="max-w-[36ch] font-sans">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
