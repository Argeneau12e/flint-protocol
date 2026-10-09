/**
 * The evidence pipeline, tested without chain, storage or network.
 *
 * Covers the five properties the task names (item 11):
 *   1. manifest hashing and canonical JSON — byte-for-byte reproducible;
 *   2. the upload allowlist — extension and MIME must agree, SVG/HTML refused;
 *   3. nonce expiry and single use — a captured signature cannot be replayed;
 *   4. the external link helper — only http(s), hostname for display;
 *   5. state derivation — including "a claimed agreement is never expired".
 *
 * Hermetic like policy-engine.test.ts: no RPC, no keypairs, no blob store.
 */

import { strict as assert } from "node:assert";
import {
  ALLOWED_UPLOADS,
  canonicalJson,
  evidenceHash,
  findItemByHash,
  hexToBytes,
  isAllowedUpload,
  manifestMatchesHash,
  NO_CLAIM_HASH,
  sha256Hex,
  buildManifest,
  type EvidenceManifest,
} from "../../app/lib/evidence";
import {
  consumeNonce,
  issueNonce,
  NONCE_TTL_SECONDS,
  resetNonces,
  uploadSignMessage,
} from "../../app/lib/evidence-nonce";
import { externalLinkHost, parseExternalLink } from "../../app/lib/links";
import { deriveState, deriveViewer, reviewWindowEnd } from "../../app/lib/agreement-state";
import type { Frs1Agreement } from "../../app/lib/frs1-types";

const AGREEMENT = "8sP3CkGKZoXeXhQzGSHaBvJpTzYQmNwRdUfVkBnMoPkQ";
const RECIPIENT = "ArdoTwZy2Cqvtk6B1BtNqbwnR45W3mCo73MemgNhrXPK";
const PAYER = "2c3TBCrtoaRz81JcqVLKQ3X97xA81YwJeziqQeUiTESF";

/** A funded agreement at a fixed time; override per case. */
function agreement(overrides: Partial<Frs1Agreement> = {}): Frs1Agreement {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    payerAddress: PAYER,
    recipientAddress: RECIPIENT,
    title: "Market report access",
    amount: "1000000",
    asset: "79nrrEnrDK6BQrUUgH2uBpYK1XCPJcgKy3tRQF4ecXuY",
    escrowAddress: "6BxAnhexayAEa4pAf2pkZ5CQr8jXmUMBNkMXtqCxsF2A",
    memo: "",
    expiresAt: 1_767_225_600 + 900,
    status: "funded",
    condition: { type: "manual-confirmation", description: "Deliver the resource" },
    reviewWindowSecs: 24 * 60 * 60,
    claimedAt: null,
    evidenceHash: "00".repeat(32),
    evidenceRef: "",
    disputedAt: null,
    arbiterDeadline: null,
    disputeReason: null,
    feeAmount: "1000",
    ...overrides,
  };
}

describe("canonical JSON and manifest hashing", () => {
  it("sorts keys and emits no whitespace", () => {
    const out = canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: "s" });
    assert.equal(out, '{"a":{"c":3,"d":2},"b":1,"z":"s"}');
    assert.ok(!/\s/.test(out), "no whitespace anywhere");
  });

  it("hashes the canonical form, so key order cannot change the hash", async () => {
    const a = { agreement: AGREEMENT, items: [{ name: "x" }], createdAt: "2026-01-01" };
    const b = { createdAt: "2026-01-01", items: [{ name: "x" }], agreement: AGREEMENT };
    const [ha, hb] = await Promise.all([evidenceHash(a), evidenceHash(b)]);
    assert.equal(ha, hb, "same content, different insertion order, same hash");
    assert.equal(ha.length, 64, "hex sha256 is 64 characters");
  });

  it("produces a different hash when any byte of the manifest changes", async () => {
    const base = buildManifest(
      AGREEMENT,
      [{ kind: "note", name: "note", size: 5, mime: "", sha256: "aa".repeat(32), blobId: "", text: "hello" }],
      "2026-01-01T00:00:00.000Z",
    );
    const mutated: EvidenceManifest = {
      ...base,
      items: [{ ...base.items[0], text: "hellp" }],
    };
    assert.notEqual(await evidenceHash(base), await evidenceHash(mutated));
  });

  it("verifies a manifest against an on-chain hash and refuses the sentinel", async () => {
    const manifest = buildManifest(AGREEMENT, [], "2026-01-01T00:00:00.000Z");
    const hash = await evidenceHash(manifest);
    assert.ok(await manifestMatchesHash(manifest, hash), "recomputed hash matches");
    assert.ok(
      !(await manifestMatchesHash(manifest, NO_CLAIM_HASH)),
      "the all-zeros sentinel never verifies",
    );
    const flipped = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    assert.ok(!(await manifestMatchesHash(manifest, flipped)), "one flipped bit fails");
  });

  it("matches a dropped file's sha256 to its manifest item", async () => {
    const fileBytes = "the delivered bytes";
    const fileHash = await sha256Hex(fileBytes);
    const manifest = buildManifest(
      AGREEMENT,
      [
        { kind: "file", name: "report.pdf", size: fileBytes.length, mime: "application/pdf", sha256: fileHash, blobId: "abc" },
        { kind: "link", name: "example.com", size: 0, mime: "", sha256: "bb".repeat(32), blobId: "", url: "https://example.com/" },
      ],
      "2026-01-01T00:00:00.000Z",
    );

    const found = findItemByHash(manifest, fileHash);
    assert.ok(found !== undefined, "the file's own hash finds its item");
    assert.equal(found?.name, "report.pdf");
    assert.equal(
      findItemByHash(manifest, "cc".repeat(32)),
      undefined,
      "an unknown hash finds nothing",
    );
    // The link's hash must never match a *file* lookup.
    assert.equal(findItemByHash(manifest, "bb".repeat(32)), undefined);
  });

  it("decodes hex to the claim's 32 bytes", () => {
    assert.deepEqual(hexToBytes("00ff10"), [0, 255, 16]);
    assert.equal(hexToBytes("00".repeat(32)).length, 32);
    assert.throws(() => hexToBytes("xyz"), /hex/i);
  });
});

