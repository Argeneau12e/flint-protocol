/**
 * Evidence sheet links + note sections (Task 3, item 2, part 2).
 *
 * Links: up to 5, each with a domain preview, add and remove. Note: 500
 * characters with a counter.
 */

"use client";

import { useState } from "react";
import { TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { externalLinkHost } from "@/lib/links";
import { EVIDENCE_LIMITS } from "@/components/evidence-files";

export function LinksSection({
  links,
  setLinks,
  disabled,
}: {
  links: string[];
  setLinks: (next: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  function add() {
    const raw = draft.trim();
    if (raw === "") return;
    if (links.length >= EVIDENCE_LIMITS.maxLinks) {
      setLinkError("You can add at most 5 links.");
      return;
    }
    const host = externalLinkHost(raw);
    if (host === null) {
      setLinkError("That is not a valid http or https link. Paste the full address.");
      return;
    }
    setLinks([...links, raw]);
    setDraft("");
    setLinkError(null);
  }

  return (
    <section aria-labelledby="evidence-links">
      <h3 id="evidence-links">Links</h3>
      <div className="flint-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Label htmlFor="evidence-link-input">Add a link</Label>
          <Input
            id="evidence-link-input"
            value={draft}
            disabled={disabled}
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://example.com/delivery"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={add}>
          Add link
        </Button>
      </div>
      {linkError === null ? null : (
        <p role="alert" className="flint-error-text">{linkError}</p>
      )}
      <ul className="flint-file-list">
        {links.map((link) => (
          <li key={link} className="flint-file-row">
            <span className="flint-file-meta">
              <strong>{externalLinkHost(link) ?? link}</strong>
              <span className="flint-muted" style={{ overflowWrap: "anywhere" }}>{link}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={`Remove link ${link}`}
              onClick={() => setLinks(links.filter((item) => item !== link))}
            >
              <TrashIcon strokeWidth={1.5} />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NoteSection({
  note,
  setNote,
  disabled,
}: {
  note: string;
  setNote: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <section aria-labelledby="evidence-note">
      <h3 id="evidence-note">Note</h3>
      <Label htmlFor="evidence-note-input">Delivery note</Label>
      <Textarea
        id="evidence-note-input"
        value={note}
        disabled={disabled}
        rows={4}
        maxLength={EVIDENCE_LIMITS.maxNoteChars}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What was delivered, and where to look."
      />
      <p className="flint-hint" aria-live="polite">
        {note.length} of {EVIDENCE_LIMITS.maxNoteChars} characters.
      </p>
    </section>
  );
}
