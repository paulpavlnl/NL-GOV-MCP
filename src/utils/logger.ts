import pino from "pino";

const destination = pino.destination({ dest: 2, sync: false });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    // Paths are case-sensitive: list the lower-case names Node uses for incoming and
    // fetch headers, and the spellings the sources set on their requests.
    redact: [
      "req.headers.authorization",
      "authorization",
      "headers.Authorization",
      "headers.authorization",
      'headers["x-api-key"]',
      'headers["X-Api-Key"]',
      'headers["X-API-Key"]',
      'headers["ocp-apim-subscription-key"]',
      'headers["Ocp-Apim-Subscription-Key"]',
      'headers["x-auth-token"]',
      'headers["X-AUTH-TOKEN"]',
      'req.headers["x-api-key"]',
      'req.headers["ocp-apim-subscription-key"]',
      'req.headers["x-auth-token"]',
      "apiKey",
      "api_key",
    ],
  },
  destination,
);
