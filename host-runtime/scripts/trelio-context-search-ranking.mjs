// Generated portable context-search ranking. Do not edit by hand.
import { compileContextSearchQuery, normalizeContextSearchReference, normalizeContextSearchText } from "./trelio-context-search-matching.mjs";
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
export const calculateLexicalQuality = (match) => {
    if (match.lexicalQuality !== undefined)
        return Math.max(0, Math.min(300, match.lexicalQuality));
    const normalizedQuery = normalizeContextSearchText(match.query);
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
    const queryTokens = tokenize(normalizedQuery);
    if (queryTokens.length === 0)
        return 0;
    const bestCoverage = comparableValues.reduce((best, value) => {
        const matchedTokens = queryTokens.filter((token) => ` ${value} `.includes(` ${token} `)).length;
        return Math.max(best, matchedTokens / queryTokens.length);
    }, 0);
    return Math.round(bestCoverage * 100);
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
const isExactReferenceMatch = (candidate, match) => {
    const normalizedQueryValues = buildReferenceComparisonValues(match.query);
    if (normalizedQueryValues.length === 0)
        return false;
    if ((candidate.referenceValues ?? []).some((value) => (buildReferenceComparisonValues(value).some((referenceValue) => (normalizedQueryValues.includes(referenceValue)))))) {
        return true;
    }
    return DIRECT_VALUE_SOURCES.has(match.source)
        && buildDirectPreviewValues(match.previewText).some((previewValue) => (normalizedQueryValues.includes(previewValue)));
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
export const buildContextSearchRank = (candidate) => {
    const bestMatchByQuery = new Map();
    for (const match of candidate.matches) {
        const normalizedQuery = compileContextSearchQuery(match.query).key;
        if (!normalizeContextSearchText(match.query))
            continue;
        const next = { match, reference: isExactReferenceMatch(candidate, match),
            direct: DIRECT_VALUE_SOURCES.has(match.source), field: calculateFieldQuality(candidate, match),
            lexical: calculateLexicalQuality(match) };
        const previous = bestMatchByQuery.get(normalizedQuery);
        if (!previous) {
            bestMatchByQuery.set(normalizedQuery, next);
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
            bestMatchByQuery.set(normalizedQuery, next);
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
export const compareContextSearchRanks = (leftRank, rightRank) => (rightRank.exactReferenceMatches - leftRank.exactReferenceMatches
    || rightRank.strongestEvidence - leftRank.strongestEvidence
    || rightRank.matchedQueryCount - leftRank.matchedQueryCount
    || rightRank.fieldQuality - leftRank.fieldQuality
    || rightRank.lexicalQuality - leftRank.lexicalQuality
    || rightRank.authority - leftRank.authority
    || compareStableText(leftRank.stableKey, rightRank.stableKey));
export const compareContextSearchCandidates = (left, right) => compareContextSearchRanks(buildContextSearchRank(left), buildContextSearchRank(right));
/** Decorate once: sort comparisons must never normalize full documents again. */
export const rankContextSearchCandidates = (candidates, toCandidate) => candidates.map((candidate) => ({ candidate, rank: buildContextSearchRank(toCandidate(candidate)) }))
    .sort((left, right) => compareContextSearchRanks(left.rank, right.rank))
    .map(({ candidate }) => candidate);
