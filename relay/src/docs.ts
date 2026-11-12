/**
 * The /docs page, built from public/llms-full.txt so people and models read the same text.
 * A small Markdown renderer covers what that file uses: headings, paragraphs, lists, tables,
 * code blocks, quotes, inline code, bold and links.
 */

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function inline(text: string) {
  // Code spans first, so their content is not formatted.
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>')
        // Bare addresses, without the sentence's closing punctuation.
        .replace(/(^|[\s(])(https:\/\/[^\s)<]*[^\s)<.,;:])/g, '$1<a href="$2">$2</a>');
    })
    .join("");
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

export function renderMarkdown(source: string) {
  const lines = source.split("\n");
  const html: string[] = [];
  const toc: { id: string; title: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      i++;
      html.push(`<pre><code${lang ? ` data-lang="${escape(lang)}"` : ""}>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      const id = slug(title);
      if (level === 2) toc.push({ id, title });
      const cls = level === 1 ? "heading-3" : level === 2 ? "heading-6" : "title-3";
      html.push(`<h${level} id="${id}" class="${cls}">${inline(title)}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(lines[i]!);
      const [head, , ...body] = rows;
      html.push(`<div class="table"><table><thead><tr>${cells(head!).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        body.map((row) => `<tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")
      }</tbody></table></div>`);
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith("- "); i++) items.push(lines[i]!.slice(2));
      html.push(`<ul class="body-3">${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (line.startsWith("> ")) {
      html.push(`<p class="body-3 lead">${inline(line.slice(2))}</p>`);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#|```|\||- |> )/.test(lines[i]!); i++) paragraph.push(lines[i]!);
    html.push(`<p class="body-3">${inline(paragraph.join(" "))}</p>`);
  }
  return { html: html.join("\n"), toc };
}

export function docsPage(source: string) {
  const { html, toc } = renderMarkdown(source);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Docs | Herb</title>
  <meta name="description" content="How to connect agents to Herb, place calls, and build webhook handlers for live calls.">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="alternate" type="text/plain" href="/llms-full.txt" title="Docs for language models">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <nav class="nav" aria-label="Main"><a class="brand title-3" href="/"><img src="/icon.svg" alt="" width="24" height="24">Herb</a></nav>
  <main class="prose docs">
    <p class="caption-2 muted">Also as plain text for language models: <a href="/llms.txt">llms.txt</a>, <a href="/llms-full.txt">llms-full.txt</a></p>
    <nav class="toc caption-1" aria-label="On this page">${toc.map((t) => `<a href="#${t.id}">${escape(t.title)}</a>`).join("")}</nav>
${html}
  </main>
  <footer class="foot caption-2 muted"><a href="/">Home</a><a href="/docs">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/GR0SST/herb">GitHub</a></footer>
</body>
</html>
`;
}
