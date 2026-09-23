import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms for using Syllabus Center: what it does, what it does not promise, and what you are responsible for.",
};

const CONTACT = "jaappaz7@gmail.com";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="September 22, 2026">
      <p>
        These terms cover your use of Syllabus Center (&ldquo;the app&rdquo;),
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

      <h2>Your account and acceptable use</h2>
      <p>
        You must be at least 13 years old to use the app, and old enough to enter
        a contract where you live. You are responsible for what happens under
        your account and for keeping your calendar feed link private — anyone
        holding that URL can read your schedule.
      </p>
      <p>
        Syllabi are typically the work of your instructor or institution. You are
        responsible for having the right to upload the documents you upload.
      </p>
      <p>Do not:</p>
      <ul>
        <li>Break the law, or infringe anyone&rsquo;s copyright or privacy.</li>
        <li>
          Upload anything you do not have the right to upload, or anything
          containing another person&rsquo;s personal information.
        </li>
        <li>
          Attack, overload, or probe the service; bypass its rate limits; or run
          automated clients against it beyond ordinary personal use.
        </li>
        <li>
          Resell, sublicense, or provide the hosted service to others as if it
          were your own. (The <em>code</em> is open source and you may run your
          own copy — see below. This clause is about this deployment.)
        </li>
        <li>
          Share one account between multiple people, or use the app to evade the
          free-course limit through multiple accounts.
        </li>
      </ul>
      <p>
        Accounts that do these things may be suspended or terminated, and abuse
        that costs money (for example, driving up AI usage) may be billed or
        referred.
      </p>

      <h2>Your content</h2>
      <p>
        What you upload stays yours. The app is granted only the permission it
        needs to run the service for you: to process your syllabi, build your
        plan, and write to the calendar and Notion accounts you connect. Nothing
        you upload is sold, published, or used to train any model.
      </p>

      <h2>Payments, the Term Pass, and refunds</h2>
      <p>
        The app is free to use for one course per academic term. The{" "}
        <strong>Academic Term Pass</strong> is a <strong>one-time payment</strong>{" "}
        that removes that limit for a single term. It is <strong>not a
        subscription</strong>: nothing recurs, nothing auto-renews, and there is
        nothing to cancel. A pass covers the term you bought it for and stays
        valid until fourteen days after that term&rsquo;s end date. A later term
        is a separate purchase.
      </p>
      <p>
        Payment is processed by <strong>Stripe</strong>. Your card number never
        reaches this app&rsquo;s servers and is never stored by it. The price you
        are shown before you pay is the price you are charged, in US dollars, and
        any tax is shown at checkout. Access is unlocked when Stripe confirms the
        payment, which is usually immediate.
      </p>
      <p>
        <strong>Refunds.</strong> If a pass is not what you expected, email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> within{" "}
        <strong>fourteen days</strong> of the purchase and it will be refunded in
        full, no reason required. After fourteen days, refunds are at the
        operator&rsquo;s discretion &mdash; but if the app failed at what you paid
        for, ask anyway. Refunds go back to the original payment method and
        typically take five to ten business days to appear. A refunded pass ends
        the premium access it granted; your courses, plan and data are untouched.
      </p>
      <p>
        <strong>Pricing changes and experiments.</strong> The price may change
        over time, and different visitors may be shown different prices while
        pricing is being tested. Whatever price is displayed to you on the
        checkout screen is the price you will be charged, and a change never
        affects a pass you have already bought. Promotional codes and discounts
        are offered at the operator&rsquo;s discretion and may be withdrawn.
      </p>
      <p>
        If a payment is reversed through a chargeback rather than a refund
        request, the associated access may be suspended.
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
        The app is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo;
        without warranties of any kind, express or implied, including any implied
        warranty of merchantability, fitness for a particular purpose, or
        non-infringement. The operator does not warrant that the app will be
        uninterrupted, error-free, or that anything it extracts from a syllabus
        will be accurate.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent the law allows, the operator is not liable for any
        indirect, incidental, special, consequential, exemplary or punitive
        damages, or for lost profits, lost data, or{" "}
        <strong>academic consequences of any kind</strong> — including a missed
        deadline, a missed exam, a lower grade, or a failed course — arising from
        your use of or inability to use the app.
      </p>
      <p>
        The operator&rsquo;s total liability for all claims relating to the app is
        limited to the <strong>greater of fifty US dollars ($50) or the total
        amount you paid for the app in the twelve months before the claim
        arose</strong>.
      </p>
      <p>
        Nothing in these terms excludes liability that cannot be excluded by law
        — including liability for fraud, for gross negligence or willful
        misconduct, or for death or personal injury caused by negligence. Some
        jurisdictions do not allow certain exclusions, so parts of this section
        may not apply to you.
      </p>

      <h2>Indemnification</h2>
      <p>
        You agree to indemnify the operator against claims, damages and
        reasonable costs arising from your breach of these terms, from content
        you uploaded that you did not have the right to upload, or from your
        misuse of the app. This does not apply to claims caused by the
        operator&rsquo;s own conduct.
      </p>

      <h2>Ending it</h2>
      <p>
        You can delete your account at any time from the Account panel; deletion
        is immediate and permanent. The operator may suspend or terminate an
        account that breaches these terms, and may discontinue the service with
        reasonable notice. If the service is discontinued, any unexpired Term
        Pass will be refunded on a pro-rata basis. The sections on payments,
        liability, indemnification and governing law survive termination.
      </p>

      <h2>Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of the{" "}
        <strong>State of New York</strong>, without regard to its conflict-of-law
        rules. Any dispute that cannot be settled informally will be brought
        exclusively in the state or federal courts located in New York, and both
        sides consent to the jurisdiction of those courts.
      </p>
      <p>
        <strong>Try email first.</strong> Before filing anything, contact{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and give it thirty days. Most
        problems with a five-dollar app are a misunderstanding and a refund.
      </p>
      <p>
        Either side may bring an individual claim in small-claims court instead.
        Nothing here waives any right you have under the consumer-protection law
        of the place you live, and if you are a consumer in the EU, the UK, or
        another jurisdiction whose law gives you the right to sue where you live,
        this section does not take that away.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        These terms may change. The date at the top changes when they do, and a
        change that materially affects your rights will be announced in the app
        before it takes effect. Continuing to use the app after that means you
        accept the new terms; if you do not, delete your account. A change never
        alters the terms of a Term Pass you have already bought.
      </p>

      <h2>The software itself</h2>
      <p>
        Syllabus Center is open source under the GNU Affero General Public License
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
