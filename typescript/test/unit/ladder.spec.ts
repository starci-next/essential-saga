import { classifyFailure, ladderOf, runOnLadder } from "../../src/orders/platform/jobs/ladder"
import { answerOf } from "../../src/orders/features/api/checkout.controller"
import { CallError } from "../../src/platform/errors"
import type { SagaRun } from "../../src/orders/platform/saga/saga.types"

const noAnswer = () => new CallError({ op: "payments.refund", status: null, code: null, message: "no answer" })
const outOfStock = () => new CallError({ op: "stock.reserve", status: 409, code: "out-of-stock", message: "sold out" })

describe("classifyFailure", () => {
    test("no answer and a 5xx are transient, a 4xx is a refusal, anything else is a code failure", () => {
        expect(classifyFailure(noAnswer())).toBe("transient")
        expect(classifyFailure(new CallError({ op: "x", status: 503, code: null, message: "down" }))).toBe("transient")
        expect(classifyFailure(outOfStock())).toBe("refused")
        expect(classifyFailure(new TypeError("bug"))).toBe("code")
    })
})

describe("runOnLadder", () => {
    const waits: number[] = []
    const wait = async (ms: number) => {
        waits.push(ms)
    }

    beforeEach(() => {
        waits.length = 0
    })

    test("a transient failure is retried after each rung until the work is done", async () => {
        let tries = 0
        const outcome = await runOnLadder(
            async () => {
                tries += 1
                if (tries < 3) throw noAnswer()
            },
            [10, 20, 40],
            wait,
        )
        expect(outcome).toEqual({ kind: "done" })
        expect(waits).toEqual([10, 20])
    })

    test("after the last rung the work is parked, not swallowed", async () => {
        const outcome = await runOnLadder(async () => Promise.reject(noAnswer()), [10, 20], wait)
        expect(outcome.kind).toBe("parked")
        expect(waits).toEqual([10, 20])
    })

    test("a refusal ends at once and a code failure parks at once", async () => {
        expect((await runOnLadder(async () => Promise.reject(outOfStock()), [10], wait)).kind).toBe("refused")
        expect((await runOnLadder(async () => Promise.reject(new TypeError("bug")), [10], wait)).kind).toBe("parked")
        expect(waits).toEqual([])
    })
})

describe("ladderOf", () => {
    test("reads the rungs from the environment and refuses a bad one", () => {
        process.env.LADDER_WAITED_MS = "1,2,3"
        expect(ladderOf("waited")).toEqual([1, 2, 3])
        process.env.LADDER_WAITED_MS = "1,x"
        expect(() => ladderOf("waited")).toThrow("bad ladder")
        delete process.env.LADDER_WAITED_MS
        expect(ladderOf("waited").length).toBeGreaterThan(0)
    })
})

describe("answerOf", () => {
    const run = (status: SagaRun<null>["status"], failedStep: string | null = null) =>
        ({ correlationId: "o-1", status, failedStep }) as SagaRun<never>

    test("the customer gets confirmed, an honest on-hold line naming the step, or pending", () => {
        expect(answerOf(run("completed"))).toEqual({ httpStatus: 200, body: { status: "confirmed", orderId: "o-1" } })
        const held = answerOf(run("failed", "stock"))
        expect(held.httpStatus).toBe(409)
        expect(held.body).toMatchObject({ status: "on-hold", failedStep: "stock" })
        expect(answerOf(run("parked", "payment")).httpStatus).toBe(202)
    })
})
