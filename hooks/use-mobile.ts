import * as React from "react"

const MOBILE_BREAKPOINT = 768
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

// A store subscription rather than the template's setState in an effect,
// which the React Compiler lint rejects; the server snapshot is desktop.
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}
