import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  Command,
  InvalidArgumentError,
  Option,
} from "commander";

import * as pkgJson from "../package.json";
import {
  MisbehaviourMonitor,
} from "./misbehaviour/monitor.js";
import {
  Relayer,
} from "./relayer.js";
import {
  ChainType,
  MisbehaviourStatus,
} from "./types/index.js";
import {
  log,
} from "./utils/logging.js";
import {
  storage,
} from "./utils/storage.js";

// Global error handlers for uncaught exceptions and unhandled rejections
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    reason,
  });
  process.exit(1);
});

// Stops a long-running command cleanly (finishing the current iteration and
// closing the database) on SIGINT/SIGTERM.
function stopOnSignal(name: string, stop: () => Promise<void>) {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      log.info(`Received ${signal}, stopping ${name}...`);
      try {
        await stop();
        process.exit(0);
      }
      catch (error) {
        log.error(`Failed to stop ${name}`, {
          error,
        });
        process.exit(1);
      }
    });
  }
}

function parsePathIds(value: string): number[] {
  const ids = value.split(",").map(id => Number(id.trim()));
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new InvalidArgumentError("Expected comma-separated relay path IDs.");
  }
  return ids;
}

const program = new Command();
program.name(pkgJson.name).description(pkgJson.description).version(pkgJson.version);
program.command("add-mnemonic")
  .description("Add a mnemonic to the keyring. Reads from --mnemonic option, MNEMONIC env var, or prompts on stdin.")
  .requiredOption("-c, --chain-id <chainId>", "Chain ID for the mnemonic")
  .option("-m, --mnemonic <mnemonic>", "Mnemonic phrase (prefer env var MNEMONIC or stdin for security)")
  .action(async (options) => {
    try {
      let mnemonic: string = options.mnemonic || process.env.MNEMONIC || "";
      if (!mnemonic) {
        // Read from stdin
        process.stderr.write("Enter mnemonic: ");
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
          // Stop after first line
          if (chunk.toString().includes("\n")) break;
        }
        mnemonic = Buffer.concat(chunks).toString().trim();
      }
      if (!mnemonic) {
        log.error("No mnemonic provided. Use --mnemonic, MNEMONIC env var, or pipe via stdin.");
        process.exit(1);
      }
      const relayer = new Relayer(log);
      await relayer.addMnemonic(mnemonic, options.chainId);
    }
    catch (error) {
      log.error("Failed to add mnemonic", {
        error,
        chainId: options.chainId,
      });
      process.exit(1);
    }
  });
program.command("add-gas-price")
  .description("Add gas price for a chain")
  .requiredOption("-c, --chain-id <chainId>", "Chain ID to add gas price for")
  .option("-g, --gas-adjustment <gasAdjustment>", "Gas adjustment multiplier (default: 1.4)", parseFloat)
  .argument("<string>", "Gas information in string format. e.g. 0.025udenom")
  .action(async (gasPrice, options) => {
    try {
      const relayer = new Relayer(log);
      const gas = GasPrice.fromString(gasPrice);
      await relayer.addGasPrice(options.chainId, gas.amount.toString(), gas.denom, options.gasAdjustment);
    }
    catch (error) {
      log.error("Failed to add gas price", {
        error,
        chainId: options.chainId,
      });
      process.exit(1);
    }
  });
program.command("relay")
  .description("Relay packets between chains")
  .action(async () => {
    try {
      const relayer = new Relayer(log);
      stopOnSignal("relayer", () => relayer.stop());
      await relayer.start();
    }
    catch (error) {
      log.error("Failed to start relayer", {
        error,
      });
      process.exit(1);
    }
  });

program.command("monitor")
  .description("Watch the relay paths' light clients for misbehaviour and record it for the relayer to submit")
  .option("--dry-run", "Record detected misbehaviour without having the relayer submit it", false)
  .option("-p, --paths <ids>", "Only monitor these relay path IDs (comma-separated)", parsePathIds)
  .action(async (options: {
    dryRun: boolean
    paths?: number[]
  }) => {
    try {
      const monitor = new MisbehaviourMonitor(log.child({
        service: "Misbehaviour Monitor",
      }), {
        dryRun: options.dryRun,
        pathIds: options.paths,
      });
      stopOnSignal("misbehaviour monitor", () => monitor.stop());
      await monitor.start();
    }
    catch (error) {
      log.error("Failed to start misbehaviour monitor", {
        error,
      });
      process.exit(1);
    }
  });

