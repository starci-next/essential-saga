/**
 * The saga platform's model. A saga here is a forward-only chain of steps. A step that the business can undo declares a
 * compensation beside it, and a person decides to press it: no machine undoes a step because a later one failed. The run moves
 * forward, or stops in a typed state a person can see and act on.
 */

/** Where a run stands. */
export type SagaStatus =
    /** Its steps are running forward. */
    | "running"
    /** Every blocking step is done. Side steps may still be running on their own. */
    | "completed"
    /** A step was refused for a business reason (out of stock, no funds). Nothing more runs until a person decides. */
    | "failed"
    /** A step or a compensation kept failing for a transient reason after the whole retry ladder: a person resumes it. */
    | "parked"
    /** A person pressed the compensation: the declared undos of the done steps run forward, newest first. */
    | "compensating"
    /** Every declared undo ran. */
    | "compensated"

/** The persisted state of one run: one row per (saga, correlation id), moved only through its version. */
export interface SagaRun<TInput> {
    readonly saga: string
    /** The id the run is about (the order id). It is also what makes a second start of the same order a no-op. */
    readonly correlationId: string
    readonly status: SagaStatus
    /** The fence: every transition names the version it read and moves it by one. */
    readonly version: number
    readonly input: TInput
    /** The steps that finished, in the order they ran (side steps included). */
    readonly done: ReadonlyArray<string>
    /** The steps whose compensation ran, in the order it ran. */
    readonly undone: ReadonlyArray<string>
    /** The step that was refused or kept failing, or null. */
    readonly failedStep: string | null
    /**
     * A step whose outcome is unknown: it kept getting no answer, so it may have committed on the other side. Its undo runs
     * first when a person presses the compensation (an undo of something that never happened changes nothing).
     */
    readonly unclearStep: string | null
    /** Why the run stopped, in one line, or null. */
    readonly reason: string | null
    /** What a resume goes back to: running forward or compensating. */
    readonly parkedFrom: "running" | "compensating" | null
    /** Who pressed the compensation, or null. */
    readonly pressedBy: string | null
    /** Side steps that failed: recorded on the run, they never stop it. */
    readonly sideFailures: ReadonlyArray<string>
}

/** One step of a saga definition. */
export interface SagaStep<TInput> {
    /** The name a compensation pairs with. */
    readonly name: string
    /** The event this step announces when it is done. */
    readonly event: string
    /**
     * False for a side step: a step that only informs (an email, a notice). It runs after the blocking steps on its own retry
     * ladder; its failure is recorded on the run and never parks it.
     */
    readonly blocking: boolean
    run(input: TInput): Promise<void>
}

/** The declared undo of one step, run only when a person presses it. */
export interface SagaCompensation<TInput> {
    /** The step this compensation undoes. */
    readonly step: string
    /** The event it announces when the undo is done. */
    readonly event: string
    run(input: TInput): Promise<void>
}

/** The retry ladder a run uses: `waited` when a customer waits on it, `background` otherwise. */
export type LadderName = "waited" | "background"

/** Everything the platform needs to run one saga. */
export interface SagaDefinition<TInput> {
    readonly saga: string
    readonly ladder: LadderName
    readonly steps: ReadonlyArray<SagaStep<TInput>>
    readonly compensations: ReadonlyArray<SagaCompensation<TInput>>
}

/** What can happen to a run. Each event names what happened, never what to do next. */
export type SagaEvent =
    | { readonly type: "step-done"; readonly step: string }
    | { readonly type: "step-refused"; readonly step: string; readonly reason: string }
    | { readonly type: "parked"; readonly step: string; readonly reason: string }
    | { readonly type: "completed" }
    | { readonly type: "resumed" }
    | { readonly type: "compensation-pressed"; readonly by: string }
    | { readonly type: "step-undone"; readonly step: string }
    | { readonly type: "compensated" }
    | { readonly type: "side-done"; readonly step: string }
    | { readonly type: "side-failed"; readonly step: string; readonly reason: string }

/** The answer of a transition: the next state, or why it is refused in the current one. */
export type SagaTransition<TInput> =
    | { readonly ok: true; readonly run: SagaRun<TInput> }
    | { readonly ok: false; readonly refusal: string }
