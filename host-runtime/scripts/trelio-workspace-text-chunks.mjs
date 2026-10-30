// Generated portable Workspace text index. Do not edit by hand.
import { compileContextSearchQuery, contextSearchTokenRoot, normalizeContextSearchText, buildContextSearchPreview } from "./trelio-context-search-matching.mjs";
// Size bounds apply to work units, never to the searchable document. Overlap
// covers the complete 500-character query plus context even for UTF-8 text.
export const WORKSPACE_TEXT_CHUNK_BYTES = 64 * 1024;
export const WORKSPACE_TEXT_CHUNK_OVERLAP = 2048;
/** Fatal decoding rejects a mislabeled binary, including damage at stream seams. */
export async function* chunkWorkspaceText(source) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let overlap = "";
    let index = 0;
    for await (const bytes of source) {
        // Upstream crypto/network buffers may be much larger than one index row.
        for (let offset = 0; offset < bytes.length; offset += WORKSPACE_TEXT_CHUNK_BYTES) {
            const text = decoder.decode(bytes.subarray(offset, offset + WORKSPACE_TEXT_CHUNK_BYTES), { stream: true });
            if (text.includes("\0"))
                throw new Error("WORKSPACE_TEXT_INVALID");
            pending += text;
            while (Buffer.byteLength(pending, "utf8") > WORKSPACE_TEXT_CHUNK_BYTES) {
                // Split on a code-point boundary; a chunk's overlap is read-only context.
                let end = Math.min(pending.length, WORKSPACE_TEXT_CHUNK_BYTES);
                while (Buffer.byteLength(pending.slice(0, end), "utf8") > WORKSPACE_TEXT_CHUNK_BYTES)
                    end = Math.floor(end * 0.9);
                if (end > 0 && /[\uD800-\uDBFF]/u.test(pending[end - 1]))
                    end--;
                const part = pending.slice(0, end);
                yield { index: index++, text: overlap + part, isLast: false };
                overlap = (overlap + part).slice(-WORKSPACE_TEXT_CHUNK_OVERLAP);
                // The overlap is a second code-point boundary, independent of the cut.
                if (/^[\uDC00-\uDFFF]/u.test(overlap))
                    overlap = overlap.slice(1);
                pending = pending.slice(end);
            }
        }
    }
    pending += decoder.decode();
    if (pending.includes("\0"))
        throw new Error("WORKSPACE_TEXT_INVALID");
    yield { index, text: overlap + pending, isLast: true };
}
/** A cut in the middle of a word/reference must never manufacture a boundary. */
export const workspaceChunkPattern = (pattern, first, last) => {
    const start = first ? pattern : pattern.replace("(^|", "(");
    return last ? start : start.replace("($|", "(");
};
/** Prepare bounded witnesses once for every formulation of the same file.
 * The streaming caller holds at most one chunk per query pattern. Cache lives
 * only for that file; it never retains a company corpus or a plaintext index.
 * The ordinary single-query API below deliberately does not cache normalized
 * parts, since its callers may supply an arbitrarily large complete file.
 */
