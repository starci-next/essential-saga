import { Injectable } from "@nestjs/common"
import { type CheckoutInput, OrdersService } from "../../../../domain/orders.service"
import type { SagaCompensation } from "../../../../platform/saga/saga.types"

@Injectable()
/** The declared undo of the order step: the order is cancelled. It runs only after a person pressed the compensation. */
export class OrderCompensation implements SagaCompensation<CheckoutInput> {
    readonly step = "order"
    readonly event = "orders.order-cancelled"

    constructor(private readonly orders: OrdersService) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.orders.cancel(input.orderId)
    }
}
