import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "../../../platform/database"
import { transition } from "./saga-transition"
import type { SagaEvent, SagaRun, SagaStatus } from "./saga.types"

/** The table of runs, created by the orders schema. */
export const SAGA_SCHEMA = `
    CREATE TABLE IF NOT EXISTS saga_runs (
        saga           text        NOT NULL,
        correlation_id text        NOT NULL,
        status         text        NOT NULL,
        version        integer     NOT NULL,
        input          jsonb       NOT NULL,
        done           text[]      NOT NULL DEFAULT '{}',
        undone         text[]      NOT NULL DEFAULT '{}',
        failed_step    text,
        unclear_step   text,
        reason         text,
        parked_from    text,
        pressed_by     text,
        side_failures  text[]      NOT NULL DEFAULT '{}',
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (saga, correlation_id)
    )`

interface RunRow {
    saga: string
    correlation_id: string
    status: SagaStatus
    version: number
    input: unknown
    done: string[]
    undone: string[]
    failed_step: string | null
    unclear_step: string | null
    reason: string | null
    parked_from: "running" | "compensating" | null
    pressed_by: string | null
    side_failures: string[]
}

const toRun = <TInput>(row: RunRow): SagaRun<TInput> => ({
    saga: row.saga,
    correlationId: row.correlation_id,
    status: row.status,
    version: row.version,
    input: row.input as TInput,
    done: row.done,
    undone: row.undone,
    failedStep: row.failed_step,
    unclearStep: row.unclear_step,
    reason: row.reason,
    parkedFrom: row.parked_from,
    pressedBy: row.pressed_by,
    sideFailures: row.side_failures,
})

/** A transition the fence refused: the run moved since it was read (another worker, a late delivery) or the event does not fit. */
export class SagaTransitionRefused extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SagaTransitionRefused"
    }
}

@Injectable()
/**
 * The fenced store of runs. A transition reads the run's version, computes the next state with the pure `transition`, and
 * writes it only `WHERE version = <the version it read>`. A second writer that read the same version finds no row to update and
 * is refused, so a late or repeated delivery can never move a run twice.
 */
export class SagaStore {
    constructor(private readonly db: Database) {}

    /** Opens a run, once per (saga, correlation id). Answers false when the run already exists (a second checkout of the same order). */
    async begin<TInput>(saga: string, correlationId: string, input: TInput): Promise<boolean> {
        const rows = await this.db.query(
            `INSERT INTO saga_runs (saga, correlation_id, status, version, input) VALUES ($1, $2, 'running', 0, $3)
             ON CONFLICT DO NOTHING RETURNING correlation_id`,
            [saga, correlationId, JSON.stringify(input)],
        )
        return rows.length === 1
    }

    async find<TInput>(saga: string, correlationId: string): Promise<SagaRun<TInput> | null> {
        const rows = await this.db.query<RunRow>(`SELECT * FROM saga_runs WHERE saga = $1 AND correlation_id = $2`, [saga, correlationId])
        return rows[0] === undefined ? null : toRun<TInput>(rows[0])
    }

    async get<TInput>(saga: string, correlationId: string): Promise<SagaRun<TInput>> {
        const run = await this.find<TInput>(saga, correlationId)
        if (run === null) throw new Error(`no run of ${saga} for ${correlationId}`)
        return run
    }

    /** The runs in the given statuses (the recovery sweep's work list). */
    async inStatus<TInput>(saga: string, statuses: ReadonlyArray<SagaStatus>): Promise<ReadonlyArray<SagaRun<TInput>>> {
        const rows = await this.db.query<RunRow>(`SELECT * FROM saga_runs WHERE saga = $1 AND status = ANY($2) ORDER BY updated_at`, [
            saga,
            [...statuses],
        ])
        return rows.map((row) => toRun<TInput>(row))
    }

    /**
     * Applies one event to the run it read, under the fence. `effect` runs in the same transaction, so a domain write tied to the
     * transition (the order confirmed with the run completed) commits with it or not at all.
     */
    async apply<TInput>(run: SagaRun<TInput>, event: SagaEvent, effect?: (tx: Tx) => Promise<void>): Promise<SagaRun<TInput>> {
        const answer = transition(run, event)
        if (!answer.ok) throw new SagaTransitionRefused(answer.refusal)
        const next = answer.run
        return this.db.transaction(async (tx) => {
            const updated = await tx.query(
                `UPDATE saga_runs SET status = $3, version = $4, done = $5, undone = $6, failed_step = $7, reason = $8,
                        parked_from = $9, pressed_by = $10, side_failures = $11, unclear_step = $13, updated_at = now()
                 WHERE saga = $1 AND correlation_id = $2 AND version = $12`,
                [
                    run.saga,
                    run.correlationId,
                    next.status,
                    next.version,
                    next.done,
                    next.undone,
                    next.failedStep,
                    next.reason,
                    next.parkedFrom,
                    next.pressedBy,
                    next.sideFailures,
                    run.version,
                    next.unclearStep,
                ],
            )
            if (updated.rowCount !== 1) throw new SagaTransitionRefused(`${event.type}: run ${run.correlationId} moved past version ${run.version}`)
            if (effect !== undefined) await effect(tx)
            return next
        })
    }

    /** Removes every run (the sample data reset of the specs). */
    async clear(): Promise<void> {
        await this.db.query(`TRUNCATE saga_runs`)
    }
}
