import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, type OnApplicationBootstrap, Param, Post } from "@nestjs/common"
import { asRecord, keyOf, positiveInt, text } from "../platform/body"
import { SEEDER, type Seeder, ServiceModule } from "../platform/service.module"
import { type ChargeView, PAYMENTS_SCHEMA, PaymentsService } from "./payments.service"

@Controller()
/** The payments door. Both writes honour `Idempotency-Key`. */
export class PaymentsController {
    constructor(private readonly payments: PaymentsService) {}

    @Post("charges")
    @HttpCode(200)
    async charge(@Body() raw: unknown, @Headers("idempotency-key") key: string | undefined): Promise<ChargeView> {
        const body = asRecord(raw)
        const input = { orderId: text(body, "orderId"), customerId: text(body, "customerId"), amount: positiveInt(body, "amount") }
        return (await this.payments.charge(keyOf(key), input)).response
    }

    @Post("charges/:orderId/refund")
    @HttpCode(200)
    async refund(
        @Param("orderId") orderId: string,
        @Headers("idempotency-key") key: string | undefined,
    ): Promise<{ refunded: ChargeView | null }> {
        return { refunded: (await this.payments.refund(keyOf(key), orderId)).response }
    }

    @Get("charges/:orderId")
    findCharge(@Param("orderId") orderId: string): Promise<ChargeView> {
        return this.payments.findCharge(orderId)
    }

    @Get("wallets/:customerId")
    wallet(@Param("customerId") customerId: string): Promise<{ customerId: string; balance: number }> {
        return this.payments.balanceOf(customerId)
    }
}

@Injectable()
class PaymentsSeeder implements Seeder, OnApplicationBootstrap {
    constructor(private readonly payments: PaymentsService) {}

    reset(): Promise<void> {
        return this.payments.reset()
    }

    onApplicationBootstrap(): Promise<void> {
        return this.payments.seedIfEmpty()
    }
}

@Module({
    imports: [ServiceModule.forService("payments", PAYMENTS_SCHEMA)],
    controllers: [PaymentsController],
    providers: [PaymentsService, PaymentsSeeder, { provide: SEEDER, useExisting: PaymentsSeeder }],
})
export class PaymentsModule {}
