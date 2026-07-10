import actions

predicate forbiddenPublicTrigger(Event event) { event.getName() = "pull_request_target" }

bindingset[callee]
predicate externalActionReference(string callee) {
  not callee.regexpMatch("^\\./.*") and
  not callee.regexpMatch("^docker://.*")
}

bindingset[callee]
predicate pinnedActionReference(string callee) {
  callee.regexpMatch("^[^@]+@[0-9a-fA-F]{40}$")
}

bindingset[command]
predicate releasePublishingCommand(string command) {
  command.regexpMatch("(?is).*\\bgh\\s+release\\s+(create|upload|edit)\\b.*")
  or
  command.regexpMatch("(?is).*\\bnpm\\s+publish\\b.*")
}

predicate jobPublishesRelease(Job job) {
  exists(Run run |
    run.getEnclosingJob() = job and
    releasePublishingCommand(run.getScript().getACommand())
  )
}

predicate jobAttestsArtifacts(Job job) {
  exists(UsesStep step |
    step.getEnclosingJob() = job and
    step.getCallee().regexpMatch("(?i)^actions/attest-build-provenance@[0-9a-f]{40}$")
  )
}
