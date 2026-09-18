// Generated portable Trelio response contract. Do not edit by hand.
import { createHash } from "node:crypto";
export const MCP_RESPONSE_PROJECTION_VERSION = 2;
export const MCP_RESPONSE_DETAIL_TOOLS = new Set([
    "get_contact", "get_registry", "get_knowledge_base_page", "get_project_meta",
    "get_task_create_meta", "get_regular_work", "list_recent_activity", "list_agent_skills",
    "get_agent_skill", "get_agent_workspace", "get_agent_workspace_by_scope",
    "list_agent_secrets", "get_agent_instructions", "get_workspace", "fetch",
    "list_company_activity",
]);
export const MCP_RESPONSE_FIELD_TOOLS = {
    get_contact: ["richText", "options"],
    get_project_meta: ["taskCustomFields", "taskTemplates", "members", "memberGroups"],
    get_registry: ["richText", "history", "comments", "commentsPagination", "mentionableMembers"],
    get_knowledge_base_page: ["richText", "pages"],
    get_regular_work: ["richText", "history", "preparation", "options", "mentionableMembers"],
    list_recent_activity: ["feeds", "filterOptions"],
};
// These two project reads resolve the same current authority for the same
// authenticated member. The caller may reuse that immutable payload across the
// pair, but only while the exact revision key and the full previous bytes still
// exist in the current model context.
export const MCP_EFFECTIVE_INSTRUCTION_REUSE_TOOLS = new Set([
    "get_agent_instructions",
    "get_workspace",
    "fetch",
    "get_project_meta",
    "get_task_create_meta",
]);
export const MCP_AGENT_SKILL_SECTION_NAMES = [
    "instructions", "connection", "execution", "publication",
];
const record = (value) => (value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value : null);
const own = (value, key) => Object.hasOwn(value, key);
const mapArray = (value, project) => (Array.isArray(value) ? value.map(project) : value);
const mapFields = (value, fields) => {
    const source = record(value);
    if (!source)
        return value;
    const result = { ...source };
    for (const [key, project] of Object.entries(fields)) {
        if (own(source, key))
            result[key] = project(source[key]);
    }
    return result;
};
const list = (project) => (value) => mapArray(value, project);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const stringArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
// Явный набор смысловых полей человека/группы. Если service добавит неизвестное
// поле, сохраняем весь объект: новый смысл нельзя потерять молча. Budget fixtures
// на настоящих builders заметят возврат оформления и потребуют классификации.
const PERSON_FIELDS = new Set([
    "id", "memberId", "userId", "groupId", "displayName", "userDisplayName",
    "displayNameOverride", "username", "name", "profileNote", "lastSeenAt",
    "companyRole", "projectRole", "role", "entityType", "memberCount",
    "isPlaceholder", "isActive", "availability", "permissions", "profilePath",
    "absence", "substitution", "status", "canSelect", "disabledReason",
    "avatarUrl", "initials", "color", "members",
]);
export const projectMcpPerson = (value) => {
    const person = record(value);
    if (!person || Object.keys(person).some((key) => !PERSON_FIELDS.has(key)))
        return value;
    const result = Object.fromEntries(Object.entries(person).filter(([key]) => (key !== "avatarUrl" && key !== "initials" && key !== "color")));
    // Effective name уже сформирован canonical member builder. Удалять отличающееся
    // исходное имя нельзя: оно может объяснять совпадение поиска или различать людей.
    // Null/false в профильных заметках, доступе и состоянии сохраняются буквально.
    for (const key of ["userDisplayName", "displayNameOverride"]) {
        if (typeof result.displayName === "string" && result[key] === result.displayName)
            delete result[key];
    }
    if (Array.isArray(result.members))
        result.members = result.members.map(projectMcpPerson);
    return result;
};
const person = projectMcpPerson;
const persons = list(person);
const control = (value) => mapFields(value, { createdBy: person });
const attachment = (value) => mapFields(value, { uploadedBy: person, deletedBy: person });
const memberLink = (value) => mapFields(value, { member: person });
const comment = (value) => {
    const source = record(mapFields(value, { author: person, createdBy: person, actor: person }));
    if (!source)
        return value;
    const { avatarUrl: _avatar, initials: _initials, ...result } = source;
    // content/entries содержат пользовательский rich text и immutable audit.
    // Их поля и прошлые значения сохраняются, даже если они похожи на UI metadata.
    return result;
};
const checklist = (value) => mapFields(value, {
    createdBy: person,
    items: list((item) => mapFields(item, { createdBy: person, completedBy: person, assignee: person })),
});
const task = (value) => mapFields(value, {
    assignee: person, createdBy: person, participants: persons, participantGroups: persons,
    availableMembers: persons, availableMemberGroups: persons, mentionableMembers: persons,
    controls: list(control), comments: list(comment), checklists: list(checklist),
    attachments: list(attachment), deletedAttachments: list(attachment),
    subscriptions: list(memberLink), substitution: (item) => mapFields(item, { member: person }),
});
const TASK_LIST_ENTITY_FIELDS = {
    project: "projects",
    status: "statuses",
    createdBy: "actors",
    assignee: "actors",
};
/**
 * Списки задач повторяют один и тот же project/status/member DTO десятки раз.
 * Словарь остаётся полностью обратимым: в него попадает exact projected JSON,
 * а строка получает zero-based ref. Неизвестные поля сущности не теряются.
 */
const projectTaskListPayload = (value) => {
    if (!Array.isArray(value.tasks) || value.tasks.length < 2 || record(value.taskListEntities)) {
        return value;
    }
    const topLevelCompany = record(value.company);
    const topLevelProject = record(value.project);
    const dictionaries = {
        projects: [],
        statuses: [],
        actors: [],
    };
    const indexes = {
        projects: new Map(),
        statuses: new Map(),
        actors: new Map(),
    };
    const intern = (dictionaryName, entity) => {
        const serialized = JSON.stringify(entity);
        const dictionaryIndex = indexes[dictionaryName];
        const dictionary = dictionaries[dictionaryName];
        const existing = dictionaryIndex.get(serialized);
        if (existing !== undefined)
            return existing;
        const index = dictionary.length;
        dictionary.push(entity);
        dictionaryIndex.set(serialized, index);
        return index;
    };
    const sharedTaskFields = new Set();
    const tasks = value.tasks.map((rawTask) => {
        const source = record(rawTask);
        if (!source)
            return rawTask;
        const result = { ...source };
        // Company/project already present on the envelope are the canonical value
        // for rows with the exact same bytes. A mismatch remains inline fail-safe.
        if (own(source, "company") && topLevelCompany && equal(source.company, topLevelCompany)) {
            delete result.company;
            sharedTaskFields.add("company");
        }
        if (own(source, "project") && topLevelProject && equal(source.project, topLevelProject)) {
            delete result.project;
            sharedTaskFields.add("project");
        }
        for (const [field, dictionaryName] of Object.entries(TASK_LIST_ENTITY_FIELDS)) {
            if (!own(result, field) || source[field] === null || !record(source[field]))
                continue;
            result[`${field}Ref`] = intern(dictionaryName, source[field]);
            delete result[field];
        }
        if (Array.isArray(source.participants) && source.participants.every((item) => record(item))) {
            result.participantRefs = source.participants.map((item) => intern("actors", item));
            delete result.participants;
        }
        return result;
    });
    const taskListEntities = Object.fromEntries(Object.entries(dictionaries).filter(([, entities]) => entities.length > 0));
    const candidate = {
        ...value,
        tasks,
        ...(Object.keys(taskListEntities).length ? { taskListEntities, taskListRefBase: 0 } : {}),
        ...(sharedTaskFields.size ? { sharedTaskFields: [...sharedTaskFields] } : {}),
    };
    // Маленькая страница может стать больше из-за заголовка словарей. В таком
    // случае возвращаем прежний lossless payload, а не навязываем новый формат.
    return JSON.stringify(candidate).length < JSON.stringify(value).length ? candidate : value;
};
const proposalInstructionKey = (instruction) => (`task-proposal-instruction-sha256:${createHash("sha256").update(instruction).digest("hex")}`);
const projectInstructionField = (value) => {
    const source = record(value);
    if (!source || typeof source.instruction !== "string")
        return value;
    const { instruction, ...rest } = source;
    return { ...rest, instructionKey: proposalInstructionKey(instruction) };
};
/**
 * Эти prose-инструкции статичны и уже входят в versioned tool description /
 * выбранный skill. В model-facing ответе достаточно content-addressed key:
 * изменение хотя бы одного байта автоматически создаёт другую версию.
 */
