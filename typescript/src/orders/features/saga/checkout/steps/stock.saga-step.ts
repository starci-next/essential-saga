import { Injectable } from "@nestjs/common"
import type { CheckoutInput } from "../../../../domain/orders.service"
import type { SagaStep } from "../../../../platform/saga/saga.types"
import { ServiceClient } from "../../../../../platform/http-client"
import { serviceUrls, stepKey } from "../services"

@Injectable()
/**
 * Reserves the pairs in the stock service. When the answer is lost, the ladder sends the same command again with the same key:
 * stock's inbox answers with the reservation it already made, so an unclear step is settled by asking again, never by guessing.
 */
export class StockStep implements SagaStep<CheckoutInput> {
    readonly name = "stock"
    readonly event = "stock.reserved"
    readonly blocking = true
    private readonly urls = serviceUrls()

    constructor(private readonly client: ServiceClient) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.client.call({
            op: "stock.reserve",
            baseUrl: this.urls.stock,
            method: "POST",
            path: "/reservations",
            body: { orderId: input.orderId, sku: input.sku, quantity: input.quantity },
            idempotencyKey: stepKey(this.name, input.orderId),
        })
    }
}
