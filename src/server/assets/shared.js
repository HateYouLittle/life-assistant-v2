/** @param {string} id @returns {any} */
function el(id) {
  return document.getElementById(id);
}
function yuan(cents) {
  return (
    '¥' +
    (Number(cents || 0) / 100).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function esc(text) {
  return String(text === null || text === undefined ? '' : text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
