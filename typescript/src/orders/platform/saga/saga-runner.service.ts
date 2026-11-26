import { Injectable, Logger } from "@nestjs/common"
import type { Tx } from "../../../platform/database"
import { ladderOf, runOnLadder } from "../jobs/ladder"
import { definitionProblems, pendingCompensations, pendingSideSteps, pendingSteps } from "./saga-transition"
import { SagaStore, SagaTransitionRefused } from "./saga.store"
import type { SagaDefinition, SagaRun } from "./saga.types"

/** Domain writes a definition ties to a transition, committed in the same transaction as the run's new state. */
export interface SagaEffects<TInput> {
    readonly completed?: (tx: Tx, input: TInput) => Promise<void>
    readonly failed?: (tx: Tx, input: TInput) => Promise<void>
    readonly compensated?: (tx: Tx, input: TInput) => Promise<void>
}

@Injectable()
/**
 * Runs sagas. It owns the orchestration so a feature's orchestrator stays a thin list of steps and compensations:
 * - forward: each pending blocking step on the run's ladder, in order; a refusal stops the run as `failed`, a step that keeps
 *   failing parks it; when all are done the run completes and its side steps run on their own;
 * - compensation: only when a person presses it, the declared undos of the done steps run forward, newest first, each on the
 *   background ladder;
 * - resume: a person (or a new build, at start) sends a parked run back to where it stopped. Every command carries the same
 *   idempotency key as before, so a step already done on the other side is answered from its inbox and not repeated.
 */
export class SagaRunner {
    private readonly logger = new Logger(SagaRunner.name)
    /** The runs this process is moving right now, so the sweep does not pick them up twice. Across processes, the fence decides. */
    private readonly active = new Set<string>()

    constructor(private readonly store: SagaStore) {}

    /** Refuses a definition whose compensations do not pair with its steps (checked once, when the orchestrator is built). */
    check<TInput>(definition: SagaDefinition<TInput>): void {
        const problems = definitionProblems(definition)
        if (problems.length > 0) throw new Error(`saga ${definition.saga} is invalid: ${problems.join("; ")}`)
    }

    isActive(saga: string, correlationId: string): boolean {
        return this.active.has(`${saga}:${correlationId}`)
    }

    /** Opens the run once and moves it forward. A second start of the same id changes nothing: the caller reads the first run. */
    async start<TInput>(definition: SagaDefinition<TInput>, effects: SagaEffects<TInput>, id: string, input: TInput): Promise<void> {
        if (await this.store.begin(definition.saga, id, input)) await this.forward(definition, effects, id)
    }

    /** Moves a running run forward from where it stands (also what recovery calls after a crash). */
    async forward<TInput>(definition: SagaDefinition<TInput>, effects: SagaEffects<TInput>, id: string): Promise<void> {
        await this.exclusive(definition.saga, id, async () => {
            let run = await this.store.get<TInput>(definition.saga, id)
            if (run.status !== "running") return
            for (const step of pendingSteps(definition, run)) {
                const outcome = await runOnLadder(() => step.run(run.input), ladderOf(definition.ladder))
                if (outcome.kind === "refused") {
                    await this.store.apply(run, { type: "step-refused", step: step.name, reason: outcome.reason }, (tx) =>
                        effects.failed === undefined ? Promise.resolve() : effects.failed(tx, run.input),
                    )
                    return
                }
                if (outcome.kind === "parked") {
                    this.logger.warn(`${definition.saga} ${id} parked at ${step.name}: ${outcome.reason}`)
                    await this.store.apply(run, { type: "parked", step: step.name, reason: outcome.reason })
                    return
                }
                run = await this.store.apply(run, { type: "step-done", step: step.name })
            }
            run = await this.store.apply(run, { type: "completed" }, (tx) =>
                effects.completed === undefined ? Promise.resolve() : effects.completed(tx, run.input),
            )
        })
        // Side steps run after the customer has the answer, outside the exclusive section: they never hold the run.
        void this.sideSteps(definition, id)
    }

    /** Runs the side steps of a completed run; a failure is recorded on the run and nothing else changes. */
    async sideSteps<TInput>(definition: SagaDefinition<TInput>, id: string): Promise<void> {
        await this.exclusive(definition.saga, `${id}:side`, async () => {
            let run = await this.store.get<TInput>(definition.saga, id)
            if (run.status !== "completed") return
            for (const step of pendingSideSteps(definition, run)) {
                const outcome = await runOnLadder(() => step.run(run.input), ladderOf("background"))
                run =
                    outcome.kind === "done"
                        ? await this.store.apply(run, { type: "side-done", step: step.name })
                        : await this.store.apply(run, { type: "side-failed", step: step.name, reason: outcome.reason })
            }
        }).catch((error: unknown) => this.logger.error(`side steps of ${definition.saga} ${id}: ${String(error)}`))
    }

    /** A person pressed the compensation of a stopped run. Answers the run as it stands after the press; the undos run on their own. */
    async press<TInput>(definition: SagaDefinition<TInput>, effects: SagaEffects<TInput>, id: string, by: string): Promise<SagaRun<TInput>> {
        const run = await this.store.get<TInput>(definition.saga, id)
        const pressed = await this.store.apply(run, { type: "compensation-pressed", by })
        void this.compensate(definition, effects, id)
        return pressed
    }

    /** A person (or a new build) resumes a parked run where it stopped. */
    async resume<TInput>(definition: SagaDefinition<TInput>, effects: SagaEffects<TInput>, id: string): Promise<SagaRun<TInput>> {
        const run = await this.store.get<TInput>(definition.saga, id)
        const resumed = await this.store.apply(run, { type: "resumed" })
        void (resumed.status === "compensating" ? this.compensate(definition, effects, id) : this.forward(definition, effects, id))
        return resumed
    }

    /** Runs the pending declared undos of a compensating run, newest done step first, each as a forward job on the background ladder. */
    async compensate<TInput>(definition: SagaDefinition<TInput>, effects: SagaEffects<TInput>, id: string): Promise<void> {
        await this.exclusive(definition.saga, id, async () => {
            let run = await this.store.get<TInput>(definition.saga, id)
            if (run.status !== "compensating") return
            for (const compensation of pendingCompensations(definition, run)) {
                const outcome = await runOnLadder(() => compensation.run(run.input), ladderOf("background"))
                if (outcome.kind !== "done") {
                    // A refused undo is not retried by a machine either: it waits, parked, for the person who pressed it.
                    await this.store.apply(run, { type: "parked", step: compensation.step, reason: outcome.reason })
                    return
                }
                run = await this.store.apply(run, { type: "step-undone", step: compensation.step })
            }
            await this.store.apply(run, { type: "compensated" }, (tx) =>
                effects.compensated === undefined ? Promise.resolve() : effects.compensated(tx, run.input),
            )
        })
    }

    /** Keeps one mover per run in this process, and lets a fence refusal (another mover got there first) end quietly. */
    private readonly exclusive = async (saga: string, id: string, work: () => Promise<void>): Promise<void> => {
        const key = `${saga}:${id}`
        if (this.active.has(key)) return
        this.active.add(key)
        try {
            await work()
        } catch (error) {
            if (!(error instanceof SagaTransitionRefused)) throw error
            this.logger.warn(error.message)
        } finally {
            this.active.delete(key)
        }
    }
}
