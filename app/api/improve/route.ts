import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { Agent, createTool } from "@cline/sdk";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { checkUser } from "@/lib/checkUser";
import type { FileData } from "@/types/workspace";
import { aj } from "@/lib/arcjet";
import { getCredits, refundCredit, reserveCredit } from "@/lib/credits";
import { improveRequestSchema } from "@/lib/validation";

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: object): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function parseFileData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<FileData>;
  if (!candidate.files || typeof candidate.files !== "object") return null;
  return {
    files: candidate.files,
    dependencies: candidate.dependencies ?? {},
    title: candidate.title,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return Response.json({ message: "Unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = improveRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return Response.json(
      {
        message:
          parsedBody.error.issues[0]?.message ?? "Invalid request payload",
      },
      { status: 400 }
    );
  }

  const { workspaceId, userRequest } = parsedBody.data;

  // This endpoint runs an agent loop of up to 8 Gemini calls, so it needs rate
  // limiting at least as much as the generation endpoint.
  const decision = await aj.protect(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(rawBody),
    }),
    {
      requested: 1,
      userId: clerkId,
      detectPromptInjectionMessage: userRequest,
    }
  );
  if (decision.isDenied()) {
    return Response.json(
      { message: decision.reason?.type ?? "Request blocked" },
      { status: 429 }
    );
  }

  // ── Auth + plan gate ───────────────────────────────────────────────────────

  let user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, plan: true },
  });

  if (!user) {
    await checkUser();
    user = await db.user.findUnique({
      where: { clerkId },
      select: { id: true, plan: true },
    });
  }

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  // Pro-only gate
  if (user.plan !== "pro")
    return Response.json({ message: "Upgrade required" }, { status: 403 });

  // Load the files from the database rather than trusting the request body, so a
  // client cannot overwrite its saved project with arbitrary content.
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, userId: user.id },
    select: { fileData: true },
  });

  if (!workspace)
    return Response.json({ message: "Workspace not found" }, { status: 404 });

  const fileData = parseFileData(workspace.fileData);
  if (!fileData)
    return Response.json(
      { message: "This project has no files to improve yet." },
      { status: 400 }
    );

  if (!(await reserveCredit(user.id)))
    return Response.json({ message: "Insufficient credits" }, { status: 402 });

  // ── Build the agent ────────────────────────────────────────────────────────

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      // Accumulate file patches as the agent calls update_file
      const patchedFiles: Record<string, { code: string }> = {
        ...fileData.files,
      };
      let finalSummary = "";

      // The credit is reserved before the agent starts; give it back on failure.
      let creditSettled = false;
      const failWith = async (message: string) => {
        if (!creditSettled) {
          creditSettled = true;
          await refundCredit(user.id).catch((err) =>
            console.error("[improve] refund failed:", err)
          );
        }
        enqueue(sseEvent("error", { message }));
      };

      // ── Tool 1: update_file ──────────────────────────────────────────────
      // The agent calls this once per file it wants to change.
      // We immediately emit a file_patch SSE event so Sandpack
      // updates live in the browser as each file is patched.

      const updateFileTool = createTool({
        name: "update_file",
        description:
          "Update or rewrite a file in the React sandbox. Call once per file you need to change.",
        inputSchema: z.object({
          path: z
            .string()
            .describe("File path exactly as it appears, e.g. /App.js"),
          code: z.string().describe("Complete new contents of the file"),
          reason: z
            .string()
            .describe("One sentence explaining what you changed and why"),
        }),
        async execute({ path, code, reason }) {
          patchedFiles[path] = { code };
          // Emit live patch — client applies it to Sandpack immediately
          enqueue(sseEvent("file_patch", { path, code, reason }));
          return `Updated ${path}: ${reason}`;
        },
      });

      // ── Tool 2: done_improving ───────────────────────────────────────────
      // Agent calls this when all files are updated.
      // lifecycle.completesRun: true tells the Cline SDK loop to stop
      // immediately after this tool runs instead of continuing iterations.

      const doneImprovingTool = createTool({
        name: "done_improving",
        description:
          "Call this when you have finished making all improvements.",
        inputSchema: z.object({
          summary: z
            .string()
            .describe(
              "A short friendly summary of all the improvements you made (1-3 sentences)"
            ),
        }),
        lifecycle: { completesRun: true },
        async execute({ summary }) {
          finalSummary = summary;
          return "Done.";
        },
      });

      // ── Serialize current files for context ──────────────────────────────
      // We give the agent all current files as context in the system prompt
      // so it knows exactly what it's working with.

      const fileContext = Object.entries(fileData.files)
        .map(([path, { code }]) => `// ${path}\n${code}`)
        .join("\n\n---\n\n");

      const agent = new Agent({
        providerId: "gemini",
        modelId: "gemini-3.5-flash",
        apiKey: process.env.GEMINI_API_KEY!,
        maxIterations: 8,
        systemPrompt: `You are an expert React developer improving a live browser preview app.

The app uses React (functional components), Tailwind CSS for styling, and runs in Sandpack.
You CANNOT use TypeScript, CSS modules, or real npm install — only what's already available.
Available packages: react, react-dom, tailwindcss (CDN), lucide-react, recharts, react-router-dom, framer-motion, date-fns, zod, react-hook-form.

Here are the current files:

${fileContext}

WORKFLOW:
1. Understand what the user wants improved.
2. Identify which files need to change.
3. Call update_file for each file that needs changes (always include the COMPLETE file, not just the diff).
4. Once all files are updated, call done_improving with a short summary.

RULES:
- Always write complete file contents — never partial snippets.
- Keep all existing functionality unless asked to remove it.
- The entry point is always /App.js with a default export.
- All imports must reference files you've updated or packages in the available list above.`,
        tools: [updateFileTool, doneImprovingTool],
        // Auto-approve both tools — no human-in-the-loop needed in this context
        toolPolicies: {
          update_file: { autoApprove: true },
          done_improving: { autoApprove: true },
        },
      });

      try {
        // ── Stream agent reasoning to chat panel ─────────────────────────
        // assistant-text-delta fires as the agent types its reasoning.
        // We emit these as "thinking" events — shown in the chat panel
        // as a live streaming message so users see the agent working.

        agent.subscribe((event) => {
          if (event.type === "assistant-text-delta" && event.text) {
            enqueue(sseEvent("thinking", { text: event.text }));
          }

          // This fires reliably every time a tool is called
          if (event.type === "tool-started") {
            const name = event.toolCall?.toolName;
            if (name === "update_file") {
              const path =
                (event.toolCall?.input as { path?: string })?.path ?? "a file";
              enqueue(
                sseEvent("thinking", { text: `\n\nUpdating \`${path}\`…` })
              );
            } else if (name === "done_improving") {
              enqueue(
                sseEvent("thinking", { text: "\n\nFinalizing improvements…" })
              );
            }
          }
        });

        // ── Run the agent ─────────────────────────────────────────────────
        enqueue(sseEvent("status", { message: "Cline agent starting…" }));

        const result = await agent.run(userRequest);

        if (result.status === "failed") {
          throw new Error(result.error?.message ?? "Agent run failed");
        }

        // ── Deduct credit + save to DB ────────────────────────────────────

        const newFileData: FileData = {
          files: patchedFiles,
          dependencies: fileData.dependencies,
          title: fileData.title,
        };

        await db.workspace.update({
          where: { id: workspaceId, userId: user.id },
          data: { fileData: newFileData as never },
        });

        // The reserved credit is now paid for by a saved improvement.
        creditSettled = true;

        // ── Final done event ──────────────────────────────────────────────

        enqueue(
          sseEvent("done", {
            fileData: newFileData,
            summary: finalSummary || result.outputText,
            creditsRemaining: await getCredits(user.id),
          })
        );
      } catch (err) {
        console.error("[improve] error:", err);
        await failWith(
          err instanceof Error ? err.message : "Something went wrong."
        );
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
      "X-Accel-Buffering": "no",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; // for vercel - 300s on Fluid