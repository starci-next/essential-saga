import { HttpException } from "@nestjs/common"

/**
 * A business answer a service gives its caller: an HTTP status plus `{ error, message }`, where `error` is a stable machine code
 * (`out-of-stock`). The service sends it only after its transaction rolled back, so the caller knows the work was not done.
 */
export const problem = (status: number, code: string, message: string): HttpException =>
    new HttpException({ error: code, message }, status)

/** What went wrong with one call between services, as the caller sees it. */
export interface CallErrorInit {
    /** The operation name, such as `payments.charge`. */
    readonly op: string
    /** The HTTP status the other side answered, or null when no answer came back. */
    readonly status: number | null
    /** The machine code of the answer (`out-of-stock`), or null. */
    readonly code: string | null
    readonly message: string
}

/**
 * The failure of one call. Its class decides what the saga does with it (see `classifyFailure` in the orders saga platform):
 * no answer or a 5xx is transient and is retried with the same idempotency key; a 4xx is a business refusal and stops the run.
 */
export class CallError extends Error {
    readonly op: string
    readonly status: number | null
    readonly code: string | null

    constructor(init: CallErrorInit) {
        super(init.message)
        this.name = "CallError"
        this.op = init.op
        this.status = init.status
        this.code = init.code
    }
}

/** One short line for a failure, stored on the run as its reason: `stock.reserve: 409 out-of-stock (size 42 is sold out)`. */
export const describeError = (error: unknown): string => {
    if (error instanceof CallError) {
        const status = error.status === null ? "no answer" : String(error.status)
        return `${error.op}: ${status}${error.code === null ? "" : ` ${error.code}`} (${error.message})`
    }
    return error instanceof Error ? error.message : String(error)
}