describe("the upload allowlist", () => {
  it("accepts the named types and refuses everything else", () => {
    const ok: Array<[string, string]> = [
      ["photo.jpg", "image/jpeg"],
      ["photo.jpeg", "image/jpeg"],
      ["shot.png", "image/png"],
      ["anim.gif", "image/gif"],
      ["crop.webp", "image/webp"],
      ["doc.pdf", "application/pdf"],
      ["bundle.zip", "application/zip"],
      ["readme.txt", "text/plain"],
      ["notes.md", "text/markdown"],
      ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["rows.csv", "text/csv"],
    ];
    for (const [name, mime] of ok) {
      assert.ok(isAllowedUpload(name, mime), `${name} / ${mime} must be allowed`);
    }
  });

  it("refuses SVG and HTML in every form", () => {
    assert.ok(!isAllowedUpload("logo.svg", "image/svg+xml"), "svg image refused");
    assert.ok(!isAllowedUpload("page.svg", "text/xml"), "svg as xml refused");
    assert.ok(!isAllowedUpload("page.html", "text/html"), "html refused");
    assert.ok(!isAllowedUpload("page.htm", "text/html"), "htm refused");
    assert.ok(!isAllowedUpload("shell.svgz", "application/octet-stream"), "compressed svg refused");
  });

  it("refuses a valid extension claiming a foreign MIME", () => {
    assert.ok(!isAllowedUpload("photo.png", "text/html"), "png cannot carry html");
    assert.ok(!isAllowedUpload("doc.pdf", "application/x-msdownload"), "pdf cannot carry a binary");
    assert.ok(!isAllowedUpload("readme.txt", "image/jpeg"), "txt cannot carry an image");
  });

  it("refuses unknown extensions and missing extensions", () => {
    assert.ok(!isAllowedUpload("run.exe", "application/octet-stream"));
    assert.ok(!isAllowedUpload("archive.tar", "application/x-tar"));
    assert.ok(!isAllowedUpload("noextension", "text/plain"));
    // Case-insensitive on both sides.
    assert.ok(isAllowedUpload("PHOTO.PNG", "IMAGE/PNG"));
    // SVG and HTML must not exist in the table at all.
    assert.equal(ALLOWED_UPLOADS["svg"], undefined);
    assert.equal(ALLOWED_UPLOADS["html"], undefined);
  });
});

describe("upload nonces", () => {
  it("is single use: the second consume fails", () => {
    resetNonces();
    const { nonce } = issueNonce(AGREEMENT, 1_000_000);
    assert.equal(consumeNonce(AGREEMENT, nonce, 1_000_001), "ok", "first use passes");
    assert.equal(consumeNonce(AGREEMENT, nonce, 1_000_002), "used", "replay refused");
  });

  it("expires exactly after five minutes", () => {
    resetNonces();
    const issuedAt = 1_000_000;
    const { nonce, expiresAt } = issueNonce(AGREEMENT, issuedAt);
    assert.equal(expiresAt, issuedAt + NONCE_TTL_SECONDS);
    assert.equal(NONCE_TTL_SECONDS, 300, "the nonce lifetime is five minutes");
    assert.equal(
      consumeNonce(AGREEMENT, nonce, issuedAt + NONCE_TTL_SECONDS - 1),
      "ok",
      "valid one second before expiry",
    );

    resetNonces();
    const { nonce: fresh } = issueNonce(AGREEMENT, issuedAt);
    assert.equal(
      consumeNonce(AGREEMENT, fresh, issuedAt + NONCE_TTL_SECONDS),
      "expired",
      "expired exactly at expiry",
    );
  });

  it("is scoped to the agreement and rejects unknown nonces", () => {
    resetNonces();
    const { nonce } = issueNonce(AGREEMENT, 1_000_000);
    assert.equal(consumeNonce("some-other-agreement", nonce, 1_000_001), "unknown");
    assert.equal(consumeNonce(AGREEMENT, "not-issued", 1_000_001), "unknown");
    // Still usable afterwards: the cross-agreement attempt did not burn it.
    assert.equal(consumeNonce(AGREEMENT, nonce, 1_000_002), "ok");
  });

  it("builds the signed message the route documents", () => {
    assert.equal(
      uploadSignMessage(AGREEMENT, "n0nce"),
      `flint-evidence-upload:${AGREEMENT}:n0nce`,
    );
  });
});