const sourceTypeOption = new Option(
  "--st, --source-type <sourceType>",
  "Source chain type (Cosmos, Ethereum, etc.)",
).choices(Object.values(ChainType)).makeOptionMandatory();
sourceTypeOption.default(ChainType.Cosmos);

const destinationTypeOption = new Option(
  "--dt, --destination-type <destinationType>",
  "Destination chain type (Cosmos, Ethereum, etc.)",
).choices(Object.values(ChainType)).makeOptionMandatory();
destinationTypeOption.default(ChainType.Cosmos);

const ibcVersionTypeOption = new Option(
  "--ibcv, --ibc-version <ibcVersion>",
  "IBC version of the relay path",
).choices(["1", "2"]).makeOptionMandatory().default("1", "Default IBC version is 1");

program.command("add-path")
  .description("Add a new relay path")
  .requiredOption("-s, --source <sourceChain>", "Source chain id")
  .requiredOption("-d, --destination <sourceChain>", "Destination chain id")
  .requiredOption("--surl, --source-url <sourceUrl>", "Source chain URL")
  .requiredOption("--durl, --destination-url <destinationUrl>", "Destination chain URL")
  .option("--squery, --source-query-url <sourceQueryUrl>", "Source chain query URL")
  .option("--dquery, --destination-query-url <destinationQueryUrl>", "Destination chain query URL")
  .addOption(sourceTypeOption)
  .addOption(destinationTypeOption)
  .addOption(ibcVersionTypeOption)
  .action(async (options) => {
    try {
      const relayer = new Relayer(log);
      await relayer.addNewRelayPath(
        options.source,
        options.sourceUrl,
        options.sourceQueryUrl,
        options.destination,
        options.destinationUrl,
        options.destinationQueryUrl,
        options.sourceType as ChainType,
        options.destinationType as ChainType,
        parseInt(options.ibcVersion, 10),
      );
    }
    catch (error) {
      log.error("Failed to add relay path", {
        error,
        source: options.source,
        destination: options.destination,
      });
      process.exit(1);
    }
  });
program.command("add-existing-path")
  .description("Add a relay path using existing clients/connections on both chains")
  .requiredOption("-s, --source <sourceChain>", "Source chain id")
  .requiredOption("-d, --destination <destinationChain>", "Destination chain id")
  .requiredOption("--surl, --source-url <sourceUrl>", "Source chain URL")
  .requiredOption("--durl, --destination-url <destinationUrl>", "Destination chain URL")
  .requiredOption("--sclient, --source-client-id <sourceClientId>", "Existing client/connection ID on the source chain")
  .requiredOption("--dclient, --destination-client-id <destinationClientId>", "Existing client/connection ID on the destination chain")
  .option("--squery, --source-query-url <sourceQueryUrl>", "Source chain query URL")
  .option("--dquery, --destination-query-url <destinationQueryUrl>", "Destination chain query URL")
  .addOption(sourceTypeOption)
  .addOption(destinationTypeOption)
  .addOption(ibcVersionTypeOption)
  .action(async (options) => {
    try {
      const relayer = new Relayer(log);
      await relayer.addExistingRelayPath(
        options.source,
        options.sourceUrl,
        options.sourceQueryUrl,
        options.destination,
        options.destinationUrl,
        options.destinationQueryUrl,
        options.sourceType as ChainType,
        options.destinationType as ChainType,
        options.sourceClientId,
        options.destinationClientId,
        parseInt(options.ibcVersion, 10),
      );
    }
    catch (error) {
      log.error("Failed to add existing relay path", {
        error,
        source: options.source,
        destination: options.destination,
      });
      process.exit(1);
    }
  });
program.command("dump-paths")
  .description("Dump all relay paths")
  .action(async () => {
    try {
      const relayer = new Relayer(log);
      const paths = await relayer.getRelayPaths();
      console.log(JSON.stringify(paths, null, 2));
    }
    catch (error) {
      log.error("Failed to dump relay paths", {
        error,
      });
      process.exit(1);
    }
  });
program.command("dump-misbehaviour")
  .description("Dump detected misbehaviour and its submission status")
  .addOption(new Option("--status <status>", "Only show records with this status").choices(Object.values(MisbehaviourStatus)))
  .action(async (options: {
    status?: MisbehaviourStatus
  }) => {
    try {
      const evidence = await storage.getMisbehaviourEvidence(options.status);
      console.log(JSON.stringify(evidence, null, 2));
    }
    catch (error) {
      log.error("Failed to dump misbehaviour evidence", {
        error,
      });
      process.exit(1);
    }
  });
program.parseAsync();
