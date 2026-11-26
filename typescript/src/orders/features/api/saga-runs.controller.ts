import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post } from "@nestjs/common"
import { asRecord, text } from "../../../platform/body"
import { SagaTransitionRefused } from "../../platform/saga/saga.store"
import type { CheckoutSagaState } from "../saga/checkout/checkout.saga-state"
import { CheckoutSagaService } from "../saga/checkout/checkout.saga.service"

@Controller("saga-runs")
/**
 * The staff's door. A stopped run is a typed row a person sees here; they decide to press the compensation (undo the order) or
 * to resume a parked run. Each press is a transition under the fence, so pressing twice moves the run once.
 */
export class SagaRunsController {
    constructor(private readonly checkout: CheckoutSagaService) {}

    @Get(":orderId")
    async state(@Param("orderId") orderId: string): Promise<CheckoutSagaState> {
        const run = await this.checkout.stateOf(orderId)
        if (run === null) throw new NotFoundException({ error: "run-not-found", message: "no run for this order" })
        return run
    }

    @Post(":orderId/compensate")
    @HttpCode(202)
    async compensate(@Param("orderId") orderId: string, @Body() raw: unknown): Promise<CheckoutSagaState> {
        const by = text(asRecord(raw), "by")
        return this.guard(orderId, () => this.checkout.press(orderId, by))
    }

    @Post(":orderId/resume")
    @HttpCode(202)
    async resume(@Param("orderId") orderId: string): Promise<CheckoutSagaState> {
        return this.guard(orderId, () => this.checkout.resume(orderId))
    }

    private readonly guard = async (orderId: string, work: () => Promise<CheckoutSagaState>): Promise<CheckoutSagaState> => {
        if ((await this.checkout.stateOf(orderId)) === null)
            throw new NotFoundException({ error: "run-not-found", message: "no run for this order" })
        try {
            return await work()
        } catch (error) {
            if (error instanceof SagaTransitionRefused) throw new ConflictException({ error: "run-not-stopped", message: error.message })
            throw error
        }
    }
}
