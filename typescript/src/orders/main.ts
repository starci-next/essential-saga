import { bootstrap } from "../platform/bootstrap"
import { OrdersModule } from "./orders.module"

void bootstrap("orders", OrdersModule, 4101)
