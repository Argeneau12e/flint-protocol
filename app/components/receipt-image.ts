/**
 * The downloadable receipt: the payer's confirmation, rendered to a PNG.
 *
 * Drawn on a canvas rather than screenshotted from the DOM, and the reason is
 * bundle size and determinism, not taste:
 *
 *   - `html-to-image` (~14 kB gzipped) and `html2canvas` (~50 kB) both work by
 *     re-parsing the live DOM, and both have to be trusted to reproduce a
 *     translucent, backdrop-filtered layout through a rasteriser. A receipt is
 *     the one image that must not look different from what the payer saw. This
 *     card is fixed and known, so it is drawn directly and comes out stable.
 *   - It adds no dependency at all, which matters on a disk that has run out
 *     before — the sizes above were checked before deciding.
 *
 * Every colour and face is read from the same CSS variables the app uses, so
 * the image cannot drift from the palette. Client-only by construction: it needs
 * `document`, `canvas`, and the webfonts the layout loaded.
 */

"use client";

/** What the receipt says. Everything but `signature` is known from chain. */
export interface ReceiptData {
  /** The agreement's title — what the payment was for. */
  title: string;
  /** Human amount, already formatted (`formatBaseUnits`). */
  amount: string;
  /** Display symbol (never on chain). */
  symbol: string;
  /** One sentence about where the money is, in the payer's own terms. */
  status: string;
  /** When it was signed, already formatted in UTC. */
  paidAt: string;
  /** The funding or settlement signature, when this session knows it. */
  signature: string | null;
  /** The agreement's own page — the link the recipient can open. */
  pageUrl: string;
  /** The verification page, where the receipt is recomputed from chain. */
  verifyUrl: string;
  /** The cluster this happened on (devnet, in this build). */
  cluster: string;
}

const WIDTH = 1200;
const HEIGHT = 630;
const INSET = 40;

/** A CSS custom property, with the fallback the stylesheet itself would use. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/**
 * The loaded font stack for a token.
 *
 * `next/font` self-hosts each face under a generated family name and exposes it
 * as a CSS variable, so the stack has to be read from the document rather than
 * hardcoded: a canvas that names the family wrong falls back to a system face
 * silently, and the receipt would ship in the wrong type.
 */
function fontStack(name: string, fallback: string): string {
  return token(name, fallback).split(",").slice(0, 2).join(",");
}

/** Breaks text to fit `maxWidth`, returning the lines it needs. */
function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current !== "") lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Letter-spaced text, which canvas has no shorthand for in every engine. */
function spacedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  let cursor = x;
  for (const character of text) {
    context.fillText(character, cursor, y);
    cursor += context.measureText(character).width + spacing;
  }
}


/** Renders the receipt and hands back a PNG blob. */
export async function renderReceiptPng(data: ReceiptData): Promise<Blob> {
  // Canvas silently substitutes a fallback face for a font that has not loaded
  // yet; waiting is what makes the image use the app's own type.
  try {
    await document.fonts.ready;
  } catch {
    // A failure here costs the typeface, not the receipt.
  }

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser could not draw the receipt image.");

  const background = token("--flint-bg", "#0f0d0b");
  const ink = token("--flint-ink", "#f3ebda");
  const muted = token("--flint-muted", "#a99e8c");
  const accent = token("--flint-accent", "#e3a73c");
  const line = token("--flint-line", "rgba(140, 100, 35, 0.35)");
  const display = fontStack("--flint-font-display", "serif");
  const body = fontStack("--flint-font-body", "sans-serif");
  const mono = fontStack("--flint-font-mono", "monospace");

  // An opaque field, the same near-black the logo sits on — a receipt is shared
  // outside the app, where a translucent panel has no backdrop to blend with.
  context.fillStyle = background;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = line;
  context.lineWidth = 2;
  context.strokeRect(INSET / 2, INSET / 2, WIDTH - INSET, HEIGHT - INSET);

  context.textBaseline = "alphabetic";
  context.fillStyle = accent;
  context.font = `600 20px ${mono}`;
  spacedText(context, "PAYMENT RECEIPT", INSET + 8, INSET + 44, 3);

  // The figure first and largest — the same order the page reads in.
  context.fillStyle = ink;
  context.font = `600 84px ${mono}`;
  context.fillText(`${data.amount} ${data.symbol}`, INSET + 8, INSET + 156);

  context.font = `500 34px ${display}`;
  let cursor = INSET + 206;
  for (const titleLine of wrap(context, data.title, WIDTH - 2 * INSET - 16).slice(0, 2)) {
    context.fillText(titleLine, INSET + 8, cursor);
    cursor += 40;
  }

  context.fillStyle = muted;
  context.font = `400 22px ${body}`;
  cursor += 8;
  for (const statusLine of wrap(context, data.status, WIDTH - 2 * INSET - 16)) {
    context.fillText(statusLine, INSET + 8, cursor);
    cursor += 30;
  }

  // ---- the facts, as label/value rows -------------------------------------
  cursor += 24;
  const rows: Array<[string, string]> = [
    ["Signed", data.paidAt],
    ["Transaction", data.signature === null ? "not recorded in this browser" : data.signature],
    ["Verify", data.verifyUrl],
    ["Agreement", data.pageUrl],
  ];
  for (const [label, value] of rows) {
    context.fillStyle = muted;
    context.font = `400 18px ${body}`;
    context.fillText(label, INSET + 8, cursor);

    // Values are machine-shaped — an 88-character signature, a URL — so they
    // take the mono face and whatever wrapping the width demands.
    context.fillStyle = ink;
    context.font = `400 18px ${mono}`;
    const valueLines = wrap(context, value, WIDTH - 2 * INSET - 220).slice(0, 2);
    let valueCursor = cursor;
    for (const valueLine of valueLines) {
      context.fillText(valueLine, INSET + 220, valueCursor);
      valueCursor += 26;
    }
    cursor += valueLines.length > 1 ? 54 : 32;
  }

  context.fillStyle = muted;
  context.font = `400 17px ${body}`;
  context.fillText(
    `Flint · FRS-1 on Solana ${data.cluster} · anyone can re-check this receipt from chain data`,
    INSET + 8,
    HEIGHT - INSET - 10,
  );

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("The browser produced an empty image."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

/** A filename a person can find again: what it was for, and when. */
export function receiptFileName(data: ReceiptData): string {
  const slug =
    data.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "payment";
  return `flint-receipt-${slug}-${data.paidAt.slice(0, 10)}.png`;
}

/** Renders, then hands the file to the browser's own download mechanism. */
export async function downloadReceiptPng(data: ReceiptData): Promise<void> {
  const blob = await renderReceiptPng(data);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = receiptFileName(data);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking in the same task can cancel the download in some engines; the
    // next task is soon enough that the blob is never kept around.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    URL.revokeObjectURL(url);
  }
}
