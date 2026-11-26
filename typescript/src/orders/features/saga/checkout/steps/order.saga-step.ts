import { Injectable } from "@nestjs/common"
import { type CheckoutInput, OrdersService } from "../../../../domain/orders.service"
import type { SagaStep } from "../../../../platform/saga/saga.types"

@Injectable()
/** First step: the order exists, `pending`. A local write in the orders database, idempotent by its order id. */
export class OrderStep implements SagaStep<CheckoutInput> {
    readonly name = "order"
    readonly event = "orders.order-created"
    readonly blocking = true

    constructor(private readonly orders: OrdersService) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.orders.create(input)
    }
}
