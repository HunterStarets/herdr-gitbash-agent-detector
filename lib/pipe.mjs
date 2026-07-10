// Raw named-pipe client for Herdr's persistent events.subscribe stream.
// Herdr's Windows accept loop races the previous connection's teardown on
// the FIRST write of a fresh connection - proven empirically (see spike
// session). Retrying with a fresh connection each time reliably gets past
// it. Once subscribed (ack received), the connection is stable indefinitely.
import net from "node:net";

function pipePath() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH not set");
  return `\\\\.\\pipe\\${socketPath}`;
}

export function subscribeWithRetry(subscriptions, { maxAttempts = 60, backoffMs = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const path = pipePath();
    let attempt = 0;

    function tryOnce() {
      attempt++;
      const client = net.createConnection(path);
      let settled = false;
      let buf = "";

      const fail = () => {
        if (settled) return;
        client.destroy();
        if (attempt >= maxAttempts) {
          settled = true;
          reject(new Error(`subscribeWithRetry: exhausted ${maxAttempts} attempts`));
        } else {
          setTimeout(tryOnce, backoffMs);
        }
      };

      client.on("connect", () => {
        client.write(
          JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n",
          (err) => { if (err) fail(); }
        );
      });
      client.on("data", (d) => {
        buf += d.toString();
        if (!settled && buf.includes("\n")) {
          settled = true;
          client.removeAllListeners("error");
          client.removeAllListeners("close");
          resolve(client);
        }
      });
      client.on("error", fail);
      client.on("close", fail);
    }
    tryOnce();
  });
}

// Line-delimited JSON event reader. Calls onEvent(parsedLine) per line.
export function pumpEvents(client, onEvent) {
  let buffer = "";
  client.on("data", (d) => {
    buffer += d.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
  });
}
