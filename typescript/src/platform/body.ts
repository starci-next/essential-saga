import { problem } from "./errors"

/** Reads a JSON body as a record, or answers 400. */
export const asRecord = (raw: unknown): Record<string, unknown> => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw problem(400, "bad-body", "the body must be an object")
    return raw as Record<string, unknown>
}

/** A required non-empty string field, or 400. */
export const text = (body: Record<string, unknown>, name: string): string => {
    const value = body[name]
    if (typeof value !== "string" || value.trim() === "") throw problem(400, "bad-body", `${name} must be a non-empty string`)
    return value
}

/** A required positive integer field, or 400. */
export const positiveInt = (body: Record<string, unknown>, name: string): number => {
    const value = body[name]
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        throw problem(400, "bad-body", `${name} must be a positive integer`)
    return value
}

/** The `Idempotency-Key` header, or null when the caller sent none. */
export const keyOf = (header: string | undefined): string | null =>
    header === undefined || header.trim() === "" ? null : header.trim()
