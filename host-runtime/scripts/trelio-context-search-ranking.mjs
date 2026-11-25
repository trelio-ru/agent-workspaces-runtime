// Generated portable context-search ranking. Do not edit by hand.
import { buildContextSearchPreview, compileContextSearchQuery, matchContextSearchField, normalizeContextSearchQueries, normalizeContextSearchReference, normalizeContextSearchText, } from "./trelio-context-search-matching.mjs";
export { normalizeContextSearchText } from "./trelio-context-search-matching.mjs";
// This module deliberately has no MCP or domain-service dependencies: task,
// contact and registry retrieval can select evidence with the same policy that
// the final mixed-result merge uses.
export const CONTEXT_SEARCH_RANKING_POLICY_VERSION = "context-search-v2";
const PRIMARY_FIELD_SOURCES = new Set([
    "task-title",
    "meeting-title",
    "project",
    "workspace-title",
    "knowledge-page-title",
    "contact-name",
    "contact-alias",
    "registry-title",
    "regular-work-title",
    "agent-secret-name",
]);
const STRUCTURED_FIELD_SOURCES = new Set([
    "task-number",
    "task-checklist",
    "task-control",
    "task-custom-field",
    "contact-tag",
    "contact-detail",
    "contact-channel",
    "contact-identifier",
    "registry-row-key",
    "registry-search-term",
    "registry-row-value",
    "registry-column",
    "regular-work-item",
]);
const PROSE_FIELD_SOURCES = new Set([
    "task-description",
    "workspace-description",
    "knowledge-page-body",
    "contact-description",
    "registry-description",
    "registry-row-note",
    "regular-work-description",
    "agent-secret-description",
]);
const DERIVED_FIELD_SOURCES = new Set([
    "task-attachment",
    "task-comment",
    "workspace-file",
    "workspace-artifact",
    "regular-work-comment",
    "regular-work-attachment",
]);
const DIRECT_VALUE_SOURCES = new Set([
    "task-number",
    "contact-channel",
    "contact-identifier",
    "registry-row-key",
]);
const REGISTRY_ROW_SOURCES = new Set([
    "registry-row-key",
    "registry-row-value",
    "registry-row-note",
]);
const compareStableText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const buildComparableValues = (value) => {
    const segments = String(value).split(/[·:()]/u);
    // Without a separator the sole segment IS the whole value. Do not normalize
    // that potentially large body a second time merely to deduplicate it later.
    const values = [normalizeContextSearchText(value),
        ...(segments.length > 1 ? segments.map(normalizeContextSearchText) : []),
    ].filter(Boolean);
    return [...new Set(values)];
};
const buildDirectPreviewValues = (value) => {
    const whole = normalizeContextSearchReference(value);
    const segments = String(value)
        .split(/[·:]/u)
        .map(normalizeContextSearchReference)
        .filter(Boolean);
    // Contact channels and identifiers commonly use `label · value`. Only the
    // value is a direct reference: a generic label such as "Telegram" must not
    // receive the same hard priority as an exact @username, phone or email.
    return segments.length > 1 ? [segments.at(-1)] : whole ? [whole] : [];
};
const buildReferenceComparisonValues = (value) => {
    const rawValue = String(value ?? "").trim();
    const values = [normalizeContextSearchReference(rawValue)];
    if (/^(?:https?:\/\/|\/)/iu.test(rawValue)) {
        try {
            values.push(normalizeContextSearchReference(new URL(rawValue, "https://reference.invalid").pathname));
        }
        catch {
            // Invalid URL-like text remains comparable as ordinary normalized text.
        }
    }
    return [...new Set(values.filter(Boolean))];
};
const tokenize = (value) => (value.split(" ").filter((token) => token.length > 1));
const calculatePreparedLexicalQuality = (match, normalizedQuery, queryTokens) => {
    if (match.lexicalQuality !== undefined)
        return Math.max(0, Math.min(300, match.lexicalQuality));
    if (!normalizedQuery)
        return 0;
    // Preview text is the provider-neutral projection of the field that really
    // matched. Display titles may contain route labels, company names or an
    // archive marker and therefore must never improve or lower lexical evidence.
    const comparableValues = buildComparableValues(match.previewText);
    if (comparableValues.includes(normalizedQuery))
        return 300;
    if (comparableValues.some((value) => ` ${value} `.includes(` ${normalizedQuery} `)))
        return 200;
    if (queryTokens.length === 0)
        return 0;
    const bestCoverage = comparableValues.reduce((best, value) => {
        const matchedTokens = queryTokens.filter((token) => ` ${value} `.includes(` ${token} `)).length;
        return Math.max(best, matchedTokens / queryTokens.length);
    }, 0);
    return Math.round(bestCoverage * 100);
};
export const calculateLexicalQuality = (match) => {
    if (match.lexicalQuality !== undefined)
        return Math.max(0, Math.min(300, match.lexicalQuality));
    const normalized = normalizeContextSearchText(match.query);
    return calculatePreparedLexicalQuality(match, normalized, tokenize(normalized));
};
const calculateFieldQuality = (_candidate, match) => {
    if (PRIMARY_FIELD_SOURCES.has(match.source))
        return 4;
    if (STRUCTURED_FIELD_SOURCES.has(match.source))
        return 3;
    if (PROSE_FIELD_SOURCES.has(match.source))
        return 2;
    if (DERIVED_FIELD_SOURCES.has(match.source))
        return 1;
    // Providers now distinguish title evidence explicitly. Presentation prefixes,
    // company names and incidental title text cannot promote a body/source hit.
    if (match.source === "meeting")
        return 2;
    return 1;
};
const isExactReferenceMatch = (candidateReferences, queryReferences, match) => {
    return queryReferences.some(value => candidateReferences.has(value))
        || DIRECT_VALUE_SOURCES.has(match.source)
            && buildDirectPreviewValues(match.previewText).some(value => queryReferences.includes(value));
};
const calculateAuthority = (candidate) => {
    if (candidate.type === "registry"
        && candidate.matches.some((match) => REGISTRY_ROW_SOURCES.has(match.source))) {
        return 3;
    }
    if (["workspace-file", "workspace_file", "workspace-artifact"].includes(candidate.type)) {
        return 1;
    }
    if (candidate.type === "project")
        return 0;
    return 2;
};
const prepareRankingQuery = (raw) => {
    const normalized = normalizeContextSearchText(raw);
    return { key: compileContextSearchQuery(raw).key, normalized,
        references: buildReferenceComparisonValues(raw), tokens: tokenize(normalized) };
};
const buildPreparedContextSearchRank = (candidate, prepareQuery) => {
    // References belong to this candidate only. Every matching field and
    // formulation sees the same normalized IDs, paths and URL pathnames.
    let references;
    const bestMatchByQuery = new Map();
    for (const match of candidate.matches) {
        const query = prepareQuery(match.query);
        if (!query.normalized)
            continue;
        references ??= new Set((candidate.referenceValues ?? []).flatMap(buildReferenceComparisonValues));
        const next = { match, reference: isExactReferenceMatch(references, query.references, match),
            direct: DIRECT_VALUE_SOURCES.has(match.source), field: calculateFieldQuality(candidate, match),
            lexical: calculatePreparedLexicalQuality(match, query.normalized, query.tokens) };
        const previous = bestMatchByQuery.get(query.key);
        if (!previous) {
            bestMatchByQuery.set(query.key, next);
            continue;
        }
        // A provider may discover one formulation in several fields. Ranking must
        // count it once, but an exact channel/identifier/reference is stronger
        // than a coincidental title hit before ordinary field quality is compared.
        if ((next.reference && !previous.reference)
            || (next.reference === previous.reference
                && ((next.direct && !previous.direct)
                    || (next.direct === previous.direct
                        && (next.field > previous.field || (next.field === previous.field && next.lexical > previous.lexical)))))) {
            bestMatchByQuery.set(query.key, next);
        }
    }
    const scored = [...bestMatchByQuery.values()];
    const matches = scored.map(({ match }) => match);
    return {
        exactReferenceMatches: scored.filter((score) => score.reference).length,
        // One strong title hit beats any number of weak derived mentions. Extra
        // formulations only break ties within the strongest evidence class.
        strongestEvidence: Math.max(0, ...scored.map((score) => score.field * 1000 + score.lexical)),
        matchedQueryCount: matches.length,
        fieldQuality: scored.reduce((sum, score) => sum + score.field, 0),
        lexicalQuality: scored.reduce((sum, score) => sum + score.lexical, 0),
        authority: calculateAuthority({ ...candidate, matches }),
        stableKey: candidate.stableKey,
    };
};
export const buildContextSearchRank = (candidate) => buildPreparedContextSearchRank(candidate, prepareRankingQuery);
/** Cache only the small request vocabulary, never source text or authority. */
export const createContextSearchRanker = () => {
    const queries = new Map();
    const getQuery = (raw) => {
        const existing = queries.get(raw);
        if (existing)
            return existing;
        const query = prepareRankingQuery(raw);
        // Narrow refinements can accept more formulations than unified search.
        // Continue scoring valid overflow without retaining an unbounded cache.
        if (queries.size < 32)
            queries.set(raw, query);
        return query;
    };
    return (candidate) => buildPreparedContextSearchRank(candidate, getQuery);
};
export const compareContextSearchRanks = (leftRank, rightRank) => (rightRank.exactReferenceMatches - leftRank.exactReferenceMatches
    || rightRank.strongestEvidence - leftRank.strongestEvidence
    || rightRank.matchedQueryCount - leftRank.matchedQueryCount
    || rightRank.fieldQuality - leftRank.fieldQuality
    || rightRank.lexicalQuality - leftRank.lexicalQuality
    || rightRank.authority - leftRank.authority
    || compareStableText(leftRank.stableKey, rightRank.stableKey));