const createWorkspaceChunkMatcher = (metadata, chunks, hasContent, cachePreparedParts) => {
    const parts = [{ index: 0, text: metadata + (hasContent ? "\n" : ""), isLast: !hasContent }, ...chunks.map(chunk => ({
            ...chunk, text: chunk.index === 0 ? metadata + "\n" + chunk.text : chunk.text,
        }))];
    const prepared = cachePreparedParts ? new Map() : undefined;
    let cachedCodeUnits = 0;
    // A complex SQL witness set can be larger than the ordinary 64-pattern
    // stream. Bound only retained normalization, never searchable source text:
    // oversized evidence still runs through the same matcher without caching.
    const maximumCachedCodeUnits = 8 * 1024 * 1024;
    const compileEdges = (pattern) => [
        new RegExp(workspaceChunkPattern(pattern, false, false), "u"),
        new RegExp(workspaceChunkPattern(pattern, false, true), "u"),
        new RegExp(workspaceChunkPattern(pattern, true, false), "u"),
        new RegExp(workspaceChunkPattern(pattern, true, true), "u"),
    ];
    return (rawQuery) => {
        const query = compileContextSearchQuery(rawQuery);
        if (!query.patterns.length)
            return null;
        const roots = query.reference ? [query.normalized]
            : [...new Set(query.normalized.split(" ").filter(Boolean).map(contextSearchTokenRoot))];
        const expressions = query.patterns.map(compileEdges);
        const matched = query.patterns.map(() => false);
        const evidence = [];
        let lexicalQuality = 0;
        const normalizedQuery = normalizeContextSearchText(rawQuery);
        const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const phraseExpressions = compileEdges(`(^|[^\\p{L}\\p{N}])${escape(normalizedQuery)}($|[^\\p{L}\\p{N}])`);
        const tokens = [...new Set(normalizedQuery.split(" ").filter(token => token.length > 1))];
        const tokenExpressions = tokens.map(token => compileEdges(`(^|[^\\p{L}\\p{N}])${escape(token)}($|[^\\p{L}\\p{N}])`));
        const exactTokens = new Set();
        for (const [position, original] of parts.entries()) {
            let part = prepared?.get(position);
            if (!part) {
                const referenceText = original.text.toLocaleLowerCase("ru").replaceAll("ё", "е");
                part = { ...original, referenceText, wordText: referenceText.replace(/[^\p{L}\p{N}]+/gu, " ") };
                // Reserve space for both representations and later segment values.
                const weight = 2 * referenceText.length + part.wordText.length;
                if (prepared && cachedCodeUnits + weight <= maximumCachedCodeUnits) {
                    prepared.set(position, part);
                    cachedCodeUnits += weight;
                }
            }
            const edge = (part.index === 0 ? 2 : 0) + (part.isLast ? 1 : 0);
            const text = query.reference ? part.referenceText : part.wordText;
            let useful = false;
            query.patterns.forEach((_pattern, index) => {
                if (text.includes(roots[index]) && expressions[index][edge].test(text)) {
                    if (!matched[index])
                        useful = true;
                    matched[index] = true;
                }
            });
            let quality = 0;
            const phraseMatched = Boolean(normalizedQuery && part.wordText.includes(normalizedQuery)
                && phraseExpressions[edge].test(part.wordText));
            if (phraseMatched)
                quality = 200;
            if (!normalizedQuery || phraseMatched) {
                // A normalized segment equal to the query necessarily contains this
                // exact phrase. Skip the much more expensive segment normalization
                // otherwise; inflection-only coverage cannot earn an exact-field bonus.
                // Artificial chunk edges still cannot invent a complete source field.
                // Punctuation-only references keep their previous empty comparable
                // segment behavior even though no word phrase exists for them.
                const normalizedSegments = part.segments ??= part.text.split(/[·:()]/u).map(normalizeContextSearchText);
                if (normalizedSegments.some((segment, index) => (index > 0 || part.index === 0)
                    && (index < normalizedSegments.length - 1 || part.isLast) && segment === normalizedQuery))
                    quality = 300;
            }
            if (quality > lexicalQuality) {
                lexicalQuality = quality;
                useful = true;
            }
            for (const [index, token] of tokens.entries()) {
                if (text.includes(token) && tokenExpressions[index][edge].test(text))
                    exactTokens.add(token);
            }
            if (useful)
                evidence.push(buildContextSearchPreview(part.text, [rawQuery], 600));
        }
        if (!query.patterns.length || !matched.every(Boolean))
            return null;
        lexicalQuality = Math.max(lexicalQuality, tokens.length ? Math.round(exactTokens.size / tokens.length * 100) : 0);
        return { lexicalQuality, previewText: buildContextSearchPreview(evidence.join(" … "), [rawQuery]) };
    };
};
/** File-local batch replay: retain bounded normalized witnesses between queries. */
export const createWorkspaceTextChunkMatcher = (metadata, chunks, hasContent = chunks.length > 0) => createWorkspaceChunkMatcher(metadata, chunks, hasContent, true);
/** Evaluate the whole logical file without joining or retaining normalized text.
 * Terms may occur in different chunks; source boundaries, lexical rank and
 * bounded factual previews remain identical to the batch interface above. */
export const matchWorkspaceTextChunks = (metadata, chunks, rawQuery, hasContent = chunks.length > 0) => createWorkspaceChunkMatcher(metadata, chunks, hasContent, false)(rawQuery);
