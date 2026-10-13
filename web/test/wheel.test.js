import test from "node:test";
import assert from "node:assert/strict";
import { createWheelClassifier, pinchFactor } from "../src/vtt/wheel.js";

const wheel = (deltaY, extra = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, timeStamp: 0, ...extra });

test("колесо мыши зумит", () => {
  const classify = createWheelClassifier();
  assert.equal(classify(wheel(100)), "zoom");
  assert.equal(classify(wheel(-120, { timeStamp: 500 })), "zoom");
});

test("колесо мыши в строках (Firefox) зумит", () => {
  assert.equal(createWheelClassifier()(wheel(3, { deltaMode: 1 })), "zoom");
});

test("прокрутка тачпада двигает карту", () => {
  const classify = createWheelClassifier();
  assert.equal(classify(wheel(4)), "pan");
  assert.equal(classify(wheel(7.5, { timeStamp: 16 })), "pan");
  assert.equal(classify(wheel(2, { deltaX: 9, timeStamp: 32 })), "pan");
});

test("инерция тачпада с крупными значениями остаётся паном", () => {
  const classify = createWheelClassifier();
  classify(wheel(12, { timeStamp: 0 }));
  assert.equal(classify(wheel(100, { timeStamp: 40 })), "pan");
});

test("колесо мыши после паузы снова зумит", () => {
  const classify = createWheelClassifier();
  classify(wheel(12, { timeStamp: 0 }));
  assert.equal(classify(wheel(100, { timeStamp: 1000 })), "zoom");
});

test("щипок и Ctrl + колесо — плавный зум", () => {
  assert.equal(createWheelClassifier()(wheel(-3, { ctrlKey: true })), "pinch");
  assert.ok(pinchFactor(-5) > 1);
  assert.ok(pinchFactor(5) < 1);
  assert.equal(pinchFactor(-1000), pinchFactor(-25));
});