export const compareContextSearchCandidates = (left, right) => compareContextSearchRanks(buildContextSearchRank(left), buildContextSearchRank(right));
/** Decorate once: sort comparisons must never normalize full documents again. */
export const rankContextSearchCandidates = (candidates, toCandidate, rank = createContextSearchRanker()) => candidates.map((candidate) => ({ candidate, rank: rank(toCandidate(candidate)) }))
    .sort((left, right) => compareContextSearchRanks(left.rank, right.rank))
    .map(({ candidate }) => candidate);
export const CONTEXT_SEARCH_MATERIAL_LIMIT = 10;
export const CONTEXT_SEARCH_CATEGORY_LIMITS = {
    task: 4,
    workspace: 2,
    "workspace-file": 3,
    meeting: 2,
    "knowledge-page": 2,
    registry: 2,
    "regular-work": 2,
    contact: 2,
    project: 2,
};
const contextSearchCategoryAliases = new Map([
    ["workspace_file", "workspace-file"], ["workspace-artifact", "workspace-file"],
    ["workspace_artifact", "workspace-file"], ["knowledge_page", "knowledge-page"], ["regular_work", "regular-work"],
]);
const contextSearchCategory = (type) => contextSearchCategoryAliases.get(type) ?? type;
export const getCategorizedContextSearchLimit = (limit) => {
    const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : CONTEXT_SEARCH_MATERIAL_LIMIT;
    return Math.min(CONTEXT_SEARCH_MATERIAL_LIMIT, Math.max(1, requested));
};
/** Allocate category seats before cutting the global list. Keep the existing
 * candidate order and reuse its scores for both passes. Unknown categories
 * (currently safe Secret metadata) may compete for unreserved places. */
