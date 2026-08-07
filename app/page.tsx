"use client"
import { BlueTitle, GrayTitle, SectionHeading, SectionLabel } from "@/components/reusables";
import { Button } from "@/components/ui/button";
import { PricingTable, SignInButton, useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils"
import { FEATURES, PLACEHOLDERS, STEPS, SUGGESTIONS } from "@/lib/data";
import { ArrowRight, ChevronRight, Zap } from "lucide-react";

export default function Home() {
    const { isSignedIn } = useAuth();
    const router = useRouter();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [prompt, setPrompt] = useState("");
    const [placeholderIndex, setPlaceholderIndex] = useState(0);
    const [isFocused, setIsFocused] = useState(false);

    useEffect(() => {
      if (isFocused || prompt) return;
      const t = setInterval(() => {
        setPlaceholderIndex((i) => (i + 1) % PLACEHOLDERS.length);
      }, 3000);
      return () => clearInterval(t);
    }, [isFocused, prompt]);

    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }, [prompt]);

    const handleSubmit = () => {
      if (!prompt.trim() || !isSignedIn) return;
      router.push(`/workspace?prompt=${encodeURIComponent(prompt.trim())}`);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    };

    const handleSuggestion = (s: string) => {
      setPrompt(s);
      textareaRef.current?.focus();
    };

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white selection:bg-violet-500/30">
      {/* HERO */}
      <section id="hero" className="relative isolate w-full overflow-hidden">
        <div className="relative mx-auto aspect-[3/2] w-full">
          <div
            aria-hidden
            className="absolute inset-0 translate-z-0 bg-[length:100%_100%] bg-no-repeat bg-top"
            style={{ backgroundImage: "url('/bloom-bg-purple-dark2.png')" }}
          />
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-[40%] bg-linear-to-b from-transparent via-[#0a0a0a]/70 to-[#0a0a0a]"
          />

          <div className="relative z-10 flex flex-col items-center px-4 pt-32 pb-12 text-center sm:pt-36">
            <h1 className="mx-auto max-w-3xl text-balance font-serif text-5xl leading-tight tracking-tight sm:text-7xl">
              <GrayTitle>Create your app</GrayTitle>
              <br />
              <BlueTitle>From a single prompt</BlueTitle>
            </h1>

            <div className="relative mx-auto mt-10 w-full max-w-2xl">
              <div
                className={cn(
                  "rounded-2xl border bg-[#111] shadow-xl shadow-black/40 duration-200",
                  isFocused
                    ? "border-violet-500/50 ring-1 ring-violet-500/30"
                    : "border-white/10"
                )}
              >
               <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  placeholder={PLACEHOLDERS[placeholderIndex]}
                  rows={1}
                  className="w-full resize-none bg-transparent px-5 pb-4 pt-5 text-sm text-white placeholder:text-white/30 focus:outline-none sm:text-base"
                  style={{ minHeight: 56, maxHeight: 200 }}
                />

                <div className="flex items-center justify-between border-t border-white/8 px-4 py-2.5">
                  <span className="text-xs text-white/30">
                    Press ⏎ to generate · Shift+⏎ for new line
                  </span>

                  {isSignedIn ? (
                    <Button
                      onClick={handleSubmit}
                      disabled={!prompt.trim()}
                      className="h-8 rounded-full bg-violet-600 px-5 font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      Generate
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <SignInButton mode="modal">
                      <Button className="h-8 rounded-full bg-violet-600 px-5 font-semibold text-white hover:bg-violet-700">
                        Generate
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </SignInButton>
                  )}
                </div>
                </div>

                <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(({ icon: Icon, label }) => (
                  <button
                    key={label}
                    onClick={() => handleSuggestion(label)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:border-violet-500/40 hover:text-violet-300"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              </div>

              <p className="mt-8 text-xs text-white/35">
                 No credit card required · 10 free generations on sign up
              </p>
          </div>
        </div>
      </section>

      {/* BROWSER MOCKUP */}
      <section className="px-4 pb-32 pt-8 [content-visibility:auto]">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-[#111] shadow-2xl shadow-black/40">
              <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
                <div className="flex gap-1.5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-3 w-3 rounded-full bg-white/15" />
                  ))}
                </div>

                <div className="mx-auto flex h-6 w-64 items-center justify-center rounded-md bg-white/5 px-3">
                  <span className="text-xs text-white/30">bloom.app/workspace</span>
                </div>
              </div>

              <div className="flex h-105">
                {/* Chat panel */}
                <div className="flex w-80 flex-col border-r border-white/8 bg-[#0d0d0d]">
                  <div className="border-b border-white/8 px-4 py-3">
                    <p className="text-xs uppercase tracking-wider text-white/30">
                      Chat
                    </p>
                  </div>

                  <div className="flex-1 space-y-4 px-4 py-4">
                    <div className="flex justify-end">
                      <div className="max-w-55 rounded-2xl rounded-br-sm bg-violet-600 px-3.5 py-2.5">
                        <p className="text-xs text-white">
                          Build a kanban board with 3 columns and drag-and-drop
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2.5">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-600">
                        <Zap className="h-3 w-3 fill-white text-white" />
                      </div>

                      <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/5 px-3.5 py-2.5">
                        <p className="text-xs text-white/60">
                          I&apos;ll build a Kanban board with Todo, In Progress, and
                          Done columns. I&apos;ll use{" "}
                          <code className="text-violet-400">@dnd-kit/core</code>{" "}
                          for smooth drag-and-drop…
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2.5">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-600">
                        <Zap className="h-3 w-3 fill-white text-white" />
                      </div>
                      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border border-white/10 bg-white/5 px-3.5 py-3">
                        {[0, 0.15, 0.3].map((delay) => (
                          <span
                            key={delay}
                            className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/25"
                            style={{ animationDelay: `${delay}s` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-white/8 px-3 py-3">
                    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                      <span className="flex-1 text-xs text-white/30">
                        Ask AI to modify…
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-white/30" />
                    </div>
                  </div>
                </div>

                <div className="flex flex-1 flex-col">
                  <div className="flex items-center gap-1 border-b border-white/8 px-4">
                    <button className="border-b-2 border-violet-500 px-3 py-2.5 text-xs text-white">
                      Preview
                    </button>
                    <button className="px-3 py-2.5 text-xs text-white/30">
                      Code
                    </button>
                  </div>

                  <div className="flex flex-1 gap-3 overflow-hidden bg-[#0d0d0d] p-5">
                    {["Todo", "In Progress", "Done"].map((col, ci) => (
                      <div key={col} className="flex w-1/3 flex-col gap-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-xs uppercase tracking-wider text-white/40">
                            {col}
                          </span>

                          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-xs text-white/40">
                            {[3, 2, 1][ci]}
                          </span>
                        </div>

                        {Array.from({ length: [3, 2, 1][ci] }).map((_, i) => (
                          <div
                            key={i}
                            className="rounded-lg border border-white/10 bg-white/5 p-2.5"
                          >
                            <div
                              className="mb-1.5 h-2 rounded-full bg-white/15"
                              style={{ width: `${60 + i * 15}%` }}
                            />
                            <div className="h-1.5 w-3/4 rounded-full bg-white/8" />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
        </div>
      </section>

      <section className="px-4 pb-32 [content-visibility:auto]">
        <div className="mx-auto mb-14 max-w-5xl text-center">
          <SectionLabel>Everything you need</SectionLabel>
          <SectionHeading gray="From prompt" blue="to production." />
        </div>

        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, label, desc }) => (
            <div
              key={label}
              className="group bg-[#111] p-7 hover:bg-[#161616]"
            >
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 group-hover:border-violet-500/30 group-hover:bg-violet-500/10">
                <Icon className="h-4 w-4 text-white/40 group-hover:text-violet-400" />
              </div>
              <p className="mb-2 text-sm font-semibold text-white">{label}</p>
              <p className="text-sm leading-relaxed text-white/40">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 pb-32">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <SectionLabel>How it works</SectionLabel>
          <SectionHeading gray="Four steps" blue="to a working app." />
        </div>

        <div className="mx-auto max-w-3xl">
          {STEPS.map((step, i) => (
            <div key={step.number} className="flex gap-6">
              <div className="flex flex-col items-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5">
                  <span className="font-mono text-xs font-semibold text-white/50">
                    {step.number}
                  </span>
                </div>

                {i < STEPS.length - 1 && (
                  <div className="mt-2 h-full w-px bg-white/10" />
                )}
              </div>

              <div className="pb-10 pt-1.5">
                <p className="mb-1.5 text-sm font-semibold text-white sm:text-base">
                  {step.label}
                </p>

                <p className="text-sm leading-relaxed text-white/40">
                  {step.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>


      <section className="px-4 pb-32">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <SectionLabel>Simple Pricing</SectionLabel>
          <SectionHeading gray="Start free" blue="scale when ready." />

          <p className="mx-auto mt-4 max-w-sm text-sm text-white/40">
            No credit card required. Upgrade or downgrade anytime.
          </p>
        </div>

        <div className="mx-auto max-w-5xl">
          <PricingTable
            checkoutProps={{
              appearance: {
                elements: {
                  drawerRoot: {
                    zIndex: 2000,
                  }
                }
              }
            }}
        />
        </div>
      </section>

          <section className="relative mx-auto mb-32 max-w-5xl overflow-hidden rounded-2xl border border-white/10 px-10 py-24 text-center">

          <div className="absolute inset-0 z-0">
            <div
              aria-hidden
              className="absolute inset-0 bg-cover bg-center bg-no-repeat"
              style={{ backgroundImage: "url('/bloom-bg-purple-dark.png')" }}
            />
            <div className="absolute inset-0 bg-[#0a0a0a]/55" />
          </div>

        <div className="relative z-10">
          <SectionHeading gray="Start building, " blue="for free." />

          <p className="mb-8 text-sm leading-relaxed text-white/50">
            Get 10 free generations on sign up. No credit card required.
            <br />
            Upgrade when you&apos;re ready.
          </p>

          <SignInButton mode="modal">
            <Button
              size="lg"
              className="relative h-11 rounded-full bg-violet-600 px-8 text-white hover:bg-violet-700"
            >
              Get started free
              <ChevronRight className="h-4 w-4" />
            </Button>
          </SignInButton>
        </div>
          </section>

          <footer className="relative z-10 border-t border-white/8 py-12 mx-auto px-6 flex flex-wrap items-center justify-center text-white/30">
        Made with ❤️ by gthm
      </footer>


    </main>
  );
}
