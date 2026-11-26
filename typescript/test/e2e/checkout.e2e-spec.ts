import {
    ORDER,
    available,
    balance,
    bootIdOf,
    call,
    checkout,
    emails,
    healthy,
    orderStatus,
    pressCompensation,
    refunds,
    resetShop,
    runOf,
    setFaults,
    waitFor,
} from "./shop"

const START = 5_000_000
const AFTER_PURCHASE = START - ORDER.amount

/** The "order placed" email is a side step: it follows the answer, so the specs wait for it. */
const waitForPlacedEmail = () =>
    waitFor("one placed email", async () => (await emails()).filter((email) => email.kind === "order-placed").length === 1)

beforeEach(async () => {
    await resetShop()
})

afterAll(async () => {
    await resetShop()
})

describe("checkout saga", () => {
    test("happy: the order is confirmed, paid once, the pair reserved, one placed email", async () => {
        const reply = await checkout()
        expect(reply.status).toBe(200)
        expect(reply.body.status).toBe("confirmed")
        expect(await orderStatus()).toBe("confirmed")
        expect(await balance()).toBe(AFTER_PURCHASE)
        expect(await available()).toBe(0)
        await waitForPlacedEmail()
        expect((await runOf()).status).toBe("completed")
    })

    test("out of stock after the charge: the run stops on-hold and keeps the money until a person presses the undo", async () => {
        await setFaults({ STOCK_OUT: true })
        const reply = await checkout()
        expect(reply.status).toBe(409)
        expect(reply.body).toMatchObject({ status: "on-hold", failedStep: "stock" })
        // No machine undoes the charge: the run is a typed failed row a person sees.
        expect((await runOf()).status).toBe("failed")
        expect(await orderStatus()).toBe("on-hold")
        expect(await balance()).toBe(AFTER_PURCHASE)
        expect(await emails()).toEqual([])

        const pressed = await pressCompensation()
        expect(pressed.status).toBe(202)
        const run = await runOf()
        expect(run.status).toBe("compensated")
        expect(run.pressedBy).toBe("staff-lan")
        // Newest done step first: the refund runs before the order is cancelled.
        expect(run.undone).toEqual(["payment", "order"])
        expect(await balance()).toBe(START)
        expect(await orderStatus()).toBe("cancelled")
        expect(await refunds()).toBe(1)
    })

    test("pressing the undo of a confirmed order is refused", async () => {
        await checkout()
        const reply = await call("orders", "POST", `/saga-runs/${ORDER.orderId}/compensate`, { by: "staff-lan" })
        expect(reply.status).toBe(409)
        expect(await balance()).toBe(AFTER_PURCHASE)
    })

    test("the first refund hits a network error: the undo retries on its ladder and refunds once", async () => {
        await setFaults({ STOCK_OUT: true, NET_FLAKY: "payments.refund" })
        await checkout()
        await pressCompensation()
        expect((await runOf()).status).toBe("compensated")
        expect(await balance()).toBe(START)
        expect(await refunds()).toBe(1)
    })

    test("every call arrives twice: the charge and the refund each happen once", async () => {
        await setFaults({ STOCK_OUT: true, DUP_EVENT: true })
        await checkout()
        expect(await balance()).toBe(AFTER_PURCHASE)
        await pressCompensation()
        expect(await balance()).toBe(START)
        expect(await refunds()).toBe(1)
    })

    test("orders crashes right after the charge: on restart the run moves on from its stored state and completes", async () => {
        const before = await bootIdOf("orders")
        await setFaults({ CRASH_AT: "after:payments.charge" })
        await checkout().catch(() => undefined)
        await waitFor("orders restarted", async () => (await healthy("orders")) && (await bootIdOf("orders")) !== before, 60_000)
        await waitFor("the run completed", async () => (await runOf()).status === "completed")
        expect(await balance()).toBe(AFTER_PURCHASE)
        expect(await available()).toBe(0)
        expect(await orderStatus()).toBe("confirmed")
        await waitForPlacedEmail()
    })

    test("stock reserved the pair but the answer was lost: the same command is sent again and answered from stock's inbox", async () => {
        await setFaults({ LOST_RESPONSE: "stock.reserve" })
        const reply = await checkout()
        expect(reply.status).toBe(200)
        expect(await available()).toBe(0)
        const reservation = await call<{ status: string }>("stock", "GET", `/reservations/${ORDER.orderId}`)
        expect(reservation.body.status).toBe("reserved")
    })

    test("stock keeps losing its answers: the run parks with the step unclear, and a person's undo releases what it may hold", async () => {
        await setFaults({ LOST_RESPONSE: "always:stock.reserve" })
        const reply = await checkout()
        // The customer is told the truth: the order arrived and is still being processed.
        expect(reply.status).toBe(202)
        const parked = await runOf()
        expect(parked.status).toBe("parked")
        expect(parked.failedStep).toBe("stock")
        // The pair was reserved on stock's side; nothing releases it by itself.
        expect(await available()).toBe(0)

        await pressCompensation()
        const run = await runOf()
        expect(run.status).toBe("compensated")
        expect(run.undone).toEqual(["stock", "payment", "order"])
        expect(await available()).toBe(1)
        expect(await balance()).toBe(START)
        expect(await orderStatus()).toBe("cancelled")
    })

    test("checkout pressed twice at once: one run, one charge, the same answer, one placed email", async () => {
        const [first, second] = await Promise.all([checkout(), checkout()])
        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(second.body).toEqual(first.body)
        expect(await balance()).toBe(AFTER_PURCHASE)
        await waitForPlacedEmail()
        expect((await runOf()).version).toBeGreaterThan(0)
    })

    test("a cancelled order never gets a placed email", async () => {
        await setFaults({ STOCK_OUT: true })
        await checkout()
        await pressCompensation()
        // Give a stray side step time to show up, then check it never did.
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        expect(await emails()).toEqual([])
    })

    test("the placed email fails once: the order is confirmed first, the email follows on its own ladder", async () => {
        await setFaults({ NET_FLAKY: "notify.send" })
        // NET_FLAKY fails only the first try; the side step's own ladder sends it again, after the customer has the answer.
        const reply = await checkout()
        expect(reply.status).toBe(200)
        await waitForPlacedEmail()
        expect((await runOf()).sideFailures).toEqual([])
    })
})
