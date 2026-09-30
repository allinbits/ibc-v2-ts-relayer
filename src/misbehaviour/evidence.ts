import {
  Any,
} from "@atomone/atomone-types/google/protobuf/any.js";
import {
  Header as TendermintHeader,
  Misbehaviour as TendermintMisbehaviour,
} from "@atomone/atomone-types/ibc/lightclients/tendermint/v1/tendermint.js";
import {
  fromBase64,
} from "@cosmjs/encoding";
import {
  ibc,
} from "@gnolang/gno-types";
import * as winston from "winston";

import {
  BaseIbcClient, isGno, isTendermint,
} from "../clients/BaseIbcClient.js";
import {
  ClientStatus,
  MisbehaviourEvidence,
  MisbehaviourStatus,
} from "../types/index.js";
import {
  GNO_HEADER_TYPE_URL, GNO_MISBEHAVIOUR_TYPE_URL, TENDERMINT_HEADER_TYPE_URL, TENDERMINT_MISBEHAVIOUR_TYPE_URL,
} from "../utils/misbehaviour.js";
import {
  storage,
} from "../utils/storage.js";
import {
  getErrorMessage,
} from "../utils/utils.js";

/**
 * Builds a Misbehaviour from the header that created the conflicting consensus
 * state and the source chain's own header at the same height.
 *
 * @returns The Misbehaviour as an Any, or undefined if the recovered header
 * does not match the source chain's light client type
 */
async function buildMisbehaviour(evidence: MisbehaviourEvidence, source: BaseIbcClient): Promise<Any | undefined> {
  if (!evidence.conflictingHeader) {
    return undefined;
  }
  const conflicting = fromBase64(evidence.conflictingHeader);
  const trustedHeight = evidence.trustedRevisionHeight;
  const height = evidence.revisionHeight;
  if (isTendermint(source) && evidence.conflictingHeaderTypeUrl === TENDERMINT_HEADER_TYPE_URL) {
    return {
      typeUrl: TENDERMINT_MISBEHAVIOUR_TYPE_URL,
      value: TendermintMisbehaviour.encode({
        // Deprecated, but ibc-go still validates it.
        clientId: evidence.clientId,
        header1: TendermintHeader.decode(conflicting),
        header2: await source.buildHeader(trustedHeight, height),
      }).finish(),
    };
  }
  if (isGno(source) && evidence.conflictingHeaderTypeUrl === GNO_HEADER_TYPE_URL) {
    return {
      typeUrl: GNO_MISBEHAVIOUR_TYPE_URL,
      value: ibc.lightclients.gno.v1.gno.Misbehaviour.encode({
        clientId: evidence.clientId,
        header1: ibc.lightclients.gno.v1.gno.Header.decode(conflicting),
        header2: await source.buildHeader(trustedHeight, height),
      }).finish(),
    };
  }
  return undefined;
}

/**
 * Freezes the client named by `evidence`.
 *
 * When the offending header was recovered and the host accepts Misbehaviour
 * messages, submits Misbehaviour{offending header, source header}. Otherwise,
 * or if that fails, updates the client with the source chain's own header at
 * the conflicting height: light clients freeze themselves when a verified
 * header conflicts with a stored consensus state.
 *
 * @param host - Signing client for the chain that hosts the light client
 * @param source - Client for the chain the light client tracks
 * @returns The hash of the Misbehaviour transaction, or null if the client was
 * frozen another way
 * @throws If the client could not be frozen
 */
export async function freezeClient(
  evidence: MisbehaviourEvidence,
  host: BaseIbcClient,
  source: BaseIbcClient,
  logger: winston.Logger,
): Promise<string | null> {
  const {
    clientId, revisionHeight, trustedRevisionHeight,
  } = evidence;
  const status = await host.getClientStatus(clientId);
  if (status === ClientStatus.Frozen) {
    logger.info(`Client ${clientId} on ${host.chainId} is already frozen`);
    return null;
  }
  if (status !== ClientStatus.Active) {
    throw new Error(`Client ${clientId} on ${host.chainId} is ${status} and cannot be frozen`);
  }
  if (trustedRevisionHeight <= 0) {
    throw new Error(`No verified consensus state below height ${revisionHeight} to build evidence from`);
  }

  let txHash: string | null = null;
  if (isTendermint(host)) {
    try {
      const misbehaviour = await buildMisbehaviour(evidence, source);
      if (misbehaviour) {
        txHash = (await host.submitMisbehaviour(clientId, misbehaviour)).transactionHash;
      }
    }
    catch (e) {
      logger.warn(`Misbehaviour submission for client ${clientId} on ${host.chainId} failed, submitting the source header instead: ${getErrorMessage(e)}`);
    }
  }
  if (txHash === null) {
    await host.submitConflictingHeader(clientId, source, trustedRevisionHeight, revisionHeight);
  }

  const after = await host.getClientStatus(clientId);
  if (after !== ClientStatus.Frozen) {
    throw new Error(`Client ${clientId} on ${host.chainId} is still ${after} after submitting evidence`);
  }
  return txHash;
}

/**
 * Submits one pending evidence record and stores the outcome. A failure is
 * retried on later calls until `maxAttempts` is reached.
 */
export async function processMisbehaviourEvidence(
  evidence: MisbehaviourEvidence,
  host: BaseIbcClient,
  source: BaseIbcClient,
  maxAttempts: number,
  logger: winston.Logger,
): Promise<void> {
  const attempts = evidence.attempts + 1;
  try {
    const txHash = await freezeClient(evidence, host, source, logger);
    await storage.updateMisbehaviourEvidence(evidence.id, {
      status: MisbehaviourStatus.Confirmed,
      attempts,
      txHash,
      error: null,
    });
    logger.warn(`Froze client ${evidence.clientId} on ${host.chainId}: misbehaviour at height ${evidence.revisionHeight}`, {
      txHash,
    });
  }
  catch (e) {
    const error = getErrorMessage(e);
    const failed = attempts >= maxAttempts;
    await storage.updateMisbehaviourEvidence(evidence.id, {
      status: failed ? MisbehaviourStatus.Failed : MisbehaviourStatus.Pending,
      attempts,
      error,
    });
    logger.error(`Submitting misbehaviour evidence ${evidence.id} for client ${evidence.clientId} on ${host.chainId} failed (attempt ${attempts}/${maxAttempts}): ${error}`);
  }
}
