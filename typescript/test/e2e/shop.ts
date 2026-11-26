// Helpers for the end-to-end specs: they talk to the four running services over HTTP only (start them with `npm run up`).
export type Service = "orders" | "payments" | "stock" | "notify"

export const SERVICES: ReadonlyArray<Service> = ["orders", "payments", "stock", "notify"]
const PORTS: Record<Service, number> = { orders: 4101, payments: 4102, stock: 4103, notify: 4104 }

export const urlOf = (service: Service): string => process.env[`${service.toUpperCase()}_URL`] ?? `http://localhost:${PORTS[service]}`

export interface Reply<T> {
    readonly status: number
    readonly body: T
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One HTTP call, never retried: a spec wants to see the first answer. */
export const call = async <T = unknown>(service: Service, method: string, path: string, body?: unknown): Promise<Reply<T>> => {
    const response = await fetch(`${urlOf(service)}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(40_000),
    })
    const text = await response.text()
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T }
}

/** Waits until `probe` holds, or fails the spec with what it waited for. */
export const waitFor = async (what: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await probe().catch(() => false)) return
        await sleep(200)
    }
    throw new Error(`waited ${timeoutMs}ms for: ${what}`)
}

export const healthy = (service: Service): Promise<boolean> => call(service, "GET", "/health").then((reply) => reply.status === 200)

export const bootIdOf = async (service: Service): Promise<string> =>
    (await call<{ bootId: string }>(service, "GET", "/health")).body.bootId

/** Sample data back in every service (5,000,000 in the wallet, one pair of size 42), every fault switch off. */
export const resetShop = async (): Promise<void> => {
    for (const service of SERVICES) {
        await waitFor(`${service} /health`, () => healthy(service))
        const reply = await call(service, "POST", "/test/reset")
        if (reply.status !== 200) throw new Error(`${service} reset answered ${reply.status}`)
    }
}

export type Faults = Partial<Record<"STOCK_OUT" | "NET_FLAKY" | "DUP_EVENT" | "LOST_RESPONSE" | "CRASH_AT", string | boolean>>

/** Sets fault switches on every service. */
export const setFaults = async (faults: Faults): Promise<void> => {
    for (const service of SERVICES) await call(service, "PUT", "/test/faults", faults)
}

export const ORDER = { orderId: "o-1", customerId: "c-minh", sku: "giay-42", quantity: 1, amount: 1_200_000 }

export const checkout = (order = ORDER) => call<{ status: string; failedStep?: string | null; message?: string }>("orders", "POST", "/checkout", order)

export interface RunView {
    readonly status: string
    readonly version: number
    readonly done: string[]
    readonly undone: string[]
    readonly failedStep: string | null
    readonly pressedBy: string | null
    readonly sideFailures: string[]
}

export const runOf = async (orderId = ORDER.orderId): Promise<RunView> => (await call<RunView>("orders", "GET", `/saga-runs/${orderId}`)).body

export const balance = async (): Promise<number> => (await call<{ balance: number }>("payments", "GET", "/wallets/c-minh")).body.balance

export const available = async (): Promise<number> => (await call<{ available: number }>("stock", "GET", "/items/giay-42")).body.available

export const orderStatus = async (orderId = ORDER.orderId): Promise<string> =>
    (await call<{ status: string }>("orders", "GET", `/orders/${orderId}`)).body.status

export const emails = async (orderId = ORDER.orderId): Promise<Array<{ kind: string }>> =>
    (await call<Array<{ kind: string }>>("notify", "GET", `/emails?orderId=${orderId}`)).body

export const refunds = async (orderId = ORDER.orderId): Promise<number> =>
    (await call<{ refunds: number }>("payments", "GET", `/charges/${orderId}`)).body.refunds

/** A person presses "undo this order", then the spec waits for the run to settle. */
export const pressCompensation = async (orderId = ORDER.orderId): Promise<Reply<RunView>> => {
    const reply = await call<RunView>("orders", "POST", `/saga-runs/${orderId}/compensate`, { by: "staff-lan" })
    await waitFor("the run compensated or parked", async () => ["compensated", "parked"].includes((await runOf(orderId)).status))
    return reply
}
