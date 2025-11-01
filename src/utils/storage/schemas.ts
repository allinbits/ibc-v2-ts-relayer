import {
  z,
} from "zod";

import {
  ChainType,
} from "../../types";

/**
 * Validation schemas for database records using Zod.
 * Ensures runtime type safety for data retrieved from storage.
 */

/**
 * Schema for ChainType enum validation.
 */
const ChainTypeSchema = z.nativeEnum(ChainType);

/**
 * Schema for ChainFees database records.
 * Validates gas price configuration for chains.
 */
export const ChainFeesSchema = z.object({
  id: z.number(),
  chainId: z.string().min(1, "Chain ID cannot be empty"),
  gasPrice: z.number().positive("Gas price must be positive"),
  gasDenom: z.string().min(1, "Gas denomination cannot be empty"),
});

/**
 * Schema for RelayedHeights database records.
 * Validates relay height tracking data.
 */
export const RelayedHeightsSchema = z.object({
  id: z.number(),
  relayPathId: z.number(),
  packetHeightA: z.number().nonnegative(),
  packetHeightB: z.number().nonnegative(),
  ackHeightA: z.number().nonnegative(),
  ackHeightB: z.number().nonnegative(),
});

/**
 * Schema for RelayPaths database records.
 * Validates relay path configuration.
 */
export const RelayPathsSchema = z.object({
  id: z.number(),
  chainIdA: z.string().min(1, "Chain ID A cannot be empty"),
  nodeA: z.string().min(1, "Node A cannot be empty"),
  chainIdB: z.string().min(1, "Chain ID B cannot be empty"),
  nodeB: z.string().min(1, "Node B cannot be empty"),
  chainTypeA: ChainTypeSchema,
  chainTypeB: ChainTypeSchema,
  clientA: z.string().min(1, "Client A cannot be empty"),
  clientB: z.string().min(1, "Client B cannot be empty"),
  version: z.number().int().min(1).max(2, "IBC version must be 1 or 2"),
});

/**
 * Validates ChainFees data and throws descriptive errors if invalid.
 *
 * @param data - Data to validate
 * @returns Validated ChainFees object
 * @throws ZodError with detailed validation errors if data is invalid
 *
 * @example
 * ```typescript
 * const fees = validateChainFees(dbResult);
 * // TypeScript now knows fees is valid ChainFees
 * ```
 */
export function validateChainFees(data: unknown) {
  return ChainFeesSchema.parse(data);
}

/**
 * Validates RelayedHeights data and throws descriptive errors if invalid.
 *
 * @param data - Data to validate
 * @returns Validated RelayedHeights object
 * @throws ZodError with detailed validation errors if data is invalid
 */
export function validateRelayedHeights(data: unknown) {
  return RelayedHeightsSchema.parse(data);
}

/**
 * Validates RelayPaths data and throws descriptive errors if invalid.
 *
 * @param data - Data to validate
 * @returns Validated RelayPaths object
 * @throws ZodError with detailed validation errors if data is invalid
 */
export function validateRelayPaths(data: unknown) {
  return RelayPathsSchema.parse(data);
}

/**
 * Safely validates data without throwing, returning validation result.
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Object with success flag and data or error
 *
 * @example
 * ```typescript
 * const result = safeValidate(ChainFeesSchema, dbResult);
 * if (result.success) {
 *   console.log("Valid data:", result.data);
 * } else {
 *   console.error("Validation errors:", result.error.issues);
 * }
 * ```
 */
export function safeValidate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
) {
  return schema.safeParse(data);
}
