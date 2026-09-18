import assert from "node:assert/strict";
import test from "node:test";
import { compactLocalMcpResult, compactLocalNativeMcpResult, compactRemoteDoctorPayload } from "../host-runtime/scripts/trelio-mcp-results.mjs";
import { projectMcpAgentPayload } from "../host-runtime/scripts/trelio-agent-response-projection.mjs";
import { handleLocalMcpMessage } from "../host-runtime/scripts/trelio-remote-mcp.mjs";

test("local MCP emits one copy of successful data without altering hidden App capabilities", async () => {
  const structuredContent = { proposalId: "proposal", revision: 2, bodyText: "private proposal".repeat(500) };
  const metadata = { ui: { resourceUri: "ui://trelio/test" }, capabilityToken: "hidden-human-only" };
  const original = { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }], _meta: metadata };
  const response = await handleLocalMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture" } }, {
    callTool: async () => original,
  });
  assert.equal(response.result.structuredContent, structuredContent);
  assert.equal(response.result._meta, metadata);
  assert.doesNotMatch(response.result.content[0].text, /private proposal|hidden-human-only/u);
  assert.match(response.result.content[0].text, /structuredContent/u);
  assert.ok(JSON.stringify(response.result).length < JSON.stringify(original).length * 0.55);
  assert.equal(compactLocalMcpResult(response.result), response.result);
});

test("local MCP preserves errors, independent text, partial projections and mixed media", () => {
  const structuredContent = { a: 1, b: 2 };
  const duplicate = { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
  for (const result of [
    null,
    { ...duplicate, isError: true },
    { ...duplicate, content: [{ type: "text", text: "Human explanation" }] },
    { ...duplicate, content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] },
    { ...duplicate, content: [{ type: "text", text: JSON.stringify({ ...structuredContent, extra: "must survive" }) }] },
    { ...duplicate, content: [...duplicate.content, { type: "image", data: "image", mimeType: "image/png" }] },
    { content: duplicate.content },
  ]) assert.equal(compactLocalMcpResult(result), result);
});

test("local projection preserves hydrated notes, explicit states and arbitrary document keys", () => {
  const person = { memberId: "member", displayName: "Анна – закупки", userDisplayName: "Анна Иванова",
    displayNameOverride: "Анна – закупки", profileNote: "Отвечает за договоры", avatarUrl: "image", initials: "АИ", color: "slate" };
  const payload = { schemaVersion: 3, taskRevision: { id: "task", updatedAt: "exact" }, sections: {
    controls: { controls: [{ createdBy: person, permissions: { canClear: false }, note: null }] },
    custom_fields: { customFields: { color: "green", avatarUrl: "user-value" } },
  } };
  const expected = projectMcpAgentPayload("get_task_sections", payload);
  for (const original of [
    { content: [{ type: "text", text: JSON.stringify(payload) }] },
    { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }], _meta: { secret: "hidden" } },
  ]) {
    const result = compactLocalNativeMcpResult("get_task_sections", original);
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.deepEqual(value, expected);
    assert.equal(value.sections.controls.controls[0].createdBy.profileNote, person.profileNote);
    assert.equal(value.sections.controls.controls[0].createdBy.userDisplayName, person.userDisplayName);
    assert.equal("avatarUrl" in value.sections.controls.controls[0].createdBy, false);
    assert.equal(value.sections.controls.controls[0].permissions.canClear, false);
    assert.equal(value.sections.controls.controls[0].note, null);
    assert.deepEqual(value.sections.custom_fields, payload.sections.custom_fields);
    assert.equal(result._meta, original._meta);
  }
});

test("local exact reads restore selected deferred fields without changing errors or human App results", () => {
  const payload = { company: { slug: "demo" }, contact: { id: "contact", description: "Details" }, options: { contacts: ["Другой контакт\n".repeat(100)] } };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const compact = JSON.parse(compactLocalNativeMcpResult("get_contact", envelope).content[0].text);
  assert.equal(compact.deferredData.tool, "get_contact");
  assert.deepEqual(compact.deferredData.arguments.responseFields, ["options"]);
  const full = compactLocalNativeMcpResult(compact.deferredData.tool, envelope, compact.deferredData.arguments);
  assert.deepEqual(JSON.parse(full.content[0].text), payload);
  const error = { ...envelope, isError: true };
  assert.equal(compactLocalNativeMcpResult("get_contact", error), error);
  for (const tool of ["get_task_proposal_app_state", "render_task_proposals", "external_provider_tool"]) {
    assert.deepEqual(compactLocalNativeMcpResult(tool, envelope), envelope);
  }
});

