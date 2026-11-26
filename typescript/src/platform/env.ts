/**
 * Reads configuration from the environment, so one image runs under docker compose and on a laptop without code changes.
 * A missing required value stops the process at start, which is clearer than failing on the first request.
 */
export const env = (name: string, fallback?: string): string => {
    const value = process.env[name]
    if (value !== undefined && value !== "") return value
    if (fallback !== undefined) return fallback
    throw new Error(`missing environment variable ${name}`)
}

/** Like `env`, for numbers (ports, timeouts). */
export const envNumber = (name: string, fallback: number): number => {
    const value = Number(env(name, String(fallback)))
    if (!Number.isFinite(value)) throw new Error(`environment variable ${name} must be a number`)
    return value
}

/** Waits `ms` milliseconds (the retry ladder's pauses). */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
