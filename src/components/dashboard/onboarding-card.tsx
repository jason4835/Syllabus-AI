"use client";

import { useEffect, useId, useState } from "react";

import { apiGet, apiPost } from "@/components/api-client";
import { Button } from "@/components/ui/button";
import type { UserProfile } from "@/lib/types";

const YEARS: { value: NonNullable<UserProfile["year"]>; label: string }[] = [
  { value: "freshman", label: "Freshman" },
  { value: "sophomore", label: "Sophomore" },
  { value: "junior", label: "Junior" },
  { value: "senior", label: "Senior" },
  { value: "grad", label: "Grad student" },
  { value: "other", label: "Other" },
];

const SOURCES: { value: NonNullable<UserProfile["source"]>; label: string }[] = [
  { value: "ad", label: "An ad" },
  { value: "social", label: "Social media" },
  { value: "search", label: "Searching" },
  { value: "friend", label: "A friend" },
  { value: "professor", label: "A professor or class" },
  { value: "other", label: "Somewhere else" },
];

/**
 * Three questions, once, skippable.
 *
 * Shown to a signed-in student on their first dashboard visit and never again
 * -- both Save and Skip mark it done. Deliberately not a gate: it sits above
 * the panels, the panels work underneath it, and nothing the student does is
 * blocked on answering. An onboarding flow that stands between a new user and
 * the upload box is a funnel step that only ever loses people.
 *
 * What it asks is the one thing a syllabus cannot say -- who this student is
 * in the coarsest terms -- so an ad campaign can be judged by who it actually
 * brought in. Nothing in the product reads the answers.
 */
export function OnboardingCard({
  onDone,
}: {
  onDone: (profile: UserProfile) => void;
}) {
  const [school, setSchool] = useState("");
  /**
   * Typeahead options from `/api/schools`, so the field is a search over the
   * canonical list rather than a text box. A native `<datalist>` does the
   * dropdown -- no library, keyboard and screen-reader behaviour for free --
   * and the server canonicalises whatever is submitted, so a student who
   * types past the suggestions is still stored correctly (or kept aside as
   * "other" if nothing matches). Debounced: one request per pause, not per key.
   */
  const [options, setOptions] = useState<string[]>([]);
  const listId = useId();
  useEffect(() => {
    const q = school.trim();
    if (q.length < 2) {
      setOptions([]);
      return;
    }
    const handle = setTimeout(() => {
      void apiGet<{ schools: string[] }>(`/api/schools?q=${encodeURIComponent(q)}`).then(
        (result) => {
          if (result.ok) setOptions(result.data.schools);
        },
      );
    }, 150);
    return () => clearTimeout(handle);
  }, [school]);
  const [year, setYear] = useState<UserProfile["year"] | "">("");
  const [source, setSource] = useState<UserProfile["source"] | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(skip: boolean) {
    setPending(true);
    setError(null);
    const result = await apiPost<{ profile: UserProfile }>(
      "/api/me/profile",
      skip ? { skip: true } : { school, year: year || undefined, source: source || undefined },
    );
    setPending(false);
    if (!result.ok) {
      // A failed save must not trap the student under this card forever:
      // dismiss locally either way. The server will ask again next visit,
      // which is the honest outcome of "we could not save that".
      if (skip) onDone({ completedAt: new Date().toISOString() });
      else setError(result.error);
      return;
    }
    onDone(result.data.profile);
  }

  const selectClass =
    "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-[0.875rem] text-ink";

  return (
    <section
      aria-labelledby="onboarding-heading"
      className="rise rounded-lg border border-accent-line bg-accent-soft p-4 sm:p-5"
    >
      <h2 id="onboarding-heading" className="text-[1.0625rem] leading-tight text-ink">
        Quick one, before your semester
      </h2>
      <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-soft">
        Three questions, thirty seconds, and you never see this again. It helps
        us know who we&rsquo;re building for.
      </p>

      <form
        className="mt-4 grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <label className="block text-[0.8125rem] font-medium text-ink">
          School
          <input
            type="text"
            value={school}
            maxLength={80}
            placeholder="Start typing — e.g. NYU"
            autoComplete="off"
            list={listId}
            onChange={(event) => setSchool(event.target.value)}
            className={`mt-1 ${selectClass}`}
          />
          <datalist id={listId}>
            {options.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <span className="mt-1 block text-[0.75rem] font-normal text-muted">
            Pick from the list. Not there? Type it anyway.
          </span>
        </label>
        <label className="block text-[0.8125rem] font-medium text-ink">
          Year
          <select
            value={year}
            onChange={(event) => setYear(event.target.value as UserProfile["year"] | "")}
            className={`mt-1 ${selectClass}`}
          >
            <option value="">Pick one</option>
            {YEARS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[0.8125rem] font-medium text-ink">
          How did you find us?
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as UserProfile["source"] | "")}
            className={`mt-1 ${selectClass}`}
          >
            <option value="">Pick one</option>
            {SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void submit(true)}>
            Skip
          </Button>
          {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
        </div>
      </form>
    </section>
  );
}
