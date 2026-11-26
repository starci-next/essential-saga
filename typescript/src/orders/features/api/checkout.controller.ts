import { Body, Controller, Get, HttpCode, HttpException, NotFoundException, Param, Post } from "@nestjs/common"
import { asRecord, positiveInt, text } from "../../../platform/body"
import { envNumber, sleep } from "../../../platform/env"
import { OrdersService, type OrderView } from "../../domain/orders.service"
import type { CheckoutSagaState } from "../saga/checkout/checkout.saga-state"
import { CheckoutSagaService } from "../saga/checkout/checkout.saga.service"

/** The answer of a checkout, read from the run of the order. */
export type CheckoutAnswer =
    | { readonly status: "confirmed"; readonly orderId: string }
    | { readonly status: "on-hold"; readonly orderId: string; readonly failedStep: string | null; readonly message: string }
    | { readonly status: "pending"; readonly orderId: string; readonly message: string }

/**
 * What the customer is told, from the run's state. A run that stopped gets one honest line: the order arrived, where it stopped,
 * and that a person will answer. It promises nothing the system cannot keep (no automatic refund).
 */
export const answerOf = (run: CheckoutSagaState): { readonly httpStatus: number; readonly body: CheckoutAnswer } => {
    const orderId = run.correlationId
    if (run.status === "completed") return { httpStatus: 200, body: { status: "confirmed", orderId } }
    if (run.status === "failed" || run.status === "compensating" || run.status === "compensated") {
        const step = run.failedStep ?? "unknown"
        return {
            httpStatus: 409,
            body: {
                status: "on-hold",
                orderId,
                failedStep: run.failedStep,
                message: `Your order arrived but stopped at the ${step} step. A member of staff will contact you about it.`,
            },
        }
    }
    return {
        httpStatus: 202,
        body: { status: "pending", orderId, message: "Your order arrived and is still being processed. We will confirm it shortly." },
    }
}

@Controller()
/** The customer's door. The order id is the checkout's idempotency key: the same order checked out twice gets the first answer. */
export class CheckoutController {
    private readonly waitMs = envNumber("CHECKOUT_WAIT_MS", 20_000)

    constructor(
        private readonly checkout: CheckoutSagaService,
        private readonly orders: OrdersService,
    ) {}

    @Post("checkout")
    @HttpCode(200)
    async start(@Body() raw: unknown): Promise<CheckoutAnswer> {
        const body = asRecord(raw)
        const input = {
            orderId: text(body, "orderId"),
            customerId: text(body, "customerId"),
            sku: text(body, "sku"),
            quantity: positiveInt(body, "quantity"),
            amount: positiveInt(body, "amount"),
        }
        await this.checkout.start(input)
        const answer = answerOf(await this.settled(input.orderId))
        if (answer.httpStatus === 200) return answer.body
        throw new HttpException(answer.body, answer.httpStatus)
    }

    @Get("orders/:orderId")
    async order(@Param("orderId") orderId: string): Promise<OrderView> {
        const order = await this.orders.find(orderId)
        if (order === null) throw new NotFoundException({ error: "order-not-found", message: "no such order" })
        return order
    }

    /** Waits until the run is no longer moving forward (a second checkout waits for the first), up to CHECKOUT_WAIT_MS. */
    private readonly settled = async (orderId: string): Promise<CheckoutSagaState> => {
        const deadline = Date.now() + this.waitMs
        for (;;) {
            const run = await this.checkout.stateOf(orderId)
            if (run === null) throw new Error(`the run of ${orderId} is missing`)
            if (run.status !== "running" || Date.now() >= deadline) return run
            await sleep(50)
        }
    }
}
