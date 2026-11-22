import { createRule } from "../utils/create-rule.js";
import { createBannedFpTsExportListeners } from "../utils/fp-ts-banned-export.js";

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
  create: createBannedFpTsExportListeners("pipe", "noFpTsPipe"),
});
