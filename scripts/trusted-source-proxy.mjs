import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

// readiness §90：隔離本機測試專用的可信來源 proxy。只由 runner 建立、只聽 loopback；
// 剝除 caller 自帶的轉送／來源標頭，再以本輪 proof 注入實際 TCP 來源。不是正式部署元件。
export const clientSourceHeader = "x-app-planet-client-source";
export const sourceProofHeader = "x-app-planet-source-proof";

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const strippedExact = new Set(["forwarded", "x-real-ip", "true-client-ip", "cf-connecting-ip", "x-client-ip"]);

export function normalizeLoopbackSource(address) {
  if (typeof address !== "string") return null;
  const value = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(value) === 4 && value.startsWith("127.")) return value;
  if (value === "::1") return value;
  return null;
}

export function buildForwardHeaders(rawHeaders, source, proof, { upgrade = false } = {}) {
  const connectionTokens = new Set();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "connection") {
      for (const token of rawHeaders[index + 1].split(",")) connectionTokens.add(token.trim().toLowerCase());
    }
  }
  const headers = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (name.startsWith("x-forwarded-") || name.startsWith("x-app-planet-") || strippedExact.has(name)) continue;
    if (hopByHop.has(name) || connectionTokens.has(name)) {
      if (!(upgrade && (name === "upgrade" || name === "connection"))) continue;
    }
    headers.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  headers.push(clientSourceHeader, source, sourceProofHeader, proof);
  return headers;
}

// upstream TLS 以本機 Next 憑證 fingerprint 釘選；驗證完成前不送出任何請求資料。
function pinnedAgent(pinnedCertificatePem) {
  const expected = new X509Certificate(pinnedCertificatePem).fingerprint256;
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    let done = false;
    const finish = (error, socket) => {
      if (done) return;
      done = true;
      callback(error, socket);
    };
    const socket = tls.connect({ ...options, servername: "localhost", rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      if (socket.getPeerX509Certificate()?.fingerprint256 === expected) finish(null, socket);
      else {
        socket.destroy();
        finish(new Error("upstream_certificate_mismatch"));
      }
    });
    socket.once("error", (error) => finish(error));
    return undefined;
  };
  return agent;
}

export function createTrustedSourceProxy({ upstream, proof, tlsOptions }) {
  if (!/^[0-9a-f]{64}$/.test(proof)) throw new Error("proxy proof 格式不符。");
  const upstreamUrl = new URL(upstream.origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(upstreamUrl.hostname)) throw new Error("upstream 必須是 loopback。");
  const secureUpstream = upstreamUrl.protocol === "https:";
  if (secureUpstream && !upstream.pinnedCertificatePem) throw new Error("https upstream 必須釘選憑證。");
  const agent = secureUpstream ? pinnedAgent(upstream.pinnedCertificatePem) : new http.Agent({ keepAlive: false });
  const transport = secureUpstream ? https : http;
  const target = {
    hostname: upstreamUrl.hostname.replace(/^\[|\]$/g, ""),
    port: Number(upstreamUrl.port || (secureUpstream ? 443 : 80)),
  };

  const handler = (request, response) => {
    const source = normalizeLoopbackSource(request.socket.remoteAddress);
    if (source === null) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end("forbidden");
      return;
    }
    const outgoing = transport.request({
      ...target,
      agent,
      method: request.method,
      path: request.url,
      headers: buildForwardHeaders(request.rawHeaders, source, proof),
      setHost: false,
    }, (upstreamResponse) => {
      const headers = [];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        if (!hopByHop.has(upstreamResponse.rawHeaders[index].toLowerCase())) {
          headers.push(upstreamResponse.rawHeaders[index], upstreamResponse.rawHeaders[index + 1]);
        }
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      upstreamResponse.once("error", () => response.destroy());
    });
    outgoing.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("bad gateway");
      } else response.destroy();
    });
    request.once("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  };

  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  server.on("upgrade", (request, clientSocket, head) => {
    const source = normalizeLoopbackSource(request.socket.remoteAddress);
    if (source === null) {
      clientSocket.destroy();
      return;
    }
    const outgoing = transport.request({
      ...target,
      agent,
      method: request.method,
      path: request.url,
      headers: buildForwardHeaders(request.rawHeaders, source, proof, { upgrade: true }),
      setHost: false,
    });
    outgoing.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        lines.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
      }
      clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket).pipe(upstreamSocket);
      upstreamSocket.once("error", () => clientSocket.destroy());
      clientSocket.once("error", () => upstreamSocket.destroy());
    });
    outgoing.once("response", (upstreamResponse) => {
      upstreamResponse.resume();
      clientSocket.destroy();
    });
    outgoing.once("error", () => clientSocket.destroy());
    outgoing.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
