import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"
import { envNumber } from "../../../../platform/env"
import type { CheckoutInput } from "../../../domain/orders.service"
import { pendingSideSteps } from "../../../platform/saga/saga-transition"
import { SagaStore } from "../../../platform/saga/saga.store"
import type { SagaStatus } from "../../../platform/saga/saga.types"
import { CHECKOUT_SAGA } from "./checkout.saga-state"
import { CheckoutSagaService } from "./checkout.saga.service"

@Injectable()
/**
 * Recovery. The runs live in Postgres, so they survive a process that dies mid-run:
 * - at start, before the port opens, every run this process does not hold is moved on from where it stands, and a parked run is
 *   handed back once (a new build may have fixed what parked it);
 * - every SAGA_SWEEP_MS, runs left `running` or `compensating` by a dead process, and side steps not yet sent, are moved on.
 * The sweep never retries a parked run: that waits for a person's "resume now".
 */
export class CheckoutRecovery implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(CheckoutRecovery.name)
    private readonly intervalMs = envNumber("SAGA_SWEEP_MS", 1_000)
    private timer: NodeJS.Timeout | undefined
    private sweeping = false

    constructor(
        private readonly store: SagaStore,
        private readonly checkout: CheckoutSagaService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.sweep(["running", "compensating", "completed", "parked"])
        this.timer = setInterval(() => void this.sweep(["running", "compensating", "completed"]), this.intervalMs)
    }

    onApplicationShutdown(): void {
        if (this.timer !== undefined) clearInterval(this.timer)
    }

    private readonly sweep = async (statuses: ReadonlyArray<SagaStatus>): Promise<void> => {
        if (this.sweeping) return
        this.sweeping = true
        try {
            const runs = await this.store.inStatus<CheckoutInput>(CHECKOUT_SAGA, statuses)
            for (const run of runs) {
                if (run.status === "completed" && pendingSideSteps(this.checkout.definition, run).length === 0) continue
                await this.checkout
                    .recover(run)
                    .catch((error: unknown) => this.logger.error(`recovery of ${run.correlationId}: ${String(error)}`))
            }
        } catch (error) {
            this.logger.warn(`recovery sweep failed, the next one retries: ${String(error)}`)
        } finally {
            this.sweeping = false
        }
    }
}
