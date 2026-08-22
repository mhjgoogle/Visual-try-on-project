// Command Gateway seam — COMPATIBILITY LAYER, deprecated (TASK-072 §1.4).
//
// The implementation moved to the two seams the 系统合同 §7 names:
//
//   services/command.js   buildEnvelope · preflight · submit · adoptPaid · submitCommand
//   services/query.js     getGenerationTarget · getLockTarget · paidOps
//
// WHY IT MOVED. This file was the one write path that can SPEND money, and it was
// also the one write path outside the module whose stated rules are 「不重试、不静默
// 吞错、不自己判断允不允许」. A reader asking 「这一次调用会不会改东西」 had to know
// that gateway.js contained both kinds. Now the answer is the module name.
//
// Re-exported rather than reimplemented: exactly ONE implementation of each call
// exists, so this layer cannot drift from it. TASK-074 §1.5 deletes the file once
// nothing imports it.
export {
  buildEnvelope, preflight, submit, adoptPaid, submitCommand,
} from "./command.js";
export { getGenerationTarget, getLockTarget, paidOps } from "./query.js";
