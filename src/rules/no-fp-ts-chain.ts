import { buildBannedFpTsExportListeners } from "../lib/fp-ts-banned-export.js";
import { createRule } from "../lib/rule-factory.js";

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
  create: buildBannedFpTsExportListeners("chain", "noFpTsChain"),
});
