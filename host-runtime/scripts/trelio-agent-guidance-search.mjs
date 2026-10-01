// Generated portable guidance search. Do not edit by hand.
/* Pure guidance matching shared by native MCP and the encrypted local mirror.
 * Keep this module free of DB, transport and company-content dependencies. */
export const DEFAULT_GUIDANCE_RESULTS = 3;
export const MAX_GUIDANCE_RESULTS = 5;
export const guidanceSearchInput = (input) => ({
    query: (input.intent ?? input.queries.join(" ")).slice(0, 500),
    // Read one extra match for honest truncation metadata, never a full catalog.
    limit: Math.min(MAX_GUIDANCE_RESULTS, Math.max(1, input.guidanceLimit ?? DEFAULT_GUIDANCE_RESULTS)) + 1,
});
/** Search carries selection evidence only. Full instructions, routing policy,
 * schemas and publication metadata are read once after a candidate is selected.
 * Explicit projection prevents a future catalog field leaking credentials. */
export const compactSearchGuidance = (candidates, scope, rawLimit) => {
    const limit = Math.min(MAX_GUIDANCE_RESULTS, Math.max(1, rawLimit ?? DEFAULT_GUIDANCE_RESULTS));
    return {
        status: "searched",
        items: candidates.slice(0, limit).map((candidate) => ({
            kind: candidate.kind,
            title: candidate.title.slice(0, 160),
            descriptionPreview: candidate.description.slice(0, 180),
            matchedTerms: candidate.match.matchedTerms.slice(0, 3).map((term) => term.slice(0, 80)),
            ...(candidate.kind === "skill" && candidate.readiness ? { readiness: {
                    company: candidate.readiness.company,
                    personal: candidate.readiness.personal,
                    requiredAction: candidate.readiness.requiredAction,
                } } : {}),
            read: {
                tool: candidate.kind === "skill" ? "get_agent_skill" : "get_agent_procedure",
                arguments: {
                    companySlug: scope.companySlug,
                    ...((candidate.kind === "procedure" ? candidate.project?.slug : scope.projectSlug)
                        ? { projectSlug: candidate.kind === "procedure" ? candidate.project.slug : scope.projectSlug } : {}),
                    ...(candidate.kind === "skill"
                        ? { skillId: candidate.id, sections: ["instructions", "execution"] }
                        : { procedureId: candidate.id }),
                },
            },
        })),
        hasMore: candidates.length > limit,
    };
};
const AGENT_SKILL_SEARCH_STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "for",
    "in",
    "of",
    "the",
    "to",
    "with",
    "в",
    "где",
    "для",
    "и",
    "из",
    "или",
    "как",
    "когда",
    "мне",
    "мой",
    "моя",
    "на",
    "найди",
    "найти",
    "нужно",
    "о",
    "по",
    "покажи",
    "про",
    "с",
    "у",
    "что",
    "это",
    "я",
]);
export const normalizeAgentSkillSearchText = (value) => value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
const tokenizeAgentSkillSearchText = (value) => (normalizeAgentSkillSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !AGENT_SKILL_SEARCH_STOP_WORDS.has(token)));
const agentSkillSearchTokensMatch = (left, right) => (left === right
    || (Math.min(left.length, right.length) >= 5
        && (left.startsWith(right) || right.startsWith(left))));
/**
 * Rank a bounded effective catalog in memory. Company catalogs are small, so
 * deterministic lexical ranking avoids an external embedding service and
 * keeps private task wording inside Trelio.
 */
export const rankAgentSkillSearchDocuments = (documents, input) => {
    const query = input.query.trim();
    const hints = (input.hints ?? []).map((hint) => hint.trim()).filter(Boolean);
    const normalizedRequest = normalizeAgentSkillSearchText([query, ...hints].join(" "));
    const requestTokens = [...new Set(tokenizeAgentSkillSearchText(normalizedRequest))];
    const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
    if (!normalizedRequest || requestTokens.length === 0) {
        return [];
    }
    return documents
        .map((skill) => {
        const normalizedId = normalizeAgentSkillSearchText(skill.id);
        const normalizedCatalogSlug = normalizeAgentSkillSearchText(skill.catalogSlug);
        const fields = {
            id: normalizeAgentSkillSearchText(`${normalizedId} ${normalizedCatalogSlug}`),
            title: normalizeAgentSkillSearchText(skill.title),
            description: normalizeAgentSkillSearchText(skill.description),
            search_terms: normalizeAgentSkillSearchText(skill.searchTerms.join(" ")),
        };
        const fieldTokens = {
            id: tokenizeAgentSkillSearchText(fields.id),
            title: tokenizeAgentSkillSearchText(fields.title),
            description: tokenizeAgentSkillSearchText(fields.description),
            search_terms: tokenizeAgentSkillSearchText(fields.search_terms),
        };
        const weights = {
            id: 7,
            title: 9,
            description: 3,
            search_terms: 12,
        };
        let score = 0;
        const matchedFields = new Set();
        for (const token of requestTokens) {
            for (const field of ["id", "title", "description", "search_terms"]) {
                if (fieldTokens[field].some((candidate) => agentSkillSearchTokensMatch(token, candidate))) {
                    score += weights[field];
                    matchedFields.add(field);
                }
            }
        }
        // Exact phrases supplied by the publisher are the strongest signal and
        // let a narrow skill outrank a broad integration sharing one product name.
        const matchedTerms = skill.searchTerms.filter((term) => {
            const normalizedTerm = normalizeAgentSkillSearchText(term);
            const termTokens = tokenizeAgentSkillSearchText(normalizedTerm);
            return normalizedRequest.includes(normalizedTerm)
                || termTokens.some((termToken) => requestTokens.some((requestToken) => agentSkillSearchTokensMatch(termToken, requestToken)));
        }).slice(0, 5);
        if (matchedTerms.length > 0) {
            // Several honest aliases may match the same request, but a bounded
            // bonus prevents a publisher from winning only by repeating one idea.
            score += Math.min(matchedTerms.length, 4) * 18;
            matchedFields.add("search_terms");
        }
        if (fields.title && normalizedRequest.includes(fields.title)) {
            score += 30;
            matchedFields.add("title");
        }
        if ((normalizedId && normalizedRequest.includes(normalizedId))
            || (normalizedCatalogSlug && normalizedRequest.includes(normalizedCatalogSlug))) {
            score += 24;
            matchedFields.add("id");
        }
        return {
            skill,
            score,
            matchedTerms,
            matchedFields: [...matchedFields],
        };
    })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => (right.score - left.score
        || (left.skill.integrationRouting?.priority ?? Number.MAX_SAFE_INTEGER)
            - (right.skill.integrationRouting?.priority ?? Number.MAX_SAFE_INTEGER)
        || left.skill.title.localeCompare(right.skill.title, "ru")
        || left.skill.id.localeCompare(right.skill.id, "en")))
        .slice(0, limit);
};
