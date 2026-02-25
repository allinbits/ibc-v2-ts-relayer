# Code Review: IBC v2 TypeScript Relayer

**Date:** 2026-02-16
**Scope:** Full codebase review for performance, stability, security, and logic issues
**Files reviewed:** All 20+ source files in `src/`

---

## False Positives (Retracted)

### ~~CR-1: `relayedHeights` map reset inside `init()` loop~~ — NOT A BUG
**Rationale:** This is intentional. The map is rebuilt from the DB (source of truth) each init cycle. Heights are always persisted to the DB after each relay, so rebuilding the map from DB is correct.

### ~~CR-2: `init()` called on every relay loop iteration~~ — NOT A BUG
**Rationale:** Intentional design. `init()` is called each iteration to pick up new relay paths added to the DB between loop runs. Link creation and relaying are separate operations — paths can be added externally while the loop runs.

### ~~CR-6: `start()` does not await `relayerLoop()`~~ — BY DESIGN
**Rationale:** `start()` is fire-and-forget intentionally; the relay loop runs in the background. Errors are caught by the loop's try/catch.

### ~~CR-7: Link stored in map before channel creation~~ — BY DESIGN
**Rationale:** The link needs to be in the map so `init()` can skip it on next iteration. Channel creation is a separate step.

### ~~CR-17: Redundant relayed heights fetch~~ — BY DESIGN
**Rationale:** Heights are fetched from DB each loop iteration intentionally to use DB as source of truth.

---

## High Severity Issues

### CR-3: Infinite recursion in `getRelayedHeights` (HIGH)
**File:** `src/storage/sqlite-storage.ts:114-121`, `src/storage/dexie-storage.ts:68-78`
**Description:** Both storage implementations catch errors in `getRelayedHeights`, attempt an INSERT, then recursively call themselves. If the INSERT fails (disk full, FK violation, unique constraint), infinite recursion causes stack overflow.
**Status:** FIXED

### CR-4: `pagedAbciQuery` returns `undefined` for paginated results (HIGH)
**File:** `src/clients/gno/IbcClient.ts:1614-1658`
**Description:** When `data.total > 1`, items are collected in a pagination loop, but there is no `return items;` statement after the loop. The function falls through without returning, causing callers to receive `undefined` and crash when calling `.find()`.
**Status:** FIXED

### CR-5: `getSigner` returns implicit `undefined` for unsupported ChainType (HIGH)
**File:** `src/utils/signers.ts:15-52`
**Description:** The function handles `ChainType.Cosmos` and `ChainType.Gno` but has no `else` clause. `ChainType.Ethereum` (valid enum value) returns `undefined`, causing downstream crashes.
**Status:** FIXED

---

## Medium Severity Issues

### CR-8: SQLite database opened on every operation (MEDIUM)
**File:** `src/storage/sqlite.ts:4-41`, `src/storage/sqlite-storage.ts`
**Description:** Every storage method calls `openDB()`, which creates a new `Database` instance and runs the full DDL schema. Database handles are never closed. Multiple DB opens per poll iteration leak file descriptors.
**Status:** FIXED — singleton cached connection

### CR-9: `getPrefix()` leaks Tendermint RPC connections (MEDIUM)
**File:** `src/utils/utils.ts:88-98`
**Description:** `connectComet(node)` opens a WebSocket/RPC connection that is never disconnected. Called on every `init()` for every new path.
**Status:** FIXED — added `tmClient.disconnect()`

### CR-10: `TendermintIbcClient.connectWithSigner` opens duplicate RPC connections (MEDIUM)
**File:** `src/clients/tendermint/IbcClient.ts:157-160`
**Description:** `SigningStargateClient.connectWithSigner` creates its own internal CometClient, then `connectComet(endpoint)` creates another. Two connections per chain when one would suffice.
**Status:** FIXED — uses `createWithSigner` to share single CometClient

### CR-11: O(n^2) spread patterns in `splitPendingPackets`, `mergeUint8Arrays`, `filterUnreceived` (MEDIUM)
**File:** `src/utils/utils.ts:616-674`, `src/links/v1/link.ts:731-763`, `src/links/v2/link.ts:617-650`
**Description:** Array spread in reduce creates new arrays on every iteration, resulting in O(n^2) element copies. With hundreds of packets this causes noticeable delays and GC pressure.
**Status:** FIXED — replaced with mutable `push()` patterns

### CR-12: `v2/link.ts` `updateClientIfStale` rejects Gno consensus state (MEDIUM)
**File:** `src/links/v2/link.ts:320-324`
**Description:** Line 320 checks `isTendermintConsensusState(knownHeader)` and throws if false, before the Gno-specific code at line 345 is reached. This breaks staleness checks for Gno-to-Gno paths.
**Status:** FIXED — now accepts both Tendermint and Gno consensus states

