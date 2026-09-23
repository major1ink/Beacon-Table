// Расчёт освещения вне главного потока: на сцене с сотнями стен и десятками
// источников polygon-clipping занимает десятки миллисекунд, и в главном
// потоке это были рывки кадра при каждом шаге токена. memo живёт здесь, между
// запросами, как раньше жил в vision-fog.js.
import { computeVisionPlanWithFallback } from "./vision-plan.js";

const memo = {};

self.onmessage = (e) => {
  const { id, scene, isDM, force } = e.data;
  if (force) memo.planKey = null; // экран стёрт — нужен план целиком
  const { plan, error, unchanged } = computeVisionPlanWithFallback(scene, isDM, memo);
  self.postMessage({ id, plan: unchanged ? null : plan, unchanged: !!unchanged, error: error ? String((error && error.stack) || error) : null });
};
