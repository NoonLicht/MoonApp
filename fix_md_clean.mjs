import fs from "fs";

let c = fs.readFileSync("src/components/MarkdownRenderer.tsx", "utf8");
c = c.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

// Find the entire preprocess function and replace it
const start = c.indexOf("function preprocess(text: string): string {");
const end = c.indexOf("export default function", start);

const newPreprocess = `function preprocess(text: string): string {
  const lines = text.split("\\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    // Code blocks — skip pre-processing inside them
    if (l.trimStart().startsWith("\`\`\`")) {
      out.push(l);
      continue;
    }
    // Checkboxes: - [ ] / - [x] → custom spans
    const cb = l.match(/^(\\s*(?:[-*+]\\s+)?)\\[([ xX])\\]\\s*(.*)/);
    if (cb) {
      const checked = cb[2].toLowerCase() === "x";
      out.push(\`<span class="md-cb-row" data-line="\${i}">\` +
        \`<span class="md-cb\${checked?" md-cb-checked":""}">\${checked?"✓":""}</span>\` +
        \`<span>\${cb[3]}</span></span>\`);
      continue;
    }
    // Math block $$...$$ -> <code class="md-math-block"> (must be before inline math)
    l = l.replace(/\\$\\$([^\\$]+)\\$\\$/g, '<code class="md-math-block">$1</code>');
    // Math inline $...$ -> <code class="md-math">
    l = l.replace(/\\$([^\\$]+)\\$/g, '<code class="md-math">$1</code>');
    // Superscript ^text^ -> <sup>text</sup>
    l = l.replace(/\\^([^\\^]+)\\^/g, "<sup>$1</sup>");
    // Subscript ~text~ -> <sub>text</sub>
    l = l.replace(/(?<!~)~([^~\\s][^~]*[^~\\s])~(?!~)/g, "<sub>$1</sub>");
    // WikiLinks [[...]] and #tags
    l = l.replace(/\\[\\[([^\\]]+)\\]\\]/g, (_, title) =>
      \`<span class="md-wl" data-title="\${title.replace(/"/g,"&quot;")}">\${title}</span>\`);
    l = l.replace(/(^|\\s)(#[a-zA-Zа-яА-Я0-9_\\-\\/]+)/g, (_, sp, tag) =>
      \`\${sp}<span class="md-tg" data-tag="\${tag}">\${tag}</span>\`);
    out.push(l);
  }
  return out.join("\\n");
}\n\n`;

c = c.substring(0, start) + newPreprocess + c.substring(end);
fs.writeFileSync("src/components/MarkdownRenderer.tsx", c, "utf8");
console.log("✅ preprocess rewritten - clean single-pass");