import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "../platform/database"
import { problem } from "../platform/errors"
import { INBOX_SCHEMA, Inbox, type Claimed } from "../platform/inbox"

/** The payments database: wallets, one charge per order, and a ledger of refunds. */
export const PAYMENTS_SCHEMA = [
    INBOX_SCHEMA,
    `CREATE TABLE IF NOT EXISTS wallets (
        customer_id text   NOT NULL PRIMARY KEY,
        balance     bigint NOT NULL CHECK (balance >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS charges (
        order_id    text        NOT NULL PRIMARY KEY,
        customer_id text        NOT NULL REFERENCES wallets (customer_id),
        amount      bigint      NOT NULL CHECK (amount > 0),
        created_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS refunds (
        id         bigserial   PRIMARY KEY,
        order_id   text        NOT NULL REFERENCES charges (order_id),
        amount     bigint      NOT NULL CHECK (amount > 0),
        created_at timestamptz NOT NULL DEFAULT now()
    )`,
]

/** The sample wallet of the specs: 5,000,000 VND. */
export const SAMPLE_WALLET = { customerId: "c-minh", balance: 5_000_000 }

export interface ChargeView {
    readonly orderId: string
    readonly customerId: string
    readonly amount: number
    /** How many refunds the ledger holds for this order (the specs read it to prove a refund ran once). */
    readonly refunds: number
}

@Injectable()
/**
 * Charges and refunds. Each is one local transaction in the payments database, taken through the inbox: the claim of the
 * idempotency key, the wallet change and the ledger row commit together, so a repeated command never moves money twice.
 */
export class PaymentsService {
    constructor(
        private readonly db: Database,
        private readonly inbox: Inbox,
    ) {}

    charge(key: string | null, input: { orderId: string; customerId: string; amount: number }): Promise<Claimed<ChargeView>> {
        return this.inbox.run("payments.charge", key, async (tx) => {
            // The balance check and the debit are one statement: two charges at once cannot both pass the check.
            const debit = await tx.query(`UPDATE wallets SET balance = balance - $2 WHERE customer_id = $1 AND balance >= $2`, [
                input.customerId,
                input.amount,
            ])
            if (debit.rowCount !== 1) throw problem(402, "insufficient-funds", `wallet ${input.customerId} cannot pay ${input.amount}`)
            await tx.query(`INSERT INTO charges (order_id, customer_id, amount) VALUES ($1, $2, $3)`, [
                input.orderId,
                input.customerId,
                input.amount,
            ])
            return this.viewIn(tx, input.orderId)
        })
    }

    /**
     * The undo of a charge: a new ledger row and the money back. The inbox makes a repeat of the same undo a replay. An order
     * that was never charged (its charge got no answer and in fact never landed) answers null: there is nothing to give back.
     */
    refund(key: string | null, orderId: string): Promise<Claimed<ChargeView | null>> {
        return this.inbox.run("payments.refund", key, async (tx) => {
            const charges = await tx.query<{ customer_id: string; amount: string }>(
                `SELECT customer_id, amount FROM charges WHERE order_id = $1 FOR UPDATE`,
                [orderId],
            )
            const charge = charges.rows[0]
            if (charge === undefined) return null
            await tx.query(`INSERT INTO refunds (order_id, amount) VALUES ($1, $2)`, [orderId, charge.amount])
            await tx.query(`UPDATE wallets SET balance = balance + $2 WHERE customer_id = $1`, [charge.customer_id, charge.amount])
            return this.viewIn(tx, orderId)
        })
    }

    async findCharge(orderId: string): Promise<ChargeView> {
        const client = await this.db.pool.connect()
        try {
            return await this.viewIn(client, orderId)
        } finally {
            client.release()
        }
    }

    async balanceOf(customerId: string): Promise<{ customerId: string; balance: number }> {
        const rows = await this.db.query<{ balance: string }>(`SELECT balance FROM wallets WHERE customer_id = $1`, [customerId])
        if (rows[0] === undefined) throw problem(404, "wallet-not-found", "no such wallet")
        return { customerId, balance: Number(rows[0].balance) }
    }

    /** Puts the sample wallet back and forgets every charge, refund and claim. */
    async reset(): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.query(`TRUNCATE refunds, charges, wallets, inbox`)
            await tx.query(`INSERT INTO wallets (customer_id, balance) VALUES ($1, $2)`, [SAMPLE_WALLET.customerId, SAMPLE_WALLET.balance])
        })
    }

    /** Seeds the sample wallet on an empty database (a restart keeps the data). */
    async seedIfEmpty(): Promise<void> {
        await this.db.query(`INSERT INTO wallets (customer_id, balance) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
            SAMPLE_WALLET.customerId,
            SAMPLE_WALLET.balance,
        ])
    }

    private readonly viewIn = async (tx: Tx, orderId: string): Promise<ChargeView> => {
        const rows = await tx.query<{ customer_id: string; amount: string; refunds: string }>(
            `SELECT c.customer_id, c.amount, (SELECT count(*) FROM refunds r WHERE r.order_id = c.order_id) AS refunds
             FROM charges c WHERE c.order_id = $1`,
            [orderId],
        )
        const row = rows.rows[0]
        if (row === undefined) throw problem(404, "charge-not-found", `order ${orderId} was never charged`)
        return { orderId, customerId: row.customer_id, amount: Number(row.amount), refunds: Number(row.refunds) }
    }
}
