"use strict";

/**
 * Full integration test: start a small HTTP server,
 * call addSubscription with its URL, verify the result.
 */
const http = require("http");
const proxy = require("./server/proxy");

// 1) Start a test HTTP server that returns a fake subscription
const TEST_PORT = 19392;
const testBody = [
  "vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@1.2.3.4:443?security=tls&sni=example.com&fp=chrome&remark=Node1",
  "vless://ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj@5.6.7.8:8443?security=reality&pbk=xyz&sid=abc&sni=real.com&fp=firefox&remark=Node2",
].join("\n");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(Buffer.from(testBody).toString("base64"));
});

server.listen(TEST_PORT, "127.0.0.1", async () => {
  console.log("Test server started on", TEST_PORT);

  try {
    const sub = await proxy.addSubscription(`http://127.0.0.1:${TEST_PORT}/sub`, "TestSub");
    console.log("addSubscription result:");
    console.log("  id:", sub.id);
    console.log("  name:", sub.name);
    console.log("  url:", sub.url);
    console.log("  nodes count:", sub.nodes.length);
    for (const n of sub.nodes) {
      console.log("    -", n.name, n.type, n.server + ":" + n.port);
    }

    // Verify it persists
    const after = proxy.getSubscriptions();
    console.log("  stored count:", after.length);
    console.log(after.length > 0 ? "SUCCESS" : "FAIL - no subscriptions stored");

    // Cleanup
    server.close();
  } catch (e) {
    console.error("FAIL - error:", e.message);
    server.close();
  }
});