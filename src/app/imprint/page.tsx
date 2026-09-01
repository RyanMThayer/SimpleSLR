import type { Metadata } from "next";
import LegalPage, { LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Imprint · SimpleSLR",
  description: "Legal notice (Impressum) for simpleslr.de.",
};

/**
 * Impressum, required for a German website by Sec. 5 DDG and Sec. 18
 * MStV. The bracketed placeholders must be replaced with the
 * operator's real details before launch; a P.O. box is not
 * sufficient, it must be a summonable address.
 */
export default function ImprintPage() {
  return (
    <LegalPage title="Imprint" updated="August 31, 2026">
      <LegalSection heading="Provider (Sec. 5 DDG)">
        <p>
          Ryan Thayer
          <br />
          Goethestraße 5
          <br />
          [POSTAL CODE AND CITY]
          <br />
          Germany
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Email:{" "}
          <a className="underline underline-offset-2" href="mailto:support@simpleslr.de">
            support@simpleslr.de
          </a>
        </p>
      </LegalSection>

      <LegalSection heading="Responsible for content (Sec. 18(2) MStV)">
        <p>
          Ryan Thayer, address as above.
        </p>
      </LegalSection>

      <LegalSection heading="Dispute resolution">
        <p>
          We are neither willing nor obliged to participate in dispute
          resolution proceedings before a consumer arbitration board.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
