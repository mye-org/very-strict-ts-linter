import { createRule } from "../utils/create-rule.js";
import { createBannedFpTsExportListeners } from "../utils/fp-ts-banned-export.js";

type MessageIds = "noFpTsChain";

export const noFpTsChain = createRule<[], MessageIds>({
  name: "no-fp-ts-chain",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `fp-ts` `chain` function; use `flatMap` or `Do`-notation (`Do`, `bind`, `apS`) instead.",
    },
    messages: {
      noFpTsChain:
        "Avoid `fp-ts` `chain`. Use `flatMap` or `Do`-notation (`Do`, `bind`, `apS`) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: createBannedFpTsExportListeners("chain", "noFpTsChain"),
});
