/**
 * Value-free recovery guidance for a context boundary. The hook never opens
 * company files, injects protected text or guesses a Workspace from cwd: the
 * model must use the exact Run/scope it was already working on. This also keeps
 * the existing SessionStart definition and its approved command unchanged.
 */
export const TRELIO_COMPACTION_RECOVERY_CONTEXT = [
  "Контекст сжат. Если продолжаешь операционную работу Trelio, до следующего действия полностью перечитай правила и личный профиль.",
  "В текущем Run прочитай context/agent-instructions.md и context/user-profile.md из exact открытой папки: это закреплённый снимок, не заменяй его live revisions и не создавай новый Run ради перечитывания.",
  "Вне Run заново загрузи effective instructions exact области штатным read, опустив knownInstruction keys. Сохранившиеся фрагменты/сводка не заменяют полный текст; недоступная authority блокирует зависящую работу.",
  "В следующих сводках не копируй и не пересказывай восстановимые правила/профиль. Сохраняй область, Run, пути/revisions и обязательный шаг перечитывания, прогресс и прямые решения/разрешения пользователя, которых нет в источниках.",
].join(" ");

