import type { NextConfig } from "next";

// Content Security Policy. The directive doing the heaviest lifting is
// connect-src: browser code can only talk to this site and our Supabase
// project, so even if malicious script ever ran (XSS, bad dependency),
// fetch/XHR to an attacker's server is blocked, which is the usual way
// a stolen AI API key would leave the page. Inline scripts stay allowed
// because the theme boot script and Next's own hydration payload are
// inline; nonce-based CSP would need a proxy layer we don't otherwise
// want. 'wasm-unsafe-eval' is for pdf.js's WebAssembly image decoders.
// The accounts.google.com/gsi/ entries are Google Identity Services
// (the Sign in with Google button on the login page), exactly the
// sources Google's CSP guide prescribes and nothing broader.
const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "https://*.supabase.co";
  }
})();
const dev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace(
    "https://",
    "wss://"
  )} https://accounts.google.com/gsi/${dev ? " ws:" : ""}`,
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src https://accounts.google.com/gsi/",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
  // pdfjs-dist must run un-bundled on the server: bundling breaks its
  // internal file resolution in serverless functions, which made page
  // text extraction (/api/aipass, /api/oapdf) silently return nothing
  // in production. Excluding it makes the runtime require it straight
  // from node_modules, which Vercel's file tracing includes.
  serverExternalPackages: ["pdfjs-dist"],
  // pdf.js loads its worker via a computed dynamic import that file
  // tracing cannot see, so ship the whole legacy build with the two
  // routes that extract PDF text.
  outputFileTracingIncludes: {
    "/api/aipass": ["./node_modules/pdfjs-dist/legacy/build/**/*"],
    "/api/oapdf": ["./node_modules/pdfjs-dist/legacy/build/**/*"],
  },
};

export default nextConfig;
