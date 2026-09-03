import { ImageResponse } from "next/og";

/**
 * iOS home-screen / Safari pinned icon: the product mark (notebook + rising
 * workload bars) on a solid pine tile. Same geometry as `icon.svg`, drawn with
 * flex boxes because Satori only supports a subset of SVG.
 *
 * iOS applies its own rounded mask, so the tile is deliberately full-bleed.
 */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#1e5f4e",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 16,
          }}
        >
          {/* Notebook */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 13,
              width: 68,
              height: 113,
              paddingTop: 24,
              paddingLeft: 13,
              borderRadius: 15,
              backgroundColor: "#faf8f3",
            }}
          >
            {/* Three ruled lines, same rhythm as the `Logo` component. */}
            {[42, 42, 27].map((width, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  width,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: "#1e5f4e",
                  opacity: 0.72,
                }}
              />
            ))}
          </div>

          {/* Workload bars */}
          <div
            style={{
              display: "flex",
              width: 20,
              height: 45,
              borderRadius: 8,
              backgroundColor: "#6cc9aa",
            }}
          />
          <div
            style={{
              display: "flex",
              width: 20,
              height: 79,
              borderRadius: 8,
              backgroundColor: "#dda94f",
            }}
          />
        </div>
      </div>
    ),
    size,
  );
}
