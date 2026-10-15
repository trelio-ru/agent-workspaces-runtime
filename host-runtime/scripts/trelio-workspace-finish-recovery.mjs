import { isDeepStrictEqual } from "node:util";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// This marker contains no summary, plaintext digest, credential or file path.
// It only records that an explicit finish may have crossed the checkpoint
// boundary. A later invocation must read the exact live Run before deciding
// whether to reuse that checkpoint or restore a lost acceptance receipt.
export const createFinishRecoveryMarker = (metadata) => ({
  schemaVersion: 1, workspaceId: metadata.workspaceId, runId: metadata.runId,
});

export const hasFinishRecoveryMarker = (metadata) => {
  const value = metadata?.finishRecovery;
  return value?.schemaVersion === 1
    && uuid.test(String(value.workspaceId)) && uuid.test(String(value.runId))
    && value.workspaceId === metadata.workspaceId && value.runId === metadata.runId;
};

/** Compare the decrypted canonical checkpoint, not ciphertext or a remembered
 * local success string. Only an identical handoff on the same live draft and
 * lease can be reused. Files are names in this narrative checkpoint; candidate
 * bytes still undergo the ordinary validation/upload/acceptance CAS afterwards.
 */
export const reusableFinishHandoff = ({ metadata, snapshot, requested }) => {
  if (!hasFinishRecoveryMarker(metadata)) return null;
  const run = snapshot?.run, checkpoint = snapshot?.latestCheckpoint;
  if (!run || !checkpoint || run.id !== metadata.runId
    || run.workspaceId !== metadata.workspaceId || run.baseHead !== metadata.baseHead
    || !["running", "waiting_for_human"].includes(run.status)
    || run.leaseId !== metadata.leaseId || run.fencingToken !== metadata.fencingToken
    || (run.draftHead ?? null) !== (metadata.draftHead ?? null)
    || checkpoint.runId !== run.id || !uuid.test(String(checkpoint.id))
    || checkpoint.checkpointType !== "handoff"
    || (checkpoint.candidateHead ?? null) !== (run.draftHead ?? run.candidateHead ?? null)) return null;
  const actual = {
    summary: checkpoint.summary,
    evidence: checkpoint.evidenceJson ?? [],
    filesChanged: checkpoint.filesChangedJson ?? [],
    openQuestions: checkpoint.openQuestionsJson ?? [],
    nextAction: checkpoint.nextActionJson ?? null,
  };
  return isDeepStrictEqual(actual, requested) ? checkpoint : null;
};
