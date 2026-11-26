import { Injectable } from "@nestjs/common"
import type { CheckoutInput } from "../../../../domain/orders.service"
import type { SagaStep } from "../../../../platform/saga/saga.types"
import { ServiceClient } from "../../../../../platform/http-client"
import { serviceUrls, stepKey } from "../services"

@Injectable()
/**
 * The "order placed" email. A side step: it only informs, it cannot be undone, and it runs after every blocking step is done,
 * so a cancelled order never gets it. When it fails, the failure is recorded on the run; the order stays confirmed.
 */
export class NotifyStep implements SagaStep<CheckoutInput> {
    readonly name = "notify"
    readonly event = "notify.order-placed-sent"
    readonly blocking = false
    private readonly urls = serviceUrls()

    constructor(private readonly client: ServiceClient) {}

    async run(input: CheckoutInput): Promise<void> {
        await this.client.call({
            op: "notify.send",
            baseUrl: this.urls.notify,
            method: "POST",
            path: "/emails",
            body: { orderId: input.orderId, customerId: input.customerId, kind: "order-placed" },
            idempotencyKey: stepKey(this.name, input.orderId),
        })
    }
}
