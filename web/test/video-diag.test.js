import test from "node:test";
import assert from "node:assert/strict";
import { isBlackFrame } from "../src/vtt/video-diag.js";

test("чёрные пиксели — чёрный кадр", () => {
  assert.equal(isBlackFrame(new Uint8ClampedArray([0, 0, 0, 255, 3, 2, 1, 255])), true);
});

test("один светлый пиксель — кадр не чёрный", () => {
  assert.equal(isBlackFrame(new Uint8ClampedArray([0, 0, 0, 255, 0, 40, 0, 255])), false);
});
