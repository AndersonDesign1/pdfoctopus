// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small Markdown to HTML converter, for making a PDF from a Markdown file: headings,
// paragraphs, emphasis, code (inline and fenced), block quotes, lists (nested by indentation),
// links, horizontal rules and pipe tables. Raw HTML in the Markdown is shown as text, not
// interpreted, and pictures become their description: the PDF is made without fetching
// anything.

/** Escape text for HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Only these link targets are kept; others (javascript:, data:) become plain text. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:|#)/i.test(trimmed) ? trimmed : null;
}

/** Inline Markdown in an already-escaped line: code, links, pictures, bold and italic. */
function inline(escaped: string): string {
  // Code spans first, kept out of the other rules by a placeholder.
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  // Pictures: their description, in brackets (nothing is fetched).
  // A URL can hold one level of brackets ("https://en.wikipedia.org/wiki/PDF_(format)").
  const url = String.raw`((?:[^()\s]|\([^()\s]*\))*)(?:\s+[^)]*)?`;
  s = s.replace(new RegExp(String.raw`!\[([^\]]*)\]\(${url}\)`, "g"), (_, alt: string) =>
    alt ? `[${alt}]` : "",
  );
  s = s.replace(
    new RegExp(String.raw`\[([^\]]+)\]\(${url}\)`, "g"),
    (_, text: string, url: string) => {
      // The URL was escaped with the rest of the line: unescape the ampersands for checking.
      const target = safeUrl(url.replaceAll("&amp;", "&"));
      return target ? `<a href="${escapeHtml(target)}">${text}</a>` : text;
    },
  );
  // Underscores only count at word boundaries, so snake_case_names stay as they are.
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "<strong>$1</strong>");
  s = s.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "<em>$1</em>");
  s = s.replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "<em>$1</em>");
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>");
  // A line ending in two spaces, or a backslash, is a line break.
  s = s.replace(/( {2,}|\\)$/, "<br>");
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)] ?? "");
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Convert Markdown to an HTML fragment (no <html> or <body>). */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  // Open lists, innermost last: their indentation and tag.
  const lists: { indent: number; tag: "ul" | "ol" }[] = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("\n")}</p>`);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && (lists[lists.length - 1]?.indent ?? 0) > toIndent) {
      out.push(`</li></${lists.pop()?.tag}>`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = escapeHtml(raw);

    // Fenced code block.
    const fence = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flushParagraph();
      closeLists();
      const marker = fence[1] as string;
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(marker); i++) {
        code.push(escapeHtml(lines[i] ?? ""));
      }
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    if (raw.trim() === "") {
      flushParagraph();
      // A blank line inside a list keeps it open if the list carries on.
      const next = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
      if (!LIST_ITEM.test(next) && !/^\s{2,}\S/.test(next)) closeLists();
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ""))}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushParagraph();
      closeLists();
      out.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(raw)) {
      flushParagraph();
      closeLists();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i] ?? ""); i++) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
      }
      i--;
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }
    // A pipe table: a header row, then a row of dashes.
    if (raw.includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flushParagraph();
      closeLists();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => inline(escapeHtml(c.trim())));
      const head = cells(raw);
      const body: string[][] = [];
      for (i += 2; i < lines.length && (lines[i] ?? "").includes("|"); i++) {
        body.push(cells(lines[i] ?? ""));
      }
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    const item = raw.match(LIST_ITEM);
    if (item) {
      flushParagraph();
      const indent = (item[1] ?? "").replace(/\t/g, "    ").length;
      const tag = /\d/.test(item[2] ?? "") ? "ol" : "ul";
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}><li>`);
        lists.push({ indent, tag });
      } else {
        closeLists(indent);
        const current = lists[lists.length - 1];
        if (current && current.tag !== tag) {
          out.push(`</li></${lists.pop()?.tag}><${tag}><li>`);
          lists.push({ indent, tag });
        } else if (current) {
          out.push("</li><li>");
        } else {
          out.push(`<${tag}><li>`);
          lists.push({ indent, tag });
        }
      }
      out.push(inline(escapeHtml(item[3] ?? "")));
      continue;
    }
    // A line indented under a list item carries the item on.
    if (lists.length && /^\s+\S/.test(raw)) {
      out.push(` ${inline(line.trim())}`);
      continue;
    }
    closeLists();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeLists();
  return out.join("\n");
}
