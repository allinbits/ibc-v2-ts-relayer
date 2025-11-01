import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  Command,
  Option,
} from "commander";

import * as pkgJson from "../package.json";
import {
  Relayer,
} from "./relayer";
import {
  ChainType,
} from "./types";
import {
  log,
} from "./utils/logging";

const program = new Command();

program.name(pkgJson.name).description(pkgJson.description).version(pkgJson.version);
program.command("add-mnemonic")
  .description("Add a mnemonic to the keyring")
  .requiredOption("-c, --chain-id <chainId>", "Chain ID for the mnemonic")
  .argument("<string>")
  .action(async (mnemonic, options) => {
    // Validate inputs
    if (!mnemonic || mnemonic.trim() === "") {
      log.error("Mnemonic cannot be empty");
      process.exit(1);
    }
    if (!options.chainId || options.chainId.trim() === "") {
      log.error("Chain ID cannot be empty");
      process.exit(1);
    }
    // Basic mnemonic validation (should have 12, 15, 18, 21, or 24 words)
    const words = mnemonic.trim().split(/\s+/);
    if (![12, 15, 18, 21, 24].includes(words.length)) {
      log.error(`Invalid mnemonic: expected 12, 15, 18, 21, or 24 words, got ${words.length}`);
      process.exit(1);
    }

    const relayer = new Relayer(log);
    relayer.addMnemonic(mnemonic, options.chainId);
  });
program.command("add-gas-price")
  .description("Add gas price for a chain")
  .requiredOption("-c, --chain-id <chainId>", "Chain ID to add gas price for")
  .argument("<string>", "Gas information in string format. e.g. 0.025udenom")
  .action(async (gasPrice, options) => {
    // Validate inputs
    if (!options.chainId || options.chainId.trim() === "") {
      log.error("Chain ID cannot be empty");
      process.exit(1);
    }
    if (!gasPrice || gasPrice.trim() === "") {
      log.error("Gas price cannot be empty");
      process.exit(1);
    }

    try {
      const relayer = new Relayer(log);
      const gas = GasPrice.fromString(gasPrice);
      relayer.addGasPrice(options.chainId, gas.amount.toString(), gas.denom);
    }
    catch (error) {
      log.error(`Invalid gas price format: ${gasPrice}. Expected format: 0.025udenom`);
      process.exit(1);
    }
  });
program.command("relay")
  .description("Relay packets between chains")
  .action(async () => {
    const relayer = new Relayer(log);
    await relayer.start();
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
  .addOption(sourceTypeOption)
  .addOption(destinationTypeOption)
  .addOption(ibcVersionTypeOption)
  .action(async (options) => {
    // Validate chain IDs
    if (!options.source || options.source.trim() === "") {
      log.error("Source chain ID cannot be empty");
      process.exit(1);
    }
    if (!options.destination || options.destination.trim() === "") {
      log.error("Destination chain ID cannot be empty");
      process.exit(1);
    }
    if (options.source === options.destination) {
      log.error("Source and destination chain IDs must be different");
      process.exit(1);
    }

    // Validate URLs
    try {
      new URL(options.sourceUrl);
    }
    catch {
      log.error(`Invalid source URL: ${options.sourceUrl}`);
      process.exit(1);
    }
    try {
      new URL(options.destinationUrl);
    }
    catch {
      log.error(`Invalid destination URL: ${options.destinationUrl}`);
      process.exit(1);
    }

    // Validate IBC version
    const ibcVersion = parseInt(options.ibcVersion, 10);
    if (isNaN(ibcVersion) || ![1, 2].includes(ibcVersion)) {
      log.error(`Invalid IBC version: ${options.ibcVersion}. Must be 1 or 2`);
      process.exit(1);
    }

    const relayer = new Relayer(log);
    await relayer.addNewRelayPath(
      options.source,
      options.sourceUrl,
      options.destination,
      options.destinationUrl,
      options.sourceType as ChainType,
      options.destinationType as ChainType,
      ibcVersion,
    );
  });
program.command("dump-paths")
  .description("Dump all relay paths")
  .action(async () => {
    const relayer = new Relayer(log);
    console.log(JSON.stringify(await relayer.getRelayPaths()));
  });
program.parseAsync();
