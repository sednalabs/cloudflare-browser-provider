/**
 * @name Forbidden public workflow trigger
 * @description Detects trusted pull request target workflows in this public repository.
 * @kind problem
 * @problem.severity error
 * @security-severity 8.2
 * @precision high
 * @id cloudflare-browser-provider/forbidden-public-workflow-trigger
 * @tags actions
 *       security
 *       external/cwe/cwe-266
 */

import actions
import WorkflowPolicy

from Job job, Event event
where event = job.getATriggerEvent() and forbiddenPublicTrigger(event)
select job,
  "This public workflow uses pull_request_target. Use pull_request with read-only permissions and keep trusted publication in a separate protected workflow."
