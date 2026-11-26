import "reflect-metadata"
import { Logger, type Type } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { envNumber } from "./env"

/** Starts one service on its port; shutdown hooks close the database pool on `docker compose down`. */
export const bootstrap = async (service: string, module: Type<unknown>, defaultPort: number): Promise<void> => {
    const app = await NestFactory.create(module, { logger: ["log", "warn", "error"] })
    app.enableShutdownHooks()
    const port = envNumber("PORT", defaultPort)
    await app.listen(port)
    new Logger(service).log(`${service} listening on ${port}`)
}