### CR-13: No graceful shutdown — connections not cleaned up (MEDIUM)
**File:** `src/relayer.ts:286-289`
**Description:** `stop()` sets `running = false` but does not disconnect RPC clients, close database connections, or wait for in-flight operations.
**Status:** FIXED — `stop()` disconnects all clients, closes DB, clears links

### CR-14: Incomplete path traversal validation in `validateDbPath` (MEDIUM)
**File:** `src/config/index.ts:86-91`
**Description:** Naive blocklist (`..`, `/etc/`, `/sys/`) is trivially bypassable. Does not prevent `/root/`, `/var/`, absolute paths to sensitive locations.
**Status:** FIXED — allowlist approach using `path.resolve()` + working directory prefix check

### CR-15: Gno template injection via Handlebars (MEDIUM)
**File:** `src/clients/gno/IbcClient.ts:605-715`
**Description:** Chain data (chainId, clientId, ports) interpolated into Go source templates via Handlebars. Handlebars escapes HTML chars but not Go string escape chars. A malicious chain could craft values with newlines/backslashes to inject Go code executed via MsgRun.
**Status:** FIXED — `validateIbcIdentifier` applied to all string template parameters

### CR-16: Tendermint event query injection (MEDIUM)
**File:** `src/clients/tendermint/IbcClient.ts:1968+`, `src/clients/gno/IbcClient.ts:1760+`
**Description:** Connection/client IDs interpolated directly into Tendermint event query strings without sanitization. Malicious IDs with single quotes could alter query semantics.
**Status:** FIXED — `validateIbcIdentifier` applied to all query string interpolations in both clients

### CR-18: O(N*M) receipt/ack lookup in Gno client (MEDIUM)
**File:** `src/clients/gno/IbcClient.ts:1660-1681, 1718-1738`
**Description:** `queryUnreceivedPacketsV2` fetches ALL receipts then does `.find()` for each sequence. Should use a Set for O(1) lookup.
**Status:** FIXED — replaced `.find()` with `Set` for O(1) lookup

---

## Low Severity Issues

### CR-19: Mnemonic exposed as CLI positional argument
**File:** `src/index.ts:38-53`
**Status:** FIXED — changed from positional arg to `--mnemonic` option with `MNEMONIC` env var and stdin fallback

### CR-20: Log file paths not validated for path traversal
**File:** `src/config/index.ts:133-134`
**Status:** FIXED — log file paths now validated with same `validateFilePath` as DB path

### CR-21: `ibcRegistry()` creates new Registry on every connection
**File:** `src/clients/tendermint/IbcClient.ts:107-109`
**Status:** FIXED — module-level singleton

### CR-22: `deepCloneAndMutate` called for debug logging regardless of log level
**File:** `src/clients/tendermint/IbcClient.ts` (multiple locations)
**Status:** FIXED — added `debugMsg` helper + `isLevelEnabled("debug")` guards on all 12 call sites

### CR-23: `getAddress()` called inside loops instead of hoisted
**File:** `src/clients/gno/IbcClient.ts:898, 999, 1105`
**Status:** FIXED — hoisted before loops

### CR-24: Duplicate `fundsToCoins(new Map())` calls inside loops
**File:** `src/clients/gno/IbcClient.ts:894-896, 995-996, 1101-1102`
**Status:** FIXED — hoisted before loops

---

## Fixes Applied

### CR-3 Fix: Eliminated infinite recursion in storage
- **Files modified:** `src/storage/sqlite-storage.ts:105-122`, `src/storage/dexie-storage.ts:58-79`
- Replaced recursive error recovery with linear flow: query → INSERT if not found → query again → throw if still not found.

### CR-4 Fix: Added missing `return items` to `pagedAbciQuery`
- **File modified:** `src/clients/gno/IbcClient.ts:1653`
- Added `return items;` before the catch block so paginated results are properly returned.

### CR-5 Fix: Added `else` clause to `getSigner`
- **File modified:** `src/utils/signers.ts:51`
- Added `else { throw new Error('Unsupported chain type') }` for unhandled chain types.

### CR-8 Fix: Singleton SQLite database connection
- **File modified:** `src/storage/sqlite.ts`
- `openDB()` now caches the database instance and reuses it across calls. Schema DDL only runs on first open.

### CR-9 Fix: Disconnect `tmClient` in `getPrefix()`
- **File modified:** `src/utils/utils.ts:88-98`
- Added `tmClient.disconnect()` after querying the bech32 prefix.

