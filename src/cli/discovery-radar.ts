#!/usr/bin/env node
import path from "node:path";
import * as ts from "typescript";
import { buildDiscoveryRadarReport, formatDiscoveryReport } from "../analyzers/radar-report.js";

const parseFlag = (args: ReadonlyArray<string>, flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ?? fallback;
};

const runRadarCli = () => {
  const args = process.argv.slice(2);
  const tsconfigPath = path.resolve(process.cwd(), parseFlag(args, "--tsconfig", "tsconfig.json"));
  const formatArg = parseFlag(args, "--format", "markdown");
  const format = formatArg === "json" ? ("json" as const) : ("markdown" as const);
  const configFile = ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f));
  if (configFile.error) {
    console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  console.log(formatDiscoveryReport(buildDiscoveryRadarReport(program), format));
};

runRadarCli();
