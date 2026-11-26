import { env } from "../../../../platform/env"

/** Where the other services listen (docker compose sets these). */
export const serviceUrls = () => ({
    payments: env("PAYMENTS_URL", "http://localhost:4102"),
    stock: env("STOCK_URL", "http://localhost:4103"),
    notify: env("NOTIFY_URL", "http://localhost:4104"),
})

/**
 * The idempotency key of a command: fixed per step and order, never random. A retry, a duplicate delivery and a replay after a
 * crash all send the same key, and the receiver's inbox answers them with the first result. An undo has its own key.
 */
export const stepKey = (step: string, orderId: string): string => `checkout:${orderId}:${step}`
export const undoKey = (step: string, orderId: string): string => `checkout:${orderId}:${step}:undo`

export const segment = (value: string): string => encodeURIComponent(value)
