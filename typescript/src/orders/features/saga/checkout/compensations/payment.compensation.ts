import { Injectable } from "@nestjs/common"
import type { CheckoutInput } from "../../../../domain/orders.service"
import type { SagaCompensation } from "../../../../platform/saga/saga.types"
import { ServiceClient } from "../../../../../platform/http-client"
import { segment, serviceUrls, undoKey } from "../services"

@Injectable()
/**
 * The declared undo of the payment step: refund the charge. A new forward command with its own key, not a rollback: the charge
 * committed in another database long ago. A retry of it (a network error on the first try) refunds once.
 */
export class PaymentCompensation implements SagaCompensation<CheckoutInput> {
    readonly step = "payment"
    readonly event = "payments.refunded"
    private readonly urls = serviceUrls()

    constructor(private readonly client: ServiceClient) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.client.call({
            op: "payments.refund",
            baseUrl: this.urls.payments,
            method: "POST",
            path: `/charges/${segment(input.orderId)}/refund`,
            idempotencyKey: undoKey(this.step, input.orderId),
        })
    }
}
