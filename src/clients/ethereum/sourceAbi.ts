/**
 * The parts of the solidity-ibc-eureka ICS26Router ABI (solidity-v3.0.2)
 * the source side reads: commitments, counterparties and packet events.
 */
const packet = {
  name: "packet",
  type: "tuple",
  components: [
    {
      name: "sequence",
      type: "uint64",
    },
    {
      name: "sourceClient",
      type: "string",
    },
    {
      name: "destClient",
      type: "string",
    },
    {
      name: "timeoutTimestamp",
      type: "uint64",
    },
    {
      name: "payloads",
      type: "tuple[]",
      components: [
        {
          name: "sourcePort",
          type: "string",
        },
        {
          name: "destPort",
          type: "string",
        },
        {
          name: "version",
          type: "string",
        },
        {
          name: "encoding",
          type: "string",
        },
        {
          name: "value",
          type: "bytes",
        },
      ],
    },
  ],
} as const;

export const routerSourceAbi = [
  {
    type: "function",
    name: "getCommitment",
    stateMutability: "view",
    inputs: [
      {
        name: "hashedPath",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32",
      },
    ],
  },
  {
    type: "function",
    name: "getCounterparty",
    stateMutability: "view",
    inputs: [
      {
        name: "clientId",
        type: "string",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "clientId",
            type: "string",
          },
          {
            name: "merklePrefix",
            type: "bytes[]",
          },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "SendPacket",
    inputs: [
      {
        name: "clientId",
        type: "string",
        indexed: true,
      },
      {
        name: "sequence",
        type: "uint256",
        indexed: true,
      },
      {
        ...packet,
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "WriteAcknowledgement",
    inputs: [
      {
        name: "clientId",
        type: "string",
        indexed: true,
      },
      {
        name: "sequence",
        type: "uint256",
        indexed: true,
      },
      {
        ...packet,
        indexed: false,
      },
      {
        name: "acknowledgements",
        type: "bytes[]",
        indexed: false,
      },
    ],
  },
] as const;

/**
 * The slot of the commitments mapping in solidity-ibc-eureka's
 * IBCStoreUpgradeable (ERC-7201 namespace).
 */
export const IBC_STORE_COMMITMENT_SLOT = "0x1260944489272988d9df285149b5aa1b0f48f2136d6f416159f840a3e0747600" as const;
