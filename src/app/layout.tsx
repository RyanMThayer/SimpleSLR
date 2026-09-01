import type { Metadata } from "next";
// IBM Plex, self hosted through @fontsource so the CSP stays closed:
// Sans is the UI face, Serif carries headings and paper titles, Mono
// carries stats, hotkeys, and identifiers.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-serif/400.css";
import "@fontsource/ibm-plex-serif/400-italic.css";
import "@fontsource/ibm-plex-serif/500.css";
import "@fontsource/ibm-plex-serif/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SimpleSLR",
  description:
    "Collaborative systematic literature reviews: PRISMA screening, snowballing, and the Webster and Watson concept matrix.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        {/* Applies the stored theme (or the OS preference) before first
            paint, so there is no light flash when dark is chosen; also
            lifts dark mode while printing so paper output is always
            light, restoring it afterward. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var c=document.documentElement.classList;var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);c.toggle("dark",d);window.addEventListener("beforeprint",function(){if(c.contains("dark")){c.add("print-was-dark");c.remove("dark");}});window.addEventListener("afterprint",function(){if(c.contains("print-was-dark")){c.add("dark");c.remove("print-was-dark");}});}catch(e){}})();',
          }}
        />
        {children}
      </body>
    </html>
  );
}
