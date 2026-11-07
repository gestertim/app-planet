// readiness §108：schema、HTTP handler、受限 DB invocation 與 0041→0042 升級共用同一組路徑案例。
// current：現行規則（core schema 與 0042 DB 函式）是否接受；legacy0041：0041 實際舊規則是否接受。
export type ProjectFilePathCase = Readonly<{ path: string; current: boolean; legacy0041: boolean; note: string }>;

const longestValid = `${"a/".repeat(253)}x.html`;
const tooLong = `${"a/".repeat(253)}xx.html`;

export const projectFilePathCases: readonly ProjectFilePathCase[] = [
  { path: "con.js", current: false, legacy0041: true, note: "小寫保留名" },
  { path: "Aux.css", current: false, legacy0041: true, note: "混合大小寫保留名" },
  { path: "nul.html", current: false, legacy0041: true, note: "小寫保留名" },
  { path: "Com1.js", current: false, legacy0041: true, note: "混合大小寫 COM 裝置名" },
  { path: "nested/con.js", current: false, legacy0041: true, note: "巢狀檔名保留名" },
  { path: "lpt9/app.js", current: false, legacy0041: true, note: "巢狀資料夾保留名" },
  { path: "deep/Prn/index.html", current: false, legacy0041: true, note: "多層巢狀資料夾保留名" },
  { path: "CON.js", current: false, legacy0041: false, note: "大寫保留名" },
  { path: "src/AUX.css", current: false, legacy0041: false, note: "巢狀大寫保留名" },
  { path: "console.js", current: true, legacy0041: true, note: "合法近似名稱" },
  { path: "Auxiliary.css", current: true, legacy0041: true, note: "合法近似名稱" },
  { path: "nested/PrnFolder.js", current: true, legacy0041: true, note: "合法近似資料夾" },
  { path: "com10.js", current: true, legacy0041: true, note: "COM 後非單一數字" },
  { path: "lpt.js", current: true, legacy0041: true, note: "無數字 LPT" },
  { path: "con-test/app.js", current: true, legacy0041: true, note: "保留名前綴資料夾" },
  { path: longestValid, current: true, legacy0041: true, note: "512 ASCII bytes 邊界" },
  { path: tooLong, current: false, legacy0041: false, note: "513 ASCII bytes" },
  { path: "index.HTML", current: false, legacy0041: false, note: "副檔名大小寫" },
  { path: "src//main.js", current: false, legacy0041: false, note: "空 segment" },
  { path: "a./b.js", current: false, legacy0041: false, note: "segment 以點結尾" },
];

export const legacyOnlyPathCases = projectFilePathCases.filter((entry) => entry.legacy0041 && !entry.current);
