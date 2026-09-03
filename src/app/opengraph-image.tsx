import { ImageResponse } from "next/og";

/**
 * The link-preview card (iMessage, Slack, X, LinkedIn, Discord).
 *
 * Same design language as the landing page: warm paper ground, ink type, the
 * pine mark, and the workload heatmap strip as the visual signature. Colors are
 * the literal hex values from `globals.css` — Satori cannot resolve CSS custom
 * properties, and the layout sticks to flexbox for the same reason.
 *
 * No font file is bundled in the repo and fetching one at build time would make
 * the build network-dependent, so the serif stack is declared for hosts that
 * have it and Satori's built-in face carries the rest.
 */

export const alt =
  "Syllabus AI — upload your syllabus. Let AI organize your semester in 60 seconds.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SERIF =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
const SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const INK = "#1b1a16";
const INK_SOFT = "#494640";
const MUTED = "#757066";
const PAPER = "#faf8f3";
const PINE = "#1e5f4e";
const MINT = "#6cc9aa";

/** The landing page's sample semester, scored by estimated hours. */
const WEEKS: { hours: number; intensity: 0 | 1 | 2 | 3 }[] = [
  { hours: 4, intensity: 0 },
  { hours: 7, intensity: 1 },
  { hours: 9, intensity: 1 },
  { hours: 14, intensity: 2 },
  { hours: 11, intensity: 1 },
  { hours: 21, intensity: 3 },
  { hours: 8, intensity: 1 },
  { hours: 5, intensity: 0 },
  { hours: 13, intensity: 2 },
  { hours: 16, intensity: 2 },
  { hours: 23, intensity: 3 },
  { hours: 10, intensity: 1 },
  { hours: 6, intensity: 0 },
  { hours: 12, intensity: 2 },
];

/** Workload ramp: 0 calm .. 3 crunch. */
const LOAD = ["#bfb9a6", "#8fb99c", "#dda94f", "#bd5540"];
const PEAK = 24;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: PAPER,
          fontFamily: SANS,
        }}
      >
        {/* Pine rule across the top — the one piece of brand color at the edge. */}
        <div
          style={{ display: "flex", width: "100%", height: 10, backgroundColor: PINE }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            padding: "54px 68px 56px 68px",
          }}
        >
          {/* ------------------------------------------------- Wordmark */}
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                gap: 4,
                width: 58,
                height: 58,
                paddingBottom: 12,
                borderRadius: 14,
                backgroundColor: PINE,
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: 20,
                  height: 34,
                  borderRadius: 5,
                  backgroundColor: PAPER,
                }}
              />
              <div
                style={{
                  display: "flex",
                  width: 6,
                  height: 14,
                  borderRadius: 3,
                  backgroundColor: MINT,
                }}
              />
              <div
                style={{
                  display: "flex",
                  width: 6,
                  height: 24,
                  borderRadius: 3,
                  backgroundColor: "#dda94f",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                fontFamily: SERIF,
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: INK,
              }}
            >
              Syllabus AI
            </div>
          </div>

          {/* ------------------------------------------------- Headline */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 44,
              fontFamily: SERIF,
              fontSize: 60,
              fontWeight: 600,
              lineHeight: 1.12,
              letterSpacing: "-0.025em",
              color: INK,
            }}
          >
            {/* Broken by hand, and pinned with nowrap, so the card always
                reads as exactly two large lines at thumbnail size. */}
            <div style={{ display: "flex", whiteSpace: "nowrap" }}>
              Upload your syllabus. Let AI organize
            </div>
            <div style={{ display: "flex", whiteSpace: "nowrap" }}>
              your semester in 60 seconds.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              marginTop: 24,
              maxWidth: 920,
              fontSize: 24,
              lineHeight: 1.45,
              color: INK_SOFT,
            }}
          >
            {"Upload your syllabi. AI builds your semester plan, syncs your calendar, and creates a living study system."}
          </div>

          {/* ------------------------------------------- Heatmap strip */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              marginTop: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                color: MUTED,
              }}
            >
              Workload forecast · 14 weeks
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
              {WEEKS.map((week, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    width: 28,
                    height: Math.round(22 + (week.hours / PEAK) * 84),
                    borderRadius: 8,
                    backgroundColor: LOAD[week.intensity],
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
