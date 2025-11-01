import {
  BaseEndpoint,
} from "../endpoints/BaseEndpoint";
import {
  TendermintEndpoint,
} from "../endpoints/TendermintEndpoint";
import {
  BaseIbcClient, isTendermint,
} from "../clients/BaseIbcClient";
import {
  TendermintIbcClient,
} from "../clients/tendermint/IbcClient";
import {
  ClientType,
} from "../types";

/**
 * Side represents which endpoint in a bidirectional link.
 * Many link operations work on a source and destination, so we use Side to select A or B.
 */
export type Side = "A" | "B";

/**
 * Returns the opposite side.
 *
 * @param side - The current side
 * @returns The other side
 */
export function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

/**
 * Creates an appropriate endpoint wrapper for the given client.
 *
 * @param client - The IBC client
 * @param clientId - The client ID
 * @param connectionId - Optional connection ID (for IBC v1)
 * @returns An endpoint instance
 * @throws Error if the client type is unsupported
 */
export function getEndpoint(
  client: BaseIbcClient,
  clientId: string,
  connectionId?: string,
): BaseEndpoint {
  switch (client.clientType) {
    case ClientType.Tendermint:
      return new TendermintEndpoint(client as TendermintIbcClient, clientId, connectionId);
    default:
      throw new Error(`Unsupported client type: ${client.clientType}`);
  }
}

/**
 * Creates IBC light clients on both chains pointing to each other.
 *
 * @param nodeA - The first chain's IBC client
 * @param nodeB - The second chain's IBC client
 * @param trustPeriodA - Trust period in seconds for client on B pointing to A
 * @param trustPeriodB - Trust period in seconds for client on A pointing to B
 * @returns Array of [clientIdA, clientIdB] where clientIdA is on nodeB pointing to nodeA
 */
export async function createClients(
  nodeA: BaseIbcClient,
  nodeB: BaseIbcClient,
  trustPeriodA?: number | null,
  trustPeriodB?: number | null,
): Promise<string[]> {
  let clientIdA = "";
  let clientIdB = "";

  // Create client on B pointing to A
  if (isTendermint(nodeA)) {
    const args = await nodeA.buildCreateClientArgs(trustPeriodA);
    const {
      clientId,
    } = await nodeB.createTendermintClient(
      args.clientState, args.consensusState,
    );
    nodeB.logger.info(`Created client on chain B: ${clientId}`);
    clientIdB = clientId;
  }

  // Create client on A pointing to B
  if (isTendermint(nodeB)) {
    const args = await nodeB.buildCreateClientArgs(trustPeriodB);
    const {
      clientId,
    } = await nodeA.createTendermintClient(
      args.clientState, args.consensusState,
    );
    nodeA.logger.info(`Created client on chain A: ${clientId}`);
    clientIdA = clientId;
  }

  return [clientIdA, clientIdB];
}
