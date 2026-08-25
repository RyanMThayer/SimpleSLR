import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
