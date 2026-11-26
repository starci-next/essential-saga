import { Injectable } from "@nestjs/common"
import type { CheckoutInput } from "../../../../domain/orders.service"
import type { SagaStep } from "../../../../platform/saga/saga.types"
import { ServiceClient } from "../../../../../platform/http-client"
import { serviceUrls, stepKey } from "../services"

@Injectable()
/** Charges the customer's wallet in the payments service. Its key makes a retry or a duplicate charge only once. */
export class PaymentStep implements SagaStep<CheckoutInput> {
    readonly name = "payment"
    readonly event = "payments.charged"
    readonly blocking = true
    private readonly urls = serviceUrls()

    constructor(private readonly client: ServiceClient) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.client.call({
            op: "payments.charge",
            baseUrl: this.urls.payments,
            method: "POST",
            path: "/charges",
            body: { orderId: input.orderId, customerId: input.customerId, amount: input.amount },
            idempotencyKey: stepKey(this.name, input.orderId),
        })
    }
}
