// modules-link.js — открыть витрину модулей. В десктопе новая вкладка не
// откроется (window.open там не работает), поэтому плавающее окно.
import { openFloatingWindow } from "./floating-window.js";

function inDesktop() {
  try {
    return !!window.top.beaconDesktop;
  } catch {
    return false;
  }
}

export function openModulesShowcase(query = "") {
  const url = "/modules.html" + query;
  if (!inDesktop()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const opts = { key: "modules", title: "Модули", url, navigate: true };
  if (window.top === window) openFloatingWindow({ ...opts, width: 1100, height: 760 });
  else window.top.postMessage({ type: "beacon:openFloatingWindow", ...opts }, location.origin);
}
