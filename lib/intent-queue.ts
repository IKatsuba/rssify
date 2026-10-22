// Sends changes to one thing strictly one after another, so when the person
// changes their mind before an earlier call returns, the server ends in the
// state they asked for last. show() is optimistic; when the newest intent
// fails, it falls back to the last state the server confirmed, so the screen
// never claims a state the server does not hold.
export function intentQueue<T>({
  confirmed,
  send,
  show,
  failed,
}: {
  confirmed: T
  send: (intent: T) => Promise<void>
  show: (state: T) => void
  failed: (intent: T) => void
}) {
  let tail: Promise<void> = Promise.resolve()
  let turns = 0
  return (intent: T) => {
    const turn = ++turns
    show(intent)
    tail = tail.then(async () => {
      try {
        await send(intent)
        confirmed = intent
      } catch {
        failed(intent)
        if (turn === turns) show(confirmed)
      }
    })
    return tail
  }
}
