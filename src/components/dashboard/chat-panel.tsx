"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { apiPost } from "@/components/api-client";
import type { ChatTurn } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { ChatIcon, SendIcon } from "@/components/icons";
import { ErrorState } from "@/components/ui/states";

const EXAMPLES = [
  "When should I start studying for Calc midterm?",
  "Which week of the semester is worst?",
  "What is due in the next ten days?",
  "How much of my grade is still up for grabs?",
];

interface Message extends ChatTurn {
  id: string;
}

export function ChatPanel({ openaiReady }: { openaiReady: boolean }) {
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ error: string; detail?: string } | null>(
    null,
  );
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, pending]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setError(null);
    const history: ChatTurn[] = messages.map(({ role, content }) => ({
      role,
      content,
    }));
    const outgoing: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    setMessages((current) => [...current, outgoing]);
    setDraft("");
    setPending(true);

    const result = await apiPost<{ reply: string }>("/api/chat", {
      message: trimmed,
      history,
    });
    setPending(false);

    if (!result.ok) {
      setError({ error: result.error, detail: result.detail });
      return;
    }
    setMessages((current) => [
      ...current,
      {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: result.data.reply,
      },
    ]);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(draft);
  }

  return (
    <Panel
      id="chat"
      title="Ask about your semester"
      icon={<ChatIcon width={17} height={17} />}
      description="Answers come from your own syllabi, deadlines and weights."
      action={
        messages.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
          >
            Clear
          </Button>
        ) : null
      }
    >
      <div className="flex h-full flex-col gap-3">
        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="max-h-96 min-h-40 flex-1 overflow-y-auto rounded-lg border border-line bg-sunken/50 p-3"
        >
          {messages.length === 0 && !pending ? (
            <div className="p-2">
              <p className="text-[0.875rem] leading-relaxed text-ink-soft">
                Ask anything about your courses. For example:
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {EXAMPLES.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => void ask(example)}
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-left text-[0.875rem] text-ink transition-colors hover:border-accent-line hover:bg-accent-soft"
                    >
                      “{example}”
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="space-y-3">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={
                    message.role === "user" ? "flex justify-end" : "flex"
                  }
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-[0.875rem] leading-relaxed whitespace-pre-wrap ${
                      message.role === "user"
                        ? "bg-accent text-accent-on"
                        : "border border-line bg-surface text-ink"
                    }`}
                  >
                    <span className="sr-only">
                      {message.role === "user" ? "You said: " : "Syllabus AI replied: "}
                    </span>
                    {message.content}
                  </div>
                </li>
              ))}
              {pending ? (
                <li className="flex">
                  <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[0.875rem] text-muted">
                    <Spinner label="Thinking" />
                    Thinking…
                  </div>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        {error ? (
          <ErrorState error={error.error} detail={error.detail} />
        ) : null}

        {!openaiReady ? (
          <p className="text-[0.75rem] text-muted">
            Running without an OpenAI key — replies come from the built-in
            fallback and stay basic.
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <div className="flex-1">
            <label
              htmlFor={inputId}
              className="mb-1 block text-[0.75rem] font-medium text-muted"
            >
              Your question
            </label>
            <input
              id={inputId}
              name="message"
              type="text"
              autoComplete="off"
              value={draft}
              disabled={pending}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="When should I start studying for Calc midterm?"
              className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[0.875rem] text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </div>
          <Button type="submit" disabled={pending || draft.trim().length === 0}>
            <SendIcon width={16} height={16} />
            <span className="sr-only sm:not-sr-only">Send</span>
          </Button>
        </form>
      </div>
    </Panel>
  );
}
