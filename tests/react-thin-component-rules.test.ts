import path from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import * as vitest from "vitest";
import plugin from "../src/index.js";
import { noReactInTs } from "../src/rules/no-react-in-ts.js";
import { noUnsafeReactHooks } from "../src/rules/no-unsafe-react-hooks.js";
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

const typeAwareJsxRuleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      ecmaFeatures: { jsx: true },
      projectService: {
        allowDefaultProject: ["file.tsx"],
        defaultProject: "tsconfig.json",
      },
      tsconfigRootDir: path.resolve(import.meta.dirname, "fixtures"),
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

typeAwareJsxRuleTester.run("thin-react-component (type-aware primitive destructuring)", thinReactComponent, {
  valid: [
    // Primitive destructuring from a single view object does not penalize maxDerivedConsts / noViewDestructuring
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; readonly span: unknown; } }
        type Props = { readonly id: string };
        type CardView = { readonly title: string; readonly count: number; readonly isReady: boolean; readonly items: ReadonlyArray<string> };
        declare function toCardView(props: Props): CardView;
        export const Card = (props: Props) => {
          const view = toCardView(props);
          const { title, count, isReady } = view;
          return <div><span>{title}</span><span>{count}</span><span>{isReady}</span></div>;
        };
      `,
    },
    // Primitive destructuring from a useMemo wrapper
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; } }
        declare function useMemo<T>(factory: () => T, deps: ReadonlyArray<unknown>): T;
        type Props = { readonly id: string };
        type CardView = { readonly title: string; readonly count: number };
        declare function toCardView(props: Props): CardView;
        export const Card = (props: Props) => {
          const view = useMemo(() => toCardView(props), [props.id]);
          const { title, count } = view;
          return <div>{title}{count}</div>;
        };
      `,
    },
    // Direct primitive destructuring from a single view call
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; } }
        type Props = { readonly id: string };
        type CardView = { readonly title: string; readonly count: number };
        declare function toCardView(props: Props): CardView;
        export const Card = (props: Props) => {
          const { title, count } = toCardView(props);
          return <div>{title}{count}</div>;
        };
      `,
    },
  ],
  invalid: [
    // Destructuring non-primitive properties (e.g. arrays/objects) from view still fails
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; } }
        type Props = { readonly id: string };
        type CardView = { readonly title: string; readonly items: ReadonlyArray<string> };
        declare function toCardView(props: Props): CardView;
        export const Card = (props: Props) => {
          const view = toCardView(props);
          const { title, items } = view;
          return <div>{title}{items.length}</div>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }, { messageId: "noViewDestructuring" }],
    },
    // Rest destructuring creates a new object and still fails
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; } }
        type Props = { readonly id: string };
        type CardView = { readonly title: string; readonly count: number };
        declare function toCardView(props: Props): CardView;
        export const Card = (props: Props) => {
          const view = toCardView(props);
          const { title, ...rest } = view;
          return <div>{title}{rest.count}</div>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }, { messageId: "noViewDestructuring" }],
    },
    // Multiple derived view objects still fail maxDerivedConsts
    {
      filename: "file.tsx",
      code: `
        declare namespace JSX { interface IntrinsicElements { readonly div: unknown; } }
        type Props = { readonly id: string };
        declare function toViewA(props: Props): { readonly title: string };
        declare function toViewB(props: Props): { readonly subtitle: string };
        export const Card = (props: Props) => {
          const viewA = toViewA(props);
          const viewB = toViewB(props);
          const { title } = viewA;
          return <div>{title}{viewB.subtitle}</div>;
        };
      `,
      errors: [{ messageId: "tooManyDerivedConsts" }],
    },
  ],
});

typeAwareJsxRuleTester.run("no-unsafe-react-hooks", noUnsafeReactHooks, {
  valid: [
    // Expression-bodied effect returning void
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
        declare function track(id: string): void;
        export const Comp = (props: { readonly id: string }) => {
          useEffect(() => track(props.id), [props.id]);
          return null;
        };
      `,
    },
    // Expression-bodied effect returning cleanup function () => void
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
        declare function useLayoutEffect(cb: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
        declare function subscribe(id: string): () => void;
        declare function maybeSubscribe(id: string): (() => void) | undefined;
        export const Comp = (props: { readonly id: string }) => {
          useEffect(() => subscribe(props.id), [props.id]);
          useLayoutEffect(() => maybeSubscribe(props.id), [props.id]);
          return null;
        };
      `,
    },
    // Block-bodied effect for side-effect-only async or non-void calls
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
        declare function loadAsync(id: string): Promise<void>;
        declare function computeCount(): number;
        export const Comp = (props: { readonly id: string }) => {
          useEffect(() => { void loadAsync(props.id); }, [props.id]);
          useEffect(() => { computeCount(); }, []);
          return null;
        };
      `,
    },
    // Memoized object, primitive call result, primitive member access, and module-level object in deps
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
        declare function useMemo<T>(factory: () => T, deps: ReadonlyArray<unknown>): T;
        declare function useCallback<T extends (...args: ReadonlyArray<never>) => unknown>(fn: T, deps: ReadonlyArray<unknown>): T;
        declare function computePlan(id: string): { readonly stepId: string };
        declare function formatLabel(id: string): string;
        declare function run(v: unknown): void;
        const MODULE_CONFIG = { retries: 3 };
        export const Comp = (props: { readonly id: string }) => {
          const plan = useMemo(() => computePlan(props.id), [props.id]);
          const label = formatLabel(props.id);
          const rawPlan = computePlan(props.id);
          useEffect(() => { run(plan); }, [plan, label, rawPlan.stepId, MODULE_CONFIG]);
          const onClick = useCallback(() => { run(plan); }, [plan, label]);
          return onClick;
        };
      `,
    },
  ],
  invalid: [
    // Expression-bodied useEffect returning Promise
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => unknown, deps?: ReadonlyArray<unknown>): void;
        declare function fetchData(id: string): Promise<void>;
        export const Comp = (props: { readonly id: string }) => {
          useEffect(() => fetchData(props.id), [props.id]);
          return null;
        };
      `,
      errors: [{ messageId: "expressionEffectReturnsPromise" }],
    },
    // Expression-bodied useLayoutEffect returning custom thenable
    {
      filename: "file.tsx",
      code: `
        declare function useLayoutEffect(cb: () => unknown, deps?: ReadonlyArray<unknown>): void;
        declare function makeThenable(): { readonly then: (cb: () => void) => void };
        export const Comp = () => {
          useLayoutEffect(() => makeThenable(), []);
          return null;
        };
      `,
      errors: [{ messageId: "expressionEffectReturnsPromise" }],
    },
    // Async expression-bodied useEffect
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => unknown, deps?: ReadonlyArray<unknown>): void;
        declare function track(): void;
        export const Comp = () => {
          useEffect(async () => track(), []);
          return null;
        };
      `,
      errors: [{ messageId: "expressionEffectReturnsPromise" }],
    },
    // Expression-bodied useEffect returning non-void primitive or object
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => unknown, deps?: ReadonlyArray<unknown>): void;
        declare function computeCount(): number;
        export const Comp = () => {
          useEffect(() => computeCount(), []);
          return null;
        };
      `,
      errors: [{ messageId: "expressionEffectUnsafeReturn" }],
    },
    // Expression-bodied useEffect returning cleanup function that returns Promise instead of void
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => unknown, deps?: ReadonlyArray<unknown>): void;
        declare function subscribeAsync(): () => Promise<void>;
        export const Comp = () => {
          useEffect(() => subscribeAsync(), []);
          return null;
        };
      `,
      errors: [{ messageId: "expressionEffectUnsafeReturn" }],
    },
    // Unmemoized render-time call result passed directly into useEffect / useCallback / useMemo deps
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void, deps?: ReadonlyArray<unknown>): void;
        declare function useCallback<T>(fn: T, deps: ReadonlyArray<unknown>): T;
        declare function useMemo<T>(factory: () => T, deps: ReadonlyArray<unknown>): T;
        declare function computePlan(id: string): { readonly stepId: string };
        declare function run(v: unknown): void;
        export const Comp = (props: { readonly id: string }) => {
          const plan = computePlan(props.id);
          useEffect(() => { run(plan); }, [plan]);
          const cb = useCallback(() => { run(plan); }, [plan]);
          const val = useMemo(() => plan.stepId, [plan]);
          return { cb, val };
        };
      `,
      errors: [
        { messageId: "unstableHookDependency" },
        { messageId: "unstableHookDependency" },
        { messageId: "unstableHookDependency" },
      ],
    },
    // Unmemoized render-time object literal and inline object/call in deps
    {
      filename: "file.tsx",
      code: `
        declare function useEffect(cb: () => void, deps?: ReadonlyArray<unknown>): void;
        declare function computePlan(id: string): { readonly stepId: string };
        declare function run(v: unknown): void;
        export const Comp = (props: { readonly id: string }) => {
          const opts = { id: props.id };
          useEffect(() => { run(opts); }, [opts, { inline: true }, computePlan(props.id)]);
          return null;
        };
      `,
      errors: [
        { messageId: "unstableHookDependency" },
        { messageId: "unstableInlineHookDependency" },
        { messageId: "unstableInlineHookDependency" },
      ],
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
      "no-sequences": "error",
      "strict-fp/no-unsafe-react-hooks": "error",
      "strict-fp/require-js-thread-schedule-on-rn": "error",
      "strict-fp/thin-react-component": "error",
    });
  });
});
