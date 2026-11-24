import { preferStateMonadForTraversal } from "../src/rules/prefer-state-monad-for-traversal.js";
import { createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();

typeAwareRuleTester.run(
  "prefer-state-monad-for-traversal",
  preferStateMonadForTraversal,
  {
    valid: [
      // Non-recursive function with state-like parameter name
      `
        type TreeNode = { readonly id: string; readonly children: ReadonlyArray<TreeNode> };
        const initVisited = (node: TreeNode, visited: ReadonlySet<string>) =>
          new Set([...visited, node.id]);
      `,
      // Recursive function without any state/accumulator parameter
      `
        type TreeNode = { readonly id: string; readonly next?: TreeNode };
        function countNodes(node: TreeNode | undefined): number {
          return node === undefined ? 0 : 1 + countNodes(node.next);
        }
      `,
      // Recursive function with ReadonlySet passed unchanged (read-only lookup, not state)
      `
        type TreeNode = { readonly id: string; readonly next?: TreeNode };
        const hasAllowed = (node: TreeNode | undefined, allowed: ReadonlySet<string>): boolean =>
          node === undefined
            ? false
            : allowed.has(node.id) || hasAllowed(node.next, allowed);
      `,
      // Single ReadonlyArray parameter (not passed alongside a node/cursor)
      `
        const sumList = (items: ReadonlyArray<number>): number =>
          items.length === 0 ? 0 : items[0] + sumList(items.slice(1));
      `,
      // Recursive function using fp-ts State (single cursor param, no manual state param)
      `
        type TreeNode = { readonly id: string; readonly next?: TreeNode };
        const step = (node: TreeNode | undefined): ((s: ReadonlySet<string>) => readonly [number, ReadonlySet<string>]) =>
          (s) => node === undefined ? [0, s] : step(node.next)(new Set([...s, node.id]));
      `,
    ],
    invalid: [
      // FunctionDeclaration with `visited` parameter
      {
        code: `
          type GraphNode = { readonly id: string; readonly neighbors: ReadonlyArray<GraphNode> };
          function dfs(node: GraphNode, visited: ReadonlySet<string>): ReadonlySet<string> {
            return visited.has(node.id)
              ? visited
              : node.neighbors.reduce((s, n) => dfs(n, s), new Set([...visited, node.id]));
          }
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      // Arrow function with `acc` parameter
      {
        code: `
          type TreeNode = { readonly value: number; readonly next?: TreeNode };
          const collectValues = (
            node: TreeNode | undefined,
            acc: ReadonlyArray<number>,
          ): ReadonlyArray<number> =>
            node === undefined ? acc : collectValues(node.next, [...acc, node.value]);
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      // Arrow function with `seen`, `queue`, `stack`, `worklist`, `state`, `collected`, `accumulator`
      {
        code: `
          type Node = { readonly id: string; readonly next?: Node };
          const walkSeen = (node: Node | undefined, seen: ReadonlySet<string>): ReadonlySet<string> =>
            node === undefined ? seen : walkSeen(node.next, new Set([...seen, node.id]));
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      {
        code: `
          type Node = { readonly id: string; readonly next?: Node };
          const walkWorklist = (cursor: Node | undefined, worklist: ReadonlyArray<Node>): number =>
            cursor === undefined ? worklist.length : walkWorklist(cursor.next, [...worklist, cursor]);
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      {
        code: `
          type Node = { readonly id: string; readonly next?: Node };
          const walkState = (cursor: Node | undefined, state: { readonly count: number }): number =>
            cursor === undefined ? state.count : walkState(cursor.next, { count: state.count + 1 });
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      // Collection type (ReadonlyMap) with non-standard name updated in recursive call
      {
        code: `
          type Entry = { readonly key: string; readonly val: number; readonly next?: Entry };
          const indexEntries = (
            cursor: Entry | undefined,
            byKey: ReadonlyMap<string, number>,
          ): ReadonlyMap<string, number> =>
            cursor === undefined
              ? byKey
              : indexEntries(cursor.next, new Map([...byKey, [cursor.key, cursor.val]]));
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
      // Collection type (ReadonlyArray) with non-standard name updated in recursive call
      {
        code: `
          type TreeNode = { readonly label: string; readonly next?: TreeNode };
          const gatherLabels = (
            node: TreeNode | undefined,
            labels: ReadonlyArray<string>,
          ): ReadonlyArray<string> =>
            node === undefined ? labels : gatherLabels(node.next, [...labels, node.label]);
        `,
        errors: [{ messageId: "preferStateMonadForTraversal" }],
      },
    ],
  },
);
