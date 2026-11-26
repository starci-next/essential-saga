import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Post, Query } from "@nestjs/common"
import { asRecord, keyOf, text } from "../platform/body"
import { Database } from "../platform/database"
import { INBOX_SCHEMA, Inbox } from "../platform/inbox"
import { SEEDER, type Seeder, ServiceModule } from "../platform/service.module"

/** The notify database: the emails sent (a real deployment hands each one to a mail provider). */
export const NOTIFY_SCHEMA = [
    INBOX_SCHEMA,
    `CREATE TABLE IF NOT EXISTS emails (
        id          bigserial   PRIMARY KEY,
        order_id    text        NOT NULL,
        customer_id text        NOT NULL,
        kind        text        NOT NULL,
        sent_at     timestamptz NOT NULL DEFAULT now()
    )`,
]

export interface EmailView {
    readonly orderId: string
    readonly customerId: string
    readonly kind: string
}

@Injectable()
/** Emails. An email cannot be taken back, which is why the saga sends it last; the inbox makes a repeated send a replay. */
export class NotifyService {
    constructor(
        private readonly db: Database,
        private readonly inbox: Inbox,
    ) {}

    async send(key: string | null, email: EmailView): Promise<EmailView> {
        const claimed = await this.inbox.run("notify.send", key, async (tx) => {
            await tx.query(`INSERT INTO emails (order_id, customer_id, kind) VALUES ($1, $2, $3)`, [
                email.orderId,
                email.customerId,
                email.kind,
            ])
            return email
        })
        return claimed.response
    }

    async sentFor(orderId: string): Promise<ReadonlyArray<EmailView>> {
        const rows = await this.db.query<{ order_id: string; customer_id: string; kind: string }>(
            `SELECT order_id, customer_id, kind FROM emails WHERE order_id = $1 ORDER BY id`,
            [orderId],
        )
        return rows.map((row) => ({ orderId: row.order_id, customerId: row.customer_id, kind: row.kind }))
    }

    async reset(): Promise<void> {
        await this.db.query(`TRUNCATE emails, inbox`)
    }
}

@Controller()
/** The notify door. */
export class NotifyController {
    constructor(private readonly notify: NotifyService) {}

    @Post("emails")
    @HttpCode(200)
    send(@Body() raw: unknown, @Headers("idempotency-key") key: string | undefined): Promise<EmailView> {
        const body = asRecord(raw)
        return this.notify.send(keyOf(key), {
            orderId: text(body, "orderId"),
            customerId: text(body, "customerId"),
            kind: text(body, "kind"),
        })
    }

    @Get("emails")
    list(@Query("orderId") orderId: string): Promise<ReadonlyArray<EmailView>> {
        return this.notify.sentFor(orderId)
    }
}

@Injectable()
class NotifySeeder implements Seeder {
    constructor(private readonly notify: NotifyService) {}

    reset(): Promise<void> {
        return this.notify.reset()
    }
}

@Module({
    imports: [ServiceModule.forService("notify", NOTIFY_SCHEMA)],
    controllers: [NotifyController],
    providers: [NotifyService, NotifySeeder, { provide: SEEDER, useExisting: NotifySeeder }],
})
export class NotifyModule {}
