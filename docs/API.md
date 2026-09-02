# API contract

Every route returns `ApiResult<T>` from `src/lib/types.ts`:
`{ ok: true, data: T }` or `{ ok: false, error: string, detail?: string }`.
Non-2xx responses still use this shape.

| Route | Method | Body / Query | `data` on success |
|---|---|---|---|
| `/api/auth/google` | GET | — | redirect to Google consent (not JSON) |
| `/api/auth/callback` | GET | `code`, `state` | redirect to `/dashboard` (not JSON) |
| `/api/auth/logout` | POST | — | `{ ok: true }` |
| `/api/me` | GET | — | `User \| null` |
| `/api/me/timezone` | POST | `{ timezone: string }` (IANA zone) | `User` |
| `/api/me` | DELETE | `{ confirm: "DELETE"; removeGoogleCalendar?: boolean }` | `{ deleted: true; googleCalendarRemoved: boolean }` — erases the account and every course, assessment, link and connection; clears the session. Notion pages are never touched. **400** unless `confirm` is exactly `"DELETE"`; **403** for the shared demo account. |
| `/api/health` | GET | — | `{ status; version; commit; uptimeSeconds; time; capabilities; storage; warnings }` |
| `/api/upload` | POST | `multipart/form-data`, field `file` (PDF) | `{ courseId: string; course: Course; assessments: Assessment[]; warnings: string[] }` |
| `/api/courses` | GET | — | `{ courses: Course[]; assessments: Assessment[] }` |
| `/api/courses/[id]` | DELETE | — | `{ deleted: true }` |
| `/api/plan` | GET | — | `SemesterPlan` |
| `/api/sync` | POST | `{ courseId?: string }` | `CalendarSyncResult` |
| `/api/chat` | POST | `{ message: string; history?: {role,content}[] }` | `{ reply: string }` |
| `/api/notion/auth` | GET | — | redirect to Notion consent (not JSON) |
| `/api/notion/callback` | GET | `code`, `state` | redirect to `/dashboard?notion=connected` (not JSON) |
| `/api/notion/status` | GET | — | `NotionStatus` (below) |
| `/api/notion/parent` | POST | `{ pageId: string }` | `NotionStatus` — builds the hub under that page |
| `/api/notion/sync` | POST | `{ courseId?: string }` | `NotionSyncResult & { dryRun: boolean }` |
| `/api/notion/disconnect` | POST | — | `{ disconnected: true }` |

`POST /api/upload` additionally returns `notion: { pageUrl: string | null; hubUrl: string | null; error: string | null } | null`
— `null` when Notion is not connected; `error` set (and `pageUrl` null) when the
upload succeeded but the Notion page could not be created. Notion failing never
fails the upload.

```ts
interface NotionStatus {
  configured: boolean;            // NOTION_CLIENT_ID + SECRET present on the server
  connected: boolean;             // a connection record exists and is not revoked
  status: "connected" | "needs_parent" | "revoked" | null;
  workspaceName: string | null;
  hubUrl: string | null;          // the "Syllabus AI" hub page, once built
  needsParent: boolean;           // true => show the picker below
  candidates: { id: string; title: string; url: string }[];   // pages the user shared
  coursePages: Record<string, string>;   // courseId -> Notion page URL
}
```

## Rate limits

`/api/upload`, `/api/chat` and `/api/sync` are rate limited per user. A denied
request returns **429** with the standard envelope and a `Retry-After` header.
Limits are in-memory, so they reset on a serverless cold start -- they raise the
cost of casual abuse and are not a security boundary.

## Demo mode

When `OPENAI_API_KEY` / Google credentials are absent the app runs in **demo
mode**: `/api/me` returns a seeded demo user, upload uses the deterministic
fixture parser, and `/api/sync` reports what *would* be created without calling
Google. `GET /api/config` returns `{ demoMode: boolean; googleReady: boolean; openaiReady: boolean }`
so the UI can show an honest banner.
