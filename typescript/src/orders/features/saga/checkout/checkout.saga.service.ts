import { Injectable } from "@nestjs/common"
import { type CheckoutInput, OrdersService } from "../../../domain/orders.service"
import { SagaRunner, type SagaEffects } from "../../../platform/saga/saga-runner.service"
import { SagaStore } from "../../../platform/saga/saga.store"
import type { SagaDefinition, SagaRun } from "../../../platform/saga/saga.types"
import { CHECKOUT_SAGA, type FindCheckoutSagaResult } from "./checkout.saga-state"
import { OrderCompensation } from "./compensations/order.compensation"
import { PaymentCompensation } from "./compensations/payment.compensation"
import { StockCompensation } from "./compensations/stock.compensation"
import { NotifyStep } from "./steps/notify.saga-step"
import { OrderStep } from "./steps/order.saga-step"
import { PaymentStep } from "./steps/payment.saga-step"
import { StockStep } from "./steps/stock.saga-step"

@Injectable()
/**
 * The orchestrator of the checkout saga: the list of its steps and, beside each step that can be undone, its compensation. It
 * decides nothing: the order of the steps, the retry ladder, the fence and the undo belong to the saga platform (`SagaRunner`).
 *
 *   order    create the order, pending   | undo: cancel the order
 *   payment  charge the wallet           | undo: refund
 *   stock    reserve the pairs           | undo: release
 *   notify   "order placed" email        | no undo: a side step, after every blocking step
 *
 * A customer waits on this run, so it uses the `waited` ladder. When a step is refused (out of stock), the run stops `failed`
 * and the order goes `on-hold`: the money already taken stays taken until a person presses the compensation. That is a choice:
 * the undo is a reviewable act a person decides to make, never a reflex that could itself fail half-way unseen.
 */
export class CheckoutSagaService {
    readonly definition: SagaDefinition<CheckoutInput>
    private readonly effects: SagaEffects<CheckoutInput>

    constructor(
        private readonly runner: SagaRunner,
        private readonly store: SagaStore,
        orders: OrdersService,
        orderStep: OrderStep,
        paymentStep: PaymentStep,
        stockStep: StockStep,
        notifyStep: NotifyStep,
        orderCompensation: OrderCompensation,
        paymentCompensation: PaymentCompensation,
        stockCompensation: StockCompensation,
    ) {
        this.definition = {
            saga: CHECKOUT_SAGA,
            ladder: "waited",
            steps: [orderStep, paymentStep, stockStep, notifyStep],
            compensations: [orderCompensation, paymentCompensation, stockCompensation],
        }
        this.effects = {
            completed: (tx, input) => orders.setStatus(tx, input.orderId, "confirmed"),
            failed: (tx, input) => orders.setStatus(tx, input.orderId, "on-hold"),
            compensated: (tx, input) => orders.setStatus(tx, input.orderId, "cancelled"),
        }
        runner.check(this.definition)
    }

    /** Starts the run of an order once; a second checkout of the same order starts nothing. */
    start(input: CheckoutInput): Promise<void> {
        return this.runner.start(this.definition, this.effects, input.orderId, input)
    }

    /** Where the run of an order stands, or null. */
    stateOf(orderId: string): Promise<FindCheckoutSagaResult> {
        return this.store.find(CHECKOUT_SAGA, orderId)
    }

    /** A person pressed "undo this order". */
    press(orderId: string, by: string): Promise<SagaRun<CheckoutInput>> {
        return this.runner.press(this.definition, this.effects, orderId, by)
    }

    /** A person pressed "resume now" on a parked run. */
    resume(orderId: string): Promise<SagaRun<CheckoutInput>> {
        return this.runner.resume(this.definition, this.effects, orderId)
    }

    /** Recovery: moves a run this process does not hold, from where its state says it stands. */
    async recover(run: SagaRun<CheckoutInput>): Promise<void> {
        if (this.runner.isActive(CHECKOUT_SAGA, run.correlationId)) return
        if (run.status === "running") await this.runner.forward(this.definition, this.effects, run.correlationId)
        if (run.status === "compensating") await this.runner.compensate(this.definition, this.effects, run.correlationId)
        if (run.status === "completed") await this.runner.sideSteps(this.definition, run.correlationId)
        if (run.status === "parked") await this.resume(run.correlationId)
    }
}
