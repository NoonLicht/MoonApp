// Test parseSubBody and addSubscription flow
const src = require('fs').readFileSync('server/proxy.js', 'utf8');

// Mock settings
const settingsMock = { _data: {}, get(key) { return this._data[key]; }, set(key, val) { this._data[key] = val; } };

// Extract parseSubBody by evaluating the module with a mock
const proxy = require('./server/proxy');

// Test 1: base64 encoded vless links
console.log("=== Test 1: Base64 encoded body ===");
const body1 = Buffer.from(
  'vless://abc123@1.2.3.4:443?security=reality&pbk=xyz&sni=example.com&remark=Tokyo%20Node\n' +
  'vless://def456@5.6.7.8:8443?security=tls&sni=test.com&remark=Singapore%20Node'
).toString('base64');

// We need to call addSubscription but it does a real fetch. Let's just test parseSubBody.
// Since it's internal, let's eval it manually.
const fnStart = src.indexOf('function parseSubBody');
const fnEnd = src.indexOf('\n/* ---------------------------- Экспорт', fnStart);
const parseSubBodyCode = src.substring(fnStart, fnEnd);

// Create a mini-module
const testModule = `
const require = arguments[0];
const { parseVlessLink } = require('./server/proxy');
${parseSubBodyCode}
const body1 = ${JSON.stringify(body1)};
console.log('Result:', JSON.stringify(parseSubBody(body1), null, 2));
`;

const vm = require('vm');
const sandbox = {};
vm.createContext(sandbox);
try {
  const result = vm.runInNewContext(testModule, { require });
  console.log("parseSubBody works!");
} catch(e) {
  console.log("parseSubBody error:", e.message);
}