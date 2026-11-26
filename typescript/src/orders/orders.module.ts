import { Injectable, Module } from "@nestjs/common"
import { SEEDER, type Seeder, ServiceModule } from "../platform/service.module"
import { ORDERS_SCHEMA, OrdersService } from "./domain/orders.service"
import { CheckoutController } from "./features/api/checkout.controller"
import { SagaRunsController } from "./features/api/saga-runs.controller"
import { CheckoutRecovery } from "./features/saga/checkout/checkout.recovery"
import { CheckoutSagaService } from "./features/saga/checkout/checkout.saga.service"
import { OrderCompensation } from "./features/saga/checkout/compensations/order.compensation"
import { PaymentCompensation } from "./features/saga/checkout/compensations/payment.compensation"
import { StockCompensation } from "./features/saga/checkout/compensations/stock.compensation"
import { NotifyStep } from "./features/saga/checkout/steps/notify.saga-step"
import { OrderStep } from "./features/saga/checkout/steps/order.saga-step"
import { PaymentStep } from "./features/saga/checkout/steps/payment.saga-step"
import { StockStep } from "./features/saga/checkout/steps/stock.saga-step"
import { SagaRunner } from "./platform/saga/saga-runner.service"
import { SAGA_SCHEMA, SagaStore } from "./platform/saga/saga.store"

@Injectable()
/** The specs' reset: no orders and no runs. */
class OrdersSeeder implements Seeder {
    constructor(
        private readonly orders: OrdersService,
        private readonly store: SagaStore,
    ) {}

    async reset(): Promise<void> {
        await this.store.clear()
        await this.orders.clear()
    }
}

@Module({
    imports: [ServiceModule.forService("orders", [ORDERS_SCHEMA, SAGA_SCHEMA])],
    controllers: [CheckoutController, SagaRunsController],
    providers: [
        OrdersService,
        SagaStore,
        SagaRunner,
        OrderStep,
        PaymentStep,
        StockStep,
        NotifyStep,
        OrderCompensation,
        PaymentCompensation,
        StockCompensation,
        CheckoutSagaService,
        CheckoutRecovery,
        OrdersSeeder,
        { provide: SEEDER, useExisting: OrdersSeeder },
    ],
})
export class OrdersModule {}