const projectProposalInstructions = (value, includeEnvelopeInstruction = false) => {
    const hasProjectedInstruction = [
        value.proposalAuthoring,
        value.authoringBasis,
        value.publicCommentsSnapshot,
        value.pendingHumanUpdateBasis,
    ].some((item) => typeof record(item)?.instruction === "string")
        || (includeEnvelopeInstruction && typeof value.instruction === "string");
    let result = mapFields(value, {
        proposalAuthoring: projectInstructionField,
        authoringBasis: projectInstructionField,
        publicCommentsSnapshot: projectInstructionField,
        pendingHumanUpdateBasis: projectInstructionField,
    });
    if (includeEnvelopeInstruction && typeof result.instruction === "string") {
        const instruction = result.instruction;
        result = { ...result, instructionKey: proposalInstructionKey(instruction) };
        delete result.instruction;
    }
    return hasProjectedInstruction
        ? { ...result, proposalInstructionSource: "tool_description" }
        : result;
};
const PROPOSAL_SHARED_ENTITY_FIELDS = {
    run: "runs",
    contextRequest: "contextRequests",
    company: "companies",
    project: "projects",
    task: "tasks",
};
/**
 * Bundle сохраняет независимые stateRevision/CAS/snapshot поля inline. Только
 * одинаковые координаты цели переносятся в общие словари и заменяются ref.
 */
