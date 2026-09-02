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
| `/api/health` | GET | — | `{ status; version; commit; uptimeSeconds; time; capabilities; storage; warnings }` |
| `/api/upload` | POST | `multipart/form-data`, field `file` (PDF) | `{ courseId: string; course: Course; assessments: Assessment[]; warnings: string[] }` |
| `/api/courses` | GET | — | `{ courses: Course[]; assessments: Assessment[] }` |
| `/api/courses/[id]` | DELETE | — | `{ deleted: true }` |
| `/api/plan` | GET | — | `SemesterPlan` |
| `/api/sync` | POST | `{ courseId?: string }` | `CalendarSyncResult` |
| `/api/chat` | POST | `{ message: string; history?: {role,content}[] }` | `{ reply: string }` |

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
