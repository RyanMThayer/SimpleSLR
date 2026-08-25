import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist must run un-bundled on the server: bundling breaks its
  // internal file resolution in serverless functions, which made page
  // text extraction (/api/aipass, /api/oapdf) silently return nothing
  // in production. Excluding it makes the runtime require it straight
  // from node_modules, which Vercel's file tracing includes.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
