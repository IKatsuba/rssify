"use client"

import { ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { KeyHint } from "../../keys"

// Made on the client, like StepLink: a trigger element made on the server
// does not reliably open its tooltip.
export function OpenOriginal({ url }: { url: string | null }) {
  // No valid URL: disabled, and a disabled control shows no tooltip.
  if (!url) {
    return (
      <Button variant="outline" disabled>
        <ExternalLinkIcon />
        <span className="max-sm:sr-only">Open original</span>
      </Button>
    )
  }
  return (
    <KeyHint
      label="Open original"
      keys={["V"]}
      render={
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        />
      }
    >
      <ExternalLinkIcon />
      <span className="max-sm:sr-only">Open original</span>
    </KeyHint>
  )
}
