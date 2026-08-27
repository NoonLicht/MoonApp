const s = require("./server/settings");

// Test: set with full object
s.set({ proxy: { test: 1 } });
console.log("After set full:", JSON.stringify(s.get("proxy")));

// Now test: set but with key as patch (BROKEN way)
s.set("proxy", { test: 2 }); // this is wrong - passes string as patch
console.log("After set wrong:", JSON.stringify(s.get("proxy")));

// Correct way
const all = s.get();
all.proxy = { test: 3 };
s.set(all);
console.log("After set correct:", JSON.stringify(s.get("proxy")));

// Restore
s.set({ proxy: {} });
console.log("After restore:", JSON.stringify(s.get("proxy")));

// Verify subscriptions via correct method
const cfg = s.get();
const subs = cfg.proxy.subscriptions || [];
subs.push({ id: "test1", url: "x", name: "Test", nodes: [], updatedAt: new Date().toISOString() });
cfg.proxy.subscriptions = subs;
s.set(cfg);
const c2 = s.get();
console.log("Subs count:", (c2.proxy.subscriptions || []).length);