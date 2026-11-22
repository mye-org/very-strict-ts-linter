import { formatLargeReport } from "./helper-for-large.js";

// Padding lines to simulate a large file exceeding a tight maxMergedFileLines budget
const line01 = "a";
const line02 = "b";
const line03 = "c";
const line04 = "d";
const line05 = "e";
const line06 = "f";
const line07 = "g";
const line08 = "h";
const line09 = "i";
const line10 = "j";
const line11 = "k";
const line12 = "l";
const line13 = "m";
const line14 = "n";
const line15 = "o";
const line16 = "p";
const line17 = "q";
const line18 = "r";
const line19 = "s";
const line20 = "t";

export const renderFullReport = (title: string) =>
  `${formatLargeReport(title)}:${line01}${line02}${line03}${line04}${line05}${line06}${line07}${line08}${line09}${line10}${line11}${line12}${line13}${line14}${line15}${line16}${line17}${line18}${line19}${line20}`;
