import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer, ServerOptions } from "node:https";

export declare const clientSourceHeader: "x-app-planet-client-source";
export declare const sourceProofHeader: "x-app-planet-source-proof";
export declare function normalizeLoopbackSource(address: string | undefined): string | null;
export declare function buildForwardHeaders(
  rawHeaders: readonly string[],
  source: string,
  proof: string,
  options?: { readonly upgrade?: boolean },
): string[];
export declare function createTrustedSourceProxy(options: {
  readonly upstream: { readonly origin: string; readonly pinnedCertificatePem?: string };
  readonly proof: string;
  readonly tlsOptions?: ServerOptions;
}): HttpServer | HttpsServer;
