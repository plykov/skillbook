// Skill packaging for claude.ai: validation, SKILL.md assembly and zipping.
import { strToU8, zipSync } from "fflate";
import type { SkillDraft } from "./types";

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/anthropic|claude/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-$/, "");
}

export function validateSkill(d: SkillDraft): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.name)) errors.push("Name: lowercase letters, digits and single hyphens only.");
  if (d.name.length > NAME_MAX) errors.push(`Name: ${NAME_MAX} characters max.`);
  if (/anthropic|claude/.test(d.name)) errors.push('Name: must not contain "anthropic" or "claude".');
  if (!d.description.trim()) errors.push("Description is required.");
  if (d.description.length > DESCRIPTION_MAX) errors.push(`Description: ${DESCRIPTION_MAX} characters max (now ${d.description.length}).`);
  if (/<[^>]+>/.test(d.description)) errors.push("Description must not contain XML/HTML tags.");
  if (!d.body.trim()) errors.push("SKILL.md body is empty.");
  const seen = new Set<string>();
  for (const r of d.references) {
    if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(r.filename)) errors.push(`Reference "${r.filename}": use lowercase-hyphen names ending in .md.`);
    if (seen.has(r.filename)) errors.push(`Reference "${r.filename}" appears twice.`);
    seen.add(r.filename);
  }
  return errors;
}

/** YAML double-quoted scalar; JSON string escaping is valid YAML. */
const yamlString = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

export function skillMarkdown(d: SkillDraft): string {
  return `---\nname: ${d.name}\ndescription: ${yamlString(d.description)}\n---\n\n${d.body.trim()}\n`;
}

/** Zip laid out as claude.ai expects: one top-level folder holding SKILL.md. */
export function skillZip(d: SkillDraft): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [`${d.name}/SKILL.md`]: strToU8(skillMarkdown(d)),
  };
  for (const r of d.references) files[`${d.name}/references/${r.filename}`] = strToU8(r.content.trim() + "\n");
  return zipSync(files, { level: 6 });
}
