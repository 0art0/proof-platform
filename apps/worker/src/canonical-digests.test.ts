import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { definitionHash } from "./approved-catalog";
import { artifactDigest } from "./artifact-export";

// Golden tests: these digests are persisted (artifact files, definition hashes in stored rows and
// interaction events), so the canonical JSON they hash must never change byte-for-byte.

const GOLDEN_INPUT = {
  z: [3, -1.5, 1e21, 0.1, -0, 2e-7, 123456789012345680000],
  a: {
    é: 'ünïcødé ∀x. x≥0   "quoted" \\ \n\t\u0001',
    "10": true,
    "2": false,
    "": null,
    B: "upper",
    b: "lower",
  },
  m: [["Add", 1, { sym: "x" }], { fn: ["Sin", "Pi"] }, [], {}],
  emoji: "😀 \ud800",
};

describe("persisted canonical digests (golden)", () => {
  it("definitionHash hashes sorted-key canonical JSON and drops undefined properties", () => {
    expect(definitionHash(GOLDEN_INPUT)).toBe(
      "sha256:d82ec65f6d13435c5ae476b98c502401943a006625637ea268fc4be600c5b434",
    );
    expect(definitionHash({ b: 1, a: undefined, c: [undefined, { d: undefined }] })).toBe(
      "sha256:902fe9e58c6d249aba11537ea0eda00eb8704779181080c10d8c2a75f2ab353b",
    );
  });

  it("artifactDigest reproduces the recorded digest of the reviewed artifact fixtures", () => {
    for (const name of ["proof-artifact.json", "proof-artifact-v2.json"]) {
      const artifact = JSON.parse(
        readFileSync(
          new URL(`../../web/src/features/discovery-viewer/fixtures/${name}`, import.meta.url),
          "utf8",
        ),
      ) as { digest: string };
      expect(artifactDigest(artifact)).toBe(artifact.digest);
    }
    expect(artifactDigest({ ...GOLDEN_INPUT, digest: "ignored" })).toBe(
      "sha256:d82ec65f6d13435c5ae476b98c502401943a006625637ea268fc4be600c5b434",
    );
  });
});
