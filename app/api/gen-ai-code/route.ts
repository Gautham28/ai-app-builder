import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/prisma";
import { checkUser } from "@/lib/checkUser";
import type { Message, FileData } from "@/types/workspace";
import { aj } from "@/lib/arcjet";
import { getCredits, refundCredit, reserveCredit } from "@/lib/credits";
import { aiResponseSchema, generateRequestSchema } from "@/lib/validation";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

function sseEvent(type: string, payload: unknown): string {
  return `data: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
}

function extractThoughtLabel(text: string): string | null {
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  const sentence = text.split(/[.\n]/)[0].trim();
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;

  return null;
}

async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) valid[pkg] = version;
      } catch {
      }
    })
  );
  return valid;
}

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape:
{
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
4. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
5. The entry point must always be /App.js and must export a default component.
6. All imports must reference files you include in "files" or packages in "dependencies".
7. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
8. When modifying existing code, include ALL files (both changed and unchanged) in "files".
9. Keep code clean, readable, and production-quality.
10. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.`;

function buildContents(messages: Message[], fileData: FileData | null) {
  const trimmed = trimHistory(messages);

  return trimmed.map((msg, idx) => {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "user") {
      const parts: object[] = [];

      let text = msg.content;

      if (msg.imageUrl) {
        text = `[The user has attached an image. Use this URL directly in the generated app where relevant (as img src, background-image, etc.): ${msg.imageUrl}]\n\n${text}`;
      }

      const isLast = idx === trimmed.length - 1;
      if (isLast && fileData) {
        text +=
          "\n\nCurrent project files for context:\n" +
          JSON.stringify(fileData, null, 2);
      }

      parts.push({ text });
      return { role, parts };
    }

    return { role, parts: [{ text: msg.content }] };
  });
}

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = generateRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return Response.json(
      {
        message:
          parsedBody.error.issues[0]?.message ?? "Invalid request payload",
      },
      { status: 400 }
    );
  }

  const { workspaceId, messages, fileData } = parsedBody.data;

  const arcjetReq = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(rawBody),
  });

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const decision = await aj.protect(arcjetReq, {
    requested: 1,
    userId: clerkId,
    detectPromptInjectionMessage: lastUserMessage,
  });
  if (decision.isDenied()) {
    return Response.json(
      { message: decision.reason?.type ?? "Request blocked" },
      { status: 429 }
    );
  }

  // Identity comes from the Clerk session only. A client-supplied user id would
  // let a caller charge someone else's credits and overwrite their workspaces.
  let user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });

  if (!user) {
    await checkUser();
    user = await db.user.findUnique({
      where: { clerkId },
      select: { id: true },
    });
  }

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  // Confirm ownership up front so an unauthorised workspaceId fails loudly
  // instead of silently matching nothing during the update.
  if (workspaceId) {
    const owned = await db.workspace.findFirst({
      where: { id: workspaceId, userId: user.id },
      select: { id: true },
    });
    if (!owned) {
      return Response.json({ message: "Workspace not found" }, { status: 404 });
    }
  }

  if (!(await reserveCredit(user.id))) {
    return Response.json({ message: "Insufficient credits" }, { status: 402 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      // The credit is already reserved. Every exit path that does not produce a
      // saved workspace has to give it back, and exactly once.
      let creditSettled = false;
      const failWith = async (message: string) => {
        if (!creditSettled) {
          creditSettled = true;
          await refundCredit(user.id).catch((err) =>
            console.error("[gen-ai-code] refund failed:", err)
          );
        }
        enqueue(sseEvent("error", { message }));
      };

      try {
        const contents = buildContents(messages, fileData ?? null);

        const geminiStream = await ai.models.generateContentStream({
          model: "gemini-3.5-flash",
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.7,
            responseMimeType: "application/json",
            thinkingConfig: {
              includeThoughts: true,
            },
          },
        });

        let accumulated = ""; // final JSON output
        let lastEmitTime = 0; // throttle thought emissions

        for await (const chunk of geminiStream) {
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (!part.text) continue;

            if (part.thought) {
              const now = Date.now();
              if (now - lastEmitTime > 600) {
                const label = extractThoughtLabel(part.text);
                if (label) {
                  enqueue(sseEvent("status", { message: label }));
                  lastEmitTime = now;
                }
              }
            } else {
              accumulated += part.text;
            }
          }
        }

        let rawParsed: unknown;
        try {
          rawParsed = JSON.parse(accumulated);
        } catch {
          await failWith("AI returned invalid JSON. Please try again.");
          return;
        }

        const aiResult = aiResponseSchema.safeParse(rawParsed);
        if (!aiResult.success) {
          console.error(
            "[gen-ai-code] unexpected AI shape:",
            aiResult.error.issues
          );
          await failWith("AI returned an unexpected response. Please try again.");
          return;
        }

        const {
          assistantMessage,
          title: aiTitle,
          files,
          dependencies,
        } = aiResult.data;

        enqueue(sseEvent("status", { message: "Validating packages…" }));
        const validatedDeps = await validateDependencies(dependencies);
        const newFileData: FileData = {
          files,
          dependencies: validatedDeps,
          title: aiTitle,
        };

        enqueue(sseEvent("status", { message: "Saving…" }));

        const lastUserMessage = messages[messages.length - 1];
        const updatedMessages: Message[] = [
          ...messages,
          { role: "assistant", content: assistantMessage },
        ];

        const workspace = workspaceId
          ? await db.workspace.update({
              where: { id: workspaceId, userId: user.id },
              data: {
                title: aiTitle ?? undefined,
                messages: updatedMessages as never,
                fileData: newFileData as never,
              },
            })
          : await db.workspace.create({
              data: {
                userId: user.id,
                title: aiTitle ?? lastUserMessage.content.slice(0, 80),
                messages: updatedMessages as never,
                fileData: newFileData as never,
              },
            });

        // The reserved credit is now paid for by a saved workspace.
        creditSettled = true;

        enqueue(
          sseEvent("done", {
            workspaceId: workspace.id,
            assistantMessage,
            fileData: newFileData,
            creditsRemaining: await getCredits(user.id),
          })
        );
      } catch (err) {
        console.error("[gen-ai-code] stream error:", err);
        await failWith("Something went wrong. Please try again.");
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops intermediate proxies buffering the stream into one final dump.
      "X-Accel-Buffering": "no",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; 