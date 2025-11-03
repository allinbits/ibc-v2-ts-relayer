/**
 * Configuration Example
 *
 * This example demonstrates all configuration options available
 * in the IBC relayer through environment variables.
 */

import config from "../src/config";

/**
 * All 12 Configuration Options
 * ============================
 *
 * Set these via environment variables before starting the relayer.
 */

console.log("=== IBC Relayer Configuration ===\n");

// 1. LOGGING CONFIGURATION
console.log("📝 Logging:");
console.log(`  LOG_LEVEL: ${config.logging.level}`);
console.log(`    Values: error | warn | info | debug | verbose`);
console.log(`    Default: debug\n`);

// 2. DATABASE CONFIGURATION
console.log("💾 Database:");
console.log(`  DB_FILE: ${config.database.file}`);
console.log(`    Default: relayer.db`);
console.log(`    Production: /var/lib/relayer/relayer.db\n`);

// 3. RELAY TIMING CONFIGURATION
console.log("⏱️  Relay Timing:");
console.log(`  RELAY_POLL_INTERVAL: ${config.relay.pollInterval}ms`);
console.log(`    How often to check for new packets`);
console.log(`    Default: 5000ms (5 seconds)`);
console.log(`    Min: 1000ms, Max: 60000ms\n`);

console.log(`  RELAY_MAX_AGE_DEST: ${config.relay.maxAgeDest}ms`);
console.log(`    Max age before updating destination client`);
console.log(`    Default: 300000ms (5 minutes)\n`);

console.log(`  RELAY_MAX_AGE_SRC: ${config.relay.maxAgeSrc}ms`);
console.log(`    Max age before updating source client`);
console.log(`    Default: 300000ms (5 minutes)\n`);

// 4. TIMEOUT CONFIGURATION
console.log("⏰ Packet Timeouts:");
console.log(`  RELAY_TIMEOUT_BLOCKS: ${config.relay.timeoutBlocks}`);
console.log(`    Timeout threshold in blocks`);
console.log(`    Default: 100 blocks\n`);

console.log(`  RELAY_TIMEOUT_SECONDS: ${config.relay.timeoutSeconds}`);
console.log(`    Timeout threshold in seconds`);
console.log(`    Default: 600 seconds (10 minutes)\n`);

// 5. NETWORK RESILIENCE CONFIGURATION
console.log("🔄 Network Resilience:");
console.log(`  NETWORK_MAX_RETRIES: ${config.network.maxRetries}`);
console.log(`    Max retry attempts for failed operations`);
console.log(`    Default: 3\n`);

console.log(`  NETWORK_RETRY_BACKOFF: ${config.network.retryBackoff}ms`);
console.log(`    Initial backoff time (exponential)`);
console.log(`    Default: 1000ms`);
console.log(`    Max backoff: 30000ms\n`);

console.log(`  NETWORK_REQUEST_TIMEOUT: ${config.network.requestTimeout}ms`);
console.log(`    Timeout for network requests`);
console.log(`    Default: 30000ms (30 seconds)\n`);

// 6. ESTIMATED BLOCK TIMES
console.log("⏲️  Block Times:");
console.log(`  ESTIMATED_BLOCK_TIME: ${config.estimatedBlockTime}ms`);
console.log(`    Estimated time per block for waiting`);
console.log(`    Default: 7000ms (7 seconds)\n`);

console.log(`  ESTIMATED_INDEXER_TIME: ${config.estimatedIndexerTime}ms`);
console.log(`    Estimated time for indexer to catch up`);
console.log(`    Default: 3000ms (3 seconds)\n`);

// EXAMPLE CONFIGURATIONS FOR DIFFERENT ENVIRONMENTS

console.log("\n=== Example Configurations ===\n");

console.log("🚀 Development:");
console.log(`  export LOG_LEVEL=debug`);
console.log(`  export RELAY_POLL_INTERVAL=10000`);
console.log(`  export NETWORK_MAX_RETRIES=5\n`);

console.log("🧪 Testing:");
console.log(`  export LOG_LEVEL=verbose`);
console.log(`  export RELAY_POLL_INTERVAL=1000`);
console.log(`  export NETWORK_MAX_RETRIES=1`);
console.log(`  export ESTIMATED_BLOCK_TIME=1000\n`);

console.log("🏭 Production:");
console.log(`  export LOG_LEVEL=warn`);
console.log(`  export DB_FILE=/var/lib/relayer/relayer.db`);
console.log(`  export RELAY_POLL_INTERVAL=5000`);
console.log(`  export NETWORK_MAX_RETRIES=3`);
console.log(`  export NETWORK_RETRY_BACKOFF=2000\n`);

console.log("⚡ High-frequency (for busy chains):");
console.log(`  export RELAY_POLL_INTERVAL=2000`);
console.log(`  export RELAY_MAX_AGE_DEST=60000`);
console.log(`  export RELAY_MAX_AGE_SRC=60000\n`);

console.log("🐌 Conservative (for slow chains):");
console.log(`  export RELAY_POLL_INTERVAL=30000`);
console.log(`  export ESTIMATED_BLOCK_TIME=15000`);
console.log(`  export NETWORK_REQUEST_TIMEOUT=60000\n`);

// VALIDATION EXAMPLE

console.log("=== Configuration Validation ===\n");
console.log("The relayer validates all configuration:");
console.log("  ✅ Log levels must be valid");
console.log("  ✅ Numbers must be within min/max bounds");
console.log("  ✅ Invalid values fallback to defaults");
console.log("  ✅ Warnings logged for invalid config\n");

console.log("Try setting invalid config:");
console.log(`  export LOG_LEVEL=invalid  # Falls back to 'debug'`);
console.log(`  export RELAY_POLL_INTERVAL=500  # Enforced minimum: 1000`);
console.log(`  export RELAY_POLL_INTERVAL=100000  # Enforced maximum: 60000\n`);
