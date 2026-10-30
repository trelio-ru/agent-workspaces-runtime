// Generated context discovery and ordinary list policies. Do not edit by hand.
/**
 * Portable agent-search policy. The same patterns run in PostgreSQL and in the
 * encrypted local mirror; neither provider may substitute its own dictionary,
 * substring coverage threshold or six-character prefix heuristic.
 */
export const normalizeContextSearchReference = (value) => String(value ?? "")
    .toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
export const normalizeContextSearchText = (value) => normalizeContextSearchReference(value)
    .replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
// This is an explicit, conservative inflection family, not fuzzy matching or
// a claim to reproduce a PostgreSQL language dictionary. A minimum three-letter
// root prevents short names/prepositions from matching arbitrary word prefixes.
// The policy deliberately keeps foreign words and identifiers unstemmed.
const ENDINGS = ["иями", "ями", "ами", "его", "ого", "ему", "ому", "ими", "ыми", "ией", "иям", "иях", "иев", "ах", "ях", "ов", "ев", "ом", "ем", "ам", "ям", "ой", "ей", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ия", "ии", "ию", "а", "я", "ы", "и", "у", "ю", "е", "о", "ь"];
const ENDING_PATTERN = `(?:${[...new Set(ENDINGS)].join("|")})?`;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const contextSearchTokenRoot = (token) => {
    if (!/^[а-я]+$/u.test(token))
        return token;
    const ending = ENDINGS.find((candidate) => token.endsWith(candidate) && token.length - candidate.length >= 3);
    return ending ? token.slice(0, -ending.length) : token;
};
export const compileContextSearchQuery = (value) => {
    const original = value.trim();
    const referenceText = normalizeContextSearchReference(original);
    // Paths, filenames, handles, UUIDs and digests retain punctuation and order.
    // `0126--message_126.jpg` must never become a bag of four ordinary words.
    const digest = /^[a-f0-9]{32,64}$/u.test(referenceText);
    const reference = /[/\\]/u.test(referenceText)
        || /\.[a-z0-9]{1,12}$/u.test(referenceText)
        || (!/\s/u.test(referenceText) && (/[./@:_\\-]/u.test(referenceText) || digest));
    const normalized = reference ? referenceText : normalizeContextSearchText(original);
    const tokens = [...new Set(normalized.split(" ").filter(Boolean))];
    const roots = tokens.map(contextSearchTokenRoot);
    const referenceBoundary = digest ? "\\p{L}\\p{N}" : "\\p{L}\\p{N}./@:_\\-";
    const patterns = reference
        ? [`(^|[^${referenceBoundary}])${escapePattern(referenceText)}($|[^${referenceBoundary}])`]
        : [...new Set(tokens.map((token, index) => {
                const root = roots[index];
                const word = /^[а-я]{3,}$/u.test(root) ? `${escapePattern(root)}${ENDING_PATTERN}` : escapePattern(token);
                return `(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`;
            }))];
    return {
        original, normalized, reference,
        key: reference ? `ref:${normalized}` : `words:${[...new Set(roots)].sort().join(" ")}`,
        patterns,
        expressions: normalized ? patterns.map((pattern) => new RegExp(pattern, "u")) : [],
    };
};
export const normalizeContextSearchQueries = (queries) => ([...new Map(queries.map(compileContextSearchQuery).filter((query) => query.normalized)
        .map((query) => [query.key, query])).values()]);
export const CONTEXT_SEARCH_PREVIEW_MAX_LENGTH = 300;
const findContextSearchEvidenceSpans = (compactText, rawQueries) => {
    const referenceText = normalizeContextSearchReference(compactText);
    // Replace punctuation one code point at a time instead of collapsing it.
    // That preserves offsets into the human-facing original while giving the
    // portable word-boundary expressions the same searchable surface as rank.
    const wordText = referenceText.replace(/[^\p{L}\p{N}]/gu, (separator) => " ".repeat(separator.length));
    const spans = [];
    for (const query of normalizeContextSearchQueries(rawQueries)) {
        const searchableText = query.reference ? referenceText : wordText;
        for (const pattern of query.patterns) {
            const match = new RegExp(pattern, "u").exec(searchableText);
            if (!match)
                continue;
            const leadingBoundaryLength = match[1]?.length ?? 0;
            const trailingBoundaryLength = match[2]?.length ?? 0;
            spans.push({
                start: match.index + leadingBoundaryLength,
                end: Math.max(match.index + leadingBoundaryLength + 1, match.index + match[0].length - trailingBoundaryLength),
            });
        }
    }
    return [...new Map(spans
            .sort((left, right) => left.start - right.start || left.end - right.end)
            .map((span) => [`${span.start}:${span.end}`, span])).values()];
};
const sliceContextSearchPreview = (text, evidenceStart, evidenceEnd, limit) => {
    if (text.length <= limit)
        return text;
    // Reserve one character for each possible ellipsis. The window then moves
    // around the evidence without ever pushing the matched token out of view.
    const contentBudget = Math.max(1, limit - 2);
    const evidenceLength = Math.min(contentBudget, Math.max(1, evidenceEnd - evidenceStart));
    let start = Math.max(0, evidenceStart - Math.floor((contentBudget - evidenceLength) / 2));
    let end = Math.min(text.length, start + contentBudget);
    start = Math.max(0, end - contentBudget);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end)}${suffix}`.slice(0, limit);
};
/**
 * Build display evidence only after ranking. A nearby match gets one readable
 * window; widely separated terms get two short fragments so a subject anchor
 * near the start cannot hide the distinguishing term near the end of a file.
 */
export const buildContextSearchPreview = (value, rawQueries, maxLength = CONTEXT_SEARCH_PREVIEW_MAX_LENGTH) => {
    const compactText = String(value ?? "").replace(/\s+/gu, " ").trim();
    const limit = Math.max(32, Math.trunc(maxLength));
    if (!compactText || compactText.length <= limit)
        return compactText;
    const spans = findContextSearchEvidenceSpans(compactText, rawQueries);
    if (spans.length === 0)
        return `${compactText.slice(0, limit - 1)}…`;
    const first = spans[0];
    const last = spans.at(-1);
    if (last.end - first.start <= limit - 2) {
        return sliceContextSearchPreview(compactText, first.start, last.end, limit);
    }
    const separator = " … ";
    const firstLimit = Math.floor((limit - separator.length) / 2);
    const lastLimit = limit - separator.length - firstLimit;
    return `${sliceContextSearchPreview(compactText, first.start, first.end, firstLimit)}${separator}`
        + sliceContextSearchPreview(compactText, last.start, last.end, lastLimit);
};
export const matchContextSearchField = (value, query, { allowQueryContainsField = false } = {}) => {
    if (!query.expressions.length)
        return false;
    const text = query.reference ? normalizeContextSearchReference(value) : normalizeContextSearchText(value);
    if (query.expressions.every((expression) => expression.test(text)))
        return true;
    // Only explicitly declared registry discovery terms permit reverse matching;
    // even there, whole words and complete coverage remain mandatory.
    return allowQueryContainsField && !query.reference && Boolean(text)
        && compileContextSearchQuery(text).expressions.every((expression) => expression.test(query.normalized));
};

const listRecord = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? value : {};
const listArray = (value) => Array.isArray(value) ? value : [];
const listLower = (value) => String(value ?? "").toLocaleLowerCase("ru");
/** PostgreSQL LIKE wildcard/escape semantics, including one Unicode code point. */
export const compileContextListPattern = (rawQuery) => {
    let pattern = "";
    const characters = [...`%${listLower(rawQuery)}%`];
    const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (let index = 0; index < characters.length; index++) {
        const character = characters[index];
        if (character === "\\" && index + 1 < characters.length)
            pattern += literal(characters[++index]);
        else
            pattern += character === "%" ? "[\\s\\S]*" : character === "_" ? "[\\s\\S]" : literal(character);
    }
    return new RegExp(`^(?:${pattern})$`, "u");
};
export const matchesContextListDocument = (type, payload, rawQuery) => {
    const query = rawQuery.trim();
    if (!query)
        return true;
    const detail = listRecord(payload);
    const entity = listRecord(detail[type === "knowledge_page" ? "page" : type]);
    const pattern = compileContextListPattern(query);
    const like = (value) => pattern.test(listLower(value));
    if (type === "contact") {
        const organization = listRecord(entity.organization);
        return [entity.displayName, organization.legalName ?? entity.legalName, entity.descriptionPlainText].some(like)
            || listArray(entity.aliases).some((alias) => alias === query);
    }
    if (type === "knowledge_page") {
        // Native list pages filters the compact index preview, never full body,
        // discussion, sidebar pages, audit actors or rich-text editor metadata.
        const body = String(entity.bodyPlainText ?? "").trim().replace(/\s+/gu, " ");
        const preview = entity.previewText ?? (body.length <= 180 ? body : `${body.slice(0, 177).trimEnd()}...`);
        return [entity.title, entity.slug, preview].some((value) => listLower(value).includes(listLower(query)));
    }
    if (type === "registry") {
        return [entity.title, entity.description,
            ...listArray(entity.columns).filter((column) => column?.isTechnical !== true).map((column) => column?.label)]
            .some(like)
            || listArray(entity.searchTerms).some((term) => like(term) || compileContextListPattern(String(term)).test(listLower(query)));
    }
    return false;
};
/** Ordinary task list query: one contiguous substring in the native haystack. */
export const buildContextTaskListSearchText = (number, task, project) => {
    const name = (value) => {
        const person = listRecord(value);
        return String(person.displayName || person.name || person.username || "").trim();
    };
    return [number, task.title, task.descriptionPlainText, task.status?.code, task.status?.name,
        project.name, project.slug, name(task.createdBy),
        ...listArray(task.assignees ?? (task.assignee ? [task.assignee] : [])).map(name),
        ...listArray(task.participants).map(name)]
        .map((value) => String(value || "").toLowerCase()).join(" ");
};
export const matchesContextTaskDueState = ({ dueDate, dueState, statusKind, todayDate }) => {
    if (dueState === "without_due_date")
        return dueDate === null;
    if (dueState === "with_due_date")
        return dueDate !== null;
    if (dueState === "overdue")
        return statusKind !== "done" && dueDate !== null && dueDate < todayDate;
    if (dueState === "today")
        return dueDate === todayDate;
    if (dueState === "upcoming")
        return dueDate !== null && dueDate >= todayDate;
    return true;
};
export const matchesContextRegistryRowQuery = (row, columns, rawQuery) => {
    if (!rawQuery.trim())
        return true;
    const pattern = compileContextListPattern(rawQuery.trim());
    const values = listRecord(row.values);
    const candidates = [row.rowKey, row.note, ...columns.flatMap((column) => column.type === "document"
            ? listArray(values[column.key]).flatMap((document) => [document?.label, document?.fileName])
            : [typeof values[column.key] === "object" && values[column.key] !== null
                    ? JSON.stringify(values[column.key]) : values[column.key]])];
    return candidates.some((value) => value !== null && value !== undefined && pattern.test(listLower(value)));
};
/** UTF-8/C ordering compares Unicode code points, independently of OS locale. */
export const compareContextListText = (left, right) => {
    const a = String(left ?? ""), b = String(right ?? "");
    let ai = 0, bi = 0;
    while (ai < a.length && bi < b.length) {
        const ac = a.codePointAt(ai), bc = b.codePointAt(bi);
        if (ac !== bc)
            return ac < bc ? -1 : 1;
        ai += ac > 0xffff ? 2 : 1;
        bi += bc > 0xffff ? 2 : 1;
    }
    return Number(ai < a.length) - Number(bi < b.length);
};
export const compareContextRegistryRows = (left, right, column, descending) => {
    const a = column ? left.values?.[column.key] : left.rowKey;
    const b = column ? right.values?.[column.key] : right.rowKey;
    const nullish = (value) => value === null || value === undefined || ((column?.type === "number" || column?.type === "boolean") && value === "");
    // PostgreSQL ASC defaults NULLS LAST; DESC defaults NULLS FIRST. NULL is not
    // zero/false/empty text, and the row-key tie breaker always stays ascending.
    let result = nullish(a) || nullish(b) ? Number(nullish(a)) - Number(nullish(b))
        : column?.type === "number" ? Number(a) - Number(b)
            : column?.type === "boolean" ? Number(a === true || a === "true") - Number(b === true || b === "true")
                : compareContextListText(a, b);
    return (descending ? -result : result) || compareContextListText(left.rowKey, right.rowKey);
};
