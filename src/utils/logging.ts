import * as winston from "winston";

import config from "../config/index.js";

const {
  printf,
} = winston.format;

const eclesiaFormat = printf(({
  level, message, timestamp,
}) => {
  return `${timestamp} [${level.toUpperCase()}]:\t${message}`;
});
export const log = winston.createLogger({
  level: config.logging.level,
  defaultMeta: {
    service: "IBC V2 Relayer",
  },
  transports: [
    new winston.transports.File({
      filename: config.logging.errorFile,
      level: "error",
    }),
    new winston.transports.File({
      filename: config.logging.combinedFile,
    }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.splat(), winston.format.metadata(), winston.format.timestamp(), eclesiaFormat, winston.format.colorize({
        all: true,
      })),
    }),
  ],
});
