import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildContextSearchPreview,
  compileContextSearchQuery,
  matchContextSearchField,
  normalizeContextSearchQueries,
} from "../host-runtime/scripts/trelio-context-search-matching.mjs";
import { searchCompanyContextMirror, getWorkspaceFileFromMirror } from "../host-runtime/scripts/trelio-local-context.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/context-search-matching-v2.json", import.meta.url), "utf8"));
test("local admission follows the shared native/local corpus", () => {
  for (const example of fixture.cases) {
    assert.equal(matchContextSearchField(example.text, compileContextSearchQuery(example.query)), example.matches, example.name);
  }
  assert.equal(normalizeContextSearchQueries(["Документы Мария", "документы Марии", "МАРИИ документы"]).length, 1);
});

test("local preview keeps distant subject and distinguishing evidence within 300 characters", () => {
  const source = [
    "ASUS Принт VPN прокси: базовое описание.",
    "обычный контекст ".repeat(80),
    "Маршрут переведён в fail-open после проверки.",
  ].join(" ");
  const preview = buildContextSearchPreview(source, ["ASUS fail-open маршрут"]);

  assert.ok(preview.length <= 300);
  assert.match(preview, /ASUS/u);
  assert.match(preview, /fail-open/u);
  assert.match(preview, /маршрут/iu);
  assert.match(preview, / … /u);
});

test("generated previews preserve whole Unicode characters at every clipping boundary", () => {
  // A valid emoji must never become a lone UTF-16 surrogate in a JSON result.
  // Exercise the generated implementation, including both distant windows,
  // rather than repairing a malformed result in a client-specific adapter.
  const base = `anchor ${"x".repeat(100)} ${"y".repeat(100)} ending`;
  for (let offset = 0; offset <= base.length; offset++) {
    const source = `${base.slice(0, offset)}💗${base.slice(offset)}`;
    for (const queries of [["anchor ending"], ["absent"]]) {
      for (const limit of [32, 63, 64, 300]) {
        const preview = buildContextSearchPreview(source, queries, limit);
        assert.equal(preview.isWellFormed(), true, `Split Unicode at ${offset}/${limit}`);
        assert.ok(preview.length <= limit);
        assert.ok(!preview.includes("\uFFFD"));
      }
    }
  }
});

test("local unified search returns five results by default and reports remaining coverage", () => {
  const mirror = {
    company: { id: "11111111-1111-4111-8111-111111111111", slug: "example", name: "Example" },
    generation: "test", serverGeneration: "server-test", createdAt: "2026-09-17T10:00:00.000Z",
    projects: Array.from({ length: 6 }, (_, index) => ({
      id: `22222222-2222-4222-8222-22222222222${index}`,
      slug: `asus-${index}`,
      name: `ASUS ${index}`,
    })),
    tasks: [], workspaceEntries: [], workspaces: [], contextDocuments: [],
  };
  const result = searchCompanyContextMirror(mirror, ["ASUS"]);

  assert.equal(result.results.length, 5);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.pagination, { limit: 5, total: 6, returned: 5, hasMore: true });
});

test("discovery resolves a binary original above an old registry mention without an inspection", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const head = "b".repeat(40);
  const mirror = { company: { id: "11111111-1111-4111-8111-111111111111", slug: "example", name: "Example" }, generation: "test",
    workspaceEntries: [{ id, title: "Документы Марии", description: "Личные документы", state: "active" }],
    workspaces: [
      { id, acceptedHead: head, documents: [{ path: "sources/0088--scan_88.jpg", name: "0088--scan_88.jpg", text: "", sizeBytes: 123, contentType: "image/jpeg" }] },
      { id: "33333333-3333-4333-8333-333333333333", acceptedHead: "a".repeat(40), documents: [{ path: "index.md", name: "index.md", text: "Рождение. Дочь. Файл 0088--scan_88.jpg перенесён.", sizeBytes: 100 }] },
    ],
  };
  const title = searchCompanyContextMirror(mirror, ["Документы Мария", "рождение", "дочь"], 1);
  assert.equal(title.results[0].workspaceId, id);
  assert.equal(title.results[0].type, "workspace");
  const found = searchCompanyContextMirror(mirror, ["0088--scan_88.jpg"], 1).results[0];
  assert.equal(found.workspaceId, id);
  assert.equal(found.path, "sources/0088--scan_88.jpg");
  assert.equal("sizeBytes" in found, false);
  assert.equal("contentType" in found, false);
  assert.equal("scopeType" in found, false);
  const exact = getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.equal(exact.materialize.arguments.operation, "download_file");
  assert.deepEqual(exact.materialize.arguments.parameters, { workspaceId: id, workspaceHead: head, filePath: found.path });
  assert.throws(() => getWorkspaceFileFromMirror(mirror, { workspaceId: id, workspaceHead: "c".repeat(40), filePath: found.path }), { code: "LOCAL_CONTEXT_WORKSPACE_OUTDATED" });
});

test("generated common text pages and guidance keep Unicode valid within legacy budgets", async () => {
  const { readUtf16TextChunk, sliceUtf16CodePoints } = await import('../host-runtime/scripts/trelio-context-search-matching.mjs');
  const { compactSearchGuidance } = await import('../host-runtime/scripts/trelio-agent-guidance-search.mjs');
  const source = 'a'.repeat(7999) + '💗👍🏽👨‍👩‍👧‍👦🇷🇺' + 'b'.repeat(8100);
  let offset = 0, rebuilt = '';
  for (;;) {
    const page = readUtf16TextChunk(source, offset, 8000);
    assert.ok(page.text.isWellFormed()); assert.ok(page.text.length <= 8000);
    rebuilt += page.text;
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.text.length); assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(rebuilt, source);
  assert.throws(() => readUtf16TextChunk(source, 8000, 8000), /offset splits/);
  assert.throws(() => readUtf16TextChunk('💗', 0, 1), /limit cannot fit/);
  assert.ok(sliceUtf16CodePoints(source, 8000, 8100).isWellFormed());
  const edge = limit => 'a'.repeat(limit - 1) + '💗tail';
  const result = compactSearchGuidance([{ kind: 'skill', id: 'synthetic', title: edge(160),
    description: edge(180), match: { matchedTerms: [edge(80)] } }], { companySlug: 'synthetic' }).items[0];
  for (const [value, limit] of [[result.title, 160], [result.descriptionPreview, 180], [result.matchedTerms[0], 80]]) {
    assert.ok(value.isWellFormed()); assert.ok(value.length <= limit); assert.ok(!value.includes('\uFFFD'));
  }
});
