// Shared (X)HTML → text helpers for the EPUB and web importers.

const SKIP = new Set(["script", "style", "head", "title", "svg", "img", "nav", "audio", "video", "object", "canvas"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section",
  "table", "tr", "ul",
]);

/** Footnote call-outs ("…next.¹") are dropped: they'd glue a stray digit onto the sentence. The note text itself is kept. */
function isNoteRef(el: Element, name: string): boolean {
  const type = `${el.getAttribute("epub:type") ?? ""} ${el.getAttribute("role") ?? ""}`;
  if (/noteref|footnote-ref/.test(type)) return true;
  return name === "sup" && el.querySelector("a[href]") !== null;
}

/** Visible text of an (X)HTML document with paragraph breaks, plus anchor offsets. */
export function htmlToText(root: Element): { text: string; anchors: Record<string, number> } {
  let out = "";
  const anchors: Record<string, number> = {};
  const brk = (n: number) => {
    if (!out) return;
    const have = /\n*$/.exec(out)![0].length;
    if (have < n) out += "\n".repeat(n - have);
  };
  const addText = (raw: string, pre: boolean) => {
    raw = raw.replace(/[\u21A9\u21B5]\uFE0E?/g, ""); // footnote "back" arrows
    let s = pre ? raw : raw.replace(/\s+/g, " ");
    if (!pre && (!out || out.endsWith("\n") || out.endsWith(" "))) s = s.replace(/^ /, "");
    out += s;
  };
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === 3) return addText((node as Text).data, pre);
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const name = el.localName.toLowerCase();
    if (SKIP.has(name) || isNoteRef(el, name)) return;
    const id = el.getAttribute("id") ?? (name === "a" ? el.getAttribute("name") : null);
    const block = BLOCK.has(name);
    if (block) brk(2);
    if (id && !(id in anchors)) anchors[id] = out.length;
    if (name === "br") out += "\n";
    else if (name === "td" || name === "th") out += out && !out.endsWith("\n") ? " " : "";
    for (const c of Array.from(el.childNodes)) walk(c, pre || name === "pre");
    if (block) brk(2);
  };
  walk(root, false);
  return { text: out.replace(/[ \t]+\n/g, "\n").trimEnd(), anchors };
}

export const byLocal = (root: ParentNode, name: string): Element[] =>
  Array.from(root.querySelectorAll("*")).filter((e) => e.localName.toLowerCase() === name);

export function parse(xml: string, type: DOMParserSupportedType): Document {
  return new DOMParser().parseFromString(xml, type);
}

export function parseXhtml(xml: string): Document {
  const doc = parse(xml, "application/xhtml+xml");
  return byLocal(doc, "parsererror").length ? parse(xml, "text/html") : doc;
}

