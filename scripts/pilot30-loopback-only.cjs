const net = require("node:net");

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...input) {
  const args = Array.isArray(input[0]) ? input[0] : input;
  const first = args[0];
  if (typeof first === "string" && first.startsWith("\\\\.\\pipe\\")) {
    return originalConnect.apply(this, input);
  }
  const host = first !== null && typeof first === "object"
    ? first.host ?? first.hostname ?? "localhost"
    : typeof args[1] === "string" ? args[1] : "localhost";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("P30_NON_LOOPBACK_CONNECTION_BLOCKED");
  }
  return originalConnect.apply(this, input);
};