test("local skill detail loads authority sections lazily and reuses only an exact in-context revision", () => {
  const payload = {
    instructionsValidUntil: "2026-09-16T10:00:00.000Z",
    companySlug: "demo",
    projectSlug: "mobile",
    updatePolicy: "current",
    skill: {
      id: "provider-skill",
      title: "Provider skill",
      version: "3.1.0",
      currentReleaseId: "release-3",
      readiness: { company: "configured", personal: "configured" },
      instructionsMarkdown: "Полные обязательные инструкции\n".repeat(300),
      connectionDefinition: { fields: [{ key: "account" }] },
      connection: { id: "connection", config: { account: "demo" }, secretBindings: [] },
      runtimeRequirements: { capabilities: ["network"] },
      runtimeRelease: {
        releaseId: "release-3",
        trustLevel: "company_unverified",
        manifest: { commands: ["run"] },
        publication: { id: "publication-3", summary: "Версия администратора" },
      },
      remoteMcp: null,
    },
    localIdentity: { companyId: "company", projectId: "project", connectionId: "connection" },
    runtimeExecution: {
      releaseId: "release-3",
      trust: { level: "company_unverified", publication: { id: "publication-3", summary: "Версия администратора" } },
      localAction: { schemaVersion: 1, operation: "skill_run", parameters: { releaseId: "release-3" } },
      command: ["legacy", "run"],
    },
    remoteMcpExecution: null,
  };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const baseArgs = { companySlug: "demo", projectSlug: "mobile", skillId: "provider-skill" };
  const summary = JSON.parse(compactLocalNativeMcpResult("get_agent_skill", envelope, baseArgs).content[0].text);
  assert.equal(summary.skill.instructionsMarkdown, undefined);
  assert.equal(summary.runtimeExecution, undefined);
  assert.deepEqual(summary.deferredData.sections, ["instructions", "connection", "execution", "publication"]);
  assert.match(summary.skill.instructionKey, /demo:mobile:provider-skill:release-3/u);

  const selectedArgs = { ...baseArgs, sections: ["instructions", "execution"] };
  const selected = JSON.parse(compactLocalNativeMcpResult("get_agent_skill", envelope, selectedArgs).content[0].text);
  assert.equal(selected.skill.instructionsMarkdown, payload.skill.instructionsMarkdown);
  assert.deepEqual(selected.runtimeExecution.localAction, payload.runtimeExecution.localAction);
  assert.equal(selected.runtimeExecution.command, undefined);
  assert.equal(selected.runtimeExecution.trust.publication, undefined);
  assert.equal(selected.runtimeExecution.trust.publicationSection, "publication");

  // A key is only an acknowledgement that the complete Markdown is still in
  // this model context; a different project creates a different key.
  const reused = JSON.parse(compactLocalNativeMcpResult("get_agent_skill", envelope, {
    ...selectedArgs,
    knownInstructionKey: summary.skill.instructionKey,
  }).content[0].text);
  assert.equal(reused.skill.instructionsMarkdown, undefined);
  assert.deepEqual(reused.responseProjection.includedSections, ["execution"]);
  assert.deepEqual(reused.responseProjection.reusedSections, ["instructions"]);
  const otherProject = projectMcpAgentPayload("get_agent_skill", { ...payload, projectSlug: "other" }, {
    ...selectedArgs,
    projectSlug: "other",
    knownInstructionKey: summary.skill.instructionKey,
  });
  assert.equal(otherProject.skill.instructionsMarkdown, payload.skill.instructionsMarkdown);
  const legacyEnvelope = { content: [{ type: "text", text: JSON.stringify({
    ...payload,
    runtimeExecution: { releaseId: "release-3", trust: { level: "platform_verified" }, command: ["legacy", "only"] },
  }) }] };
  const legacyOnly = JSON.parse(compactLocalNativeMcpResult(
    "get_agent_skill", legacyEnvelope, { ...baseArgs, sections: ["execution"] },
  ).content[0].text);
  assert.deepEqual(legacyOnly.runtimeExecution.command, ["legacy", "only"]);
});

