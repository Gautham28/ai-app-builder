import arcjet, {
  tokenBucket,
  detectPromptInjection,
  sensitiveInfo,
} from "@arcjet/next";

export const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["userId"],
  rules: [
    tokenBucket({
      mode: "LIVE",
      refillRate: 5,
      interval: 60,
      capacity: 5,
    }),

    detectPromptInjection({
      mode: "LIVE",
    }),

    sensitiveInfo({
      mode: "LIVE",
      deny: ["CREDIT_CARD_NUMBER", "API_KEY", "AWS_SECRET_KEY"],
    }),
  ],
});

// Uploads get their own budget so attaching images cannot exhaust the
// generation quota. Prompt-injection and sensitive-info rules do not apply to
// binary payloads.
export const ajUpload = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["userId"],
  rules: [
    tokenBucket({
      mode: "LIVE",
      refillRate: 10,
      interval: 60,
      capacity: 10,
    }),
  ],
});
