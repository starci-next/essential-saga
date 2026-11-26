import { randomUUID } from "node:crypto"
import { Body, Controller, type DynamicModule, Get, HttpCode, Inject, Module, NotFoundException, Post, Put } from "@nestjs/common"
import { APP_INTERCEPTOR, ModuleRef } from "@nestjs/core"
import { Database, SCHEMA } from "./database"
import { env } from "./env"
import { FaultsInterceptor, FaultsService, type Faults } from "./faults"
import { ServiceClient } from "./http-client"
import { Inbox } from "./inbox"

/** Each service puts its own sample data back for the specs, registered under this token. */
export interface Seeder {
    reset(): Promise<void>
}
export const SEEDER = Symbol("SEEDER")
const SERVICE_NAME = Symbol("SERVICE_NAME")

/** A new id per process start: the crash spec reads it to know orders really restarted. */
export const BOOT_ID = randomUUID()

@Controller()
/** Health for docker, and the test hooks (fault switches, sample data reset) that answer only under `TEST_HOOKS=on`. */
export class ServiceController {
    private readonly hooks = env("TEST_HOOKS", "off") === "on"

    constructor(
        @Inject(SERVICE_NAME) private readonly service: string,
        private readonly moduleRef: ModuleRef,
        private readonly faults: FaultsService,
    ) {}

    @Get("health")
    health(): { ok: true; service: string; bootId: string } {
        return { ok: true, service: this.service, bootId: BOOT_ID }
    }

    @Put("test/faults")
    setFaults(@Body() patch: Record<string, unknown>): Faults {
        this.requireHooks()
        return this.faults.set(patch)
    }

    @Post("test/reset")
    @HttpCode(200)
    async reset(): Promise<{ ok: true }> {
        this.requireHooks()
        this.faults.reset()
        await this.moduleRef.get<Seeder>(SEEDER, { strict: false }).reset()
        return { ok: true }
    }

    private readonly requireHooks = (): void => {
        if (!this.hooks) throw new NotFoundException()
    }
}

@Module({})
/** What every service shares: its database and schema, the inbox, the service client, the fault switches and health. */
export class ServiceModule {
    static forService(service: string, schema: ReadonlyArray<string>): DynamicModule {
        return {
            module: ServiceModule,
            global: true,
            controllers: [ServiceController],
            providers: [
                { provide: SERVICE_NAME, useValue: service },
                { provide: SCHEMA, useValue: schema },
                Database,
                Inbox,
                FaultsService,
                ServiceClient,
                { provide: APP_INTERCEPTOR, useClass: FaultsInterceptor },
            ],
            exports: [Database, Inbox, FaultsService, ServiceClient],
        }
    }
}
