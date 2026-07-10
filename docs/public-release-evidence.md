# Public Release Evidence

Release classification: Release Track.

Target repository: `sednalabs/cloudflare-browser-provider`.

## License decision

The release owner approved delivery of the repository work item whose explicit scope requires
Apache-2.0 licensing and attribution. The tracked `LICENSE`, package metadata, contributor terms,
dependency license, and source-harvest notices consistently use Apache-2.0.

## Publication scan review

The bootstrap public commit passed the release scanner with no findings. The implementation tree is
scanned again before every public push.

The release workflow intentionally has job-scoped `contents: write`, `id-token: write`, and
`attestations: write` permissions. This is a reviewed exception required to publish a GitHub release
and provenance attestations. The workflow has only version-tag and explicit manual triggers, checks
out the existing tag, does not consume repository or environment secrets, and never runs for pull
request content.

## Finish criteria

- Hosted CI, dependency review, custom query tests, advanced CodeQL, and Code Quality pass on the
  audited default-branch commit.
- Public-repository secret scanning, push protection, non-provider patterns, validity checks,
  Dependabot, read-only default tokens, and SHA pinning are enabled or have an exact documented
  product/permission blocker.
- The default branch requires the hosted checks and restricts landing to the release owner.
- A release archive, SBOM, checksums, and build-provenance attestation are published from the
  audited tag.
- Open CodeQL, secret-scanning, Dependabot, and Code Quality findings are zero or explicitly
  triaged.
