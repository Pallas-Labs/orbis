import { Context } from "effect";

/** The address a request came from, which the failed-attempt limits count by. */
export class ClientAddress extends Context.Service<ClientAddress, string>()(
  "Orbis/ClientAddress"
) {}
