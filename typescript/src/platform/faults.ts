import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Observable } from "rxjs"
import { CallError, problem } from "./errors"

/**
 * Fault switches for the end-to-end specs. They live in the infrastructure (the service client and one interceptor), never in the
 * saga code: the saga must survive these faults without knowing they are simulated. They are reachable only when the process
 * runs with `TEST_HOOKS=on` (docker-compose.yml sets it; a production deployment does not).
 *
 * A switch targets operations by name (`payments.refund`): `true` targets every operation, a comma list targets the named ones.
 *
 *   STOCK_OUT      stock answers 409 out-of-stock to every reservation
 *   NET_FLAKY      the first call of each targeted operation fails with 503 before it reaches the other side
 *   DUP_EVENT      every targeted call is delivered twice with the same body and key
 *   LOST_RESPONSE  the call reaches the other side and commits, but the answer is lost (once; `always:<ops>` every time)
 *   CRASH_AT       `before:<op>` or `after:<op>`: the process exits there, like a power cut (docker restarts it)
 *
 * The switches live in the memory of one process, so a restart clears them: CRASH_AT kills a process exactly once.
 */
export const FAULT_KEYS = ["STOCK_OUT", "NET_FLAKY", "DUP_EVENT", "LOST_RESPONSE", "CRASH_AT"] as const
export type FaultKey = (typeof FAULT_KEYS)[number]
export type Faults = Partial<Record<FaultKey, string | boolean>>

const isFaultKey = (key: string): key is FaultKey => (FAULT_KEYS as ReadonlyArray<string>).includes(key)

@Injectable()
export class FaultsService {
    private readonly logger = new Logger("faults")
    private state: Faults = {}
    private readonly flakyDone = new Set<string>()
    private readonly lostDone = new Set<string>()
    private crashArmed = false

    get(): Faults {
        return { ...this.state }
    }

    /** Sets the named switches; `false` or null clears one. Setting switches starts a fresh attempt for NET_FLAKY. */
    set(patch: Readonly<Record<string, unknown>>): Faults {
        for (const [key, value] of Object.entries(patch)) {
            if (!isFaultKey(key)) continue
            if (value === false || value === null || value === undefined) delete this.state[key]
            else if (typeof value === "string" || typeof value === "boolean") this.state[key] = value
        }
        this.flakyDone.clear()
        this.lostDone.clear()
        this.crashArmed = false
        return this.get()
    }

    reset(): void {
        this.state = {}
        this.flakyDone.clear()
        this.lostDone.clear()
        this.crashArmed = false
    }

    targets(key: FaultKey, op: string): boolean {
        const value = this.state[key]
        if (value === undefined || value === false) return false
        if (value === true) return true
        return value
            .split(",")
            .map((name) => name.trim())
            .includes(op)
    }

    /** Runs one call under the switches, in a fixed order: crash before, flaky, the call, duplicate, lost answer, crash after. */
    async runOp<T>(op: string, work: () => Promise<T>): Promise<T> {
        if (this.crashArmed) this.crash(`CRASH_AT=after (next operation ${op})`)
        if (this.state.CRASH_AT === `before:${op}`) this.crash(`CRASH_AT=before:${op}`)
        if (this.targets("NET_FLAKY", op) && !this.flakyDone.has(op)) {
            this.flakyDone.add(op)
            throw new CallError({ op, status: 503, code: "net-flaky", message: "NET_FLAKY: the call never reached the service" })
        }
        const result = await work()
        if (this.targets("DUP_EVENT", op)) {
            await work().catch((error: unknown) => this.logger.warn(`DUP_EVENT: second delivery of ${op}: ${String(error)}`))
        }
        if (this.losesAnswer(op)) {
            throw new CallError({ op, status: null, code: null, message: "LOST_RESPONSE: the answer never came back" })
        }
        if (this.state.CRASH_AT === `after:${op}`) {
            // Die at the start of the next operation (or after two seconds when none comes), after this one committed.
            this.crashArmed = true
            setTimeout(() => this.crash(`CRASH_AT=after:${op}`), 2_000).unref()
        }
        return result
    }

    /**
     * LOST_RESPONSE loses the answer of the first call of each targeted operation, like a blip; prefixed `always:`
     * (`always:stock.reserve`) it loses every answer, like an outage that outlasts the whole retry ladder.
     */
    private readonly losesAnswer = (op: string): boolean => {
        const value = this.state.LOST_RESPONSE
        if (typeof value === "string" && value.startsWith("always:"))
            return value
                .slice("always:".length)
                .split(",")
                .map((name) => name.trim())
                .includes(op)
        if (!this.targets("LOST_RESPONSE", op) || this.lostDone.has(op)) return false
        this.lostDone.add(op)
        return true
    }

    private readonly crash = (why: string): never => {
        this.logger.error(`${why}: exiting`)
        process.exit(1)
    }
}

export const FAULT_OP = "faults:op"

/** Names the operation a route serves (`@FaultOp("stock.reserve")`), so receiver-side switches can target it. */
export const FaultOp = (op: string): MethodDecorator => SetMetadata(FAULT_OP, op)

@Injectable()
/** The one receiver-side switch: STOCK_OUT answers 409 before the reservation handler runs, so the stock service holds no test code. */
export class FaultsInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly faults: FaultsService,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const op = this.reflector.get<string | undefined>(FAULT_OP, context.getHandler())
        if (op === "stock.reserve" && this.faults.targets("STOCK_OUT", op))
            throw problem(409, "out-of-stock", "STOCK_OUT: stock says the item is sold out")
        return next.handle()
    }
}
