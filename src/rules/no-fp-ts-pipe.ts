import { buildBannedFpTsExportListeners } from "../lib/fp-ts-banned-export.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noFpTsPipe";

export const noFpTsPipe = createRule<[], MessageIds>({
  name: "no-fp-ts-pipe",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `fp-ts` `pipe` function; prefer `flow` composition instead.",
    },
    messages: {
      noFpTsPipe:
        "Avoid `fp-ts` `pipe`. Use `flow(...)` composition instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: buildBannedFpTsExportListeners("pipe", "noFpTsPipe"),
});
