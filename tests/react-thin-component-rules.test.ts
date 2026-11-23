import { RuleTester } from "@typescript-eslint/rule-tester";
import * as vitest from "vitest";
import plugin from "../src/index.js";
import { noReactInTs } from "../src/rules/no-react-in-ts.js";
import { requireJsThreadScheduleOnRn } from "../src/rules/require-js-thread-schedule-on-rn.js";
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
      filename: "src/useCart.tsx",
      code: `
        import { useState } from "react";
        export const useCart = () => {
          const [count, setCount] = useState(0);
          return { count, setCount };
        };
      `,
    },
    {
      filename: "src/StatusBanner.tsx",
      code: `
        import { match } from "ts-pattern";
        export const StatusBanner = (props: Props) =>
          match(props.status)
            .with("loading", () => <Spinner />)
            .with("ready", () => <Text>Ready</Text>)
            .exhaustive();
      `,
    },
    {
      filename: "src/logic.ts",
      code: `export const helper = (xs: ReadonlyArray<number>) => xs.filter((x) => x > 0);`,
    },
    {
      filename: "src/AnimatedCard.tsx",
      code: `
        import { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
        export const AnimatedCard = (props: Props) => {
          const view = toCardView(props);
          const color = view.color;
          const borderWidth = view.borderWidth;
          const opacity = useSharedValue(1);
          const animatedStyle = useAnimatedStyle(() => ({
            backgroundColor: color,
            borderWidth,
            opacity: opacity.value,
          }));
          return <Animated.View style={animatedStyle}><Text>{view.title}</Text></Animated.View>;
        };
      `,
    },
    {
      filename: "src/AnimatedCardDestructured.tsx",
      code: `
        import { useAnimatedStyle } from "react-native-reanimated";
        export const AnimatedCard = (props: Props) => {
          const view = toCardView(props);
          const { color, width } = view;
          const style = useAnimatedStyle(() => ({ backgroundColor: color, width }));
          return <Animated.View style={style}><Text>{view.title}</Text></Animated.View>;
        };
      `,
    },
    {
      filename: "src/GestureCard.tsx",
      code: `
        import { useState } from "react";
        import { Gesture, GestureDetector } from "react-native-gesture-handler";
        import { scheduleOnRN, useSharedValue, withTiming } from "react-native-reanimated";
        export const GestureCard = (props: Props) => {
          const [done, setDone] = useState(false);
          const width = useSharedValue(100);
          const handleDone = () => { setDone(true); };
          const grow = () => {
            "worklet";
            width.value = withTiming(200, { duration: 300 }, () => {
              scheduleOnRN(handleDone);
            });
          };
          const tap = Gesture.Tap().onEnd(() => {
            grow();
          });
          return <GestureDetector gesture={tap}><Animated.View /></GestureDetector>;
        };
      `,
    },
    {
      filename: "src/ScrollScreen.tsx",
      code: `
        import { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
        export const ScrollScreen = () => {
          const offset = useSharedValue(0);
          const onScroll = useAnimatedScrollHandler({
            onScroll: (event) => {
              offset.value = event.contentOffset.y;
            },
          });
          return <Animated.ScrollView onScroll={onScroll} />;
        };
      `,
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
    {
      filename: "src/AnimatedCardUnusedExtraction.tsx",
      code: `
        import { useAnimatedStyle } from "react-native-reanimated";
        export const AnimatedCard = (props: Props) => {
          const view = toCardView(props);
          const unused = view.color;
          const style = useAnimatedStyle(() => ({ opacity: 1 }));
          return <Animated.View style={style}><Text>{unused}</Text></Animated.View>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }],
    },
    {
      filename: "src/AnimatedCardPartialDestructure.tsx",
      code: `
        import { useAnimatedStyle } from "react-native-reanimated";
        export const AnimatedCard = (props: Props) => {
          const view = toCardView(props);
          const { color, title } = view;
          const style = useAnimatedStyle(() => ({ backgroundColor: color }));
          return <Animated.View style={style}><Text>{title}</Text></Animated.View>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }, { messageId: "noViewDestructuring" }],
    },
  ],
});

