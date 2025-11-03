import Handlebars from "handlebars";

import {
  CreateClient,
} from "./templates/CreateClient.gno.js";
import {
  RegisterCounterparty,
} from "./templates/RegisterCounterParty.gno.js";
import {
  UpdateClient,
} from "./templates/UpdateClient.gno.js";

const createClientTemplate = Handlebars.compile(CreateClient);
const updateClientTemplate = Handlebars.compile(UpdateClient);
const registerCounterParty = Handlebars.compile(RegisterCounterparty);

export {
  createClientTemplate,
  registerCounterParty,
  updateClientTemplate,
};
