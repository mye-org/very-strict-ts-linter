import { RuleTester } from "@typescript-eslint/rule-tester";
import * as vitest from "vitest";
import plugin from "../src/index.js";
import { noReactInTs } from "../src/rules/no-react-in-ts.js";
import { thinReactComponent } from "../src/rules/thin-react-component.js";

RuleTester.afterAll = vitest.afterAll;
RuleTester.describe = vitest.describe;
RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;

const jsxRuleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

jsxRuleTester.run("no-react-in-ts", noReactInTs, {
  valid: [
    {
      filename: "src/cart.ts",
      code: `import { pipe } from "fp-ts/lib/function.js"; export const toCartView = (x: number) => pipe(x, (n) => ({ total: n }));`,
    },
    {
      filename: "src/CartScreen.tsx",
      code: `import React from "react"; import { View } from "react-native"; export const CartScreen = () => <View />;`,
    },
  ],
  invalid: [
    {
      filename: "src/useCart.ts",
      code: `import { useState } from "react";`,
      errors: [{ messageId: "forbiddenReactInTs" }],
    },
    {
      filename: "src/nativeHelper.ts",
      code: `import { StyleSheet } from "react-native";`,
      errors: [{ messageId: "forbiddenReactInTs" }],
    },
    {
      filename: "src/reexport.ts",
      code: `export { useEffect } from "react";`,
      errors: [{ messageId: "forbiddenReactInTs" }],
    },
  ],
});

jsxRuleTester.run("thin-react-component", thinReactComponent, {
  valid: [
    {
      filename: "src/CartScreen.tsx",
      code: `
        import { toCartView } from "./cart";
        type Props = { readonly items: ReadonlyArray<{ readonly id: string }> };
        export const CartScreen = (props: Props) => {
          const view = toCartView(props);
          return (
            <View>
              {view.items.map((item) => <CartRow key={item.id} item={item} />)}
              {view.isEmpty ? <Empty /> : <Text>{view.total}</Text>}
            </View>
          );
        };
      `,
    },
    {
      filename: "src/ProfileScreen.tsx",
      code: `
        import { useEffect, useState } from "react";
        export const ProfileScreen = (props: Props) => {
          const [open, setOpen] = useState(false);
          const view = toProfileView(props, open);
          useEffect(() => { trackScreen(view.id); }, [view.id]);
          const renderItem = ({ item }: RowProps) => <Row item={item} />;
          return <FlatList data={view.items} renderItem={renderItem} onPress={() => setOpen(!open)} />;
        };
      `,
    },
    {
      filename: "src/logic.ts",
      code: `export const helper = (xs: ReadonlyArray<number>) => xs.filter((x) => x > 0);`,
    },
  ],
  invalid: [
    {
      filename: "src/CartScreen.tsx",
      code: `const formatCents = (n: number) => String(n); export const Cart = () => <Text />;`,
      errors: [{ messageId: "nonJsxHelperInTsx" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = (props: Props) => {
          const { items, total } = toCartView(props);
          return <Text>{total}</Text>;
        };
      `,
      errors: [{ messageId: "noViewDestructuring" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = (props: Props) => {
          const a = getA(props);
          const b = getB(a);
          return <Text>{b}</Text>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = (props: Props) => {
          const active = props.items.filter(isOk);
          return <Text>{active.length}</Text>;
        };
      `,
      errors: [{ messageId: "nonJsxArrayTransform" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = (props: Props) => {
          if (props.loading) { return <Spinner />; }
          return <Text>ok</Text>;
        };
      `,
      errors: [{ messageId: "forbiddenControlFlow" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = () => {
          useEffect(() => {
            const a = 1;
            const b = 2;
            const c = 3;
            doSomething(a, b, c);
          }, []);
          return <View />;
        };
      `,
      errors: [{ messageId: "fatHookCallback" }],
    },
    {
      filename: "src/CartScreen.tsx",
      code: `
        export const Cart = () => (
          <Button
            onPress={() => {
              const a = 1;
              const b = 2;
              const c = 3;
              submit(a, b, c);
            }}
          />
        );
      `,
      errors: [{ messageId: "fatJsxHandler" }],
    },
  ],
});

vitest.describe("createStrictReactConfig", () => {
  vitest.it("creates .ts boundary and .tsx thin-component config blocks", () => {
    const blocks = plugin.createStrictReactConfig();
    vitest.expect(blocks).toHaveLength(2);
    vitest.expect(plugin.configs.react).toHaveLength(2);
    vitest.expect(blocks[0]?.name).toBe("strict-fp/react-ts-boundary");
    vitest.expect(blocks[1]?.name).toBe("strict-fp/react-thin-tsx");
    vitest.expect(blocks[0]?.rules).toEqual({ "strict-fp/no-react-in-ts": "error" });
    vitest.expect(blocks[1]?.rules).toEqual({ "strict-fp/thin-react-component": "error" });
  });
});
