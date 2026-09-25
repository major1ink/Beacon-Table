// native-app.js — стол открыт в приложении для Android
// (github.com/major1ink/beacon-table-android): оно дописывает к User-Agent
// «BeaconTableApp/<версия>». Окно там одно и уже во весь экран — window.open
// увёл бы со стола, а полноэкранный режим ничего не даёт.
export const inApp = typeof navigator !== "undefined" && /\bBeaconTableApp\//.test(navigator.userAgent);
