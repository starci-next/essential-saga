import { Injectable } from "@nestjs/common"
import type { CheckoutInput } from "../../../../domain/orders.service"
import type { SagaCompensation } from "../../../../platform/saga/saga.types"
import { ServiceClient } from "../../../../../platform/http-client"
import { segment, serviceUrls, undoKey } from "../services"

@Injectable()
/** The declared undo of the stock step: release the reservation. Releasing an order that holds nothing answers 200 and does nothing. */
export class StockCompensation implements SagaCompensation<CheckoutInput> {
    readonly step = "stock"
    readonly event = "stock.released"
    private readonly urls = serviceUrls()

    constructor(private readonly client: ServiceClient) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.client.call({
            op: "stock.release",
            baseUrl: this.urls.stock,
            method: "POST",
            path: `/reservations/${segment(input.orderId)}/release`,
            idempotencyKey: undoKey(this.step, input.orderId),
        })
    }
}
