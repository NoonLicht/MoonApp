// Test settings persistence for subscriptions
const settings = require("./server/settings");
const proxy = require("./server/proxy");

// Clear existing
const cur = settings.get("proxy") || {};
delete cur.subscriptions;
settings.set("proxy", cur);

// Add via the real addSubscription (needs a real HTTP server)
// Instead, manually add to settings and verify getSubscriptions works
const cfg = settings.get("proxy") || {};
const subs = cfg.subscriptions || [];
subs.push({
  id: "test_manual_1",
  url: "http://example.com/sub",
  name: "ManualTest",
  nodes: [{ link: "vless://abc@1.2.3.4:443?security=tls", name: "TestNode", type: "vless", server: "1.2.3.4", port: 443 }],
  updatedAt: new Date().toISOString(),
});
cfg.subscriptions = subs;
settings.set("proxy", cfg);

// Now read back
const result = proxy.getSubscriptions();
console.log("getSubscriptions count:", result.length);
if (result.length > 0) {
  console.log("  id:", result[0].id);
  console.log("  name:", result[0].name);
  console.log("  nodes:", result[0].nodes.length);
  console.log("  node[0].name:", result[0].nodes[0].name);
  console.log("SUCCESS: persistence works");
} else {
  console.log("FAIL: persistence broken");
}

// Cleanup
const c2 = settings.get("proxy") || {};
delete c2.subscriptions;
settings.set("proxy", c2);