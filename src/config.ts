const logLevel = process.env.LOG_LEVEL || "debug";

export default {
  logLevel: logLevel,
  dbFile: process.env.DB_FILE || "relayer.db",
};