test("local task mutation returns a compact receipt with an exact section continuation", () => {
  const payload = {
    ok: true,
    action: "update_task_title",
    replayed: false,
    task: {
      id: "task-id", number: 61, updatedAt: "revision", title: "Новый заголовок",
      descriptionPlainText: "Полное описание\n".repeat(500),
      descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
      commentsIncluded: true,
      comments: Array.from({ length: 40 }, (_, index) => ({ id: `comment-${index}`, content: "Контекст" })),
      checklists: [{ id: "checklist" }],
      availableMembers: Array.from({ length: 20 }, (_, index) => ({ memberId: `member-${index}`, displayName: `Участник ${index}` })),
    },
    document: { id: "task:demo/mobile/61", url: "/demo/mobile/tasks/61/", text: "duplicate", metadata: { company: "demo", project: "mobile", taskNumber: 61 } },
  };
  const compact = projectMcpAgentPayload("update_task_title", payload, {
    companySlug: "demo", projectSlug: "mobile", taskNumber: 61,
  });
  assert.equal(compact.task.comments, undefined);
  assert.equal(compact.task.descriptionJson, undefined);
  assert.equal(compact.task.availableMembers, undefined);
  assert.equal(compact.document.text, undefined);
  assert.equal(compact.task.summary.descriptionTruncated, true);
  assert.equal(compact.task.deferredSections.tool, "get_task_sections");
  assert.deepEqual(compact.task.deferredSections.arguments.companySlug, "demo");
  assert.ok(JSON.stringify(compact).length < JSON.stringify(payload).length * 0.25);
});

test("local task update plan preserves the decision surface without the repeated full task", () => {
  const payload = {
    dryRun: true,
    ok: false,
    task: {
      id: "task-id",
      number: 61,
      permissions: { canEditTask: true },
      descriptionPlainText: "Полное описание\n".repeat(500),
      descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
      commentsIncluded: true,
      commentsPagination: { total: 40 },
      comments: Array.from({ length: 5 }, (_, index) => ({ id: `comment-${index}`, content: "Контекст" })),
      availableMembers: Array.from({ length: 20 }, (_, index) => ({ memberId: `member-${index}`, displayName: `Участник ${index}` })),
      templates: Array.from({ length: 10 }, (_, index) => ({ id: `template-${index}` })),
    },
    requestedChanges: [{ field: "dueAt", value: "2026-09-20" }],
    validationMessages: ["Missing update scope"],
    absenceConflicts: [{ memberId: "member-1", startsAt: "2026-09-19", endsAt: "2026-09-21" }],
    requiresAbsenceConflictAcknowledgement: true,
  };
  const compact = projectMcpAgentPayload("plan_task_update", payload, {
    companySlug: "demo", projectSlug: "mobile", taskNumber: 61,
  });
  assert.deepEqual(compact.requestedChanges, payload.requestedChanges);
  assert.deepEqual(compact.validationMessages, payload.validationMessages);
  assert.deepEqual(compact.absenceConflicts, payload.absenceConflicts);
  assert.equal(compact.task.comments, undefined);
  assert.equal(compact.task.availableMembers, undefined);
  assert.equal(compact.task.templates, undefined);
  assert.equal(compact.task.deferredSections.tool, "get_task_sections");
  assert.equal(compact.task.deferredSections.available.find(({ name }) => name === "comments").itemCount, 40);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(payload).length * 0.3);
});

test("local project reads defer specialist metadata and reuse only exact authority bytes", () => {
  const revisionKey = "a".repeat(64);
  const effectiveInstructions = {
    schemaVersion: 1,
    status: "loaded",
    revisionKey,
    workingRules: {
      platformRevision: { id: "platform", version: 1, sha256: "b".repeat(64) },
      companyRevision: null,
      projectRevision: null,
      compiledMarkdown: "Точные правила\n".repeat(500),
    },
    personalProfile: { revisionId: "profile", version: 1, compiledMarkdown: "Профиль\n".repeat(100) },
  };
  const statuses = [{ id: "status", code: "queue" }];
  const payload = {
    effectiveInstructions,
    company: { slug: "demo" },
    project: { slug: "mobile" },
    statuses,
    taskCreate: { statuses, defaults: { statusCode: "queue", urgency: 0 } },
    taskCustomFields: { companyFields: Array.from({ length: 20 }, (_, index) => ({ id: `field-${index}` })) },
    taskTemplates: Array.from({ length: 20 }, (_, index) => ({ id: `template-${index}` })),
    availableMembers: [{ memberId: "member", displayName: "Анна" }],
    availableMemberGroups: [],
    members: [{ memberId: "member", displayName: "Анна" }],
    memberGroups: [],
  };
  const cold = projectMcpAgentPayload("get_project_meta", payload, {
    companySlug: "demo", projectSlug: "mobile",
  });
  assert.equal(cold.taskTemplates, undefined);
  assert.equal(cold.taskCustomFields, undefined);
  assert.equal(cold.members, undefined);
  assert.equal(cold.taskCreate.statuses, undefined);
  assert.deepEqual(cold.effectiveInstructions.nextReadArguments, { knownInstructionRevisionKey: revisionKey });

  const warm = projectMcpAgentPayload("get_project_meta", payload, {
    companySlug: "demo", projectSlug: "mobile", knownInstructionRevisionKey: revisionKey,
  });
  assert.equal(warm.effectiveInstructions.workingRules.compiledMarkdown, undefined);
  assert.equal(warm.effectiveInstructions.personalProfile.compiledMarkdown, undefined);
  assert.equal(warm.effectiveInstructions.reusedInstructionRevisionKey, revisionKey);

  const stale = projectMcpAgentPayload("get_task_create_meta", {
    effectiveInstructions,
    project: { slug: "mobile" },
    statuses,
    availableMembers: [],
    availableMemberGroups: [],
  }, { knownInstructionRevisionKey: "c".repeat(64) });
  assert.equal(stale.effectiveInstructions.workingRules.compiledMarkdown, effectiveInstructions.workingRules.compiledMarkdown);
  assert.equal(stale.effectiveInstructions.reusedInstructionRevisionKey, undefined);
});

