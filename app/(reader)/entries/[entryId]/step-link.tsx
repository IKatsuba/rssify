"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

import { KeyHint } from "../../keys"

// Previous/next in the list. A client component, so its Link is made on the
// client: a server-made Link inside the tooltip trigger never opens the tip.
export function StepLink({
  href,
  label,
  hint,
  hintKey,
  children,
}: {
  href: string | null
  label: string
  hint: string
  hintKey: string
  children: React.ReactNode
}) {
  // No neighbour that way: a disabled button, not a dead link.
  if (!href) {
    return (
      <Button variant="ghost" size="icon" disabled>
        {children}
        <span className="sr-only">{label}</span>
      </Button>
    )
  }
  return (
    <KeyHint
      label={hint}
      keys={[hintKey]}
      render={
        <Button
          variant="ghost"
          size="icon"
          nativeButton={false}
          render={<Link href={href} prefetch={false} />}
        />
      }
    >
      {children}
      <span className="sr-only">{label}</span>
    </KeyHint>
  )
}