describe("the external link helper", () => {
  it("returns the hostname for display on http(s)", () => {
    assert.equal(externalLinkHost("https://example.com/path?q=1"), "example.com");
    assert.equal(externalLinkHost("http://sub.domain.co.uk/x"), "sub.domain.co.uk");
    const parsed = parseExternalLink("https://example.com/a b");
    assert.ok(parsed !== null, "URL() percent-encodes the space");
    assert.ok(parsed.href.startsWith("https://example.com/"));
  });

  it("refuses non-http(s) schemes outright", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "ftp://example.com/f",
      "mailto:a@b.c",
      "not a url",
    ]) {
      assert.equal(parseExternalLink(bad), null, `${bad} must be refused`);
      assert.equal(externalLinkHost(bad), null);
    }
  });
});

describe("derived agreement state", () => {
  const NOW = 1_767_225_600;

  it("derives awaiting_payment, funded and terminal states", () => {
    assert.equal(deriveState(agreement({ status: "pending" }), NOW), "awaiting_payment");
    assert.equal(deriveState(agreement({ status: "funded" }), NOW), "funded");
    assert.equal(deriveState(agreement({ status: "released" }), NOW), "released");
    assert.equal(deriveState(agreement({ status: "refunded" }), NOW), "refunded");
    assert.equal(deriveState(agreement({ status: "cancelled" }), NOW), "cancelled");
    assert.equal(deriveState(agreement({ status: "split" }), NOW), "released");
  });

  it("derives expired only from the clock on an unclaimed agreement", () => {
    const before = agreement({ status: "funded", expiresAt: NOW + 1 });
    const after = agreement({ status: "funded", expiresAt: NOW - 1 });
    assert.equal(deriveState(before, NOW), "funded", "not yet expired");
    assert.equal(deriveState(after, NOW), "expired", "past expiry is expired");
    assert.equal(
      deriveState(agreement({ status: "pending", expiresAt: NOW - 1 }), NOW),
      "expired",
      "an unclaimable pending agreement past expiry is expired",
    );
  });

  it("never derives a claimed agreement to expired", () => {
    // The load-bearing rule (task item 2): once claimed, expires_at is
    // irrelevant — even far in the past — and the claim stays in review.
    const claimedLongAgo = agreement({
      status: "deliveryClaimed",
      claimedAt: NOW - 10,
      expiresAt: NOW - 1_000_000,
    });
    assert.notEqual(deriveState(claimedLongAgo, NOW), "expired");
    assert.equal(deriveState(claimedLongAgo, NOW), "delivered_in_review");

    // Same for a dispute raised off that claim.
    const disputed = agreement({
      status: "disputed",
      claimedAt: NOW - 10,
      disputedAt: NOW - 5,
      expiresAt: NOW - 1_000_000,
    });
    assert.notEqual(deriveState(disputed, NOW), "expired");
    assert.equal(deriveState(disputed, NOW), "disputed");
  });

  it("derives the review deadline as claimed_at plus the stored window", () => {
    const claimed = agreement({
      status: "deliveryClaimed",
      claimedAt: 1_000,
      reviewWindowSecs: 6 * 3600,
    });
    assert.equal(reviewWindowEnd(claimed), 1_000 + 6 * 3600);
    assert.equal(reviewWindowEnd(agreement({ claimedAt: null })), null, "no claim, no deadline");
  });

  it("names the viewer from the connected address and Config arbiter", () => {
    const base = agreement({ status: "deliveryClaimed" });
    const arbiter = "FyevbXfasafAe8nJWbe2rgMYtkKKx3PmfUGaBUtSvPCM";
    assert.equal(deriveViewer(base, RECIPIENT, arbiter), "recipient");
    assert.equal(deriveViewer(base, PAYER, arbiter), "payer");
    assert.equal(deriveViewer(base, arbiter, arbiter), "arbiter");
    assert.equal(deriveViewer(base, "11111111111111111111111111111111", arbiter), "visitor");
    assert.equal(deriveViewer(base, null, arbiter), null, "no wallet connected, no viewer");
    // A pending agreement has no payer: an address that is neither party nor
    // arbiter is honestly a visitor, not "the payer of nothing".
    assert.equal(
      deriveViewer(agreement({ payerAddress: null, status: "pending" }), PAYER, arbiter),
      "visitor",
    );
  });
});



