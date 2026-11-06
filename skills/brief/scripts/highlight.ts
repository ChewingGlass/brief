// Reads [{key, lang, code}] as JSON on stdin and writes {key: [html per line]} to stdout.
// Each line closes the spans it opened, so a caller can place any line on its own.
import hljs from "highlight.js";

type Source = { key: string; lang: string; code: string };

const TOKEN = /(<span class="[^"]*">)|(<\/span>)|([^<]+)/g;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(source: Source): string {
  if (source.lang && hljs.getLanguage(source.lang)) {
    return hljs.highlight(source.code, { language: source.lang, ignoreIllegals: true }).value;
  }

  return escapeHtml(source.code);
}

function splitLines(html: string): string[] {
  const lines: string[] = [];
  const openSpans: string[] = [];
  let line = "";

  for (const [, open, close, text] of html.matchAll(TOKEN)) {
    if (open) {
      openSpans.push(open);
      line += open;
    } else if (close) {
      openSpans.pop();
      line += close;
    } else {
      const parts = text.split("\n");
      line += parts[0];
      for (const part of parts.slice(1)) {
        lines.push(line + "</span>".repeat(openSpans.length));
        line = openSpans.join("") + part;
      }
    }
  }

  lines.push(line + "</span>".repeat(openSpans.length));
  return lines;
}

const sources: Source[] = JSON.parse(await Bun.stdin.text());
const result: Record<string, string[]> = {};
for (const source of sources) {
  result[source.key] = splitLines(highlight(source));
}

process.stdout.write(JSON.stringify(result));
