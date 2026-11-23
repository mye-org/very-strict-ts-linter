interface ExpectMatcher {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toThrow(expected?: string | RegExp): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toHaveBeenCalledWith(...args: ReadonlyArray<unknown>): void;
  readonly not: ExpectMatcher;
}

interface SpyHandle {
  mockReturnValue(val: unknown): SpyHandle;
  mockImplementation(fn: (...args: ReadonlyArray<never>) => unknown): SpyHandle;
}

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void): void;
declare namespace it {
  function each<T>(cases: ReadonlyArray<T>): (name: string, fn: (...args: ReadonlyArray<never>) => void) => void;
}
declare function test(name: string, fn: () => void): void;
declare function expect(actual: unknown): ExpectMatcher;

declare const vi: {
  mock(modulePath: string, factory?: () => unknown): void;
  spyOn<T extends object, K extends keyof T>(obj: T, method: K): SpyHandle;
  fn(impl?: (...args: ReadonlyArray<never>) => unknown): (...args: ReadonlyArray<unknown>) => unknown;
};

declare const assert: {
  strictEqual(actual: unknown, expected: unknown): void;
  deepStrictEqual(actual: unknown, expected: unknown): void;
  throws(fn: () => unknown, err?: string | RegExp): void;
  ok(value: unknown): void;
};
