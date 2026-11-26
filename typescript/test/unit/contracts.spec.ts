import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OrderCompensation } from "../../src/orders/features/saga/checkout/compensations/order.compensation"
import { PaymentCompensation } from "../../src/orders/features/saga/checkout/compensations/payment.compensation"
import { StockCompensation } from "../../src/orders/features/saga/checkout/compensations/stock.compensation"
import { NotifyStep } from "../../src/orders/features/saga/checkout/steps/notify.saga-step"
import { OrderStep } from "../../src/orders/features/saga/checkout/steps/order.saga-step"
import { PaymentStep } from "../../src/orders/features/saga/checkout/steps/payment.saga-step"
import { StockStep } from "../../src/orders/features/saga/checkout/steps/stock.saga-step"

interface Contract {
    readonly version: number
    readonly step?: string
    readonly compensates?: string
    readonly side?: boolean
}

const contracts = JSON.parse(readFileSync(join(__dirname, "../../contracts/events.json"), "utf8")) as Record<string, Contract>

// The steps only need their names and events here, so their clients are left out.
const none = {} as never
const steps = [new OrderStep(none), new PaymentStep(none), new StockStep(none), new NotifyStep(none)]
const compensations = [new OrderCompensation(none), new PaymentCompensation(none), new StockCompensation(none)]

describe("the event contract", () => {
    test("every step's event is declared for that step, and a side step is declared as one", () => {
        for (const step of steps) {
            expect(contracts[step.event]).toMatchObject({ step: step.name })
            expect(contracts[step.event]?.side === true).toBe(!step.blocking)
        }
    })

    test("every compensation's event declares the event of the step it undoes", () => {
        for (const compensation of compensations) {
            const step = steps.find((candidate) => candidate.name === compensation.step)
            expect(step).toBeDefined()
            expect(contracts[compensation.event]?.compensates).toBe(step?.event)
        }
    })

    test("the contract declares no event the saga does not use", () => {
        const used = [...steps.map((step) => step.event), ...compensations.map((compensation) => compensation.event)].sort()
        expect(Object.keys(contracts).sort()).toEqual(used)
    })
})
