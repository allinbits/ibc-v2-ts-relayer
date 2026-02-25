import Handlebars from "handlebars";

import {
  Acknowledgement,
} from "./templates/AcknowledgePacket.gno.js";
import {
  CreateClient,
} from "./templates/CreateClient.gno.js";
import {
  RecvPacket,
} from "./templates/RecvPacket.gno.js";
import {
  RegisterCounterparty,
} from "./templates/RegisterCounterParty.gno.js";
import {
  Timeout,
} from "./templates/TimeoutPacket.gno.js";
import {
  UpdateClient,
} from "./templates/UpdateClient.gno.js";

const createClientTemplate = Handlebars.compile(CreateClient);
const updateClientTemplate = Handlebars.compile(UpdateClient);
const registerCounterParty = Handlebars.compile(RegisterCounterparty);
const acknowledgement = Handlebars.compile(Acknowledgement);
const recvPacket = Handlebars.compile(RecvPacket);
const timeout = Handlebars.compile(Timeout);

export {
  acknowledgement,
  createClientTemplate,
  recvPacket,
  registerCounterParty,
  timeout,
  updateClientTemplate,
};
