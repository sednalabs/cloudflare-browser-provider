/**
 * @name External action is not pinned to a commit
 * @description Detects external GitHub Actions references that do not use a full commit SHA.
 * @kind problem
 * @problem.severity error
 * @security-severity 7.5
 * @precision high
 * @id cloudflare-browser-provider/unpinned-external-action
 * @tags actions
 *       security
 *       external/cwe/cwe-829
 */

import actions
import WorkflowPolicy

from UsesStep step, string callee, string version
where
  callee = step.getCallee() and
  version = step.getVersion() and
  externalActionReference(callee) and
  not pinnedActionVersion(version)
select step,
  "Pin the external action '" + callee + "@" + version +
    "' to a reviewed full-length commit SHA and keep update automation enabled."
