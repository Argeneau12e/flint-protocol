/**
 * Evidence sheet file queue (Task 3, item 2, part 1).
 *
 * Files section: drag-and-drop styled with shadcn tokens, drag state,
 * per-file row with name, size, progress bar, SHA-256 shown in mono as it
 * computes, remove button. Limits from the Task 2 upload route are enforced
 * here with friendly messages.
 */

"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { FileIcon, ImageIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { isAllowedUpload, sha256Hex } from "@/lib/evidence";

export const EVIDENCE_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 25 * 1024 * 1024,
  maxLinks: 5,
  maxNoteChars: 500,
} as const;

export interface QueuedFile {
  id: string;
  file: File;
  hash: string | null;
  hashing: boolean;
  error: string | null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let queueCounter = 0;
function queueId(): string {
  queueCounter += 1;
  return `file-${Date.now()}-${queueCounter}`;
}

export function FilesSection({
  files,
  setFiles,
  disabled,
}: {
  files: QueuedFile[];
  setFiles: (next: QueuedFile[] | ((prev: QueuedFile[]) => QueuedFile[])) => void;
  disabled: boolean;
}) {
  const [dropError, setDropError] = useState<string | null>(null);

  const onDrop = useCallback(
    (accepted: File[]) => {
      setDropError(null);
      if (files.length + accepted.length > EVIDENCE_LIMITS.maxFiles) {
        setDropError("You can attach at most 5 files. Remove one to add another.");
        return;
      }
      const queued: QueuedFile[] = [];
      for (const file of accepted) {
        if (file.size > EVIDENCE_LIMITS.maxFileBytes) {
          setDropError(`${file.name} is larger than 25 MB. Compress it first.`);
          continue;
        }
        if (!isAllowedUpload(file.name, file.type)) {
          setDropError(`${file.name} is not an accepted type. Use images (not SVG), PDF, ZIP, TXT, Markdown, DOCX, XLSX or CSV.`);
          continue;
        }
        queued.push({ id: queueId(), file, hash: null, hashing: true, error: null });
      }
      if (queued.length === 0) return;
      setFiles((prev) => [...prev, ...queued]);
      for (const entry of queued) {
        void entry.file
          .arrayBuffer()
          .then((buffer) => sha256Hex(new Uint8Array(buffer)))
          .then((hash) => {
            setFiles((prev) =>
              prev.map((item) =>
                item.id === entry.id ? { ...item, hash, hashing: false } : item,
              ),
            );
          })
          .catch(() => {
            setFiles((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? { ...item, hashing: false, error: "Could not read this file." }
                  : item,
              ),
            );
          });
      }
    },
    [files.length, setFiles],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled,
    multiple: true,
  });

  return (
    <section aria-labelledby="evidence-files">
      <h3 id="evidence-files">Files</h3>
      <div
        {...getRootProps()}
        data-dragging={isDragActive}
        className="flint-dropzone"
        aria-label="Attach evidence files"
      >
        <input {...getInputProps()} />
        <p className="flint-muted">
          {isDragActive
            ? "Drop the files here."
            : "Drag files here, or click to choose. Up to 5 files, 25 MB each."}
        </p>
      </div>
      {dropError === null ? null : (
        <p role="alert" className="flint-error-text">{dropError}</p>
      )}
      <ul className="flint-file-list">
        {files.map((entry) => (
          <li key={entry.id} className="flint-file-row">
            {entry.file.type.startsWith("image/") ? (
              <ImageIcon strokeWidth={1.5} size={18} aria-hidden="true" />
            ) : (
              <FileIcon strokeWidth={1.5} size={18} aria-hidden="true" />
            )}
            <span className="flint-file-meta">
              <strong>{entry.file.name}</strong>
              <span className="flint-muted">{formatBytes(entry.file.size)}</span>
              {entry.hashing ? (
                <Progress value={50} aria-label={`Hashing ${entry.file.name}`} />
              ) : entry.hash !== null ? (
                <code title={entry.hash} className="flint-hash">{entry.hash}</code>
              ) : null}
              {entry.error === null ? null : (
                <span role="alert" className="flint-error-text">{entry.error}</span>
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={`Remove ${entry.file.name}`}
              onClick={() =>
                setFiles((prev) => prev.filter((item) => item.id !== entry.id))
              }
            >
              <TrashIcon strokeWidth={1.5} />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
