import type { Metadata } from "next";
import LegalPage, { LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy policy · SimpleSLR",
  description: "How SimpleSLR handles personal data.",
};

/**
 * GDPR privacy policy. Kept deliberately accurate to how the app
 * actually works: essential cookies only, no analytics, API keys in
 * the browser, AI calls relayed and never stored. Update this page
 * whenever data handling changes.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="August 31, 2026">
      <LegalSection heading="Who is responsible">
        <p>
          SimpleSLR (simpleslr.de) is operated by Ryan Thayer,
          Goethestraße 5, 56218 Mülheim-Kärlich, Germany (the
          controller under the EU General Data Protection Regulation,
          GDPR). You can reach us at{" "}
          <a className="underline underline-offset-2" href="mailto:support@simpleslr.de">
            support@simpleslr.de
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="What we process, and why">
        <p>
          Account data: your email address and an optional display name,
          used to sign you in, to show who did what inside a review
          team, and to let teammates invite you by address. Legal basis:
          performance of a contract, Art. 6(1)(b) GDPR.
        </p>
        <p>
          Review content: the projects you create and everything in
          them, including imported bibliographic records (which contain
          the names of authors of published works), screening decisions,
          notes, excerpts, concept tags, and full text PDFs you upload.
          This content is visible to the members of that project and to
          nobody else. Legal basis: performance of a contract, Art.
          6(1)(b) GDPR; for bibliographic author names, our legitimate
          interest in supporting scholarly literature review, Art.
          6(1)(f) GDPR.
        </p>
        <p>
          Invitations: when a project owner invites someone by email, we
          store that address and send one invitation message. Legal
          basis: legitimate interest in enabling collaboration, Art.
          6(1)(f) GDPR.
        </p>
        <p>
          Support: whatever you choose to send to our support address,
          used only to answer you. Legal basis: legitimate interest,
          Art. 6(1)(f) GDPR.
        </p>
        <p>
          Technical logs: our hosting providers process IP addresses and
          request metadata for a short time to deliver the site and keep
          it secure. Legal basis: legitimate interest, Art. 6(1)(f)
          GDPR.
        </p>
      </LegalSection>

      <LegalSection heading="AI features and your API key">
        <p>
          The AI prescreen and the reading room concept pass are
          optional and only run when you start them with your own
          Anthropic or OpenAI API key. Your key is saved only in your
          own browser, travels with each request, and is relayed
          straight to the provider. It is never stored or logged on our
          server. When you run these features, the text of the records
          involved (titles, abstracts, and extracts of uploaded PDFs) is
          sent to the provider you chose, under that provider&apos;s
          terms.
        </p>
        <p>
          The AI features make suggestions about papers, not decisions
          about people. Every AI mark is visible, auditable, and
          reversible by the review team, and no automated decision
          within the meaning of Art. 22 GDPR is made about you.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies and local storage">
        <p>
          We set only the cookies that are strictly necessary for
          signing in, all first party: the Supabase session cookie
          (named sb-…-auth-token, sometimes split into numbered parts),
          which keeps you signed in and is refreshed while you use the
          service, and a short-lived sb-…-code-verifier cookie that
          exists only during a sign in and secures the exchange. There
          are no analytics, no tracking, no advertising, and no third
          party cookies, which is why we do not show a cookie banner.
        </p>
        <p>
          Your browser&apos;s local storage holds your interface theme,
          your AI API keys if you save them, your screening view
          preference, and AI cost calibration figures. None of this is
          transmitted to us; keys travel only to the AI provider you
          chose, per request.
        </p>
        <p>
          The optional Google sign in loads Google&apos;s sign in
          script only after you click the Google button; merely opening
          the login page contacts no third party. From that click on,
          Google processes the sign in under its own privacy policy.
        </p>
      </LegalSection>

      <LegalSection heading="Who helps us run the service">
        <p>
          We use a small set of processors: Vercel (web hosting),
          Supabase (database, authentication, and file storage), Resend
          (transactional email such as confirmation and invitation
          messages), and ImprovMX (forwarding of mail sent to our
          support address). If you choose to sign in with Google, Google
          processes that sign in under its own terms. If you run AI
          features, Anthropic or OpenAI receives the record text as
          described above. These providers act as processors bound by
          data processing agreements. Where processing happens outside
          the EU or EEA, it is safeguarded by EU standard contractual
          clauses or an adequacy decision such as the EU-US Data
          Privacy Framework, as applicable.
        </p>
        <p>
          SimpleSLR is a tool for academic research and is not directed
          at children.
        </p>
      </LegalSection>

      <LegalSection heading="How long we keep data">
        <p>
          Your account data is kept until you delete your account.
          Review content is kept until the project is deleted by an
          owner, or until it is removed through account deletion as
          described below. Provider logs are short lived and governed by
          the providers&apos; retention schedules.
        </p>
      </LegalSection>

      <LegalSection heading="Deleting your account">
        <p>
          You can delete your account at any time from the dashboard.
          Reviews in which you are the only member are erased
          permanently, including uploaded PDFs. In team reviews your
          membership is removed and your name and email are erased, and
          your screening contributions remain attributed to an anonymous
          &quot;Deleted user&quot; so the team&apos;s scientific audit
          trail stays intact. If you are the only owner of a team
          review, you are asked to hand ownership to a teammate or
          delete that review first.
        </p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          Under the GDPR you have the right to access, rectification,
          erasure, restriction of processing, data portability, and
          objection to processing based on legitimate interests. The
          Report and Synthesize pages let you export your review data as
          CSV files at any time. You also have the right to lodge a
          complaint with a data protection supervisory authority. To
          exercise any right, write to{" "}
          <a className="underline underline-offset-2" href="mailto:support@simpleslr.de">
            support@simpleslr.de
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          If we change how the service handles data, we will update this
          page and its date. Substantial changes will be announced in
          the app.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
