/**
 * The clickwrap line.
 *
 * "Using the app means you accept the Terms" buried on the Terms page is
 * browsewrap, and courts routinely refuse to enforce a liability cap or a
 * refund window on it. What holds up is notice IMMEDIATELY ADJACENT to the
 * action that constitutes agreement, with the Terms one click away. So this
 * sits directly under every button that signs someone in or takes their
 * money, and nowhere else -- it is a legal instrument, not decoration.
 *
 * `action` is the verb on the button it sits under, so the sentence reads as
 * one thought: "By signing in, you agree…" / "By paying, you agree…".
 */
export function ConsentNotice({
  action = "continuing",
  className,
}: {
  action?: string;
  className?: string;
}) {
  return (
    <p className={`text-[0.75rem] leading-snug text-muted ${className ?? ""}`}>
      By {action}, you agree to the{" "}
      <a href="/terms" className="underline decoration-line-strong underline-offset-2 hover:text-ink">
        Terms of Service
      </a>{" "}
      and{" "}
      <a href="/privacy" className="underline decoration-line-strong underline-offset-2 hover:text-ink">
        Privacy Policy
      </a>
      .
    </p>
  );
}
