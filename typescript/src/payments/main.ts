import { bootstrap } from "../platform/bootstrap"
import { PaymentsModule } from "./payments.module"

void bootstrap("payments", PaymentsModule, 4102)
