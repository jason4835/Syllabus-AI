import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms for using Syllabus AI: what it does, what it does not promise, and what you are responsible for.",
};

const CONTACT = "jaappaz7@gmail.com";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="September 9, 2026">
      <p>
        These terms cover your use of Syllabus AI (&ldquo;the app&rdquo;),
        operated at syllabuscenter.com. Using the app means you accept them.
      </p>

      <h2>What the app does</h2>
      <p>
        You upload syllabus PDFs. The app extracts courses, assignments, exams,
        due dates and grading weights, builds a semester plan with suggested
        study sessions, and — if you connect them — writes that plan to your
        Google Calendar and your Notion workspace.
      </p>

      <h2>The extraction is not authoritative</h2>
      <p>
        This is the important one. The app reads your syllabus with software,
        including an AI model. It will sometimes get a date, a time, a weight, or
        a room wrong, and it can miss items entirely. Low-confidence items are
        flagged for you to confirm, and every item can be edited.
      </p>
      <p>
        <strong>
          Your syllabus and your instructor are the source of truth, not this
          app.
        </strong>{" "}
        Check anything that matters before relying on it. The app is not
        responsible for a missed deadline, a missed exam, or a grade.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for what happens under your account and for keeping
        your calendar feed link private — anyone holding that URL can read your
        schedule. Do not use the app to break the law, to infringe copyright, to
        attack the service, or to upload anything you do not have the right to
        upload.
      </p>
      <p>
        Syllabi are typically the work of your instructor or institution. You are
        responsible for having the right to upload the documents you upload.
      </p>

      <h2>Your content</h2>
      <p>
        What you upload stays yours. The app is granted only the permission it
        needs to run the service for you: to process your syllabi, build your
        plan, and write to the calendar and Notion accounts you connect. Nothing
        you upload is sold, published, or used to train any model.
      </p>

      <h2>Third-party services</h2>
      <p>
        The app relies on OpenAI, Google, and (optionally) Notion. Their
        availability and their own terms apply to those parts. When one of them
        is down or changes, parts of the app may stop working.
      </p>

      <h2>Availability</h2>
      <p>
        This is a small project run by one person. There is no uptime guarantee,
        no support commitment, and no promise that it will still exist next
        semester. Features may change or be removed. Reasonable notice will be
        given before the service is shut down, and you can export your data at
        any time from the Account panel.
      </p>

      <h2>No warranty</h2>
      <p>
        The app is provided &ldquo;as is,&rdquo; without warranties of any kind,
        express or implied, including fitness for a particular purpose. To the
        maximum extent the law allows, the operator is not liable for indirect,
        incidental, or consequential damages arising from your use of the app,
        including academic consequences.
      </p>

      <h2>Ending it</h2>
      <p>
        You can delete your account at any time from the Account panel; deletion
        is immediate and permanent. Accounts that abuse the service may be
        suspended.
      </p>

      <h2>The software itself</h2>
      <p>
        Syllabus AI is open source under the GNU Affero General Public License
        v3.0. These terms cover the hosted service; the{" "}
        <a
          href="https://github.com/jason4835/Syllabus-AI"
          target="_blank"
          rel="noreferrer noopener"
        >
          license
        </a>{" "}
        covers the code.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
