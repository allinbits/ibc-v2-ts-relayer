const logLevel = process.env.LOG_LEVEL || "info";

export default {
  logLevel: logLevel,
  dbFile: process.env.DB_FILE || "relayer.db",
};