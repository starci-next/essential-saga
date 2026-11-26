import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common"
import { Pool, type PoolClient } from "pg"
import { env, sleep } from "./env"

/** The token of the SQL statements a service runs at start to create its tables (idempotent `CREATE ... IF NOT EXISTS`). */
export const SCHEMA = Symbol("SCHEMA")

/** A client inside an open transaction: everything written through it commits or rolls back together. */
export type Tx = PoolClient

@Injectable()
/**
 * The service's own Postgres database. Each service has one database and no transaction ever spans two of them, which is
 * exactly why the checkout is a saga and not one transaction.
 */
export class Database implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(Database.name)
    readonly pool = new Pool({ connectionString: env("DATABASE_URL"), max: 10 })

    constructor(@Inject(SCHEMA) private readonly schema: ReadonlyArray<string>) {}

    /**
     * Creates the tables before the service takes requests. Postgres may still be finishing its first start (it restarts once
     * after creating the databases), so the first connection is retried for a while instead of failing the boot.
     */
    async onModuleInit(): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.pool.query("SELECT 1")
                break
            } catch (error) {
                if (attempt >= 30) throw error
                this.logger.warn(`database not reachable yet (${String(error)}), retrying`)
                await sleep(1_000)
            }
        }
        for (const statement of this.schema) await this.pool.query(statement)
        this.logger.log("schema ready")
    }

    async onApplicationShutdown(): Promise<void> {
        await this.pool.end()
    }

    /** Runs a query outside any transaction. */
    async query<T extends object>(text: string, values: ReadonlyArray<unknown> = []): Promise<T[]> {
        return (await this.pool.query<T>(text, [...values])).rows
    }

    /** Runs `work` in one transaction: commit when it returns, roll back when it throws. */
    async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
        const client = await this.pool.connect()
        try {
            await client.query("BEGIN")
            const result = await work(client)
            await client.query("COMMIT")
            return result
        } catch (error) {
            await client.query("ROLLBACK")
            throw error
        } finally {
            client.release()
        }
    }
}
