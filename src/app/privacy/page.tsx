import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What Syllabus Center collects, what it sends to Google, OpenAI and Notion, how long it keeps anything, and how to delete all of it.",
};

const CONTACT = "jaappaz7@gmail.com";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="September 22, 2026">
      <p>
        Syllabus Center (&ldquo;the app&rdquo;), operated at syllabuscenter.com, turns
        syllabus PDFs into a semester plan and puts it on your calendar. This
        policy describes exactly what it collects, who it sends data to, and how
        to get rid of all of it. It is written to be read, not to be survived.
      </p>

      <h2>What the app stores</h2>
      <ul>
        <li>
          <strong>Your Google profile</strong> — your Google account id, email
          address, name, and profile picture URL, received when you sign in.
          These identify your account.
        </li>
        <li>
          <strong>A Google refresh token</strong>, only if you grant calendar
          access. It is what lets the app write to your calendar later without
          asking you to sign in again. It is stored server-side, never sent to
          your browser, and never logged.
        </li>
        <li>
          <strong>What was extracted from your syllabi</strong> — course names,
          instructors, meeting times, assignments, exams, due dates, grading
          weights, and the policy excerpts the extractor quoted.
        </li>
        <li>
          <strong>Your settings</strong> — timezone (reported by your browser so
          calendar events land at the right local time), which categories you
          chose to sync, and the section you selected for a multi-section course.
        </li>
        <li>
          <strong>Identifiers for what it created</strong> — the ids of the
          Google Calendar events and Notion pages the app made, so a re-sync
          updates them instead of creating duplicates.
        </li>
        <li>
          <strong>A calendar feed token</strong>, if you create a subscription
          link. See below.
        </li>
      </ul>

      <h2>What the app does not store</h2>
      <p>
        <strong>The syllabus files themselves.</strong> An uploaded PDF is read
        in memory, its text extracted, and the file discarded. It is never
        written to disk or to a database.
      </p>
      <p>
        The app also does not store Google access tokens (only the refresh
        token), does not read any Google Calendar other than the one it created,
        and does not read your email or files.
      </p>
      <p>
        There are <strong>no advertising cookies and no cross-site trackers</strong>{" "}
        here: no ad network, data broker or social network is allowed to follow
        you from this site. The app does set two first-party cookies — the signed
        session cookie that keeps you logged in, and an analytics cookie
        described under <strong>Analytics and cookies</strong> below.
      </p>

      <h2>Google user data</h2>
      <p>
        Signing in requests four OAuth scopes: <code>openid</code>,{" "}
        <code>email</code>, and <code>profile</code> to identify you, and{" "}
        <code>https://www.googleapis.com/auth/calendar</code> to manage your
        calendar.
      </p>
      <p>
        The calendar scope is used for one purpose: creating and maintaining a
        dedicated secondary calendar named &ldquo;Syllabus Center&rdquo; in your
        account, and the deadlines, study sessions and class meetings inside it.
        The app writes only to that calendar. It never modifies your primary
        calendar or any other calendar, and it never deletes a calendar unless
        you explicitly ask it to while deleting your account.
      </p>
      <p>
        <strong>
          Syllabus Center&rsquo;s use and transfer of information received from
          Google APIs to any other app will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer noopener"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </strong>{" "}
        Google user data is never sold, never used for advertising, and never
        used to train any model.
      </p>

      <h2>Who else sees your data</h2>
      <ul>
        <li>
          <strong>OpenAI</strong> — the text of an uploaded syllabus is sent to
          OpenAI&rsquo;s API to be turned into structured courses and deadlines.
          Questions you type into the chat are sent along with your extracted
          plan (course names, dates, weights) so the answer can be specific. Your
          Google profile, tokens, and email address are not sent.
        </li>
        <li>
          <strong>Google</strong> — the events the app creates on your behalf, as
          described above.
        </li>
        <li>
          <strong>Notion</strong> — only if you connect it. The app then creates
          pages and databases in the Notion page you select, containing your
          course information and deadlines.
        </li>
        <li>
          <strong>Stripe</strong> — only if you buy a Term Pass. Stripe collects
          and holds your payment details directly; the app never sees or stores a
          card number. It keeps only Stripe&rsquo;s own identifiers for the
          purchase, so it knows which term you paid for.
        </li>
        <li>
          <strong>PostHog</strong> — product-analytics events, described under{" "}
          <strong>Analytics and cookies</strong> below. No syllabus content and no
          Google data.
        </li>
        <li>
          <strong>Hosting</strong> — the app runs on Railway, which stores its
          data on that infrastructure.
        </li>
      </ul>
      <p>
        No one else. Your data is not sold, rented, or shared with advertisers,
        data brokers, or your school.
      </p>

      <h2>The calendar feed link</h2>
      <p>
        If you create a subscription link for Apple Calendar or Outlook, it
        contains a long random token. Anyone who has that URL can read your
        schedule without signing in — that is what makes it work in a calendar
        app. Treat it like a password. You can reset it from the dashboard at any
        time, which immediately breaks the old link.
      </p>

      <h2>Analytics and cookies</h2>
      <p>
        To know whether the app is any good — whether people finish setting up,
        where they get stuck, whether they come back next week — it records a
        small set of <strong>product events</strong> through{" "}
        <a href="https://posthog.com/privacy" target="_blank" rel="noreferrer noopener">
          PostHog
        </a>
        , a product-analytics provider acting as a processor on the
        operator&rsquo;s instructions.
      </p>
      <p>What is sent to PostHog:</p>
      <ul>
        <li>
          <strong>Events</strong> — named actions like &ldquo;signed in,&rdquo;
          &ldquo;uploaded a syllabus,&rdquo; &ldquo;saw the paywall,&rdquo;
          &ldquo;started checkout,&rdquo; with counts and timings.
        </li>
        <li>
          <strong>A pseudonymous id</strong> for your account, so a funnel can
          tell one person from two. Your email address and name are{" "}
          <strong>not</strong> sent.
        </li>
        <li>
          <strong>Ordinary web context</strong> — page URL, referrer, browser and
          operating system, approximate country derived from your IP address, and
          which variant of an experiment you were shown.
        </li>
      </ul>
      <p>
        <strong>What is never sent:</strong> the contents of your syllabi, your
        course names, assignments, due dates or grades; anything received from
        Google; your Google or Notion tokens; your calendar feed token; your
        chat messages; or your email address. Google user data is never sent to
        PostHog or to any other analytics provider, in keeping with Google&rsquo;s
        Limited Use requirements above.
      </p>
      <p>
        <strong>Cookies.</strong> Two first-party cookies, no third-party ones:
        the session cookie (essential — the app cannot keep you logged in without
        it) and PostHog&rsquo;s analytics cookie, which holds a random id and
        nothing else. Neither is used for advertising. If your browser sends a{" "}
        <a
          href="https://globalprivacycontrol.org/"
          target="_blank"
          rel="noreferrer noopener"
        >
          Global Privacy Control
        </a>{" "}
        signal, or you enable Do Not Track, analytics is switched off for you
        automatically and the app keeps working normally.
      </p>

      <h2>Experiments</h2>
      <p>
        The app sometimes runs A/B tests — two versions of a screen, a different
        wording, or a different price — to work out which one serves people
        better. Which version you see is decided by a random id and is not based
        on anything personal about you. If you are shown a price, that is the
        price you will be charged; see the Terms for how pricing experiments work.
      </p>

      <h2>Your privacy rights</h2>
      <p>
        Wherever you live, you can see, export, correct or delete everything the
        app holds about you, yourself, from the Account panel — no request form
        and no waiting. Export gives you the whole record as JSON; delete is
        immediate and permanent.
      </p>
      <p>
        <strong>If the GDPR or UK GDPR applies to you</strong>, the lawful bases
        are: <em>performance of a contract</em> for your account, your syllabi and
        the plan built from them (there is no service without them);{" "}
        <em>consent</em> for connecting Google Calendar or Notion, which you give
        on their own consent screens and can withdraw at any time; and{" "}
        <em>legitimate interests</em> for the product analytics above and for
        keeping the service secure and affordable — an interest balanced against
        your privacy by sending no syllabus content and no directly identifying
        information. You have the rights of access, rectification, erasure,
        restriction, portability, and objection (including objection to
        processing based on legitimate interests), and the right to complain to
        your local supervisory authority.
      </p>
      <p>
        <strong>If you are in California</strong>, the CCPA/CPRA gives you rights
        to know, delete, correct, and opt out of sale or sharing. The app{" "}
        <strong>does not sell or share personal information</strong>, has never
        done so, and does not use it for cross-context behavioural advertising —
        so there is nothing to opt out of. Exercising any of these rights will
        never get you worse service.
      </p>
      <p>
        <strong>If you are a student</strong>, note that this is a service you
        signed up for personally. It is not operated by your school, it is not a
        school official under FERPA, and your institution has no access to your
        account.
      </p>
      <p>
        To exercise anything the Account panel does not cover, email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. Requests are answered within
        thirty days.
      </p>

      <h2>Where data is processed</h2>
      <p>
        The app, its database, and its processors (OpenAI, Google, Notion,
        Stripe, PostHog, and the hosting provider) are based in or process data
        in the <strong>United States</strong>. If you use the app from outside the
        US, your data is transferred there. For transfers out of the EEA or UK,
        the processors rely on the European Commission&rsquo;s Standard
        Contractual Clauses.
      </p>

      <h2>Deleting your data</h2>
      <p>
        The dashboard has an Account panel with a <strong>Delete account</strong>{" "}
        action. It removes your account, courses, extracted deadlines, plan,
        settings, and the links to anything the app created — immediately and
        permanently. There is no soft delete and no recovery.
      </p>
      <p>
        Two deliberate exceptions: the app <strong>never</strong> deletes pages in
        your Notion workspace, because those are your notes; and it removes the
        &ldquo;Syllabus Center&rdquo; Google calendar only if you tick that box while
        deleting. You can also download everything the app holds about you as
        JSON from the same panel, or disconnect Google or Notion individually
        without deleting your account. Revoking access from{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer noopener"
        >
          your Google account permissions
        </a>{" "}
        also stops all calendar access at once.
      </p>

      <h2>Retention</h2>
      <p>
        Data is kept until you delete it. There is no fixed expiry — a semester
        plan is meant to last a semester. If the service is shut down, accounts
        and their data are deleted.
      </p>

      <h2>Security</h2>
      <p>
        Traffic is served over HTTPS. Session cookies are signed, HTTP-only, and
        rejected if tampered with. Tokens are stored server-side and are stripped
        from application logs. Every request is scoped to the signed-in account,
        so one user cannot read or modify another&rsquo;s data. No system is
        perfect, and this one is maintained by one person — if you find a
        problem, please report it to the address below.
      </p>
      <p>
        <strong>If there is a breach</strong> affecting your personal
        information, you will be notified by email without undue delay, along
        with what happened, what was exposed, and what to do about it. Regulators
        will be notified where the law requires it.
      </p>

      <h2>Children</h2>
      <p>
        The app is intended for college and graduate students and is not directed
        at children under 13.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that affects what is collected or who it
        is shared with, the date at the top will change and the change will be
        noted in the project&rsquo;s public repository.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, deletion requests, or security reports:{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
