// Budget / cost seam (STUB).
//
// Real version: spent/committed come from the authoritative QCD cost facts via
// the read-only query contract (ADR-0031), and holds/settlement happen through
// the Gateway + reservation ledger. Here it is in-memory only. Each currency is
// kept separate in the real system (WQ-07); the mockup uses CNY only.

const ACCOUNT_TOTAL = 30000;
const PROJECT_BUDGET = 12000;

const projects = [
  { id: "shengtang", name: "盛唐·金銮殿", spent: 1240, cur: true },
  { id: "convenience", name: "深夜便利店", spent: 7480 },
  { id: "rain", name: "雨夜", spent: 320 },
];

export const accountTotal = () => ACCOUNT_TOTAL;
export const projectBudget = () => PROJECT_BUDGET;
export const projectsList = () => projects;
export const curProject = () => projects.find((p) => p.cur);
export const totalSpent = () => projects.reduce((a, p) => a + p.spent, 0);
export const balance = () => ACCOUNT_TOTAL - totalSpent();

/** Record spend against the current project (stub for a settled cost fact). */
export function spend(amount) {
  const p = curProject();
  p.spent = Math.round((p.spent + amount) * 100) / 100;
  return p.spent;
}

export const yuan = (n) =>
  "¥" +
  n.toLocaleString("zh-CN", {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