### CR-11 Fix: Replaced O(n^2) spread patterns with O(n) mutable patterns
- **Files modified:** `src/utils/utils.ts` (mergeUint8Arrays, splitPendingPackets, 4x attribute parsing), `src/links/v1/link.ts` (filterUnreceived), `src/links/v2/link.ts` (filterUnreceived), `src/clients/gno/IbcClient.ts` (pagedAbciQuery pagination)
- All quadratic array/object spread patterns replaced with `push()` or direct assignment.

### CR-12 Fix: `updateClientIfStale` now handles Gno consensus state
- **File modified:** `src/links/v2/link.ts:320-356`
- Added `isGnoConsensusState` import and check alongside `isTendermintConsensusState`.
- Refactored to extract `knownSeconds` from either consensus state type, then branch on source client type.

### CR-14 Fix: Improved `validateDbPath` with allowlist approach
- **File modified:** `src/config/index.ts:86-91`
- Replaced naive blocklist with `path.resolve()` + prefix check against `process.cwd()`.
- Updated tests in `src/config/index.test.ts` to expect resolved absolute paths.

### CR-10 Fix: Eliminated duplicate RPC connections
- **File modified:** `src/clients/tendermint/IbcClient.ts:140-166`
- Changed `SigningStargateClient.connectWithSigner` to `createWithSigner`, sharing the single `tmClient` CometClient instance.

### CR-13 Fix: Graceful shutdown with connection cleanup
- **Files modified:** `src/clients/BaseIbcClient.ts`, `src/clients/tendermint/IbcClient.ts`, `src/clients/gno/IbcClient.ts`, `src/storage/sqlite.ts`, `src/relayer.ts`
- Added abstract `disconnect()` to `BaseIbcClient`, implemented in both client types (calls `this.tm.disconnect()`).
- Added `closeDB()` export to `src/storage/sqlite.ts`.
- `Relayer.stop()` now iterates links, disconnects both clients per link, clears links, and closes DB.

### CR-15 Fix: Gno template injection validation
- **File modified:** `src/clients/gno/IbcClient.ts`
- Applied `validateIbcIdentifier()` to all string parameters passed to Handlebars templates (chainId, clientId, sourceClient, destinationClient, sourcePort, destinationPort, encoding, version, counterpartyClientId).

### CR-16 Fix: Tendermint event query injection validation
- **Files modified:** `src/clients/tendermint/IbcClient.ts`, `src/clients/gno/IbcClient.ts`
- Added `validateIbcIdentifier()` function to `src/utils/utils.ts` (allows `[a-zA-Z0-9._\-\/]` only).
- Applied to all query string interpolations: `write_acknowledgement.packet_connection`, `write_acknowledgement.packet_dest_client`, `send_packet.packet_connection`, `send_packet.packet_source_client` in both clients.

### CR-18 Fix: O(N*M) receipt/ack lookup replaced with Set
- **File modified:** `src/clients/gno/IbcClient.ts`
- `queryUnreceivedPacketsV2` and `queryUnreceivedAcksV2` now build a `Set` from fetched data for O(1) lookups instead of `.find()` per sequence.

### CR-21 Fix: Singleton ibcRegistry
- **File modified:** `src/clients/tendermint/IbcClient.ts`
- `ibcRegistry()` function replaced with module-level `ibcRegistryInstance` constant.

### CR-23/CR-24 Fix: Hoisted loop-invariant calls
- **File modified:** `src/clients/gno/IbcClient.ts`
- `getAddress()`, `fundsToCoins(new Map())`, and `fundsToCoins((new Map()).set("ugnot", 3000000))` hoisted before loops in `receivePacketsV2`, `acknowledgePacketsV2`, and `timeoutPacketsV2`.

### CR-19 Fix: Mnemonic no longer exposed as CLI positional arg

- **File modified:** `src/index.ts`
- Changed `add-mnemonic` from `.argument("<string>")` to `.option("-m, --mnemonic <mnemonic>")`.
- Falls back to `MNEMONIC` env var, then reads from stdin if neither provided.

### CR-20 Fix: Log file path validation

- **Files modified:** `src/config/index.ts`, `src/config/index.test.ts`
- Renamed `validateDbPath` → `validateFilePath(filePath, label)` for reuse.
- Applied to `errorFile` and `combinedFile` config values.

### CR-22 Fix: Lazy debug logging with `isLevelEnabled` guard

- **File modified:** `src/clients/tendermint/IbcClient.ts`
- Added private `debugMsg()` helper that checks `this.logger.isLevelEnabled("debug")` before calling `deepCloneAndMutate`.
- 7 simple call sites refactored to use `debugMsg()`.
- 4 complex call sites (inside `msgs.map()`) wrapped with `if (this.logger.isLevelEnabled("debug"))`.
- Deep cloning of large protobuf messages now skipped entirely when debug logging is disabled.

### Test Results

- **Build:** `pnpm build` passes (tsc --noEmit + tsdown)
- **Tests:** 205/205 pass
