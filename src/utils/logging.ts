import winston from "winston";

import config from  "../config";


const { printf } = winston.format;

const eclesiaFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level.toUpperCase()}]:\t${message}`;
  });
export const log = winston.createLogger({
    level: config.logLevel,
    defaultMeta: { service: "IBC V2 Relayer" },
    transports: [
      new winston.transports.File({
        filename: "error.log",
        level: "error"
      }),
      new winston.transports.File({ filename: "combined.log" }),
      new winston.transports.Console({
        format: winston.format.combine(winston.format.splat(), winston.format.timestamp(), eclesiaFormat, winston.format.colorize({ all: true }))
      })
    ]
  });