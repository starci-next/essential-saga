import type { CheckoutInput } from "../../../domain/orders.service"
import type { SagaRun } from "../../../platform/saga/saga.types"

/** The name of the saga, the key of its runs in `saga_runs`. */
export const CHECKOUT_SAGA = "checkout"

/** The persisted state of one checkout run: status and version (the fence) come from the platform's run. */
export type CheckoutSagaState = SagaRun<CheckoutInput>

/** The state of the run of an order, or null when it never started one. */
export type FindCheckoutSagaResult = CheckoutSagaState | null