test("local regular-work detail uses the generated native response projection", () => {
  const payload = {
    company: { slug: "demo" },
    project: { slug: "mobile" },
    set: { id: "99999999-9999-4999-8999-999999999999", revision: 4 },
    items: [{ id: "item-1", revision: 2 }],
    current: [{ id: "occurrence-1", isDone: false }],
    history: { occurrences: Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}` })) },
    preparation: { missing: [] },
    options: { availableMembers: [{ memberId: "member", displayName: "Анна", avatarUrl: "image" }] },
  };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const compact = JSON.parse(compactLocalNativeMcpResult(
    "get_regular_work",
    envelope,
    { companySlug: "demo", projectSlug: "mobile", setId: "99999999-9999-4999-8999-999999999999" },
  ).content[0].text);
  assert.equal(compact.deferredData.tool, "get_regular_work");
  assert.deepEqual(compact.deferredData.fields, ["history", "preparation", "options"]);
  assert.deepEqual(compact.items, payload.items);
  assert.deepEqual(compact.current, payload.current);

  const selected = JSON.parse(compactLocalNativeMcpResult(
    "get_regular_work",
    envelope,
    compact.deferredData.arguments,
  ).content[0].text);
  assert.deepEqual(selected.history, payload.history);
  assert.deepEqual(selected.preparation, payload.preparation);
  assert.equal(selected.options.availableMembers[0].displayName, "Анна");
  assert.equal(selected.options.availableMembers[0].avatarUrl, undefined);

  const full = JSON.parse(compactLocalNativeMcpResult(
    "get_regular_work",
    envelope,
    { companySlug: "demo", projectSlug: "mobile", setId: payload.set.id, responseDetail: "full" },
  ).content[0].text);
  assert.deepEqual(full, payload, "Compatibility full read still exposes the original hydrated DTO");
});

test("local file read carries exactly one full copy with revision and coverage", () => {
  const payload = { text: "Большой файл\n".repeat(500), revisionHead: "exact-head", truncated: true, nextOffset: 500 };
  const original = { structuredContent: payload, content: [{ type: "text", text: payload.text }] };
  const compact = compactLocalNativeMcpResult("get_agent_workspace_file", original);
  assert.equal(compact.structuredContent, payload);
  assert.doesNotMatch(compact.content[0].text, /Большой файл/);
  assert.equal(compactLocalNativeMcpResult("external_provider_tool", original).content, original.content);
});

test("provider doctor omits only unselected schemas, and exact read restores required arguments", () => {
  const payload = { ok: true, toolPolicy: "all_read_only", configFingerprint: "fingerprint", ignoredTools: [{ name: "write", reason: "write_like_name" }], tools: [
    { name: "read_one", description: "Find records", annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", required: ["sourceId"], properties: { sourceId: { type: "string" } }, additionalProperties: false } },
    { name: "read_two", description: "Read a second domain", inputSchema: { type: "object", required: ["revision"] } },
  ] };
  const args = { companySlug: "demo", projectSlug: "project", skillId: "generic-skill" };
  const catalog = compactRemoteDoctorPayload(payload, args);
  assert.equal(catalog.tools.length, 2);
  assert.equal(catalog.tools[0].inputSchema, undefined);
  assert.deepEqual(catalog.ignoredTools, payload.ignoredTools);
  assert.equal(catalog.configFingerprint, payload.configFingerprint);
  assert.deepEqual(catalog.schemaSelection.arguments, args);
  const exact = compactRemoteDoctorPayload(payload, { ...catalog.schemaSelection.arguments, schemaToolName: "read_one" });
  assert.deepEqual(exact.tools[0], payload.tools[0]);
  assert.equal(exact.tools[1].inputSchema, undefined);
  assert.equal(exact.schemaSelection.found, true);
  assert.equal(compactRemoteDoctorPayload(payload, { ...args, schemaToolName: "unknown" }).schemaSelection.found, false);
  assert.equal(payload.tools[0].inputSchema.required[0], "sourceId", "Original doctor/credential validation result stays intact");
});