export const selectCategorizedContextSearchResults = (candidates, toCandidate, limit) => {
    const calculateRank = createContextSearchRanker();
    const ranked = candidates.map((value) => {
        const candidate = toCandidate(value);
        return { value, candidate, category: contextSearchCategory(candidate.type), rank: calculateRank(candidate) };
    }).sort((left, right) => compareContextSearchRanks(left.rank, right.rank));
    const knownLimits = CONTEXT_SEARCH_CATEGORY_LIMITS;
    const selected = new Set();
    const counts = new Map();
    const queries = new Map();
    const reserve = (entry) => {
        selected.add(entry);
        counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    };
    for (const entry of ranked) {
        if (selected.size >= limit)
            break;
        if (!Object.hasOwn(knownLimits, entry.category) || counts.has(entry.category))
            continue;
        const strong = entry.rank.exactReferenceMatches > 0 || entry.candidate.matches.some((match) => {
            let query = queries.get(match.query);
            if (!query) {
                query = compileContextSearchQuery(match.query);
                queries.set(match.query, query);
            }
            // Work with the evidence from one matched field or file chunk. Neither
            // decoration on the result title nor words spread across hits count.
            if (query.reference)
                return false;
            if (entry.candidate.fileName && matchContextSearchField(entry.candidate.fileName, query))
                return true;
            return (PRIMARY_FIELD_SOURCES.has(match.source) || query.patterns.length > 1)
                && match.previewText.split(" … ").some((fragment) => matchContextSearchField(fragment, query));
        });
        if (strong)
            reserve(entry);
    }
    for (const entry of ranked) {
        if (selected.size >= limit)
            break;
        const cap = Object.hasOwn(knownLimits, entry.category) ? knownLimits[entry.category] : limit;
        if (!selected.has(entry) && (counts.get(entry.category) ?? 0) < cap)
            reserve(entry);
    }
    // Keep exact references and relevance in the displayed order. Indexes group
    // the flat, fetchable results for consumers without repeating the text.
    const results = ranked.filter((entry) => selected.has(entry));
    const resultCategories = Object.create(null);
    for (const [index, entry] of results.entries()) {
        (resultCategories[entry.category] ??= []).push(index);
    }
    return { ranked: ranked.map((entry) => entry.value), selected: results.map((entry) => entry.value), resultCategories };
};
export const searchAgentRuleDocuments = (documents, rawQueries) => {
    const queries = normalizeContextSearchQueries(rawQueries);
    const candidates = documents.flatMap(({ markdown, ...document }) => {
        const matches = queries.filter((query) => matchContextSearchField(markdown, query)).map((query) => ({
            query: query.original, source: "agent-rule", previewText: markdown,
        }));
        return matches.length > 0 ? [{ document, matches }] : [];
    });
    const ranked = rankContextSearchCandidates(candidates, ({ document, matches }) => ({
        type: "agent-rule", title: "", stableKey: `${document.companySlug}/${document.type}/${document.revisionId}`, matches,
    }));
    const limit = 3;
    return {
        items: ranked.slice(0, limit).map(({ document, matches }) => ({
            ...document,
            preview: buildContextSearchPreview(matches[0].previewText, matches.map((match) => match.query), 240),
            matchedQueries: matches.map((match) => match.query),
            read: {
                tool: document.type === "personal-skill" ? "get_agent_skill" : "get_agent_instructions",
                arguments: { companySlug: document.companySlug,
                    ...(document.projectSlug ? { projectSlug: document.projectSlug } : {}),
                    ...(document.skillId ? { skillId: document.skillId, sections: ["instructions"] } : {}),
                },
            },
        })),
        hasMore: ranked.length > limit,
    };
};
