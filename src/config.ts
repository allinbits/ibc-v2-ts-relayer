/**
 * @deprecated Import from "./config/index" instead.
 * This file is kept for backward compatibility.
 */
import config from "./config/index";

export default {
  logLevel: config.logging.level,
  dbFile: config.database.file,
};
