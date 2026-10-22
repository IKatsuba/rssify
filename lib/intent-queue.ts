// Runs changes to one thing strictly one after another, so when the person
// changes their mind before an earlier call returns, the server ends in the
// state they asked for last. isLatest tells a failing step whether a newer
// intent has already replaced the one it would roll back.
export function intentQueue<T>(
  run: (intent: T, isLatest: () => boolean) => Promise<void>
) {
  let tail: Promise<void> = Promise.resolve()
  let turns = 0
  return (intent: T) => {
    const turn = ++turns
    // A rejected step must not stall the ones queued behind it.
    tail = tail.then(() => run(intent, () => turn === turns)).catch(() => {})
    return tail
  }
}
