"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CodePanel } from "./CodePanel";
import { FileData, Message, StatusStep, WorkspaceData } from "@/types/workspace";
import ChatPanel from "./ChatPanel";
import { MIN_CREDITS_TO_GENERATE } from "@/lib/constants";
import { toast } from "sonner";

interface WorkspaceClientProps {
    initialPrompt: string | null;
    userCredits: number;
    userPlan: string;
    workspace: WorkspaceData | null;
}

function parseMessages(raw: unknown): Message[] {
    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (m): m is Message =>
        typeof m === "object" && m !== null && "role" in m && "content" in m
    );
  } 

  function parseFileData(raw: unknown): FileData | null {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (!f.files || !f.dependencies) return null;
    return raw as FileData;
  }

const WorkspaceClient = ({ initialPrompt, userCredits, workspace, userPlan}: WorkspaceClientProps) => {
    const [workspaceId, setWorkspaceId] = useState<string | null>(workspace?.id ?? null,);
    const [messages, setMessages] = useState<Message[]>(
        parseMessages(workspace?.messages),
    );
   
    const [credits, setCredits] = useState(userCredits);

    const [fileData, setFileData] = useState<FileData | null>(
        parseFileData(workspace?.fileData),
    );
    const [isGenerating, setIsGenerating] = useState(false);
    const [statusLog, setStatusLog] = useState<StatusStep[]>([]);
    const [isImproving, setIsImproving] = useState(false);

    const messagesRef = useRef<Message[]>(messages);
    useEffect(() => {
      messagesRef.current = messages;
    }, [messages]);
  
    const workspaceIdRef = useRef<string | null>(workspaceId);
    useEffect(() => {
      workspaceIdRef.current = workspaceId;
    }, [workspaceId]);

    const generateAbortRef = useRef<AbortController | null>(null);
    const improveAbortRef = useRef<AbortController | null>(null);
  
    const fileDataRef = useRef<FileData | null>(fileData);
    useEffect(() => {
      fileDataRef.current = fileData;
    }, [fileData]);

    const pushStep = (label: string) => {
        setStatusLog((prev) => [
          ...prev.map((s, i) =>
            i === prev.length - 1 ? { ...s, status: "done" as const } : s
          ),
          { label, status: "running" as const },
        ]);
      };

        const completeSteps = () => {
    setStatusLog((prev) =>
      prev.map((s, i) =>
        i === prev.length - 1 ? { ...s, status: "done" as const } : s
      )
    );
  };

    const handleFilePatch = useCallback((patches: FileData) => {
        setFileData(patches);
    }, []);

    const handleImprove = useCallback(
      async (userRequest: string) => {
        if (isGenerating || isImproving) return;
        if (credits < MIN_CREDITS_TO_GENERATE) return;
        if (!workspaceIdRef.current) return;
  
        // Read fileData from ref — never stale, never causes recreating this fn
        const currentFileData = fileDataRef.current;
        if (!currentFileData) return;
  
        setIsImproving(true);
  
        setMessages((prev) => [
          ...prev,
          { role: "user", content: userRequest },
          { role: "assistant", content: "" }, // placeholder, updated live
        ]);
  
        // Create a fresh AbortController for this request
        const abortController = new AbortController();
        improveAbortRef.current = abortController;
  
        try {
          const res = await fetch("/api/improve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({
              workspaceId: workspaceIdRef.current,
              userRequest,
            }),
          });
  
          if (res.status === 403) {
            toast.error("Upgrade to Pro to use Improve with Bloom Agent.");
            setMessages((prev) => prev.slice(0, -2));
            return;
          }
          if (res.status === 402) {
            toast.error("Not enough credits.");
            setMessages((prev) => prev.slice(0, -2));
            return;
          }
          if (res.status === 429) {
            toast.error("Too many requests. Please slow down.");
            setMessages((prev) => prev.slice(0, -2));
            return;
          }
          if (!res.ok || !res.body) {
            const detail = await res
              .json()
              .then((b) => b?.message as string | undefined)
              .catch(() => undefined);
            throw new Error(detail ?? "Improve failed");
          }
  
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let accumulatedThinking = "";
  
          // Accumulate patches locally — only apply to state at done.
          // Applying on every file_patch event would update fileData state,
          // which feeds into SandpackProvider and can cause remounts mid-stream.
          const localPatches: Record<string, { code: string }> = {};
  
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
  
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");
            buffer = lines.pop() ?? "";
  
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;

              // Skip only unparseable frames; real errors must reach the catch below.
              let event;
              try {
                event = JSON.parse(line.slice(6));
              } catch {
                continue;
              }

              if (event.type === "thinking") {
                // Stream agent reasoning into the placeholder assistant message
                accumulatedThinking += event.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: accumulatedThinking,
                  };
                  return updated;
                });
              } else if (event.type === "file_patch") {
                // Accumulate locally — don't touch state yet
                localPatches[event.path] = { code: event.code };
              } else if (event.type === "done") {
                // Apply all patches at once now that the stream is complete
                setFileData(event.fileData);
                setCredits(event.creditsRemaining);
                // Replace thinking text with clean summary
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: event.summary,
                  };
                  return updated;
                });
              } else if (event.type === "error") {
                throw new Error(event.message);
              }
            }
          }
        } catch (err) {
          // User-initiated stop — silently roll back the user + placeholder messages
          if (err instanceof Error && err.name === "AbortError") {
            setMessages((prev) => prev.slice(0, -2));
            return;
          }
          toast.error(err instanceof Error ? err.message : "Improve failed.");
          setMessages((prev) => prev.slice(0, -2));
        } finally {
          improveAbortRef.current = null;
          setIsImproving(false);
        }
      },
      // fileData intentionally omitted — read via fileDataRef above
      [credits, isGenerating, isImproving]
    );

    const handleGenerate = useCallback(
        async (prompt: string, imageUrl?: string) => {
          if (isGenerating) return;
          if (credits < MIN_CREDITS_TO_GENERATE) return;
    
          const userMessage: Message = {
            role: "user",
            content: prompt,
            ...(imageUrl ? { imageUrl } : {}),
          };
    
          const currentMessages = messagesRef.current;
          const currentWorkspaceId = workspaceIdRef.current;
    
          setMessages((prev) => [...prev, userMessage]);
          setIsGenerating(true);
          setStatusLog([{ label: "Thinking…", status: "running" }]);

          const abortController = new AbortController();
          generateAbortRef.current = abortController;

          try {
            const conversationHistory = [...currentMessages, userMessage];

            const res = await fetch("/api/gen-ai-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: abortController.signal,
              body: JSON.stringify({
                workspaceId: currentWorkspaceId,
                messages: conversationHistory,
                fileData: fileDataRef.current,
              }),
            });
            if (res.status === 402) {
                toast.error("Not enough credits.");
                setMessages((prev) => prev.slice(0, -1));
                return;
              }
              if (res.status === 429) {
                toast.error("Too many requests. Please slow down.");
                setMessages((prev) => prev.slice(0, -1));
                return;
              }
              if (!res.ok || !res.body) {
                const detail = await res
                  .json()
                  .then((b) => b?.message as string | undefined)
                  .catch(() => undefined);
                throw new Error(detail ?? "Generation failed");
              }

              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true});
                const lines = buffer.split("\n\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;

                    // Only malformed SSE frames are skipped. A server-reported
                    // error must propagate to the outer handler so the user sees it.
                    let event;
                    try {
                        event = JSON.parse(line.slice(6));
                    } catch {
                        continue;
                    }

                    if (event.type === "status"){
                        pushStep(event.message);
                    }else if (event.type === "done") {
                        completeSteps();
                        setWorkspaceId(event.workspaceId);
                        setFileData(event.fileData);
                        setCredits(event.creditsRemaining);
                        setMessages((prev) => [
                          ...prev,
                          { role: "assistant", content: event.assistantMessage },
                        ]);
                        window.history.replaceState(
                          null,
                          "",
                          `/workspace?id=${event.workspaceId}`
                        );
                    } else if (event.type === "error"){
                        throw new Error(event.message);
                    }
                }
              }

        } catch (err){
          if (err instanceof Error && err.name === "AbortError"){
            setMessages((prev) => prev.slice(0, -1));
            return;
          }
            toast.error(
                err instanceof Error ? err.message : "Something went wrong",
            );
            setMessages((prev) => prev.slice(0, -1));
        } finally {
            generateAbortRef.current = null;
            setIsGenerating(false);
            setStatusLog([]);
        }
    },
        [credits, isGenerating],
    );

    const handleStop = useCallback(() => {
      generateAbortRef.current?.abort();
      improveAbortRef.current?.abort();
    }, [])

    return (
        <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-[#0a0a0a]">
            <ChatPanel
                messages={messages}
                isGenerating={isGenerating}
                isImproving={isImproving}
                statusLog={statusLog}
                credits={credits}
                initialPrompt={initialPrompt}
                onStop={handleStop}
                onGenerate={handleGenerate}
                workspaceId={workspaceId}
                appTitle={fileData?.title ?? workspace?.title ?? null}
            />

            <CodePanel 
            fileData={fileData}
            isGenerating={isGenerating}
            statusLog={statusLog}
            onFilePatch={handleFilePatch}
            isImproving={isImproving}
            onFixError={(error) =>
              handleGenerate(
                `There is an error in the preview:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix it.`
              )
            }
            appTitle={fileData?.title ?? workspace?.title ?? null}
            isProUser={userPlan === "pro"}
            onImprove={handleImprove}
            workspaceId={workspaceId}
            />
        </div>
    )
}

export default WorkspaceClient;