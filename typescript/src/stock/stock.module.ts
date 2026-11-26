import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Injectable,
    Module,
    type OnApplicationBootstrap,
    Param,
    Post,
} from "@nestjs/common"
import { asRecord, keyOf, positiveInt, text } from "../platform/body"
import { Database } from "../platform/database"
import { problem } from "../platform/errors"
import { FaultOp } from "../platform/faults"
import { INBOX_SCHEMA, Inbox } from "../platform/inbox"
import { SEEDER, type Seeder, ServiceModule } from "../platform/service.module"

/** The stock database: items with the pairs available, and one reservation per order. */
export const STOCK_SCHEMA = [
    INBOX_SCHEMA,
    `CREATE TABLE IF NOT EXISTS items (
        sku       text    NOT NULL PRIMARY KEY,
        available integer NOT NULL CHECK (available >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS reservations (
        order_id text    NOT NULL PRIMARY KEY,
        sku      text    NOT NULL REFERENCES items (sku),
        quantity integer NOT NULL CHECK (quantity > 0),
        status   text    NOT NULL
    )`,
]

/** The sample item of the specs: one pair of size 42 shoes. */
export const SAMPLE_ITEM = { sku: "giay-42", available: 1 }

export interface ReservationView {
    readonly orderId: string
    readonly sku: string
    readonly quantity: number
    readonly status: "reserved" | "released"
}

@Injectable()
/** Reservations, each one local transaction taken through the inbox, so a repeated command reserves or releases once. */
export class StockService {
    constructor(
        private readonly db: Database,
        private readonly inbox: Inbox,
    ) {}

    async reserve(key: string | null, input: { orderId: string; sku: string; quantity: number }): Promise<ReservationView> {
        const claimed = await this.inbox.run("stock.reserve", key, async (tx) => {
            const taken = await tx.query(`UPDATE items SET available = available - $2 WHERE sku = $1 AND available >= $2`, [
                input.sku,
                input.quantity,
            ])
            if (taken.rowCount !== 1) throw problem(409, "out-of-stock", `${input.sku} has fewer than ${input.quantity} pairs`)
            await tx.query(`INSERT INTO reservations (order_id, sku, quantity, status) VALUES ($1, $2, $3, 'reserved')`, [
                input.orderId,
                input.sku,
                input.quantity,
            ])
            return { ...input, status: "reserved" as const }
        })
        return claimed.response
    }

    /** The undo of a reservation. An order that holds nothing answers `null`: there is nothing to give back. */
    async release(key: string | null, orderId: string): Promise<ReservationView | null> {
        const claimed = await this.inbox.run("stock.release", key, async (tx) => {
            const rows = await tx.query<{ sku: string; quantity: number; status: string }>(
                `SELECT sku, quantity, status FROM reservations WHERE order_id = $1 FOR UPDATE`,
                [orderId],
            )
            const held = rows.rows[0]
            if (held === undefined) return null
            if (held.status === "reserved") {
                await tx.query(`UPDATE items SET available = available + $2 WHERE sku = $1`, [held.sku, held.quantity])
                await tx.query(`UPDATE reservations SET status = 'released' WHERE order_id = $1`, [orderId])
            }
            return { orderId, sku: held.sku, quantity: held.quantity, status: "released" as const }
        })
        return claimed.response
    }

    async item(sku: string): Promise<{ sku: string; available: number }> {
        const rows = await this.db.query<{ available: number }>(`SELECT available FROM items WHERE sku = $1`, [sku])
        if (rows[0] === undefined) throw problem(404, "item-not-found", "no such item")
        return { sku, available: rows[0].available }
    }

    async reservation(orderId: string): Promise<ReservationView> {
        const rows = await this.db.query<{ sku: string; quantity: number; status: "reserved" | "released" }>(
            `SELECT sku, quantity, status FROM reservations WHERE order_id = $1`,
            [orderId],
        )
        if (rows[0] === undefined) throw problem(404, "reservation-not-found", "this order holds no reservation")
        return { orderId, ...rows[0] }
    }

    async reset(): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.query(`TRUNCATE reservations, items, inbox`)
            await tx.query(`INSERT INTO items (sku, available) VALUES ($1, $2)`, [SAMPLE_ITEM.sku, SAMPLE_ITEM.available])
        })
    }

    async seedIfEmpty(): Promise<void> {
        await this.db.query(`INSERT INTO items (sku, available) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
            SAMPLE_ITEM.sku,
            SAMPLE_ITEM.available,
        ])
    }
}

@Controller()
/** The stock door. Both writes honour `Idempotency-Key`. */
export class StockController {
    constructor(private readonly stock: StockService) {}

    @Post("reservations")
    @HttpCode(200)
    @FaultOp("stock.reserve")
    reserve(@Body() raw: unknown, @Headers("idempotency-key") key: string | undefined): Promise<ReservationView> {
        const body = asRecord(raw)
        return this.stock.reserve(keyOf(key), {
            orderId: text(body, "orderId"),
            sku: text(body, "sku"),
            quantity: positiveInt(body, "quantity"),
        })
    }

    @Post("reservations/:orderId/release")
    @HttpCode(200)
    async release(
        @Param("orderId") orderId: string,
        @Headers("idempotency-key") key: string | undefined,
    ): Promise<{ released: ReservationView | null }> {
        return { released: await this.stock.release(keyOf(key), orderId) }
    }

    @Get("items/:sku")
    item(@Param("sku") sku: string): Promise<{ sku: string; available: number }> {
        return this.stock.item(sku)
    }

    @Get("reservations/:orderId")
    reservation(@Param("orderId") orderId: string): Promise<ReservationView> {
        return this.stock.reservation(orderId)
    }
}

@Injectable()
class StockSeeder implements Seeder, OnApplicationBootstrap {
    constructor(private readonly stock: StockService) {}

    reset(): Promise<void> {
        return this.stock.reset()
    }

    onApplicationBootstrap(): Promise<void> {
        return this.stock.seedIfEmpty()
    }
}

@Module({
    imports: [ServiceModule.forService("stock", STOCK_SCHEMA)],
    controllers: [StockController],
    providers: [StockService, StockSeeder, { provide: SEEDER, useExisting: StockSeeder }],
})
export class StockModule {}
