// Small Markdown helpers shared by the web-book and text-file importers.
// The importers only need clean, readable text, not a renderer.

/** Splits a leading `---` front-matter block into key/value pairs. Values may be JSON-quoted. */
export function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Drops images, comments and link targets, and collapses runs of blank lines. */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TextGroup {
  title: string;
  text: string;
}

/**
 * Splits Markdown into groups at the shallowest heading level (# or ##) that
 * occurs at least `minHeadings` times. Text before the first heading becomes
 * an "Introduction" group. Returns one untitled group if there are too few headings.
 */
export function splitByHeadings(md: string, fallbackTitle: string, minHeadings = 3): TextGroup[] {
  const lines = md.split("\n");
  const isHeading = (l: string, level: number) => new RegExp(`^#{${level}}\\s+\\S`).test(l);
  let fenced = false;
  const level = [1, 2].find(
    (lv) =>
      lines.filter((l) => {
        if (/^```/.test(l)) fenced = !fenced;
        return !fenced && isHeading(l, lv);
      }).length >= minHeadings,
  );
  if (!level) return [{ title: fallbackTitle, text: md.trim() }];

  const groups: TextGroup[] = [];
  let cur: { title: string; lines: string[] } = { title: "Introduction", lines: [] };
  fenced = false;
  for (const l of lines) {
    if (/^```/.test(l)) fenced = !fenced;
    if (!fenced && isHeading(l, level)) {
      groups.push({ title: cur.title, text: cur.lines.join("\n").trim() });
      cur = { title: l.replace(/^#+\s+/, "").replace(/\s*#+\s*$/, "").trim(), lines: [l] };
    } else cur.lines.push(l);
  }
  groups.push({ title: cur.title, text: cur.lines.join("\n").trim() });
  return groups.filter((g) => g.text);
}
