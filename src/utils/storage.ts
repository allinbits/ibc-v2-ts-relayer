import {
  createStorage,
} from "../storage/factory.js";

// Create a singleton storage instance
const storage = createStorage();

export {
  storage,
};
