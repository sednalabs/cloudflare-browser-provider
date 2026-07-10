/**
 * @name Release publication lacks artifact attestation
 * @description Detects a release publishing job that does not create GitHub build provenance.
 * @kind problem
 * @problem.severity error
 * @security-severity 7.8
 * @precision high
 * @id cloudflare-browser-provider/release-without-attestation
 * @tags actions
 *       security
 *       external/cwe/cwe-353
 */

import actions
import WorkflowPolicy

from Job job
where jobPublishesRelease(job) and not jobAttestsArtifacts(job)
select job,
  "This job publishes a release without actions/attest-build-provenance. Attest the packaged assets before publication."
