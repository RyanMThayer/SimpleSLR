import type { Metadata } from "next";
import LegalPage, { LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of service · SimpleSLR",
  description: "The terms for using SimpleSLR.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="August 31, 2026">
      <LegalSection heading="What SimpleSLR is">
        <p>
          SimpleSLR is a free tool for conducting systematic literature
          reviews: PRISMA screening, snowballing, and concept centric
          synthesis, alone or with a team. It is provided by the
          operator named in the{" "}
          <a className="underline underline-offset-2" href="/imprint">
            imprint
          </a>
          . By creating an account you agree to these terms.
        </p>
      </LegalSection>

      <LegalSection heading="Your account">
        <p>
          Keep your sign in credentials to yourself and give us a
          working email address. You are responsible for what happens
          through your account. You can delete your account at any time
          from the dashboard.
        </p>
      </LegalSection>

      <LegalSection heading="Your content">
        <p>
          Your reviews belong to you. You grant us the technical rights
          needed to host, store, back up, and display your content to
          you and your project team, and nothing more. We never sell or
          share your content.
        </p>
        <p>
          Upload full text PDFs only if you have the right to do so, for
          example through your institution&apos;s subscriptions or open
          access licensing. Uploaded PDFs are stored privately and are
          accessible only to members of the project they belong to. You
          are responsible for the lawfulness of what you upload.
        </p>
      </LegalSection>

      <LegalSection heading="Teams">
        <p>
          Joining a project shares your contributions with that
          project&apos;s members. Owners manage a project&apos;s
          settings, criteria, team, and deletion; members screen, read,
          code, and snowball. Deleting a project permanently removes its
          content, including uploaded PDFs, for everyone.
        </p>
      </LegalSection>

      <LegalSection heading="AI features">
        <p>
          The AI features run only when you start them, with your own
          API key from Anthropic or OpenAI. Your relationship with the
          provider, including costs incurred by your key, is between you
          and the provider. AI output is methodical assistance, not
          scholarly judgment: verify AI supported decisions, and treat
          them as your own responsibility in your research. We prescribe
          the screening methodology to keep runs defensible, but we do
          not guarantee the accuracy of AI output.
        </p>
      </LegalSection>

      <LegalSection heading="Fair use">
        <p>
          Do not use SimpleSLR for unlawful content, do not attempt to
          access other teams&apos; data, and do not overload or abuse
          the infrastructure. We may suspend accounts that violate these
          terms.
        </p>
      </LegalSection>

      <LegalSection heading="Free service, no warranty">
        <p>
          SimpleSLR is free and provided as is. We work to keep it
          reliable, but we do not warrant uninterrupted availability and
          we may change or discontinue features. Export your review data
          regularly through the Report and Synthesize pages.
        </p>
        <p>
          We are liable without limit for intent, gross negligence, and
          injury to life, body, or health. For slight negligence we are
          liable only for breaches of essential contractual obligations,
          limited to the foreseeable damage typical of this kind of
          free service. Mandatory statutory liability remains
          unaffected.
        </p>
      </LegalSection>

      <LegalSection heading="Governing law">
        <p>
          German law applies. If you are a consumer, the mandatory
          consumer protections of your country of residence remain
          unaffected. We are neither willing nor obliged to participate
          in dispute resolution proceedings before a consumer
          arbitration board.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these terms:{" "}
          <a className="underline underline-offset-2" href="mailto:support@simpleslr.de">
            support@simpleslr.de
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
