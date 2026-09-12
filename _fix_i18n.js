const fs = require('fs');
let raw = fs.readFileSync('src/i18n/en.json', 'utf8');
raw = raw.replace(/"loading":\s*"[^"]*"/, () => '"loading": "Loading..."');
raw = raw.replace(/"loadMore":\s*"[^"]*"\s*/, () => '');
raw = raw.replace(/(\s+}),\s*"settings"/, () => ',\n    "loadMore": "Load more"\n  },\n  "settings"');
// Add books keys
raw = raw.replace(/"download":\s*"[^"]*"/, () => '"download": "Download"');
const booksEnd = raw.indexOf('"monitor"');
if (booksEnd > 0) {
  const before = raw.slice(0, booksEnd - 2);
  const after = raw.slice(booksEnd - 2);
  raw = before + ',\n    "clearFilters": "Clear filters",\n    "syncNew": "Sync new",\n    "syncAll": "Sync all genres",\n    "syncing": "Syncing... {n} books",\n    "downloaded": "Downloaded: {file}"' + after;
}
fs.writeFileSync('src/i18n/en.json', raw, 'utf8');
console.log('OK');