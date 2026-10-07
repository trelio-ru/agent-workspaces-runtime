// Generated portable Workspace text index. Do not edit by hand.
import { compileContextSearchQuery, normalizeContextSearchText, buildContextSearchPreview } from "./trelio-context-search-matching.mjs";
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
/**
 * Evaluate the logical file without joining it into an unbounded string.
 * Each query term may occur in a different part; output keeps bounded factual
 * windows, while lexical rank is computed from the actual source chunks.
 */
export const matchWorkspaceTextChunks = (metadata, chunks, rawQuery, hasContent = chunks.length > 0) => {
    const query = compileContextSearchQuery(rawQuery);
    const parts = [{ index: 0, text: metadata + (hasContent ? "\n" : ""), isLast: !hasContent }, ...chunks.map((chunk) => ({
            ...chunk, text: chunk.index === 0 ? metadata + "\n" + chunk.text : chunk.text,
        }))];
    const matched = query.patterns.map(() => false);
    const evidence = [];
    let lexicalQuality = 0;
    // Exact-token coverage is a property of the whole file, not the best chunk.
    const normalizedQuery = normalizeContextSearchText(rawQuery);
    const escapedPhrase = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phrasePattern = `(^|[^\\p{L}\\p{N}])${escapedPhrase}($|[^\\p{L}\\p{N}])`;
    const tokens = [...new Set(normalizedQuery.split(" ").filter((token) => token.length > 1))];
    const exactTokens = new Set();
    for (const part of parts) {
        // Preserve real separators at both edges. Trimming a middle chunk would
        // erase the source boundary; accepting ^/$ there would invent another.
        const referenceText = part.text.toLocaleLowerCase("ru").replaceAll("ё", "е");
        const wordText = referenceText.replace(/[^\p{L}\p{N}]+/gu, " ");
        const text = query.reference ? referenceText : wordText;
        let useful = false;
        query.patterns.forEach((pattern, index) => {
            if (new RegExp(workspaceChunkPattern(pattern, part.index === 0, part.isLast), "u").test(text)) {
                if (!matched[index])
                    useful = true;
                matched[index] = true;
            }
        });
        // Query-sized literal phrases fit in the overlap. Lexical evidence never
        // receives an exact-field bonus merely because a chunk ends at that phrase.
        let quality = 0;
        if (normalizedQuery && new RegExp(workspaceChunkPattern(phrasePattern, part.index === 0, part.isLast), "u").test(wordText))
            quality = 200;
        // Only complete comparable segments may receive the exact-field bonus.
        // A segment touching an artificial chunk edge is not a complete field.
        const segments = part.text.split(/[·:()]/u);
        if (segments.some((segment, index) => (index > 0 || part.index === 0)
            && (index < segments.length - 1 || part.isLast)
            && normalizeContextSearchText(segment) === normalizedQuery))
            quality = 300;
        if (quality > lexicalQuality) {
            lexicalQuality = quality;
            useful = true;
        }
        for (const token of tokens) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(workspaceChunkPattern(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, part.index === 0, part.isLast), "u").test(text))
                exactTokens.add(token);
        }
        if (useful)
            evidence.push(buildContextSearchPreview(part.text, [rawQuery], 600));
    }
    if (!query.patterns.length || !matched.every(Boolean))
        return null;
    // Only metadata without content can equal a whole field. An individual chunk
    // being equal is not equivalent to the original complete-file rank.
    lexicalQuality = Math.max(lexicalQuality, tokens.length ? Math.round(exactTokens.size / tokens.length * 100) : 0);
    return { lexicalQuality, previewText: buildContextSearchPreview(evidence.join(" … "), [rawQuery]) };
};