const projectTaskReviewContext = (value) => {
    const rawContexts = record(value.proposalContexts);
    if (!rawContexts || record(value.proposalEntities))
        return value;
    const projectedContexts = Object.fromEntries(Object.entries(rawContexts).map(([kind, contextValue]) => {
        const context = record(contextValue);
        return [kind, context ? projectProposalInstructions(context) : contextValue];
    }));
    const counts = new Map();
    for (const contextValue of Object.values(projectedContexts)) {
        const context = record(contextValue);
        if (!context)
            continue;
        for (const field of Object.keys(PROPOSAL_SHARED_ENTITY_FIELDS)) {
            if (!own(context, field) || context[field] === null || !record(context[field]))
                continue;
            const key = `${field}:${JSON.stringify(context[field])}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const dictionaries = {};
    const indexes = new Map();
    const contexts = Object.fromEntries(Object.entries(projectedContexts).map(([kind, contextValue]) => {
        const context = record(contextValue);
        if (!context)
            return [kind, contextValue];
        const result = { ...context };
        for (const [field, dictionaryName] of Object.entries(PROPOSAL_SHARED_ENTITY_FIELDS)) {
            if (!own(context, field) || context[field] === null || !record(context[field]))
                continue;
            const serialized = JSON.stringify(context[field]);
            const identity = `${field}:${serialized}`;
            if ((counts.get(identity) ?? 0) < 2)
                continue;
            const entities = dictionaries[dictionaryName] ??= [];
            let index = indexes.get(identity);
            if (index === undefined) {
                index = entities.length;
                entities.push(context[field]);
                indexes.set(identity, index);
            }
            result[`${field}Ref`] = index;
            delete result[field];
        }
        return [kind, result];
    }));
    const candidate = projectProposalInstructions({
        ...value,
        proposalContexts: contexts,
        ...(Object.keys(dictionaries).length ? {
            proposalEntities: dictionaries,
            proposalEntityRefBase: 0,
        } : {}),
    }, true);
    return JSON.stringify(candidate).length < JSON.stringify(value).length ? candidate : value;
};
const proposalContextTools = new Set([
    "get_task_comment_proposal_context", "get_task_status_proposal_context",
    "get_task_control_clear_proposal_context", "get_task_checklist_proposal_context",
]);
const taskMutationTools = new Set([
    "create_task", "apply_task_patch", "update_task_title", "update_task_description",
    "update_task_status", "update_task_due_date", "update_task_urgency", "update_task_assignee",
    "set_task_participants", "update_task_custom_field", "move_task_to_project", "create_subtask",
    "convert_checklist_item_to_subtask", "create_checklist", "update_checklist", "delete_checklist",
    "add_checklist_items", "complete_checklist_item", "create_task_control", "update_task_control",
    "clear_task_control", "delete_attachment", "upload_attachment", "upload_inline_image",
]);
const taskReadTools = new Set([
    "get_task", "get_tasks", "get_task_sections", "get_task_review_context", "plan_task_update",
    "get_task_activity", "list_my_tasks", "list_project_tasks", "search_tasks",
]);
const contactTools = new Set([
    "get_contact", "create_contact", "update_contact", "list_contacts",
    "create_contact_comment", "update_contact_comment",
]);
const registryTools = new Set([
    "get_registry", "create_registry", "update_registry_definition", "upsert_registry_rows",
    "archive_registry_rows", "set_registry_workspaces", "set_registry_tasks", "list_registries",
]);
const meetingTools = new Set([
    "get_meeting", "create_meeting", "set_meeting_access", "record_meeting_result",
    "plan_meeting_context_updates", "confirm_meeting_context_updates", "record_meeting_context_update_outcome",
]);
const regularWorkTools = new Set([
    "get_regular_work", "create_or_update_regular_work", "complete_regular_check",
]);
const peopleTools = new Set([
    "get_project_meta", "get_task_create_meta", "resolve_user", "resolve_company_member", "resolve_status",
]);
const SEARCH_RESULT_FIELDS = new Set([
    "id", "title", "url", "type", "scope", "document", "matches",
    "matchedQueries", "matchCount", "preview",
]);
const SEARCH_SCOPE_FIELDS = new Set([
    "company", "project", "workspace", "task", "registry",
    "knowledgeBasePage", "contact", "regularWork",
]);
const SEARCH_MATCH_FIELDS = new Set([
    "query", "source", "previewText", "lexicalQuality", "resultRank", "registryRow",
]);
const SEARCH_REGISTRY_ROW_FIELDS = new Set(["id", "rowKey", "verificationStatus"]);
const SEARCH_DOCUMENT_FIELDS = new Set([
    "path", "name", "contentType", "sizeBytes", "snippet", "artifactType", "verificationStatus",
]);
const SEARCH_SCOPE_ENTITY_FIELDS = {
    company: new Set(["id", "slug", "name"]),
    project: new Set(["id", "slug", "name", "url"]),
    workspace: new Set(["id", "title", "state", "head", "scopeType", "scopeKey"]),
    task: new Set(["id", "number", "title", "url", "isArchived", "archivedAt"]),
    registry: new Set(["id", "slug", "title", "scopeType", "state", "schemaRevision", "url"]),
    knowledgeBasePage: new Set(["id", "slug", "title", "url", "updatedAt"]),
    contact: new Set(["id", "kind", "displayName", "url", "revision"]),
    regularWork: new Set(["id", "title", "state", "revision", "url"]),
};
const hasOnlyFields = (value, fields) => (Object.keys(value).every((key) => fields.has(key)));
const definedEntries = (value) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined));
const projectMcpContextSearchResult = (value) => {
    const result = record(value);
    const scope = record(result?.scope);
    const matches = Array.isArray(result?.matches) ? result.matches.map(record) : null;
    const document = record(result?.document);
    const knownScopeEntities = scope && Object.entries(SEARCH_SCOPE_ENTITY_FIELDS).every(([key, fields]) => {
        const entity = record(scope[key]);
        return scope[key] === null || scope[key] === undefined
            || (entity !== null && hasOnlyFields(entity, fields));
    });
    if (!result
        || !scope
        || !matches
        || !knownScopeEntities
        || (result.document !== null && (!document || !hasOnlyFields(document, SEARCH_DOCUMENT_FIELDS)))
        || matches.some((match) => !match)
        || !hasOnlyFields(result, SEARCH_RESULT_FIELDS)
        || !hasOnlyFields(scope, SEARCH_SCOPE_FIELDS)
        || matches.some((match) => !hasOnlyFields(match, SEARCH_MATCH_FIELDS))) {
        return value;
    }
    const registryRows = matches.flatMap((match) => {
        const row = record(match.registryRow);
        if (!row)
            return [];
        // A future row field may carry semantic evidence. In that case retain the
        // complete result until this projection is explicitly reviewed.
        if (!hasOnlyFields(row, SEARCH_REGISTRY_ROW_FIELDS))
            return [null];
        return [definedEntries({ rowKey: row.rowKey, verificationStatus: row.verificationStatus })];
    });
    if (registryRows.some((row) => row === null))
        return value;
    const company = record(scope.company);
    const project = record(scope.project);
    const workspace = record(scope.workspace);
    const taskScope = record(scope.task);
    const registry = record(scope.registry);
    const page = record(scope.knowledgeBasePage);
    const contact = record(scope.contact);
    const regularWork = record(scope.regularWork);
    const locator = definedEntries({
        companySlug: company?.slug,
        projectSlug: project?.slug,
        workspaceId: workspace?.id,
        workspaceHead: workspace?.head,
        taskId: taskScope?.id,
        taskNumber: taskScope?.number,
        registrySlug: registry?.slug,
        pageSlug: page?.slug,
        contactId: contact?.id,
        regularWorkId: regularWork?.id,
        documentPath: document?.path,
    });
    const state = definedEntries({
        workspace: workspace?.state,
        taskArchived: taskScope?.isArchived,
        taskArchivedAt: taskScope?.archivedAt,
        registry: registry?.state,
        regularWork: regularWork?.state,
        artifactType: document?.artifactType,
        verificationStatus: document?.verificationStatus,
    });
    const matchedSources = [...new Set(matches
            .map((match) => match.source)
            .filter((source) => typeof source === "string"))];
    return definedEntries({
        id: result.id,
        type: result.type,
        title: result.title,
        url: result.url,
        matchedQueries: result.matchedQueries,
        preview: result.preview,
        locator: Object.keys(locator).length ? locator : undefined,
        state: Object.keys(state).length ? state : undefined,
        matchedSources: matchedSources.length ? matchedSources : undefined,
        matchedRows: registryRows.length ? registryRows : undefined,
    });
};
const projectMcpContextSearch = (payload) => mapFields(payload, {
    results: list(projectMcpContextSearchResult),
});
const projectTaskPayload = (payload) => mapFields(payload, {
    task, tasks: list((item) => {
        const entry = record(item);
        return entry && own(entry, "task") ? mapFields(entry, { task }) : task(item);
    }),
    controls: list(control), checklists: list(checklist), comments: list(comment),
    sections: (value) => {
        const sections = record(value);
        if (!sections)
            return value;
        return Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, task(section)]));
    },
});
const addDeferred = (payload, fields, readBack, rawArguments = {}, virtualFields = []) => {
    if (own(payload, "deferredData"))
        return payload;
    const present = fields.filter((field) => own(payload, field));
    const requested = new Set(stringArray(rawArguments.responseFields));
    let result = { ...payload };
    const virtualDeferredFields = [];
    for (const virtual of virtualFields) {
        if (requested.has(virtual.field))
            continue;
        const projected = virtual.project(result);
        if (!equal(projected, result)) {
            result = projected;
            virtualDeferredFields.push(virtual.field);
        }
    }
    const deferredFields = [
        ...virtualDeferredFields,
        ...present.filter((field) => !requested.has(field)),
    ];
    if (!deferredFields.length)
        return payload;
    for (const field of present) {
        if (!requested.has(field))
            delete result[field];
    }
    const deferred = {
        ...result,
        deferredData: {
            fields: deferredFields,
            tool: readBack.tool,
            arguments: {
                ...readBack.arguments,
                responseFields: deferredFields,
            },
            instruction: "Поля отложены. Запросите через responseFields только нужный subset; повторная mutation для получения подробностей запрещена.",
        },
    };
    // Пустой/короткий справочник дешевле передать сразу, чем объявлять отложенное
    // чтение. Это также не заставляет агента делать второй call ради пары записей.
    // Сравниваем только изменённую часть: повторная сериализация всех registry
    // rows ради маленького history/sidebar не должна удваивать память ответа.
    const omitted = Object.fromEntries(deferredFields
        .filter((field) => own(payload, field))
        .map((field) => [field, payload[field]]));
    // Explicit selection is a semantic projection, not merely a size hint:
    // never reintroduce a small unrequested field because it serialized cheaply.
    // The default path may still inline a tiny collection to avoid a net increase.
    return virtualDeferredFields.length > 0 || requested.size > 0
        || JSON.stringify({ deferredData: deferred.deferredData }).length < JSON.stringify(omitted).length
        ? deferred : payload;
};
// Rich-text JSON is necessary for editor-preserving writes, but ordinary model
// reasoning needs only the already-derived semantic text. Strip a rich field
// only when its sibling plain-text representation is present; an unfamiliar
// shape therefore remains lossless until explicitly reviewed.
const withoutRichTextWhenPlain = (value, richField, plainField) => {
    const source = record(value);
    if (!source || typeof source[plainField] !== "string" || !own(source, richField))
        return value;
    const result = { ...source };
    delete result[richField];
    return result;
};
const projectCommentSemanticText = (value) => (withoutRichTextWhenPlain(value, "content", "bodyPlainText"));
const projectContactSemanticText = (payload) => mapFields(payload, {
    contact: (value) => {
        const compact = record(withoutRichTextWhenPlain(value, "descriptionJson", "descriptionPlainText"));
        return compact ? mapFields(compact, { activity: list(projectCommentSemanticText) }) : value;
    },
});
const projectRegistrySemanticText = (payload) => mapFields(payload, {
    comments: list(projectCommentSemanticText),
});
const projectKnowledgePageSemanticText = (payload) => mapFields(payload, {
    page: (value) => {
        const compact = record(withoutRichTextWhenPlain(value, "bodyJson", "bodyPlainText"));
        return compact ? mapFields(compact, { comments: list(projectCommentSemanticText) }) : value;
    },
});
const projectRegularWorkSemanticText = (payload) => mapFields(payload, {
    // Regular-work rows expose the task template fields directly with a
    // task-prefixed name; the nested `task` shape exists only in mutation input.
    items: list((value) => withoutRichTextWhenPlain(value, "taskDescriptionJson", "taskDescriptionPlainText")),
    comments: list(projectCommentSemanticText),
});
const taskLocator = (payload, argumentsObject) => {
    const document = record(payload.document);
    const metadata = record(document?.metadata);
    const currentTask = record(payload.task);
    const companySlug = metadata?.company ?? argumentsObject.companySlug;
    const projectSlug = metadata?.project ?? argumentsObject.projectSlug;
    const taskNumber = currentTask?.number ?? metadata?.taskNumber ?? argumentsObject.taskNumber;
    return typeof companySlug === "string" && typeof projectSlug === "string"
        && (typeof taskNumber === "number" || typeof taskNumber === "string")
        && Number.isSafeInteger(Number(taskNumber)) && Number(taskNumber) > 0
        ? { companySlug, projectSlug, taskNumber: Number(taskNumber) } : null;
};
const TASK_SECTION_FIELDS = {
    rich_description: ["descriptionJson"],
    comments: ["commentsIncluded", "comments", "commentsUnread", "commentsPagination", "subscriptions", "viewerSubscription"],
    checklists: ["checklists"],
    attachments: ["attachments", "deletedAttachments"],
    controls: ["controls"],
    relationships: ["parentTask", "subtasks"],
    workflow: ["statuses", "absenceConflicts"],
    people: ["availableMembers", "availableMemberGroups", "mentionableMembers"],
    templates: ["templates"],
    custom_fields: ["customFields"],
};
const TASK_SECTION_NAMES = Object.keys(TASK_SECTION_FIELDS);
const TASK_DEFERRED_FIELDS = new Set([
    ...TASK_SECTION_NAMES.flatMap((name) => [...TASK_SECTION_FIELDS[name]]),
    // This is the derived plain copy of `descriptionJson`. A bounded prefix in
    // summary keeps the receipt useful without returning the whole document.
    "descriptionPlainText",
]);
const arrayLength = (value) => Array.isArray(value) ? value.length : 0;
const nestedArrayLength = (value, field) => arrayLength(record(value)?.[field]);
const taskSectionItemCount = (currentTask, section) => {
    switch (section) {
        case "rich_description": return String(currentTask.descriptionPlainText ?? "").trim() ? 1 : 0;
        case "comments": {
            if (currentTask.commentsIncluded !== true)
                return null;
            const total = record(currentTask.commentsPagination)?.total;
            return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
                ? total : arrayLength(currentTask.comments);
        }
        case "checklists": return arrayLength(currentTask.checklists);
        case "attachments": return arrayLength(currentTask.attachments) + arrayLength(currentTask.deletedAttachments);
        case "controls": return arrayLength(currentTask.controls);
        case "relationships": return (currentTask.parentTask ? 1 : 0) + arrayLength(currentTask.subtasks);
        case "workflow": return arrayLength(currentTask.statuses) + arrayLength(currentTask.absenceConflicts);
        case "people": return arrayLength(currentTask.availableMembers) + arrayLength(currentTask.availableMemberGroups);
        case "templates": return Array.isArray(currentTask.templates)
            ? currentTask.templates.length
            : nestedArrayLength(currentTask.templates, "description") + nestedArrayLength(currentTask.templates, "checklist");
        case "custom_fields": return Array.isArray(currentTask.customFields)
            ? currentTask.customFields.length : nestedArrayLength(currentTask.customFields, "fields");
    }
};
const projectTaskMutationCore = (currentTask, locator) => {
    if (own(currentTask, "deferredSections"))
        return currentTask;
    const core = Object.fromEntries(Object.entries(currentTask).filter(([field]) => !TASK_DEFERRED_FIELDS.has(field)));
    const description = typeof currentTask.descriptionPlainText === "string"
        ? Array.from(currentTask.descriptionPlainText) : null;
    return {
        ...core,
        ...(!own(core, "summary") && description ? { summary: {
                descriptionPreview: description.slice(0, 320).join(""),
                descriptionTruncated: description.length > 320,
                fullDescriptionSection: "rich_description",
            } } : {}),
        deferredSections: {
            tool: "get_task_sections",
            arguments: { ...locator, sections: TASK_SECTION_NAMES },
            available: TASK_SECTION_NAMES.map((name) => ({ name, itemCount: taskSectionItemCount(currentTask, name) })),
            instruction: "После этого ответа загружайте одним get_task_sections только нужные sections; повторять plan/mutation или полное чтение задачи для этого запрещено.",
        },
    };
};
const projectTaskMutation = (payload, argumentsObject) => {
    let result = projectTaskPayload(payload);
    result = mapFields(result, { subtask: task, checklist, comment, attachment, deletedAttachment: attachment });
    const currentTask = record(result.task);
    const document = record(result.document);
    const locator = taskLocator(payload, argumentsObject);
    if (!currentTask || !document || !locator)
        return result;
    // document.text – производное представление той же задачи. Сохраняем его
    // identity/URL/company/project metadata, чтобы перенос задачи не оставил агенту
    // прежний locator. Остальные domain поля, явные effects и replayed не трогаем.
    const { text: _text, ...documentIdentity } = document;
    result = { ...result, document: documentIdentity };
    result.task = projectTaskMutationCore(currentTask, locator);
    // imageNode является полным каноническим результатом вставки. Примеры имеют
    // право исчезнуть только при наличии этого узла; legacy replay без него цел.
    if (record(result.imageNode)) {
        delete result.bodyJsonExample;
        delete result.descriptionJsonExample;
    }
    return result;
};
const projectTaskUpdatePlan = (payload, argumentsObject) => {
    const result = projectTaskPayload(payload);
    const currentTask = record(result.task);
    const locator = taskLocator(result, argumentsObject);
    // Validation messages, absence conflicts, requested diff, permissions and
    // every unknown top-level field remain intact. Only the same ten typed heavy
    // task sections that exact reads already expose through get_task_sections are
    // replaced with an explicit continuation.
    if (!currentTask || !locator)
        return result;
    return { ...result, task: projectTaskMutationCore(currentTask, locator) };
};
const projectEffectiveInstructionReuse = (payload, args) => {
    const effectiveInstructions = record(payload.effectiveInstructions);
    const revisionKey = effectiveInstructions?.revisionKey;
    const workingRules = record(effectiveInstructions?.workingRules);
    const personalProfile = effectiveInstructions?.personalProfile === null
        ? null : record(effectiveInstructions?.personalProfile);
    // Unknown/new envelopes are preserved whole until their semantics are
    // reviewed. A requires_scope envelope has no authority bytes to cache.
    if (effectiveInstructions?.status !== "loaded"
        || typeof revisionKey !== "string"
        || !workingRules
        || (effectiveInstructions.personalProfile !== null && !personalProfile)) {
        return payload;
    }
    const nextReadArguments = { knownInstructionRevisionKey: revisionKey };
    if (args.knownInstructionRevisionKey !== revisionKey) {
        return {
            ...payload,
            effectiveInstructions: { ...effectiveInstructions, nextReadArguments },
        };
    }
    const { compiledMarkdown: _workingRulesMarkdown, ...workingRulesIdentity } = workingRules;
    const compactPersonalProfile = personalProfile
        ? (() => {
            const { compiledMarkdown: _personalMarkdown, ...profileIdentity } = personalProfile;
            return profileIdentity;
        })()
        : null;
    return {
        ...payload,
        effectiveInstructions: {
            ...effectiveInstructions,
            workingRules: workingRulesIdentity,
            personalProfile: compactPersonalProfile,
            reusedInstructionRevisionKey: revisionKey,
            nextReadArguments,
        },
    };
};
const withoutInstructionMarkdown = (value) => {
    const source = record(value);
    if (!source || !own(source, "instructionsMarkdown"))
        return value;
    const result = { ...source };
    delete result.instructionsMarkdown;
    return result;
};
const projectAgentInstructionSettings = (payload, args) => {
    const revisionKey = payload.instructionRevisionKey;
    const effective = record(payload.effective);
    const personalProfile = record(payload.personalProfile);
    const personalEffective = record(personalProfile?.effective);
    // This route intentionally keeps current/inherited/history source revisions:
    // they are needed to plan an exact replacement. Only duplicate authority
    // fragments inside the compiled effective snapshots are compacted.
    if (typeof revisionKey !== "string"
        || revisionKey.length !== 64
        || !effective
        || typeof effective.compiledMarkdown !== "string"
        || !personalProfile
        || !personalEffective
        || typeof personalEffective.compiledMarkdown !== "string") {
        return payload;
    }
    const compactEffective = mapFields(effective, {
        platform: (value) => {
            const source = record(value);
            if (!source || !own(source, "rulesMarkdown"))
                return value;
            const result = { ...source };
            delete result.rulesMarkdown;
            return result;
        },
        company: withoutInstructionMarkdown,
        project: withoutInstructionMarkdown,
        followUpPolicy: withoutInstructionMarkdown,
        managedWorkPolicy: withoutInstructionMarkdown,
    });
    const profileSnapshot = record(personalEffective.profile);
    const compactPersonalEffective = {
        ...personalEffective,
        ...(profileSnapshot ? { profile: withoutInstructionMarkdown(profileSnapshot) } : {}),
    };
    const nextReadArguments = { knownInstructionRevisionKey: revisionKey };
    if (args.knownInstructionRevisionKey !== revisionKey) {
        return {
            ...payload,
            effective: compactEffective,
            personalProfile: { ...personalProfile, effective: compactPersonalEffective },
            nextReadArguments,
        };
    }
    const { compiledMarkdown: _workingRulesMarkdown, ...effectiveIdentity } = compactEffective;
    const { compiledMarkdown: _personalProfileMarkdown, ...personalEffectiveIdentity } = compactPersonalEffective;
    return {
        ...payload,
        effective: effectiveIdentity,
        personalProfile: { ...personalProfile, effective: personalEffectiveIdentity },
        reusedInstructionRevisionKey: revisionKey,
        nextReadArguments,
    };
};
const projectProjectMeta = (payload, args) => {
    let result = mapFields(payload, {
        members: persons,
        memberGroups: persons,
        availableMembers: persons,
        availableMemberGroups: persons,
    });
    // getProjectSettings and getTaskCreateOptions are independent ACL-aware
    // builders. Alias the nested status list only when their serialized DTOs are
    // byte-for-byte equal; otherwise both policy views remain visible.
    const taskCreate = record(result.taskCreate);
    if (taskCreate && Array.isArray(result.statuses) && Array.isArray(taskCreate.statuses)
        && equal(result.statuses, taskCreate.statuses)) {
        const { statuses: _duplicateStatuses, ...taskCreateCore } = taskCreate;
        result = {
            ...result,
            taskCreate: taskCreateCore,
            collectionAliases: {
                ...(record(result.collectionAliases) ?? {}),
                "taskCreate.statuses": "statuses",
            },
        };
    }
    result = projectEffectiveInstructionReuse(result, args);
    const company = record(result.company);
    const project = record(result.project);
    const companySlug = company?.slug ?? args.companySlug;
    const projectSlug = project?.slug ?? args.projectSlug;
    if (typeof companySlug !== "string" || typeof projectSlug !== "string")
        return result;
    return addDeferred(result, ["taskCustomFields", "taskTemplates", "members", "memberGroups"], {
        tool: "get_project_meta",
        arguments: { companySlug, projectSlug },
    }, args);
};
const projectRegularWorkDetail = (value) => mapFields(value, {
    mentionableMembers: persons,
    options: (item) => mapFields(item, {
        availableMembers: persons,
        availableMemberGroups: persons,
        members: persons,
        groups: persons,
    }),
});
const deferRegularWorkDetail = (value, args) => {
    const payload = record(projectRegularWorkDetail(value));
    if (!payload)
        return value;
    const company = record(payload.company);
    const project = record(payload.project);
    const set = record(payload.set);
    const companySlug = company?.slug ?? args.companySlug;
    const projectSlug = project?.slug ?? args.projectSlug;
    const setId = set?.id ?? args.setId;
    if (typeof companySlug !== "string" || typeof projectSlug !== "string" || typeof setId !== "string") {
        return payload;
    }
    return addDeferred(payload, ["history", "preparation", "options", "mentionableMembers"], {
        tool: "get_regular_work",
        arguments: { companySlug, projectSlug, setId },
    }, args, [{ field: "richText", project: projectRegularWorkSemanticText }]);
};
const ACTIVITY_ENTITY_FIELDS = ["actor", "project", "task", "workspace"];
const internActivityItems = (payload, items, replaceItems) => {
    if (own(payload, "activityEntities"))
        return payload;
    const tables = Object.fromEntries(ACTIVITY_ENTITY_FIELDS.map((field) => [field, []]));
    const indexes = Object.fromEntries(ACTIVITY_ENTITY_FIELDS.map((field) => [field, new Map()]));
    let failed = false;
    const compactItems = items.map((value) => {
        const item = record(value);
        if (!item || ACTIVITY_ENTITY_FIELDS.some((field) => own(item, `${field}Ref`))) {
            failed = true;
            return value;
        }
        const compact = { ...item };
        for (const field of ACTIVITY_ENTITY_FIELDS) {
            if (!own(item, field))
                continue;
            const entity = item[field];
            delete compact[field];
            if (entity === null) {
                compact[`${field}Ref`] = null;
                continue;
            }
            if (!record(entity)) {
                failed = true;
                return value;
            }
            const key = JSON.stringify(entity);
            let index = indexes[field].get(key);
            if (index === undefined) {
                index = tables[field].length;
                indexes[field].set(key, index);
                tables[field].push(entity);
            }
            compact[`${field}Ref`] = index;
        }
        return compact;
    });
    if (failed)
        return payload;
    const activityEntities = Object.fromEntries(ACTIVITY_ENTITY_FIELDS
        .filter((field) => tables[field].length > 0)
        .map((field) => [`${field}s`, tables[field]]));
    if (!Object.keys(activityEntities).length)
        return payload;
    const candidate = {
        ...replaceItems(compactItems),
        activityEntities,
    };
    // A one-row page or a page without repetition can grow after adding the
    // dictionaries. Use references only when the exact serialized response wins.
    return JSON.stringify(candidate).length < JSON.stringify(payload).length ? candidate : payload;
};
const projectRecentActivity = (payload) => {
    const events = record(payload.events);
    let projected;
    if (events && Array.isArray(events.items)) {
        projected = mapFields(payload, {
            events: (value) => mapFields(value, {
                items: list((item) => mapFields(item, { actor: person, author: person })),
            }),
        });
        const projectedEvents = record(projected.events);
        return internActivityItems(projected, projectedEvents.items, (items) => ({
            ...projected,
            events: { ...projectedEvents, items },
        }));
    }
    projected = mapFields(payload, {
        events: list((item) => mapFields(item, { actor: person, author: person })),
    });
    return Array.isArray(projected.events)
        ? internActivityItems(projected, projected.events, (items) => ({ ...projected, events: items }))
        : projected;
};
const projectCompanyActivity = (payload) => {
    const projected = mapFields(payload, {
        items: list((item) => mapFields(item, { actor: person })),
    });
    return Array.isArray(projected.items)
        ? internActivityItems(projected, projected.items, (items) => ({ ...projected, items }))
        : projected;
};
const projectCatalogSkill = (value) => {
    const skill = record(value);
    if (!skill || typeof skill.id !== "string")
        return value;
    const { instructionsMarkdown: _instructions, connectionDefinition: _definition, runtimeRelease, remoteMcp, connection, ...summary } = skill;
    // Все остальные assignment/routing/readiness/requirements поля сохраняются.
    // Здесь нет truncation description: это смысловой материал для выбора навыка.
    const runtime = record(runtimeRelease);
    const remote = record(remoteMcp);
    const configuredConnection = record(connection);
    return {
        ...summary,
        ...(runtime ? { runtimeRelease: Object.fromEntries(Object.entries(runtime).filter(([key]) => (key !== "manifest" && key !== "publication"))) } : { runtimeRelease }),
        ...(remote ? { remoteMcp: Object.fromEntries(Object.entries(remote).filter(([key]) => key !== "config")) } : { remoteMcp }),
        ...(configuredConnection ? { connection: Object.fromEntries(Object.entries(configuredConnection).filter(([key]) => (key !== "config" && key !== "secretBindings"))) } : { connection }),
    };
};
const RUN_SNAPSHOT_FIELDS = [
    "agentInstructionsSnapshotJson", "userProfileSnapshotJson", "runtimePolicySnapshotJson",
    "runtimeAttestationJson", "clientMetadataJson",
];
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_for_human", "review"]);
const WORKSPACE_RECENT_TERMINAL_RUN_LIMIT = 5;
const WORKSPACE_RECENT_CHECKPOINT_LIMIT = 10;
const projectWorkspaceOverview = (payload) => {
    if (!Array.isArray(payload.runs) || own(payload, "overviewSummary"))
        return payload;
    // Overview is a navigation/readiness read, not an authority-materialization
    // endpoint. Keep every active Run plus a bounded recent terminal history;
    // pinned rules/profile/runtime snapshots remain available through an exact
    // explicit full read and through the bridge that actually executes the Run.
    const activeRuns = payload.runs.filter((run) => {
        const entry = record(run);
        return entry ? ACTIVE_RUN_STATUSES.has(String(entry.status ?? "")) : false;
    });
    const terminalRuns = payload.runs.filter((run) => {
        const entry = record(run);
        return entry ? !ACTIVE_RUN_STATUSES.has(String(entry.status ?? "")) : true;
    }).slice(0, WORKSPACE_RECENT_TERMINAL_RUN_LIMIT);
    const selectedRuns = [...activeRuns, ...terminalRuns];
    const selectedRunIds = new Set(selectedRuns.flatMap((run) => {
        const entry = record(run);
        return typeof entry?.id === "string" ? [entry.id] : [];
    }));
    const checkpoints = Array.isArray(payload.checkpoints) ? payload.checkpoints : [];
    const selectedCheckpoints = checkpoints.filter((checkpoint) => {
        const entry = record(checkpoint);
        return typeof entry?.runId !== "string" || selectedRunIds.has(entry.runId);
    }).slice(0, WORKSPACE_RECENT_CHECKPOINT_LIMIT);
    const compactRun = (run) => {
        const entry = record(run);
        if (!entry)
            return run;
        const result = { ...entry };
        for (const field of RUN_SNAPSHOT_FIELDS)
            delete result[field];
        delete result.handoffJson;
        return result;
    };
    const workspace = record(payload.workspace);
    return {
        ...payload,
        runs: selectedRuns.map(compactRun),
        checkpoints: selectedCheckpoints,
        overviewSummary: {
            runsTotal: payload.runs.length,
            runsReturned: selectedRuns.length,
            checkpointsTotal: checkpoints.length,
            checkpointsReturned: selectedCheckpoints.length,
            activeRunsAreAlwaysIncluded: true,
        },
        deferredData: {
            fields: ["completeRunHistory", "completeCheckpointHistory", "pinnedRunAuthoritySnapshots"],
            tool: "get_agent_workspace",
            arguments: {
                ...(typeof workspace?.id === "string" ? { workspaceId: workspace.id } : {}),
                responseDetail: "full",
            },
            instruction: "Use responseDetail=full only for an explicit historical or pinned-authority audit. Ordinary Workspace navigation and Run recovery use this compact overview or the prepared bridge action.",
        },
    };
};
const projectAgentSecretInventory = (payload, args) => {
    if (!Array.isArray(payload.secrets) || own(payload, "deferredData"))
        return payload;
    return {
        ...payload,
        secrets: payload.secrets.map((value) => {
            const secret = record(value);
            if (!secret)
                return value;
            const { publicDescription: _publicDescription, fields: _fields, publicPath: _publicPath, createdByMemberId: _createdBy, createdAt: _createdAt, updatedAt: _updatedAt, rotationReminderDays: _rotationReminderDays, notifyOnSensitiveEvents: _notifyOnSensitiveEvents, ...summary } = secret;
            return summary;
        }),
        deferredData: {
            fields: ["publicDescription", "fields", "auditMetadata", "rotationPolicy"],
            tool: "list_agent_secrets",
            arguments: {
                scopeType: payload.scope ? record(payload.scope)?.type ?? args.scopeType : args.scopeType,
                scopeId: args.scopeId,
                includeParents: args.includeParents ?? true,
                responseDetail: "full",
            },
            instruction: "Choose exact secretIds from this inventory and request responseDetail=full only for those secrets. Values are never returned.",
        },
    };
};
const projectCancelledWorkspaceRun = (payload) => {
    const run = record(payload.run);
    if (!run)
        return payload;
    return {
        schemaVersion: 1,
        action: "cancel_agent_workspace_run",
        run: {
            id: run.id ?? null,
            workspaceId: run.workspaceId ?? null,
            status: run.status ?? null,
            fencingToken: run.fencingToken ?? null,
            cancelledAt: run.cancelledAt ?? null,
            updatedAt: run.updatedAt ?? null,
        },
    };
};
const projectAgentSkillDetail = (payload, args) => {
    const skill = record(payload.skill);
    if (!skill || typeof skill.id !== "string" || own(payload, "deferredData"))
        return payload;
    const runtimeRelease = record(skill.runtimeRelease);
    const executionKind = runtimeRelease
        ? "signed_runtime"
        : record(skill.remoteMcp) ? "remote_mcp" : "instructions_only";
    const releaseIdentity = typeof skill.currentReleaseId === "string"
        ? skill.currentReleaseId
        : typeof runtimeRelease?.releaseId === "string"
            ? runtimeRelease.releaseId
            : typeof skill.version === "string" ? skill.version : "unversioned";
    // Project scope is part of the structural key: the same catalog skill and
    // release may resolve to different effective instructions per assignment.
    // Intent remains a caller-side reuse condition and is never inferred here.
    const instructionKey = `agent-skill:${String(payload.companySlug ?? args.companySlug ?? "unknown")}:${String(payload.projectSlug ?? args.projectSlug ?? "company")}:${skill.id}:${releaseIdentity}`;
    const requested = new Set(stringArray(args.sections).filter((section) => (MCP_AGENT_SKILL_SECTION_NAMES.includes(section))));
    const available = [
        ...(own(skill, "instructionsMarkdown") ? ["instructions"] : []),
        ...(own(skill, "connectionDefinition") || own(skill, "connection") || own(payload, "localIdentity")
            ? ["connection"] : []),
        ...(own(skill, "runtimeRequirements") || own(skill, "runtimeRelease") || own(skill, "remoteMcp")
            || own(payload, "runtimeExecution") || own(payload, "remoteMcpExecution") ? ["execution"] : []),
        ...(runtimeRelease && own(runtimeRelease, "publication")
            && runtimeRelease.publication !== null && runtimeRelease.publication !== undefined
            ? ["publication"] : []),
    ];
    const reuseInstructions = requested.has("instructions")
        && args.knownInstructionKey === instructionKey;
    const { instructionsMarkdown, connectionDefinition, connection, runtimeRequirements, runtimeRelease: _runtimeRelease, remoteMcp, ...skillSummary } = skill;
    let projectedSkill = {
        ...skillSummary,
        instructionKey,
        executionSummary: {
            kind: executionKind,
            releaseId: releaseIdentity,
            trustLevel: runtimeRelease?.trustLevel ?? null,
            minimumHostVersion: runtimeRelease?.minimumHostVersion
                ?? record(remoteMcp)?.minimumHostVersion ?? skill.minPluginVersion ?? null,
            contentProtection: runtimeRelease?.contentProtection
                ?? record(remoteMcp)?.contentProtection ?? null,
        },
    };
    if (requested.has("instructions") && !reuseInstructions) {
        projectedSkill = { ...projectedSkill, instructionsMarkdown };
    }
    if (requested.has("connection")) {
        projectedSkill = { ...projectedSkill, connectionDefinition, connection };
    }
    if (requested.has("execution")) {
        let projectedRuntimeRelease = _runtimeRelease;
        if (runtimeRelease && !requested.has("publication")) {
            const { publication: _publication, ...withoutPublication } = runtimeRelease;
            projectedRuntimeRelease = withoutPublication;
        }
        projectedSkill = {
            ...projectedSkill,
            runtimeRequirements,
            runtimeRelease: projectedRuntimeRelease,
            remoteMcp,
        };
    }
    else if (requested.has("publication") && runtimeRelease) {
        projectedSkill = {
            ...projectedSkill,
            runtimeRelease: {
                releaseId: runtimeRelease.releaseId ?? releaseIdentity,
                publication: runtimeRelease.publication,
            },
        };
    }
    let runtimeExecution = payload.runtimeExecution;
    if (requested.has("execution")) {
        const execution = record(runtimeExecution);
        if (execution) {
            const trust = record(execution.trust);
            const { command: _legacyCommand, ...modernExecution } = execution;
            runtimeExecution = {
                // Remove the legacy duplicate only when the typed route is actually
                // present. Older hydrated server payloads may still be command-only.
                ...(own(execution, "localAction") ? modernExecution : execution),
                ...(trust ? { trust: {
                        ...Object.fromEntries(Object.entries(trust).filter(([key]) => key !== "publication")),
                        ...(own(trust, "publication") && trust.publication !== null
                            && trust.publication !== undefined ? { publicationSection: "publication" } : {}),
                    } } : {}),
            };
        }
    }
    const includedSections = available.filter((section) => (requested.has(section) && !(section === "instructions" && reuseInstructions)));
    const deferredSections = available.filter((section) => (!requested.has(section) && !(section === "instructions" && reuseInstructions)));
    const projected = {
        ...Object.fromEntries(Object.entries(payload).filter(([key]) => (!["skill", "localIdentity", "runtimeExecution", "remoteMcpExecution"].includes(key)))),
        schemaVersion: 2,
        skill: projectedSkill,
        responseProjection: {
            includedSections,
            reusedSections: reuseInstructions ? ["instructions"] : [],
            revision: {
                skillId: skill.id,
                version: skill.version ?? null,
                releaseId: releaseIdentity,
            },
        },
        ...(requested.has("connection") ? { localIdentity: payload.localIdentity } : {}),
        ...(requested.has("execution") ? {
            runtimeExecution,
            remoteMcpExecution: payload.remoteMcpExecution,
        } : {}),
    };
    if (!deferredSections.length)
        return projected;
    return {
        ...projected,
        deferredData: {
            sections: deferredSections,
            tool: "get_agent_skill",
            arguments: {
                companySlug: payload.companySlug ?? args.companySlug,
                ...(payload.projectSlug ?? args.projectSlug
                    ? { projectSlug: payload.projectSlug ?? args.projectSlug } : {}),
                skillId: skill.id,
                sections: deferredSections,
            },
            instruction: "Загрузите только нужные sections. Перед первым внешним действием нужны instructions и execution; connection – только для настройки, publication – для проверки происхождения релиза.",
        },
    };
};
/** Полный обход только известных domain positions; errors/Apps обрабатывает caller. */
export const projectMcpAgentPayload = (toolName, value, rawArguments = {}) => {
    const payload = record(value);
    const args = record(rawArguments) ?? {};
    if (!payload || (MCP_RESPONSE_DETAIL_TOOLS.has(toolName) && args.responseDetail === "full"))
        return value;
    if (toolName === "get_agent_skill")
        return projectAgentSkillDetail(payload, args);
    if (toolName === "get_agent_instructions")
        return projectAgentInstructionSettings(payload, args);
    if (toolName === "get_workspace" || toolName === "fetch") {
        return projectEffectiveInstructionReuse(payload, args);
    }
    if (toolName === "get_agent_workspace" || toolName === "get_agent_workspace_by_scope")
        return projectWorkspaceOverview(payload);
    if (toolName === "list_agent_secrets")
        return projectAgentSecretInventory(payload, args);
    if (toolName === "cancel_agent_workspace_run")
        return projectCancelledWorkspaceRun(payload);
    if (toolName === "search")
        return projectMcpContextSearch(payload);
    if (taskMutationTools.has(toolName))
        return projectTaskMutation(payload, args);
    if (toolName === "plan_task_update")
        return projectTaskUpdatePlan(payload, args);
    if (toolName === "batch_update_tasks") {
        return mapFields(payload, { results: list((item) => {
                const result = record(item);
                // Failed elements содержат errors/conflicts, а не обычный task payload.
                const nested = record(result?.payload);
                if (!result || result.ok !== true || !nested)
                    return item;
                const operation = Array.isArray(args.operations) && typeof result.index === "number"
                    ? record(args.operations[result.index]) ?? {} : {};
                return { ...result, payload: payload.dryRun === false
                        ? projectTaskMutation(nested, operation) : projectTaskUpdatePlan(nested, operation) };
            }) });
    }
    if (toolName === "list_my_tasks" || toolName === "list_project_tasks") {
        return projectTaskListPayload(projectTaskPayload(payload));
    }
    if (toolName === "get_task_review_context") {
        return projectTaskReviewContext(projectTaskPayload(payload));
    }
    if (proposalContextTools.has(toolName)) {
        return projectProposalInstructions(projectTaskPayload(payload));
    }
    if (taskReadTools.has(toolName))
        return projectTaskPayload(payload);
    if (toolName === "create_comment" || toolName === "update_comment")
        return mapFields(payload, { comment });
    if (peopleTools.has(toolName)) {
        if (toolName === "get_project_meta")
            return projectProjectMeta(payload, args);
        let result = mapFields(payload, {
            members: persons, groups: persons, memberGroups: persons,
            availableMembers: persons, availableMemberGroups: persons, mentionableMembers: persons,
        });
        // Удаляем только доказанное равенство списков. Различие ACL/candidates остаётся
        // видимым, даже если два списка имеют почти одинаковые display names.
        const aliases = {};
        for (const [alias, canonical] of [["availableMembers", "members"], ["availableMemberGroups", "memberGroups"]]) {
            if (Array.isArray(result[alias]) && Array.isArray(result[canonical]) && equal(result[alias], result[canonical])) {
                delete result[alias];
                aliases[alias] = canonical;
            }
        }
        if (Object.keys(aliases).length)
            result = { ...result, collectionAliases: aliases };
        if (toolName === "get_task_create_meta") {
            result = projectEffectiveInstructionReuse(result, args);
        }
        return result;
    }
    if (contactTools.has(toolName)) {
        const projectContact = (item) => mapFields(item, {
            createdBy: person, updatedBy: person, memberLinks: list(memberLink), comments: list(comment),
            activity: list(comment), events: list(comment),
        });
        let result = mapFields(payload, { contact: projectContact, contacts: list(projectContact), comment });
        const contactRecord = record(result.contact);
        const company = record(result.company);
        if (contactRecord && typeof contactRecord.id === "string" && typeof company?.slug === "string") {
            result = addDeferred(result, ["options"], { tool: "get_contact", arguments: {
                    companySlug: company.slug, contactId: contactRecord.id,
                } }, args, toolName === "get_contact"
                ? [{ field: "richText", project: projectContactSemanticText }]
                : []);
        }
        return result;
    }
    if (registryTools.has(toolName)) {
        let result = mapFields(payload, { mentionableMembers: persons, comments: list(comment) });
        const registry = record(result.registry);
        const company = record(result.company);
        const project = record(result.project);
        if (registry && typeof registry.slug === "string" && typeof company?.slug === "string") {
            const readArgs = {
                ...args, companySlug: company.slug,
                ...(typeof project?.slug === "string" ? { projectSlug: project.slug } : {}),
                registrySlug: registry.slug,
            };
            // Не переносим mutation fields в read hint. Контекст выбранной страницы
            // сохраняет только реально поддерживаемые read filters/limits.
            const readFields = new Set(["companySlug", "projectSlug", "registrySlug", "query", "filters", "sortKey", "sortDirection", "offset", "limit", "includeArchivedRows", "historyLimit", "responseDetail"]);
            result = addDeferred(result, ["history", "comments", "commentsPagination", "mentionableMembers"], {
                tool: "get_registry", arguments: Object.fromEntries(Object.entries(readArgs).filter(([key]) => readFields.has(key))),
            }, args, toolName === "get_registry"
                ? [{ field: "richText", project: projectRegistrySemanticText }]
                : []);
        }
        return result;
    }
    if (meetingTools.has(toolName))
        return mapFields(payload, {
            meeting: (item) => mapFields(item, { createdBy: person }),
            participants: list((item) => mapFields(item, { member: person })),
            additionalAccess: list(memberLink),
        });
    if (regularWorkTools.has(toolName)) {
        if (toolName === "get_regular_work")
            return deferRegularWorkDetail(payload, args);
        const detail = record(payload.regularWork);
        return detail ? { ...payload, regularWork: deferRegularWorkDetail(detail, args) } : payload;
    }
    if (toolName === "list_agent_skills" && Array.isArray(payload.skills)) {
        return { ...payload, skills: payload.skills.map(projectCatalogSkill), skillDetails: {
                tool: "get_agent_skill", instruction: "Перед использованием загрузите точный skillId в той же компании/проекте: полный текст инструкций, схему подключения и декларацию исполнения.",
            } };
    }
    if (toolName === "get_knowledge_base_page") {
        const company = record(payload.company);
        let result = mapFields(payload, { page: (item) => mapFields(item, { createdBy: person, updatedBy: person }) });
        const page = record(result.page);
        if (typeof page?.slug === "string" && typeof company?.slug === "string")
            result = addDeferred(result, ["pages"], {
                tool: "get_knowledge_base_page", arguments: { companySlug: company.slug, pageSlug: page.slug },
            }, args, [{ field: "richText", project: projectKnowledgePageSemanticText }]);
        return result;
    }
    if (toolName === "list_recent_activity") {
        let result = projectRecentActivity(payload);
        if (typeof args.companySlug === "string")
            result = addDeferred(result, ["feeds", "filterOptions"], {
                tool: "list_recent_activity", arguments: {
                    ...Object.fromEntries(Object.entries(args).filter(([key]) => ["companySlug", "feedId", "cursor", "limit"].includes(key))),
                },
            }, args);
        return result;
    }
    if (toolName === "list_company_activity")
        return projectCompanyActivity(payload);
    // Неизвестный tool/shape сохраняется целиком. Generic provider responses,
    // instructions, snapshots, approval boundaries и arbitrary JSON не обрезаются.
    return value;
};
