import { Injectable } from "@nestjs/common"
import { envNumber } from "./env"
import { CallError } from "./errors"
import { FaultsService } from "./faults"

/** One call to another service. */
export interface ServiceRequest {
    /** The operation name (`payments.charge`): logs, fault switches and run reasons use it. */
    readonly op: string
    readonly baseUrl: string
    readonly method: "GET" | "POST"
    readonly path: string
    readonly body?: unknown
    /** Sent as `Idempotency-Key`: the receiver's inbox recognises a repeated command by it. */
    readonly idempotencyKey?: string
}

const parse = (text: string): unknown => {
    if (text === "") return null
    try {
        return JSON.parse(text) as unknown
    } catch {
        return text
    }
}

const field = (body: unknown, name: string): string | null =>
    typeof body === "object" && body !== null && name in body ? String((body as Record<string, unknown>)[name]) : null

@Injectable()
/**
 * The client every service uses to call another: fetch with a timeout and a typed `CallError`. It never retries by itself;
 * the saga's job runner decides that, because only the saga knows which command is safe to send again (each carries a fixed
 * idempotency key, which is what makes the retry safe).
 */
export class ServiceClient {
    private readonly timeoutMs = envNumber("HTTP_TIMEOUT_MS", 3_000)

    constructor(private readonly faults: FaultsService) {}

    async call<T>(request: ServiceRequest): Promise<T> {
        return this.faults.runOp(request.op, async () => (await this.send(request)) as T)
    }

    private readonly send = async (request: ServiceRequest): Promise<unknown> => {
        const headers: Record<string, string> = { accept: "application/json" }
        if (request.body !== undefined) headers["content-type"] = "application/json"
        if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey
        let response: Response
        let text: string
        try {
            response = await fetch(`${request.baseUrl}${request.path}`, {
                method: request.method,
                headers,
                body: request.body === undefined ? undefined : JSON.stringify(request.body),
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            text = await response.text()
        } catch (error) {
            // No answer: the command may or may not have committed on the other side. Sending it again with the same key is safe.
            throw new CallError({ op: request.op, status: null, code: null, message: `no answer: ${String(error)}` })
        }
        const body = parse(text)
        if (!response.ok)
            throw new CallError({
                op: request.op,
                status: response.status,
                code: field(body, "error"),
                message: field(body, "message") ?? `HTTP ${response.status}`,
            })
        return body
    }
}
