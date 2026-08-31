import { z } from "zod";

// Caps exist to bound Gemini token cost, which is otherwise attacker-controlled:
// fileData is serialised into every prompt.
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_MESSAGES = 25;
export const MAX_FILE_DATA_BYTES = 256 * 1024;
export const MAX_IMPROVE_REQUEST_LENGTH = 2000;

// Only accept image URLs we issued. An arbitrary URL here would be fetched by
// Gemini and embedded in generated apps.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const imageUrlSchema = z
  .string()
  .max(2048)
  .refine((url) => supabaseUrl.length > 0 && url.startsWith(supabaseUrl), {
    message: "Image URL must point at project storage",
  });

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_MESSAGE_LENGTH),
  imageUrl: imageUrlSchema.optional(),
});

const fileDataSchema = z.object({
  files: z.record(z.string().max(512), z.object({ code: z.string() })),
  dependencies: z.record(z.string().max(214), z.string().max(64)).default({}),
  title: z.string().max(200).optional(),
});

const withinByteLimit = (value: unknown) =>
  JSON.stringify(value ?? null).length <= MAX_FILE_DATA_BYTES;

export const generateRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64).nullish(),
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  fileData: fileDataSchema
    .nullish()
    .refine(withinByteLimit, { message: "Project files are too large" }),
});

export const improveRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  userRequest: z.string().min(1).max(MAX_IMPROVE_REQUEST_LENGTH),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type ImproveRequest = z.infer<typeof improveRequestSchema>;

// Shape of what Gemini returns. Validated before it reaches the database.
export const aiResponseSchema = z.object({
  assistantMessage: z.string().max(MAX_MESSAGE_LENGTH),
  title: z.string().max(200).optional(),
  files: z
    .record(z.string().max(512), z.object({ code: z.string() }))
    .refine((files) => Object.keys(files).length > 0, {
      message: "AI returned no files",
    }),
  dependencies: z.record(z.string().max(214), z.string().max(64)).default({}),
});
