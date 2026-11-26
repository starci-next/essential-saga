import { definitionProblems, pendingCompensations, pendingSideSteps, pendingSteps, transition } from "../../src/orders/platform/saga/saga-transition"
import type { SagaDefinition, SagaEvent, SagaRun } from "../../src/orders/platform/saga/saga.types"

const step = (name: string, blocking = true) => ({ name, event: `x.${name}`, blocking, run: async () => undefined })
const undo = (name: string) => ({ step: name, event: `x.${name}-undone`, run: async () => undefined })

const definition: SagaDefinition<null> = {
    saga: "checkout",
    ladder: "waited",
    steps: [step("order"), step("payment"), step("stock"), step("notify", false)],
    compensations: [undo("order"), undo("payment"), undo("stock")],
}

const run = (patch: Partial<SagaRun<null>> = {}): SagaRun<null> => ({
    saga: "checkout",
    correlationId: "o-1",
    status: "running",
    version: 0,
    input: null,
    done: [],
    undone: [],
    failedStep: null,
    unclearStep: null,
    reason: null,
    parkedFrom: null,
    pressedBy: null,
    sideFailures: [],
    ...patch,
})

const next = (from: SagaRun<null>, event: SagaEvent): SagaRun<null> => {
    const answer = transition(from, event)
    if (!answer.ok) throw new Error(answer.refusal)
    return answer.run
}

describe("transition", () => {
    test("every accepted event moves the version by one", () => {
        const done = next(run(), { type: "step-done", step: "order" })
        expect(done.version).toBe(1)
        expect(done.done).toEqual(["order"])
    })

    test("a refused step stops the run as failed and nothing undoes it by itself", () => {
        const failed = next(run({ done: ["order", "payment"] }), { type: "step-refused", step: "stock", reason: "out of stock" })
        expect(failed.status).toBe("failed")
        expect(failed.failedStep).toBe("stock")
        expect(failed.undone).toEqual([])
    })

    test("only a stopped run can be pressed, and the press records who pressed it", () => {
        expect(transition(run(), { type: "compensation-pressed", by: "lan" }).ok).toBe(false)
        expect(transition(run({ status: "completed" }), { type: "compensation-pressed", by: "lan" }).ok).toBe(false)
        const pressed = next(run({ status: "failed" }), { type: "compensation-pressed", by: "lan" })
        expect(pressed.status).toBe("compensating")
        expect(pressed.pressedBy).toBe("lan")
    })

    test("a run parked while compensating resumes its compensation and cannot be pressed again", () => {
        const parked = next(run({ status: "compensating", done: ["order"] }), { type: "parked", step: "order", reason: "no answer" })
        expect(parked.parkedFrom).toBe("compensating")
        expect(transition(parked, { type: "compensation-pressed", by: "lan" }).ok).toBe(false)
        expect(next(parked, { type: "resumed" }).status).toBe("compensating")
    })

    test("a step parked while running forward is unclear, and its undo runs first when a person presses", () => {
        const parked = next(run({ done: ["order", "payment"] }), { type: "parked", step: "stock", reason: "no answer" })
        expect(parked.unclearStep).toBe("stock")
        const pressed = next(parked, { type: "compensation-pressed", by: "lan" })
        expect(pendingCompensations(definition, pressed).map((each) => each.step)).toEqual(["stock", "payment", "order"])
        expect(next(pressed, { type: "step-undone", step: "stock" }).undone).toEqual(["stock"])
    })

    test("an unclear step that finally answers is done and no longer unclear", () => {
        const parked = next(run({ done: ["order"] }), { type: "parked", step: "payment", reason: "no answer" })
        const resumed = next(parked, { type: "resumed" })
        expect(next(resumed, { type: "step-done", step: "payment" }).unclearStep).toBeNull()
    })

    test("a run parked while running resumes forward", () => {
        const parked = next(run(), { type: "parked", step: "payment", reason: "no answer" })
        expect(next(parked, { type: "resumed" }).status).toBe("running")
    })

    test("a repeated or impossible event is refused instead of moving the run twice", () => {
        expect(transition(run({ done: ["order"] }), { type: "step-done", step: "order" }).ok).toBe(false)
        expect(transition(run({ status: "compensating", done: ["order"], undone: ["order"] }), { type: "step-undone", step: "order" }).ok).toBe(false)
        expect(transition(run({ status: "compensating" }), { type: "step-undone", step: "payment" }).ok).toBe(false)
        expect(transition(run({ status: "completed" }), { type: "completed" }).ok).toBe(false)
    })

    test("a side step failure is recorded on a completed run and leaves it completed", () => {
        const completed = next(run({ done: ["order", "payment", "stock"] }), { type: "completed" })
        const recorded = next(completed, { type: "side-failed", step: "notify", reason: "no answer" })
        expect(recorded.status).toBe("completed")
        expect(recorded.sideFailures).toEqual(["notify: no answer"])
    })
})

describe("pending work", () => {
    test("blocking steps run in order and side steps wait for the completed run", () => {
        expect(pendingSteps(definition, run({ done: ["order"] })).map((each) => each.name)).toEqual(["payment", "stock"])
        expect(pendingSideSteps(definition, run({ status: "completed", done: ["order", "payment", "stock"] })).map((each) => each.name)).toEqual([
            "notify",
        ])
        expect(pendingSideSteps(definition, run({ sideFailures: ["notify: no answer"] }))).toEqual([])
    })

    test("compensations run newest done step first and skip what is already undone", () => {
        const pending = pendingCompensations(definition, run({ status: "compensating", done: ["order", "payment"], undone: [] }))
        expect(pending.map((each) => each.step)).toEqual(["payment", "order"])
        const rest = pendingCompensations(definition, run({ status: "compensating", done: ["order", "payment"], undone: ["payment"] }))
        expect(rest.map((each) => each.step)).toEqual(["order"])
    })
})

describe("definitionProblems", () => {
    test("the checkout definition is valid", () => {
        expect(definitionProblems(definition)).toEqual([])
    })

    test("an undo with no step, a second undo and an undo of a side step are each a problem", () => {
        const broken: SagaDefinition<null> = {
            ...definition,
            compensations: [undo("order"), undo("order"), undo("ghost"), undo("notify")],
        }
        expect(definitionProblems(broken)).toEqual([
            "compensation ghost has no step",
            "side step notify declares a compensation",
            "a step has two compensations",
        ])
    })
})
