"use client";

import { Component, type ReactNode } from "react";

import { reportError } from "@/lib/analytics-client";
import { ErrorState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";

interface Props {
  /** Matches the panel's heading, and labels the report. */
  title: string;
  /** Stable id for the section element, as `Panel` requires. */
  id: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken panel from taking the whole dashboard down.
 *
 * The dashboard renders ten panels side by side off one pile of parsed syllabus
 * data, and that data comes out of other people's PDFs -- so the shapes it can
 * take are not fully knowable in advance. Without a boundary, a single
 * `undefined.map` in the heatmap replaces the upload panel, the calendar sync
 * and the chat box with Next's error screen, and a student whose semester is
 * otherwise fine cannot reach any of it.
 *
 * Per panel rather than per page for exactly that reason. Next's own
 * `error.tsx` is per route SEGMENT, which on a single-page dashboard means the
 * whole thing; it is still worth having (see `src/app/error.tsx`) but it is the
 * outer net, not this one.
 *
 * A class, because `getDerivedStateFromError` and `componentDidCatch` have no
 * hook equivalent -- this is the one place React still requires one.
 *
 * NOT a substitute for the panels' own error states. A failed fetch is an
 * expected outcome and `ErrorState` already handles it inline with a retry;
 * this catches the unexpected kind, the ones that are bugs.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, {
      boundary: this.props.title,
      // The React tree at the point of failure, which is usually the thing that
      // identifies the bug -- a minified stack alone rarely does.
      componentStack: info.componentStack ?? undefined,
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Panel id={this.props.id} title={this.props.title}>
        <ErrorState
          error="This section ran into a problem."
          detail="The rest of your dashboard is fine. Try again, or reload the page."
          // Clears the boundary and re-renders the panel. A deterministic bug
          // will throw straight back, which is honest -- the button is for the
          // transient case, and the copy above names reloading for the other.
          onRetry={() => this.setState({ error: null })}
        />
      </Panel>
    );
  }
}