jsxRuleTester.run("require-js-thread-schedule-on-rn", requireJsThreadScheduleOnRn, {
  valid: [
    {
      filename: "src/TapScreen.tsx",
      code: `
        import { router } from "expo-router";
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        export const TapScreen = () => {
          const tap = Gesture.Tap().onEnd(() => {
            scheduleOnRN(router.back);
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
    },
    {
      filename: "src/TapScreenComponentScope.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        export const TapScreen = ({ onDone }: Props) => {
          const notify = () => { onDone(); };
          const tap = Gesture.Tap().onEnd(() => {
            scheduleOnRN(notify);
            scheduleOnRN(onDone);
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
    },
    {
      filename: "src/TapScreenModuleScope.tsx",
      code: `
        import { scheduleOnRN, withTiming } from "react-native-reanimated";
        const logDone = (msg: string) => { console.log(msg); };
        export const AnimatedBox = () => {
          const style = useAnimatedStyle(() => {
            width.value = withTiming(100, {}, () => {
              scheduleOnRN(logDone, "done");
            });
            return { width: width.value };
          });
          return <Animated.View style={style} />;
        };
      `,
    },
    {
      filename: "src/nonWorklet.tsx",
      code: `
        import { scheduleOnRN } from "react-native-reanimated";
        export const PlainButton = () => (
          <Button onPress={() => { const fn = () => {}; scheduleOnRN(fn); }} />
        );
      `,
    },
    {
      filename: "src/workletHelper.ts",
      code: `
        import { scheduleOnRN } from "react-native-reanimated";
        export const w = () => {
          "worklet";
          const fn = () => {};
          scheduleOnRN(fn);
        };
      `,
    },
  ],
  invalid: [
    {
      filename: "src/GestureBad.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        export const App = () => {
          const tap = Gesture.Tap().onEnd(() => {
            const myFunction = () => {};
            scheduleOnRN(myFunction);
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
      errors: [{ messageId: "uiRuntimeDefinedCallback" }],
    },
    {
      filename: "src/WithTimingBad.tsx",
      code: `
        import { scheduleOnRN, useAnimatedStyle, withTiming } from "react-native-reanimated";
        export const App = () => {
          const style = useAnimatedStyle(() => {
            width.value = withTiming(100, {}, () => {
              function myFunction() {}
              scheduleOnRN(myFunction);
            });
            return { width: width.value };
          });
          return <Animated.View style={style} />;
        };
      `,
      errors: [{ messageId: "uiRuntimeDefinedCallback" }],
    },
    {
      filename: "src/ExplicitWorkletBad.tsx",
      code: `
        import { scheduleOnRN } from "react-native-reanimated";
        export const App = () => {
          const run = () => {
            "worklet";
            const cb = () => {};
            scheduleOnRN(cb);
          };
          return <View />;
        };
      `,
      errors: [{ messageId: "uiRuntimeDefinedCallback" }],
    },
    {
      filename: "src/InlineArrowBad.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        export const App = () => {
          const tap = Gesture.Tap().onEnd(() => {
            scheduleOnRN(() => { console.log("hi"); });
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
      errors: [{ messageId: "inlineWorkletCallback" }],
    },
    {
      filename: "src/InlineFnExprBad.tsx",
      code: `
        import { scheduleOnRN, useAnimatedScrollHandler } from "react-native-reanimated";
        export const App = () => {
          const handler = useAnimatedScrollHandler({
            onScroll: () => {
              scheduleOnRN(function () { console.log("hi"); });
            },
          });
          return <Animated.ScrollView onScroll={handler} />;
        };
      `,
      errors: [{ messageId: "inlineWorkletCallback" }],
    },
    {
      filename: "src/BoundFnBad.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        const notify = (id: string) => { console.log(id); };
        export const App = () => {
          const tap = Gesture.Tap().onEnd(() => {
            scheduleOnRN(notify.bind(null, "1"));
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
      errors: [{ messageId: "uiRuntimeCreatedCallback" }],
    },
    {
      filename: "src/LocalObjectMethodBad.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN } from "react-native-reanimated";
        export const App = () => {
          const tap = Gesture.Tap().onEnd(() => {
            const handlers = { done: () => {} };
            scheduleOnRN(handlers.done);
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
      errors: [{ messageId: "uiRuntimeDefinedCallback" }],
    },
    {
      filename: "src/OuterWorkletDefBad.tsx",
      code: `
        import { Gesture } from "react-native-gesture-handler";
        import { scheduleOnRN, withTiming } from "react-native-reanimated";
        export const App = () => {
          const tap = Gesture.Tap().onEnd(() => {
            const myFunction = () => {};
            width.value = withTiming(100, {}, () => {
              scheduleOnRN(myFunction);
            });
          });
          return <GestureDetector gesture={tap}><View /></GestureDetector>;
        };
      `,
      errors: [{ messageId: "uiRuntimeDefinedCallback" }],
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
    vitest.expect(blocks[1]?.rules).toEqual({
      "strict-fp/require-js-thread-schedule-on-rn": "error",
      "strict-fp/thin-react-component": "error",
    });
  });
});
