// Relative times for the reader: "2h" in list rows and "6 days ago" (Intl) in
// sentences. Times in the future (clock skew between the
// database and the server) read as now.
const units = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
] as const

function largestUnit(date: Date, now: Date) {
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000)
  for (const [unit, size] of units) {
    if (seconds >= size) return { unit, value: Math.floor(seconds / size) }
  }
  return { unit: "second" as const, value: Math.floor(seconds) }
}

// Spelled out rather than Intl's narrow unit format, whose output depends on
// the ICU build: some print a month as "1m", which reads as a minute.
const short = {
  year: "y",
  month: "mo",
  week: "w",
  day: "d",
  hour: "h",
  minute: "m",
} as const

const long = new Intl.RelativeTimeFormat("en", { numeric: "always" })

// "now", "5m", "2h", "3d", "2w", "4mo", "1y".
export function shortAgo(date: Date, now = new Date()) {
  const { unit, value } = largestUnit(date, now)
  if (unit === "second") return "now"
  return `${value}${short[unit]}`
}

// "30 seconds ago", "6 days ago".
export function longAgo(date: Date, now = new Date()) {
  const { unit, value } = largestUnit(date, now)
  return long.format(-value, unit)
}
