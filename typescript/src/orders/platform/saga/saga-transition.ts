import type { SagaDefinition, SagaEvent, SagaRun, SagaStatus, SagaTransition } from "./saga.types"

/** The statuses each event may move a run from. Anything else is refused, so a late or repeated event cannot move a run twice. */
const ALLOWED: Readonly<Record<SagaEvent["type"], ReadonlyArray<SagaStatus>>> = {
    "step-done": ["running"],
    "step-refused": ["running"],
    parked: ["running", "compensating"],
    completed: ["running"],
    resumed: ["parked"],
    // A person may undo a run that stopped: refused by the business, or parked while running forward.
    "compensation-pressed": ["failed", "parked"],
    "step-undone": ["compensating"],
    compensated: ["compensating"],
    "side-done": ["completed"],
    "side-failed": ["completed"],
}

const refuse = <TInput>(run: SagaRun<TInput>, event: SagaEvent, why: string): SagaTransition<TInput> => ({
    ok: false,
    refusal: `${event.type} refused while ${run.status}: ${why}`,
})

/**
 * The state machine of a run, as a pure function: the run it read and one event in, the next run out (its version moved by one)
 * or a refusal. The store applies the answer under the version fence; keeping the rules here makes them testable without a database.
 */
export const transition = <TInput>(run: SagaRun<TInput>, event: SagaEvent): SagaTransition<TInput> => {
    if (!ALLOWED[event.type].includes(run.status)) return refuse(run, event, "not allowed in this status")
    const next = (patch: Partial<SagaRun<TInput>>): SagaTransition<TInput> => ({
        ok: true,
        run: { ...run, ...patch, version: run.version + 1 },
    })
    switch (event.type) {
        case "step-done":
        case "side-done":
            if (run.done.includes(event.step)) return refuse(run, event, `${event.step} is already done`)
            return next({ done: [...run.done, event.step], unclearStep: run.unclearStep === event.step ? null : run.unclearStep })
        case "step-refused":
            return next({ status: "failed", failedStep: event.step, reason: event.reason })
        case "parked":
            return next({
                status: "parked",
                failedStep: event.step,
                reason: event.reason,
                parkedFrom: run.status === "compensating" ? "compensating" : "running",
                // Parked while running forward: the step got no answer in the end, so it may have happened.
                unclearStep: run.status === "running" ? event.step : run.unclearStep,
            })
        case "completed":
            return next({ status: "completed", failedStep: null, reason: null })
        case "resumed":
            return next({ status: run.parkedFrom ?? "running", parkedFrom: null })
        case "compensation-pressed":
            // A run parked during its own compensation is resumed, not pressed again.
            if (run.status === "parked" && run.parkedFrom === "compensating") return refuse(run, event, "already compensating; resume it")
            return next({ status: "compensating", parkedFrom: null, pressedBy: event.by })
        case "step-undone":
            if (!run.done.includes(event.step) && run.unclearStep !== event.step) return refuse(run, event, `${event.step} never ran`)
            if (run.undone.includes(event.step)) return refuse(run, event, `${event.step} is already undone`)
            return next({ undone: [...run.undone, event.step] })
        case "compensated":
            return next({ status: "compensated" })
        case "side-failed":
            return next({ sideFailures: [...run.sideFailures, `${event.step}: ${event.reason}`] })
    }
}

/** The blocking steps still to run, in their declared order. */
export const pendingSteps = <TInput>(definition: SagaDefinition<TInput>, run: SagaRun<TInput>) =>
    definition.steps.filter((step) => step.blocking && !run.done.includes(step.name))

/** The side steps still to run: not done and not already recorded as failed. */
export const pendingSideSteps = <TInput>(definition: SagaDefinition<TInput>, run: SagaRun<TInput>) =>
    definition.steps.filter(
        (step) =>
            !step.blocking &&
            !run.done.includes(step.name) &&
            !run.sideFailures.some((failure) => failure.startsWith(`${step.name}:`)),
    )

/**
 * The declared undos still to run: the unclear step first (it is the newest), then the done steps newest first. A done step with no compensation (a step that cannot be undone,
 * such as an email already sent) is skipped: that is why such steps run last.
 */
export const pendingCompensations = <TInput>(definition: SagaDefinition<TInput>, run: SagaRun<TInput>) =>
    [...(run.unclearStep === null ? [] : [run.unclearStep]), ...[...run.done].reverse()]
        .filter((step) => !run.undone.includes(step))
        .flatMap((step) => definition.compensations.filter((compensation) => compensation.step === step))

/**
 * A definition is valid when every compensation pairs with a declared step, no step has two, and no side step declares one:
 * an undo with no step is a mistake, and a side step only informs.
 */
export const definitionProblems = <TInput>(definition: SagaDefinition<TInput>): ReadonlyArray<string> => {
    const problems: string[] = []
    const names = definition.steps.map((step) => step.name)
    if (new Set(names).size !== names.length) problems.push("two steps share a name")
    for (const compensation of definition.compensations) {
        const step = definition.steps.find((candidate) => candidate.name === compensation.step)
        if (step === undefined) problems.push(`compensation ${compensation.step} has no step`)
        else if (!step.blocking) problems.push(`side step ${step.name} declares a compensation`)
    }
    const paired = definition.compensations.map((compensation) => compensation.step)
    if (new Set(paired).size !== paired.length) problems.push("a step has two compensations")
    return problems
}
