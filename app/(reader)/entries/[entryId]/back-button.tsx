"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

import { KeyHint } from "../../keys"
import { useBackHref } from "../../return-point"

// ← {list name}: back to the page of the list the entry was opened from,
// such as an Older entries page, like u and Esc.
export function BackButton({
  list,
  children,
}: {
  list: string
  children: React.ReactNode
}) {
  return (
    <KeyHint
      label="Back to list"
      keys={["U"]}
      render={
        <Button
          variant="ghost"
          className="min-w-0"
          nativeButton={false}
          render={<Link href={useBackHref(list)} />}
        />
      }
    >
      {children}
    </KeyHint>
  )
}
