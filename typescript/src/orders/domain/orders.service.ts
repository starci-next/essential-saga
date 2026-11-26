import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "../../platform/database"

/** The orders table, created by the orders schema. */
export const ORDERS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS orders (
        order_id    text        NOT NULL PRIMARY KEY,
        customer_id text        NOT NULL,
        sku         text        NOT NULL,
        quantity    integer     NOT NULL CHECK (quantity > 0),
        amount      bigint      NOT NULL CHECK (amount > 0),
        status      text        NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
    )`

/** What a checkout asks for. */
export interface CheckoutInput {
    readonly orderId: string
    readonly customerId: string
    readonly sku: string
    readonly quantity: number
    readonly amount: number
}

/**
 * The status of an order, as the customer and the staff read it:
 * `pending` while the saga runs, `confirmed` when it completed, `on-hold` when a step was refused and a person has to decide,
 * `cancelled` when that person pressed the compensation and every undo ran.
 */
export type OrderStatus = "pending" | "confirmed" | "on-hold" | "cancelled"

export interface OrderView {
    readonly orderId: string
    readonly customerId: string
    readonly sku: string
    readonly quantity: number
    readonly amount: number
    readonly status: OrderStatus
}

interface OrderRow {
    order_id: string
    customer_id: string
    sku: string
    quantity: number
    amount: string
    status: OrderStatus
}

@Injectable()
/** The orders domain: one local table in the orders database. */
export class OrdersService {
    constructor(private readonly db: Database) {}

    /** Creates the order once; a repeat (a retry, a replay after a crash) finds the row and changes nothing. */
    async create(input: CheckoutInput): Promise<void> {
        await this.db.query(
            `INSERT INTO orders (order_id, customer_id, sku, quantity, amount, status) VALUES ($1, $2, $3, $4, $5, 'pending')
             ON CONFLICT (order_id) DO NOTHING`,
            [input.orderId, input.customerId, input.sku, input.quantity, input.amount],
        )
    }

    /** Sets the status inside the transaction of a saga transition, so the order and the run never disagree. */
    async setStatus(tx: Tx, orderId: string, status: OrderStatus): Promise<void> {
        await tx.query(`UPDATE orders SET status = $2 WHERE order_id = $1`, [orderId, status])
    }

    /** The undo of the order step: the order is cancelled. Cancelling twice is the same as once. */
    async cancel(orderId: string): Promise<void> {
        await this.db.query(`UPDATE orders SET status = 'cancelled' WHERE order_id = $1`, [orderId])
    }

    async find(orderId: string): Promise<OrderView | null> {
        const rows = await this.db.query<OrderRow>(`SELECT * FROM orders WHERE order_id = $1`, [orderId])
        const row = rows[0]
        if (row === undefined) return null
        return {
            orderId: row.order_id,
            customerId: row.customer_id,
            sku: row.sku,
            quantity: row.quantity,
            amount: Number(row.amount),
            status: row.status,
        }
    }

    async clear(): Promise<void> {
        await this.db.query(`TRUNCATE orders`)
    }
}
