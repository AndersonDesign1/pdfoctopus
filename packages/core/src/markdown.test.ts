// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown";

describe("markdownToHtml", () => {
  it("converts headings, paragraphs and emphasis", () => {
    expect(markdownToHtml("# Title\n\nSome *em* and **strong** and `code`.")).toBe(
      "<h1>Title</h1>\n<p>Some <em>em</em> and <strong>strong</strong> and <code>code</code>.</p>",
    );
  });

  it("leaves underscores inside words alone", () => {
    expect(markdownToHtml("snake_case_name and _this_")).toBe(
      "<p>snake_case_name and <em>this</em></p>",
    );
  });

  it("nests lists by indentation, and switches between kinds", () => {
    const html = markdownToHtml("- a\n  - b\n- c\n\n1. one\n2. two");
    expect(html).toBe(
      "<ul><li>\na\n<ul><li>\nb\n</li></ul>\n</li><li>\nc\n</li></ul><ol><li>\none\n</li><li>\ntwo\n</li></ol>",
    );
  });

  it("keeps code blocks as they are", () => {
    expect(markdownToHtml("```\nif (a < b) {\n  *x*\n}\n```")).toBe(
      "<pre><code>if (a &lt; b) {\n  *x*\n}</code></pre>",
    );
  });

  it("makes quotes, rules and tables", () => {
    expect(markdownToHtml("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(markdownToHtml("---")).toBe("<hr>");
    expect(markdownToHtml("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("shows raw HTML as text, keeps only safe links, and fetches no pictures", () => {
    expect(markdownToHtml('<script>alert("x")</script>')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
    expect(markdownToHtml("[site](https://example.com?a=1&b=2)")).toBe(
      '<p><a href="https://example.com?a=1&amp;b=2">site</a></p>',
    );
    expect(markdownToHtml("[bad](javascript:alert(1))")).toBe("<p>bad</p>");
    expect(markdownToHtml("[PDF](https://en.wikipedia.org/wiki/PDF_(format))")).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/PDF_(format)">PDF</a></p>',
    );
    expect(markdownToHtml("![a chart](https://example.com/c.png)")).toBe("<p>[a chart]</p>");
  });
});
