import {
  GasPrice,
} from "@cosmjs/stargate";
import {
  Command,
  Option,
} from "commander";

import pkgJson from "../package.json";
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
    const relayer = new Relayer(log);
    relayer.addMnemonic(mnemonic, options.chainId);
  });
program.command("add-gas-price")
  .description("Add gas price for a chain")
  .requiredOption("-c, --chain-id <chainId>", "Chain ID to add gas price for")
  .argument("<string>", "Gas information in string format. e.g. 0.025udenom")
  .action(async (gasPrice, options) => {
    const relayer = new Relayer(log);
    const gas = GasPrice.fromString(gasPrice);
    relayer.addGasPrice(options.chainId, gas.amount.toString(), gas.denom);
  });
program.command("relay")
  .description("Relay packets between chains")
  .action(async () => {
    const relayer = new Relayer(log);
    await relayer.init();
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
  "-v, --version <version>",
  "IBC version of the relay path",
).choices(["1", "2"]).makeOptionMandatory().default("1", "Default IBC version is 1");

program.command("add-path")
  .description("Add a new relay path")
  .requiredOption("-s, --source <sourceChain>", "Source chain id")
  .requiredOption("-d, --destination <sourceChain>", "Source chain id")
  .requiredOption("--surl, --source-url <sourceUrl>", "Source chain URL")
  .requiredOption("--durl, --destination-url <destinationUrl>", "Destination chain URL")
  .addOption(sourceTypeOption)
  .addOption(destinationTypeOption)
  .addOption(ibcVersionTypeOption)
  .action(async (options) => {
    const relayer = new Relayer(log);
    await relayer.addNewdRelayPath(
      options.source,
      options.sourceUrl,
      options.destination,
      options.destinationUrl,
      options.sourceType as ChainType,
      options.destinationType as ChainType,
      parseInt(options.version, 10),
    );
  });
program.parseAsync();
