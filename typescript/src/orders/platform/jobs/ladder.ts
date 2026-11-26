import { CallError, describeError } from "../../../platform/errors"
import { env, sleep } from "../../../platform/env"
import type { LadderName } from "../saga/saga.types"

/**
 * The one place a failure is judged:
 * - `transient`: no answer, or a 5xx. The command may be retried with the same idempotency key, because the receiver's inbox
 *   turns a repeat into a replay of the first answer.
 * - `refused`: the other side answered no (a 4xx) after rolling back. Retrying cannot change a business answer.
 * - `code`: anything else (a bug, a bad configuration). Retrying hides it, so the run parks at once for a person.
 */
export type FailureClass = "transient" | "refused" | "code"

export const classifyFailure = (error: unknown): FailureClass => {
    if (!(error instanceof CallError)) return "code"
    if (error.status === null || error.status >= 500) return "transient"
    return "refused"
}

/** The pauses of a ladder in milliseconds, read from the environment (`LADDER_WAITED_MS=200,400,800`). */
export const ladderOf = (name: LadderName): ReadonlyArray<number> => {
    const fallback = name === "waited" ? "200,400,800,1600" : "500,1000,2000,4000"
    const text = env(name === "waited" ? "LADDER_WAITED_MS" : "LADDER_BACKGROUND_MS", fallback)
    const rungs = text.split(",").map((part) => Number(part.trim()))
    if (rungs.some((rung) => !Number.isFinite(rung) || rung < 0)) throw new Error(`bad ladder ${name}: ${text}`)
    return rungs
}

/** The outcome of one piece of work run on a ladder. */
export type LadderOutcome =
    | { readonly kind: "done" }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "parked"; readonly reason: string }

/**
 * Runs `work`, retrying a transient failure after each pause of the ladder; after the last rung the work is parked (a dead
 * letter a person resumes). A refusal ends at once; a code failure parks at once. Nothing here swallows a failure.
 */
export const runOnLadder = async (
    work: () => Promise<void>,
    rungs: ReadonlyArray<number>,
    wait: (ms: number) => Promise<void> = sleep,
): Promise<LadderOutcome> => {
    for (let attempt = 0; ; attempt++) {
        try {
            await work()
            return { kind: "done" }
        } catch (error) {
            const reason = describeError(error)
            const failure = classifyFailure(error)
            if (failure === "refused") return { kind: "refused", reason }
            const pause = rungs[attempt]
            if (failure === "code" || pause === undefined) return { kind: "parked", reason }
            await wait(pause)
        }
    }
}
