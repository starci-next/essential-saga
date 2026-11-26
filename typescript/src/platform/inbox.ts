import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "./database"

/** The inbox table every receiving service creates (one row per claimed delivery). */
export const INBOX_SCHEMA = `
    CREATE TABLE IF NOT EXISTS inbox (
        source     text        NOT NULL,
        key        text        NOT NULL,
        response   jsonb       NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source, key)
    )`

/** The answer of a claimed command: its response, and whether it is the stored answer of an earlier delivery. */
export interface Claimed<T> {
    readonly response: T
    readonly replayed: boolean
}

@Injectable()
/**
 * The receiving side of idempotency. A command arrives with an `Idempotency-Key` the sender fixed for that step and that order
 * (never random): a retry, a duplicate delivery and a replay after a crash all carry the same key.
 *
 * The claim and the effect commit in ONE transaction: the claim row is inserted first, the effect runs, and the response is
 * stored on the claim. A second delivery with the same key waits on the primary key until the first commits, then finds the
 * row and gets the stored response back; the effect never runs twice. When the effect throws, the transaction rolls back and
 * the claim disappears with it, so a later retry runs for real.
 */
export class Inbox {
    constructor(private readonly db: Database) {}

    async run<T>(source: string, key: string | null, effect: (tx: Tx) => Promise<T>): Promise<Claimed<T>> {
        if (key === null) return { response: await this.db.transaction(effect), replayed: false }
        return this.db.transaction(async (tx) => {
            const claimed = await tx.query(
                `INSERT INTO inbox (source, key, response) VALUES ($1, $2, 'null') ON CONFLICT DO NOTHING RETURNING key`,
                [source, key],
            )
            if (claimed.rowCount === 0) {
                const stored = await tx.query<{ response: T }>(`SELECT response FROM inbox WHERE source = $1 AND key = $2`, [
                    source,
                    key,
                ])
                return { response: stored.rows[0]!.response, replayed: true }
            }
            const response = await effect(tx)
            await tx.query(`UPDATE inbox SET response = $3 WHERE source = $1 AND key = $2`, [source, key, JSON.stringify(response)])
            return { response, replayed: false }
        })
    }
}
